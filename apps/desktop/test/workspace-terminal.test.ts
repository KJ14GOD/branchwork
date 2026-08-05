import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSettingsSchema, type TerminalChunk } from "@novus/contracts";
import { terminalEnv } from "../electron/workspace-env";
import { gitExec } from "../electron/workspace-git";
import {
  listTerminals,
  onTerminalOutput,
  openTerminal,
  shutdownTerminals,
  worktreeFor,
  writeTerminal,
  type WorkspaceHost,
  type WorkspaceTarget
} from "../electron/workspace";
import {
  assertWorktree,
  parseProfile,
  shellFor,
  TerminalError,
  TerminalSessions
} from "../electron/workspace-terminal";

/**
 * The interactive terminal against real PTYs (D-042).
 *
 * Real is the point. A process group a close does not reach, a scrollback that
 * grows without bound, a session that opens in somebody's own checkout, or a
 * shell that outlives the app are all faults a mocked PTY would happily pretend
 * not to have. Every session here is a real `forkpty` running a real shell.
 *
 * The authority property is asserted by absence and cannot be tested from here:
 * there is no shell kind in `RunnerCommandKindSchema` and no control-plane
 * route to any of this, so an interactive shell is unreachable from anywhere
 * except this machine by construction.
 */

const MISSION_ID = "msn_terminal";
const WORKSTREAM_ID = "wst_terminal";
const MISSION_BRANCH = "novus/m-t3rm1n4l";
const LOCAL_ID = "local-terminal";
const HARNESS_CREDENTIAL = "sk-ant-oat01-do-not-leak-this-value";

let repo: string;
let worktree: string;
let userData: string;
let sessions: TerminalSessions;
let chunks: TerminalChunk[];

async function git(cwd: string, args: string[]): Promise<string> {
  const outcome = await gitExec(cwd, args);
  if (outcome.code !== 0) throw new Error(`git ${args.join(" ")}: ${outcome.stderr}`);
  return outcome.stdout.trim();
}

/**
 * Writes a line into a session and keeps writing it until its output appears.
 *
 * A cold login shell — this machine's loads conda — emits its startup in bursts,
 * and a line written before it reaches a prompt is simply eaten. Under load
 * that window is wide enough to lose the whole test, which is what it did on a
 * gate run. Retrying is the fix rather than a longer timeout, because the shell
 * was never slow to answer; it was not listening yet (D-058's sibling, and the
 * same remedy `e2e/runtime.spec.ts` uses).
 */
async function writeUntil(
  sessionId: string,
  line: string,
  appears: () => boolean,
  attempts = 5
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    writeTerminal(sessionId, line);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (appears()) return;
      await new Promise((settle) => setTimeout(settle, 20));
    }
  }
  throw new Error(`the shell never answered \`${line.trim()}\` after ${attempts} attempts`);
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Everything a session has printed so far, from the streamed chunks alone —
 *  the same thing the drawer sees. */
function streamed(sessionId: string): string {
  return chunks
    .filter((chunk) => chunk.sessionId === sessionId)
    .map((chunk) => chunk.data)
    .join("");
}

/**
 * The environment a session gets, built exactly the way `openTerminal` builds
 * it. `source` deliberately carries a harness credential, because the whole
 * point of D-041 is that Novus never hands one on.
 */
function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...terminalEnv({
      workspace: {
        workspaceId: WORKSTREAM_ID,
        missionBranch: MISSION_BRANCH,
        port: 3100,
        portRangeStart: 3100,
        portRangeEnd: 3109
      },
      settings: WorkspaceSettingsSchema.parse({}),
      profile: {},
      workspaceDir: worktree,
      source: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: HARNESS_CREDENTIAL,
        CLAUDE_CODE_OAUTH_TOKEN: HARNESS_CREDENTIAL
      },
      platform: "darwin"
    }),
    // A predictable shell everywhere: a developer's own zsh prompt is noise
    // this suite should not have to parse.
    SHELL: "/bin/sh",
    ...overrides
  };
}

function open(overrides: Partial<Parameters<TerminalSessions["open"]>[0]> = {}) {
  return sessions.open({
    workstreamId: WORKSTREAM_ID,
    worktree,
    sourceRepo: repo,
    env: env(),
    // Wide enough that a temporary-directory path is never wrapped by the tty
    // before the assertions get to read it.
    cols: 400,
    ...overrides
  });
}

