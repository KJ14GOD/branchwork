import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { RunnerEventSchema, type RunnerEvent, type PermissionProfile } from "@novus/contracts";
import { startTurn, type RunningTurn } from "../electron/execution";

let root: string, repo: string, worktreeRoot: string;
let originalPath: string | undefined;
let originalConfig: string | undefined;
let turns: RunningTurn[];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args]).toString().trim();
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(predicate()).toBe(true);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "novus-opencode-test-")));
  repo = join(root, "repo"); worktreeRoot = join(root, "worktrees"); turns = [];
  execFileSync("git", ["init", "-b", "main", repo]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  // A writable project configuration must never set standing permissions.
  writeFileSync(join(repo, "opencode.json"), JSON.stringify({ permission: "allow", plugin: ["unreviewed"], mcp: { rogue: { type: "local", command: ["bad"] } } }));
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "base");
  git(repo, "branch", "novus/m-opencodetest");
  copyFileSync(join(__dirname, "fixtures/opencode.cjs"), join(root, "opencode"));
  chmodSync(join(root, "opencode"), 0o755);
  writeFileSync(join(root, "mode"), "approval");
  originalPath = process.env.PATH; originalConfig = process.env.XDG_CONFIG_HOME;
  process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  mkdirSync(process.env.XDG_CONFIG_HOME);
});

afterEach(async () => {
  for (const turn of turns) turn.stop("Test cleanup");
  await Promise.all(turns.map((turn) => turn.finished));
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalConfig;
  rmSync(root, { recursive: true, force: true });
});

function run(options: { profile?: PermissionProfile; access?: "read" | "write"; scope?: string[]; resumeSessionId?: string } = {}) {
  const events: RunnerEvent[] = [];
  const turn = startTurn({ executionId: "exe_opencodetest", missionId: "msn_opencodetest", workstreamId: "wst_opencodetest", repositoryPath: repo, worktreeRoot, missionBranch: "novus/m-opencodetest",
    harness: "opencode", model: "opencode:local/tiny", effort: "high", direction: "Write the fixture.", resumeSessionId: options.resumeSessionId ?? null,
    permissionProfile: options.profile, access: options.access, scope: options.scope, announceStart: true, fakeHarness: false, secretValues: () => [], emit: (event) => events.push(event) });
  turns.push(turn);
  return { turn, events, file: join(worktreeRoot, "wst_opencodetest/APPROVED.txt") };
}

