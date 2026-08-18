import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCheckpoint,
  createSanitizer,
  dirtyEntries,
  isSecretPath,
  uncommittedChanges,
  type GitRunner
} from "../electron/evidence";

/**
 * Evidence comes from git, so these run against a real temporary repository
 * rather than a stubbed one. A parser that agrees with a fake `git` and
 * disagrees with the real one proves nothing.
 */

const git: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

let repo: string;

async function commitAll(message: string): Promise<void> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", message]);
}

/** Makes every subsequent commit in the fixture fail, without touching the
 *  index — so `git add` still works and the failure is the commit itself. */
async function failCommits(): Promise<void> {
  await git(repo, ["config", "commit.gpgsign", "true"]);
  await git(repo, ["config", "user.signingkey", "0000000000000000"]);
}

const write = (relative: string, contents: string): void => {
  const path = join(repo, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
};

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-evidence-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  write("README.md", "# fixture\n");
  await commitAll("initial");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("the dirty set", () => {
  it("reads paths with spaces and reports the state of each", async () => {
    write("src/added file.ts", "export const added = 1;\n");
    write("README.md", "# fixture\n\nchanged\n");
    const entries = await dirtyEntries(git, repo);
    const byPath = new Map(entries.map((entry) => [entry.path, entry.changeState]));
    expect(byPath.get("src/added file.ts")).toBe("added");
    expect(byPath.get("README.md")).toBe("modified");
  });
});

/**
 * A person's own attached file must never reach a commit (D-153).
 *
 * Written against a real git repository with no `.git/info/exclude` entry at
 * all, which is the whole point: this proves the checkpoint refuses the path
 * on its own, so a missing or hand-edited exclude file cannot put somebody's
 * screenshot into a mission branch and from there into a pull request.
 */
describe("a staged attachment at checkpoint time", () => {
  it("is never committed, even when git would happily see it", async () => {
    write(".novus/attachments/art_abc-private.png", "pretend bytes\n");
    write("src/real-work.ts", "export const work = 1;\n");

    // Git sees both — nothing is ignoring the directory here.
    const seen = (await dirtyEntries(git, repo)).map((entry) => entry.path);
    expect(seen).toContain(".novus/attachments/art_abc-private.png");

    const checkpoint = await captureCheckpoint(git, repo, {
      branch: "novus/m-abc123",
      summary: "a turn that also had an attachment lying about"
    });

    expect(checkpoint.files.map((file) => file.path)).toEqual(["src/real-work.ts"]);
    const committed = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(committed).toContain("src/real-work.ts");
    expect(committed).not.toContain(".novus");
    // Still on disk, because the agent may still need to open it.
    const after = (await dirtyEntries(git, repo)).map((entry) => entry.path);
    expect(after).toContain(".novus/attachments/art_abc-private.png");
  });

  it("does not turn a turn that only staged a file into a commit", async () => {
    write(".novus/attachments/art_abc-only.png", "pretend bytes\n");
    const checkpoint = await captureCheckpoint(git, repo, {
      branch: "novus/m-abc123",
      summary: "nothing of the mission's changed"
    });
    expect(checkpoint.sha).toBeNull();
    expect(checkpoint.files).toEqual([]);
  });
});

describe("captureCheckpoint", () => {
  it("records a clean turn as evidence rather than as silence", async () => {
    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "nothing to do" });
    expect(checkpoint.outcome).toBe("clean");
    expect(checkpoint.sha).toBeNull();
    expect(checkpoint.files).toEqual([]);
    expect(checkpoint.uncommitted).toBe(false);
    expect(checkpoint.parentSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("commits added, modified and deleted files with counts and diffs", async () => {
    write("doomed.txt", "delete me\n");
    await commitAll("a file that a later turn removes");

    write("src/added.ts", "export const added = 1;\n");
    write("README.md", "# fixture\n\nsecond line\n");
    rmSync(join(repo, "doomed.txt"));

    const checkpoint = await captureCheckpoint(git, repo, {
      branch: "novus/m-abc123",
      summary: "Add the health check"
    });
    expect(checkpoint.outcome).toBe("committed");
    expect(checkpoint.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.parentSha).not.toBe(checkpoint.sha);

    const byPath = new Map(checkpoint.files.map((file) => [file.path, file]));
    expect(byPath.get("src/added.ts")?.changeState).toBe("added");
    expect(byPath.get("src/added.ts")?.additions).toBe(1);
    expect(byPath.get("src/added.ts")?.diff).toContain("export const added = 1;");
    expect(byPath.get("README.md")?.changeState).toBe("modified");
    expect(byPath.get("doomed.txt")?.changeState).toBe("deleted");
    expect(byPath.get("doomed.txt")?.deletions).toBe(1);

    const message = await git(repo, ["log", "-1", "--format=%s%n%an"]);
    expect(message).toContain("Checkpoint: Add the health check");
    expect(message).toContain("Novus");
  });

  it("detects a rename instead of reporting a delete and an add", async () => {
    write("src/original.ts", Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index};`).join("\n"));
    await commitAll("add a file worth renaming");
    renameSync(join(repo, "src/original.ts"), join(repo, "src/renamed.ts"));

    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "rename" });
    expect(checkpoint.outcome).toBe("committed");
    expect(checkpoint.files.length).toBe(1);
    expect(checkpoint.files[0]?.changeState).toBe("renamed");
    expect(checkpoint.files[0]?.path).toBe("src/renamed.ts");
    expect(checkpoint.files[0]?.previousPath).toBe("src/original.ts");
  });

  it("marks a binary file as binary and carries no diff for it", async () => {
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 7, 0]));
    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "add a binary" });
    const binary = checkpoint.files.find((file) => file.path === "logo.bin");
    expect(binary?.binary).toBe(true);
    expect(binary?.diff).toBeNull();
  });

  it("refuses to commit files that look like secrets and says how many it withheld", async () => {
    write(".env", "ANTHROPIC_API_KEY=sk-should-never-be-committed\n");
    write("keys/id_ed25519", "PRIVATE KEY\n");
    write("src/real.ts", "export const real = true;\n");

    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "mixed" });
    expect(checkpoint.outcome).toBe("committed");
    expect(checkpoint.withheldSecrets).toBe(2);
    expect(checkpoint.uncommitted).toBe(true);
    expect(checkpoint.files.map((file) => file.path)).toEqual(["src/real.ts"]);

    const tracked = await git(repo, ["ls-files"]);
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain("id_ed25519");
  });

  it("stays clean, and uncommitted, when the only change is a withheld secret", async () => {
    write(".env.local", "TOKEN=nope\n");
    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "secret only" });
    expect(checkpoint.outcome).toBe("clean");
    expect(checkpoint.withheldSecrets).toBe(1);
    expect(checkpoint.uncommitted).toBe(true);
    expect(checkpoint.sha).toBeNull();
  });

  it("reports a failure as a failure, with the error and nothing committed", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "novus-not-a-repo-"));
    try {
      const checkpoint = await captureCheckpoint(git, notARepo, { branch: "novus/m-abc123", summary: "doomed" });
      expect(checkpoint.outcome).toBe("failed");
      expect(checkpoint.uncommitted).toBe(true);
      expect(checkpoint.error).toBeTruthy();
      expect(checkpoint.sha).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("bounds a very large diff and says it truncated", async () => {
    write("src/big.ts", Array.from({ length: 4_000 }, (_, index) => `export const line${index} = ${index};`).join("\n"));
    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "a big file" });
    const file = checkpoint.files.find((entry) => entry.path === "src/big.ts");
    expect(file?.truncated).toBe(true);
    expect(file?.diff?.length).toBe(12_000);
  });

  it("lists what is still uncommitted when a checkpoint could not take it", async () => {
    write("README.md", "# fixture\n\nnot yet committed\n");
    const files = await uncommittedChanges(git, repo);
    expect(files.map((file) => file.path)).toEqual(["README.md"]);
    expect(files[0]?.additions).toBeGreaterThan(0);
  });
});

describe("secret paths", () => {
  it("names the files an agent must never have committed for it", () => {
    for (const path of [".env", "config/.env.local", "keys/id_rsa", "certs/server.pem", ".npmrc", "gcp/credentials.json"]) {
      expect(isSecretPath(path)).toBe(true);
    }
    for (const path of ["src/environment.ts", "docs/credentials.md", "src/app.ts"]) {
      expect(isSecretPath(path)).toBe(false);
    }
  });
});

describe("path sanitization", () => {
  it("replaces machine-local paths with neutral labels", () => {
    const sanitize = createSanitizer([
      { path: "/Users/someone/Library/Application Support/Novus/worktrees/msn_1", label: "the mission worktree" },
      { path: "/Users/someone/code/payments", label: "the repository" }
    ]);
    expect(sanitize("wrote /Users/someone/Library/Application Support/Novus/worktrees/msn_1/src/app.ts")).toBe(
      "wrote the mission worktree/src/app.ts"
    );
    expect(sanitize("cloned from /Users/someone/code/payments")).toBe("cloned from the repository");
  });

  it("masks the longest path first, so a nested worktree is not half-masked", () => {
    const sanitize = createSanitizer([
      { path: "/repo", label: "the repository" },
      { path: "/repo/.worktrees/msn_1", label: "the mission worktree" }
    ]);
    expect(sanitize("/repo/.worktrees/msn_1/src/app.ts")).toBe("the mission worktree/src/app.ts");
  });

  it("masks the /private alias macOS prints for temporary paths", () => {
    const sanitize = createSanitizer([{ path: "/var/folders/t7/novus-worktree", label: "the mission worktree" }]);
    expect(sanitize("fatal: /private/var/folders/t7/novus-worktree/.git is missing")).toBe(
      "fatal: the mission worktree/.git is missing"
    );
  });

  it("sweeps any home directory it was never told about", () => {
    const sanitize = createSanitizer([]);
    expect(sanitize("ENOENT: /Users/kartik/Desktop/thing.txt")).toBe("ENOENT: ~/Desktop/thing.txt");
    expect(sanitize("ENOENT: /home/kartik/thing.txt")).toBe("ENOENT: ~/thing.txt");
  });
});

describe("a checkpoint that could not commit", () => {
  /**
   * The failure path used to report an empty file list, which reads in the room
   * as "the turn changed nothing" — about a turn that changed things and could
   * not save them, which is the one moment those files matter most. The verb
   * that produces the record existed and had tests; nothing called it (D-054).
   *
   * Entered through `captureCheckpoint`, the function the product actually
   * calls, rather than through `uncommittedChanges` directly. A test that calls
   * the orphan is what let the orphan stay an orphan.
   */
  it("says what changed instead of reporting nothing", async () => {
    write("README.md", "# fixture\n\nchanged by the turn\n");
    write("new-file.ts", "export const added = true;\n");
    // A real commit failure, not a simulated one: signing is required and the
    // key does not exist, so `git add` succeeds and `git commit` does not —
    // which is the shape of every commit failure that matters (a hook, a full
    // disk, an identity the machine cannot use).
    await failCommits();

    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "a turn" });
    expect(checkpoint.outcome).toBe("failed");
    expect(checkpoint.uncommitted).toBe(true);
    expect(checkpoint.sha).toBeNull();
    const paths = checkpoint.files.map((file) => file.path).sort();
    expect(paths).toContain("README.md");
    expect(paths).toContain("new-file.ts");
  });

  it("withholds a credential file from that record, exactly as a successful one does", async () => {
    write("README.md", "# fixture\n\nchanged by the turn\n");
    write(".env", "API_TOKEN=not-a-real-token-0000\n");
    await failCommits();

    const checkpoint = await captureCheckpoint(git, repo, { branch: "novus/m-abc123", summary: "a turn" });
    expect(checkpoint.outcome).toBe("failed");
    const paths = checkpoint.files.map((file) => file.path);
    expect(paths).toContain("README.md");
    expect(paths).not.toContain(".env");
    expect(JSON.stringify(checkpoint)).not.toContain("not-a-real-token");
  });
});

describe("a scoped checkpoint (D-097)", () => {
  it("commits only the scope's paths, names the rest as drift, and leaves them in the worktree", async () => {
    write("server/api.ts", "export const api = 1;\n");
    write("apps/desktop/view.tsx", "export const view = 1;\n");
    write("scratch.log", "shell side-effect\n");

    const checkpoint = await captureCheckpoint(git, repo, {
      branch: "novus/m-abc123",
      summary: "server work",
      scope: ["server/**"]
    });
    expect(checkpoint.outcome).toBe("committed");
    expect(checkpoint.files.map((file) => file.path)).toEqual(["server/api.ts"]);
    // The rest is drift: observed and named, never committed by this turn —
    // it could be a parallel sibling's in-flight work, and attributing it
    // would be a guess.
    expect(checkpoint.driftPaths.sort()).toEqual(["apps/desktop/view.tsx", "scratch.log"]);
    expect(checkpoint.uncommitted).toBe(true);

    // The commit itself holds only the scoped path; the drift is still dirty.
    const committed = await git(repo, ["show", "--name-only", "--format=", checkpoint.sha!]);
    expect(committed.trim().split("\n")).toEqual(["server/api.ts"]);
    const still = await dirtyEntries(git, repo);
    expect(still.map((entry) => entry.path).sort()).toEqual(["apps/desktop/view.tsx", "scratch.log"]);
  });

  it("a scoped turn that changed nothing in its scope is clean, drift or no drift", async () => {
    write("elsewhere.md", "someone else's ground\n");
    const checkpoint = await captureCheckpoint(git, repo, {
      branch: "novus/m-abc123",
      summary: "looked around",
      scope: ["server/**"]
    });
    expect(checkpoint.outcome).toBe("clean");
    expect(checkpoint.sha).toBeNull();
    expect(checkpoint.driftPaths).toEqual(["elsewhere.md"]);
    expect(checkpoint.uncommitted).toBe(true);
  });

  it("leaves a parallel sibling's declared territory silent — only nobody's paths are drift", async () => {
    write("server/api.ts", "export const api = 1;\n");
    write("ui/view.tsx", "export const view = 1;\n");
    write("scratch.log", "shell side-effect\n");

    const checkpoint = await captureCheckpoint(git, repo, {
      branch: "novus/m-abc123",
      summary: "server work beside the ui chat",
      scope: ["server/**"],
      siblingScopes: [["ui/**"]]
    });
    expect(checkpoint.files.map((file) => file.path)).toEqual(["server/api.ts"]);
    // The sibling's file is its own capture's business, moments from now;
    // the scratch file belongs to nobody and stays loud.
    expect(checkpoint.driftPaths).toEqual(["scratch.log"]);
  });
});