/** Types a command and its Return, the way a person at the keyboard would. */
function type(sessionId: string, line: string): void {
  sessions.write(sessionId, `${line}\r`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-term-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-term-userdata-"));
  chunks = [];
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
  worktree = worktreeFor(userData, MISSION_ID);
  await git(repo, ["worktree", "add", "--", worktree, MISSION_BRANCH]);

  sessions = new TerminalSessions({
    // The user's login shell is not this suite's business, and reading it would
    // make the result depend on whose machine is running the tests.
    profile: () => Promise.resolve({}),
    platform: "darwin"
  });
  sessions.onOutput((chunk) => chunks.push(chunk));
});

afterEach(async () => {
  await sessions.shutdown();
  await shutdownTerminals();
  await gitExec(repo, ["worktree", "prune"]);
  for (const path of [repo, userData]) rmSync(path, { recursive: true, force: true });
});

describe("a session", () => {
  it("starts a real shell in the worktree, streams what it prints, and takes input", async () => {
    const session = open({ name: "build log", kind: "log" });
    expect(session.sessionId).toMatch(/^trm_/);
    expect(session.state).toBe("running");
    expect(session.kind).toBe("log");
    expect(session.name).toBe("build log");

    type(session.sessionId, "pwd");
    type(session.sessionId, 'echo NOVUS_TERMINAL""_MARKER');
    await waitFor("the shell to answer", () => streamed(session.sessionId).includes("NOVUS_TERMINAL_MARKER"));

    // The worktree, and only the worktree: a session never opens in the
    // person's own checkout.
    expect(streamed(session.sessionId)).toContain(realpathSync(worktree));
    expect(streamed(session.sessionId)).not.toContain(realpathSync(repo));

    // The same output is readable again from the session's own scrollback, so
    // reopening the drawer shows what already happened.
    const listed = sessions.list(WORKSTREAM_ID);
    expect(listed).toHaveLength(1);
    // Fetched by its own verb rather than riding on every list: a pane asks
    // once when it opens, and a rename does not ship 200KB back.
    expect(sessions.scrollback(listed[0]?.sessionId ?? "")).toContain("NOVUS_TERMINAL_MARKER");
  }, 20_000);

  it("names a tab after the repository and numbers it from one (D-049)", () => {
    // The label the caller passes is the repository's own short name, so the
    // tabs of a mission read `branchwork 1`, `branchwork 2` — the one fact
    // that is true of every session here and that the reader already thinks in.
    const first = open({ label: "branchwork" });
    const second = open({ label: "branchwork" });
    expect(first.name).toBe("branchwork 1");
    expect(second.name).toBe("branchwork 2");

    // A closed tab does not free its number while its session is still known,
    // so two tabs never carry the same label.
    const third = open({ label: "branchwork" });
    expect(third.name).toBe("branchwork 3");

    // No label to hand — a caller with a workstream and no repository record —
    // and the kind stands in, numbered the same way.
    expect(open({ kind: "test" }).name).toBe("test 1");

    // A name a caller passes is still honoured, and renaming still works at
    // this layer even though nothing in the interface offers it (D-049).
    expect(open({ name: "  build log  " }).name).toBe("build log");
    expect(sessions.rename(first.sessionId, "  unit tests  ").name).toBe("unit tests");
    expect(() => sessions.rename(first.sessionId, "   ")).toThrow(TerminalError);
  });

  it("honours a resize, because the shell has to know how wide the reader is", async () => {
    const session = open();
    sessions.resize(session.sessionId, 123, 41);
    type(session.sessionId, "stty size");
    await waitFor("the shell to report its size", () => /\b41 123\b/.test(streamed(session.sessionId)));
    expect(streamed(session.sessionId)).toMatch(/\b41 123\b/);
  }, 20_000);

  it("refuses to open in the user's own checkout, by name", () => {
    expect(() => assertWorktree(repo, repo)).toThrow(TerminalError);
    expect(() => assertWorktree(repo, repo)).toThrow(/your own checkout/);
    expect(() => open({ worktree: repo })).toThrow(/your own checkout/);
    expect(sessions.list()).toHaveLength(0);
  });

  it("refuses a workspace that is not on this machine", () => {
    expect(() => open({ worktree: join(userData, "nowhere") })).toThrow(
      /does not exist on this machine/
    );
  });

  it("carries no harness credential into the shell, and knows where it is", async () => {
    const built = env();
    expect(built.ANTHROPIC_API_KEY).toBeUndefined();
    expect(built.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(built.NOVUS_WORKSPACE_DIR).toBe(worktree);
    expect(built.NOVUS_MISSION_BRANCH).toBe(MISSION_BRANCH);

    // Asserted against the process rather than the object: what a shell can
    // actually read is the only version of this claim that matters.
    const session = open();
    type(session.sessionId, "env");
    type(session.sessionId, 'echo ENV""_DUMPED');
    await waitFor("the environment dump", () => streamed(session.sessionId).includes("ENV_DUMPED"));
    const dumped = streamed(session.sessionId);
    expect(dumped).not.toContain(HARNESS_CREDENTIAL);
    expect(dumped).not.toContain("ANTHROPIC_API_KEY");
    expect(dumped).toContain("NOVUS_WORKSPACE_DIR=");
    expect(dumped).toContain("NOVUS_PORT=3100");
  }, 20_000);

  it("bounds its scrollback, keeping the end rather than the beginning", async () => {
    const session = open();
    // Comfortably past the 200 KB ceiling, then a marker so the test knows the
    // flood is over.
    type(session.sessionId, `awk 'BEGIN{for(i=0;i<24000;i++) print "0123456789abcdef"}'`);
    type(session.sessionId, 'echo FLOOD""_DONE');
    await waitFor(
      "the flood to finish",
      () => sessions.scrollback(sessions.list(WORKSTREAM_ID)[0]?.sessionId ?? "").includes("FLOOD_DONE"),
      30_000
    );

    const scrollback = sessions.scrollback(sessions.list(WORKSTREAM_ID)[0]?.sessionId ?? "");
    expect(scrollback.length).toBeLessThanOrEqual(200 * 1024);
    // The oldest is what was dropped: the marker at the end survived, the
    // command that started it all did not.
    expect(scrollback).toContain("FLOOD_DONE");
    expect(scrollback).not.toContain("awk 'BEGIN");
  }, 60_000);

  it("stops accepting input once it has exited, and says how it ended", async () => {
    const session = open();
    type(session.sessionId, "exit 3");
    await waitFor("the shell to exit", () => sessions.get(session.sessionId)?.state === "exited");

    const ended = sessions.get(session.sessionId);
    expect(ended?.state).toBe("exited");
    expect(ended?.exitCode).toBe(3);
    expect(ended?.endedAt).not.toBeNull();
    // The last chunk is also the news that it was the last one.
    expect(chunks.filter((chunk) => chunk.sessionId === session.sessionId).at(-1)).toMatchObject({
      state: "exited",
      exitCode: 3
    });
    expect(() => sessions.write(session.sessionId, "ls\r")).toThrow(/has exited/);
  }, 20_000);

  it("refuses a session id it never issued", () => {
    expect(() => sessions.write("trm_nothing", "ls")).toThrow(/not open on this machine/);
  });

  it("will not open an unbounded number of them", () => {
    for (let index = 0; index < 8; index += 1) open();
    expect(() => open()).toThrow(/already has 8 terminals/);
  });
});

describe("ending a session", () => {
  it("kills the whole process tree, not just the shell", async () => {
    const session = open();
    // A child the shell started: closing the session must reach it too, or a
    // stray process keeps running with nobody watching it.
    type(session.sessionId, 'sleep 300 & echo CHILD""_PID=$!');
    await waitFor("the child to start", () => /CHILD_PID=\d+/.test(streamed(session.sessionId)));
    const child = Number(/CHILD_PID=(\d+)/.exec(streamed(session.sessionId))?.[1]);
    expect(Number.isInteger(child)).toBe(true);
    expect(alive(child)).toBe(true);

    await sessions.close(session.sessionId);
    expect(sessions.list(WORKSTREAM_ID)).toHaveLength(0);
    await waitFor("the child to be gone", () => !alive(child));
    expect(alive(child)).toBe(false);
  }, 40_000);

  it("leaves nothing behind when the application quits", async () => {
    const first = open();
    const second = open();
    type(first.sessionId, 'sleep 300 & echo A""_PID=$!');
    type(second.sessionId, 'sleep 300 & echo B""_PID=$!');
    await waitFor(
      "both children to start",
      () => /A_PID=\d+/.test(streamed(first.sessionId)) && /B_PID=\d+/.test(streamed(second.sessionId))
    );
    const children = [
      Number(/A_PID=(\d+)/.exec(streamed(first.sessionId))?.[1]),
      Number(/B_PID=(\d+)/.exec(streamed(second.sessionId))?.[1])
    ];
    expect(children.every((pid) => alive(pid))).toBe(true);

    await sessions.shutdown();

    expect(sessions.list()).toHaveLength(0);
    await waitFor("every child to be gone", () => children.every((pid) => !alive(pid)));
    expect(children.some((pid) => alive(pid))).toBe(false);
  }, 40_000);

  it("does not survive a relaunch, and does not pretend to", async () => {
    open();
    open();
    expect(sessions.list(WORKSTREAM_ID)).toHaveLength(2);
    await sessions.shutdown();

    // The next launch of the application. A PTY cannot outlive the process that
    // owned it, so the honest answer is that there are no sessions at all —
    // never a dead tab presented as live.
    const relaunched = new TerminalSessions({ profile: () => Promise.resolve({}) });
    expect(relaunched.list()).toEqual([]);
    expect(relaunched.list(WORKSTREAM_ID)).toEqual([]);
    // And nothing was written down for it to have read.
    expect(readdirSync(userData).filter((entry) => entry.includes("terminal"))).toEqual([]);
  });
});

describe("the shell and the profile", () => {
  it("uses the user's own shell, interactively but never as a login shell", () => {
    // Not `-l`: the login profile has already been read and layered under the
    // project's values, and running it again here would reverse that (D-041).
    expect(shellFor({ SHELL: "/bin/fish" }, "darwin")).toEqual({ file: "/bin/fish", args: [] });
    expect(shellFor({}, "darwin").file).toBe("/bin/zsh");
    expect(shellFor({}, "linux").file).toBe("/bin/bash");
    expect(shellFor({ COMSPEC: "C:\\cmd.exe" }, "win32").file).toBe("C:\\cmd.exe");
  });

  it("reads only well-formed variables out of a profile, and skips shell bookkeeping", () => {
    const parsed = parseProfile(
      ["EDITOR=nvim", "PWD=/somewhere", "SHLVL=2", "not a variable", "GOPATH=/Users/x/go", "=broken"].join(
        "\n"
      )
    );
    expect(parsed).toEqual({ EDITOR: "nvim", GOPATH: "/Users/x/go" });
  });
});

describe("the entry points the bridge calls", () => {
  const target: WorkspaceTarget = {
    missionId: MISSION_ID,
    workstreamId: WORKSTREAM_ID,
    localId: LOCAL_ID,
    missionBranch: MISSION_BRANCH
  };

  const host = (): WorkspaceHost => ({
    userDataPath: userData,
    repositoryPath: (providerRepoId) => (providerRepoId === LOCAL_ID ? repo : null),
    git: gitExec
  });

  it("opens in the worktree with the terminal environment, and lists what is open", async () => {
    const seen: string[] = [];
    const stop = onTerminalOutput((chunk) => seen.push(chunk.data));

    const session = await openTerminal(target, { kind: "shell", cols: 400, rows: 30 }, host());
    expect(session.workstreamId).toBe(WORKSTREAM_ID);
    expect(listTerminals(WORKSTREAM_ID).map((entry) => entry.sessionId)).toEqual([session.sessionId]);

    await writeUntil(session.sessionId, "pwd\r", () => seen.join("").includes(realpathSync(worktree)));
    await writeUntil(
      session.sessionId,
      'printf "NOVUS%s=%s\\n" DIR "$NOVUS_WORKSPACE_DIR"\r',
      () => /NOVUSDIR=\//.test(seen.join(""))
    );
    stop();

    const said = seen.join("");
    expect(said).toContain(realpathSync(worktree));
    expect(said).toContain(`NOVUSDIR=${worktree}`);

    await shutdownTerminals();
    expect(listTerminals(WORKSTREAM_ID)).toEqual([]);
  }, 30_000);

  it("refuses a repository that is not on this machine", async () => {
    await expect(
      openTerminal({ ...target, localId: "somewhere-else" }, { kind: "shell" }, host())
    ).rejects.toThrow(/another machine/);
  });
});
