import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceCommandError } from "../electron/workspace-processes";
import { listWorkspaceTree, readWorkspaceFile, writeWorkspaceFile } from "../electron/workspace-tree";

/**
 * Reading the workspace's files, against a real directory (D-048).
 *
 * The assertions that matter are the refusals. A pane that shows a project's
 * files is one `..` away from showing somebody's private keys, and a symlink
 * inside the worktree is an ordinary-looking relative path right up until it is
 * followed — so the containment is tested with real symlinks pointing at real
 * files outside, not with strings that merely look suspicious.
 */

let worktree: string;
let outside: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "novus-tree-"));
  outside = mkdtempSync(join(tmpdir(), "novus-outside-"));
  writeFileSync(join(outside, "secrets.txt"), "an api key that lives somewhere else\n");

  // Credential-shaped files, with obviously-fake contents. A test that proves a
  // secret is refused must not itself be a place a real one could be pasted.
  writeFileSync(join(worktree, ".env"), "API_TOKEN=not-a-real-token-0000\n");
  writeFileSync(join(worktree, ".env.example"), "API_TOKEN=\n");
  writeFileSync(join(worktree, ".npmrc"), "//registry.example.invalid/:_authToken=fake\n");
  writeFileSync(join(worktree, "id_rsa"), "not a real key\n");
  writeFileSync(join(worktree, "server.pem"), "not a real certificate\n");

  writeFileSync(join(worktree, "README.md"), "# fixture\n\nSome prose.\n");
  writeFileSync(join(worktree, "app.ts"), "export const answer = 42;\n");
  mkdirSync(join(worktree, "src"));
  writeFileSync(join(worktree, "src", "index.ts"), "console.log('hi');\n");
  mkdirSync(join(worktree, ".git"));
  writeFileSync(join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(worktree, "node_modules"));
  writeFileSync(join(worktree, "node_modules", "junk.js"), "module.exports = 1;\n");
});

afterEach(() => {
  for (const path of [worktree, outside]) rmSync(path, { recursive: true, force: true });
});