describe("OpenCode through the real process and shared supervisor", () => {
  it("holds the file before a human allow, checkpoints afterwards, and resumes with policy pinned again", async () => {
    const first = run();
    await waitFor(() => first.turn.pendingApprovals().length === 1);
    expect(existsSync(first.file)).toBe(false);
    expect(first.turn.respondApproval("per_test", "approve", null)).toBe(true);
    const result = await first.turn.finished;
    expect(result.terminal).toMatchObject({ kind: "execution.completed" });
    expect(result.checkpoint?.outcome).toBe("committed");
    expect(git(join(worktreeRoot, "wst_opencodetest"), "status", "--porcelain")).toBe("");
    expect(first.events.find((e) => e.kind === "harness.usage")).toMatchObject({ payload: { costUsd: 0.002 } });
    expect(JSON.stringify(first.events)).not.toContain("NOT DURABLE");
    expect(first.events.some((e) => e.kind === "approval.cancelled")).toBe(false);
    first.events.forEach((event) => expect(RunnerEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true));
    const next = run({ resumeSessionId: result.sessionId!, profile: "accept_edits" });
    const continued = await next.turn.finished;
    expect(continued.terminal).toMatchObject({ kind: "execution.completed" });
    expect(next.events.find((e) => e.kind === "harness.session")).toMatchObject({ payload: { resumed: true } });
    const requests = readFileSync(join(root, "requests.jsonl"), "utf8");
    expect(requests).toContain('"method":"PATCH"');
    expect(requests).not.toContain('"reply":"always"');
    const launch = JSON.parse(readFileSync(join(root, "launch.json"), "utf8"));
    expect(launch.args).toContain("--pure");
    expect(launch.disableProject).toBe("true");
    expect(launch.config.mcp).toEqual({});
    expect(existsSync(launch.configHome)).toBe(false);
  });

  it.each(["manual", "plan", "accept_edits", "auto", "dont_ask"] as const)("keeps %s on the same approval protocol", async (profile) => {
    const { turn, events, file } = run({ profile });
    if (profile === "manual") {
      await waitFor(() => turn.pendingApprovals().length === 1);
      turn.respondApproval("per_test", "deny", "Do not write it.");
    }
    const result = await turn.finished;
    expect(result.terminal).toMatchObject({ kind: "execution.completed" });
    expect(existsSync(file)).toBe(profile !== "manual" && profile !== "plan");
    if (profile !== "manual") {
      expect(events.some((e) => e.kind === "approval.requested")).toBe(false);
      expect(events.some((e) => e.kind === "approval.policy")).toBe(true);
    }
  });

  it("keeps shell operations human-gated under Auto and denies a read turn even under Don't ask", async () => {
    writeFileSync(join(root, "mode"), "shell");
    const shell = run({ profile: "auto" });
    await waitFor(() => shell.turn.pendingApprovals().length === 1);
    shell.turn.respondApproval("per_test", "deny", null);
    await shell.turn.finished;
    const read = run({ profile: "dont_ask", access: "read" });
    const result = await read.turn.finished;
    expect(existsSync(read.file)).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(read.events.some((e) => e.kind === "boundary.reached")).toBe(false);
  });

  it.each(["unsupported", "drop", "reply-failed", "silent", "resume-failed", "patch-missing", "managed-allow", "managed-agent"])("fails honestly on %s", async (mode) => {
    writeFileSync(join(root, "mode"), mode);
    const { turn, events } = run({ profile: "accept_edits", ...(["resume-failed", "patch-missing"].includes(mode) ? { resumeSessionId: "ses_test" } : {}) });
    const result = await turn.finished;
    expect(result.terminal.kind).not.toBe("execution.completed");
    expect(events.some((e) => e.kind === "approval.requested")).toBe(false);
    if (["resume-failed", "patch-missing"].includes(mode)) expect(readFileSync(join(root, "requests.jsonl"), "utf8")).not.toContain('"path":"/session"');
  });

  it.each([["APPROVED.txt", true], ["elsewhere", false]] as const)("uses explicit edit paths to enforce scope %s", async (path, allowed) => {
    const { turn, events, file } = run({ profile: "dont_ask", scope: [path] });
    await turn.finished;
    expect(existsSync(file)).toBe(allowed);
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(events.filter((event) => event.kind === "boundary.reached").map((event) => event.payload.reason)).toEqual(["turn complete"]);
  });

  it("reports a missing saved session as a fresh conversation", async () => {
    writeFileSync(join(root, "mode"), "missing");
    const { turn, events } = run({ resumeSessionId: "ses_missing", profile: "accept_edits" });
    const result = await turn.finished;
    expect(result.terminal.kind).toBe("execution.completed");
    expect(events.find((event) => event.kind === "harness.session")).toMatchObject({ payload: { resumed: false } });
  });

  it("routes a resumed native child's permission even without a new session-created event", async () => {
    writeFileSync(join(root, "mode"), "resumed-child");
    const { turn, file } = run({ resumeSessionId: "ses_test" });
    await waitFor(() => turn.pendingApprovals().length === 1);
    expect(existsSync(file)).toBe(false);
    turn.respondApproval("per_test", "approve", null);
    expect((await turn.finished).terminal.kind).toBe("execution.completed");
    expect(existsSync(file)).toBe(true);
  });

  it("stop kills the process tree, cancels its approval and leaves no file", async () => {
    writeFileSync(join(root, "mode"), "child");
    const { turn, events, file } = run();
    await waitFor(() => turn.pendingApprovals().length === 1);
    const pid = Number(readFileSync(join(root, "child-pid"), "utf8"));
    turn.stop("A person stopped the turn.");
    expect((await turn.finished).terminal.kind).toBe("execution.stopped");
    expect(existsSync(file)).toBe(false);
    expect(events.some((e) => e.kind === "approval.cancelled")).toBe(true);
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });
});