describe("listing a workspace", () => {
  it("shows the project, folders first, and never its bookkeeping", () => {
    const entries = listWorkspaceTree(worktree);
    // `.env.example` is here and its four credential-shaped neighbours are not,
    // which is the policy in D-052 rendered as a listing.
    expect(entries.map((entry) => entry.name)).toEqual([
      "src",
      ".env.example",
      "app.ts",
      "README.md"
    ]);
    expect(entries[0]?.kind).toBe("directory");
    expect(entries.find((entry) => entry.name === "README.md")?.extension).toBe("md");
    // `.git` is not the project and `node_modules` is not somebody's reading.
    expect(entries.map((entry) => entry.name)).not.toContain(".git");
    expect(entries.map((entry) => entry.name)).not.toContain("node_modules");
  });

  it("lists a folder inside it by its relative path", () => {
    const entries = listWorkspaceTree(worktree, "src");
    expect(entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
  });

  it("refuses a path that climbs out", () => {
    for (const path of ["..", "../", "../../etc", "src/../../elsewhere"]) {
      expect(() => listWorkspaceTree(worktree, path)).toThrow(WorkspaceCommandError);
    }
  });

  it("refuses a symlink that points outside, however ordinary the path looks", () => {
    symlinkSync(outside, join(worktree, "escape"));
    // The name is a plain relative path; only following it says otherwise, which
    // is why containment is judged after `realpath` and not before.
    expect(() => listWorkspaceTree(worktree, "escape")).toThrow(/not inside this workspace/);
    expect(() => readWorkspaceFile(worktree, "escape/secrets.txt")).toThrow(
      /not inside this workspace/
    );
  });
});

describe("reading a file", () => {
  it("returns its text, its size, and where it is", () => {
    const file = readWorkspaceFile(worktree, "README.md");
    expect(file.path).toBe("README.md");
    expect(file.text).toContain("# fixture");
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(file.bytes).toBeGreaterThan(0);
  });

  it("says a file is not text rather than showing mojibake", () => {
    writeFileSync(join(worktree, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const file = readWorkspaceFile(worktree, "blob.bin");
    expect(file.binary).toBe(true);
    expect(file.text).toBeNull();
    expect(file.image).toBeNull();
  });

  it("hands a bitmap back as a picture the pane can show (D-146)", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    writeFileSync(join(worktree, "logo.png"), bytes);
    const file = readWorkspaceFile(worktree, "logo.png");
    expect(file.binary).toBe(true);
    expect(file.text).toBeNull();
    expect(file.image).toBe(`data:image/png;base64,${bytes.toString("base64")}`);

    writeFileSync(join(worktree, "photo.JPG"), bytes);
    expect(readWorkspaceFile(worktree, "photo.JPG").image).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("keeps the picture cap honest: an image beyond it is too large, not mojibake", () => {
    writeFileSync(join(worktree, "poster.png"), Buffer.alloc(10_000_001));
    const file = readWorkspaceFile(worktree, "poster.png");
    expect(file.truncated).toBe(true);
    expect(file.image).toBeNull();
  });

  it("says a file is too large rather than reading it into a pane", () => {
    writeFileSync(join(worktree, "huge.log"), "x".repeat(1_000_001));
    const file = readWorkspaceFile(worktree, "huge.log");
    expect(file.truncated).toBe(true);
    expect(file.text).toBeNull();
  });

  it("refuses a folder, by name", () => {
    expect(() => readWorkspaceFile(worktree, "src")).toThrow(/folder, not a file/);
  });
});

describe("editing a file", () => {
  it("overwrites one that is already there", () => {
    writeWorkspaceFile(worktree, "README.md", "# fixture\n\nEdited.\n");
    expect(readFileSync(join(worktree, "README.md"), "utf8")).toContain("Edited.");
  });

  it("will not create one", () => {
    // Creating files is directed work with a checkpoint behind it, not an
    // editor pane's job (D-048).
    expect(() => writeWorkspaceFile(worktree, "invented.md", "hello")).toThrow(/does not create one/);
  });

  it("will not overwrite something that is not text", () => {
    writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    expect(() => writeWorkspaceFile(worktree, "logo.png", "text")).toThrow(/not text/);
  });

  it("refuses to write outside the workspace, through a symlink or a path", () => {
    symlinkSync(join(outside, "secrets.txt"), join(worktree, "linked.txt"));
    expect(() => writeWorkspaceFile(worktree, "linked.txt", "overwritten")).toThrow(
      /not inside this workspace/
    );
    expect(() => writeWorkspaceFile(worktree, "../secrets.txt", "overwritten")).toThrow(
      WorkspaceCommandError
    );
    // And the file outside is untouched.
    expect(readFileSync(join(outside, "secrets.txt"), "utf8")).toContain("somewhere else");
  });
});

describe("files that hold credentials", () => {
  /**
   * The panel is a way for a file's contents to leave the machine — onto the
   * screen, into a screenshot, onto the clipboard by the button beside it. The
   * refusal is here in the main process rather than in the panel, because the
   * renderer can ask for any path it likes and a row that is merely not drawn
   * is a decision the caller can walk around (D-052).
   */
  it("does not list them beside the project's own files", () => {
    const names = listWorkspaceTree(worktree).map((entry) => entry.name);
    expect(names).toContain("README.md");
    for (const hidden of [".env", ".npmrc", "id_rsa", "server.pem"]) {
      expect(names, hidden).not.toContain(hidden);
    }
  });

  it("still lists the template, which is there to be read", () => {
    expect(listWorkspaceTree(worktree).map((entry) => entry.name)).toContain(".env.example");
  });

  it("refuses to read one, however directly it is asked", () => {
    for (const path of [".env", ".npmrc", "id_rsa", "server.pem"]) {
      expect(() => readWorkspaceFile(worktree, path), path).toThrow(WorkspaceCommandError);
    }
    // And the refusal does not leak what it was protecting.
    try {
      readWorkspaceFile(worktree, ".env");
    } catch (error) {
      expect((error as Error).message).not.toContain("not-a-real-token");
    }
    expect(readWorkspaceFile(worktree, ".env.example").text).toBe("API_TOKEN=\n");
  });

  it("refuses to overwrite one", () => {
    expect(() => writeWorkspaceFile(worktree, ".env", "API_TOKEN=replaced\n")).toThrow(
      WorkspaceCommandError
    );
    expect(readFileSync(join(worktree, ".env"), "utf8")).toContain("not-a-real-token-0000");
  });

  it("refuses git's own bookkeeping, which in a linked worktree is a readable file", () => {
    // `.git` is skipped when listing, which is not the same as being unreadable.
    // In a linked worktree it holds one line: the absolute path of the
    // repository, which is precisely what the path sanitizer exists to hide.
    writeFileSync(join(worktree, ".git-file-fixture"), "x\n");
    expect(() => readWorkspaceFile(worktree, ".git")).toThrow(WorkspaceCommandError);
    expect(() => readWorkspaceFile(worktree, ".git/config")).toThrow(WorkspaceCommandError);
  });
});

describe("editing something too large to have been checked", () => {
  it("refuses a binary above the readable size rather than truncating it", () => {
    // The binary sniff used to sit behind the size test, so the rule inverted
    // exactly where it mattered: a file too large for the pane to *show* was
    // small enough for it to destroy.
    const database = join(worktree, "big.db");
    const body = Buffer.alloc(1_200_000);
    body.write("SQLite format 3\0", 0, "utf8");
    writeFileSync(database, body);

    expect(() => writeWorkspaceFile(worktree, "big.db", "destroyed\n")).toThrow(
      WorkspaceCommandError
    );
    expect(statSync(database).size).toBe(1_200_000);
  });
});
