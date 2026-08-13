import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { RunnerEvent } from "@novus/contracts";
import {
  projectInstructionsFile,
  startTurn,
  type RunningTurn,
  type TurnResult
} from "../electron/execution";

/**
 * The approval protocol through the **real spawn path** (D-056).
 *
 * Everything here goes through `startTurn`'s production branch: a real child
 * process, real argv, real stdin, real stdout, the real parser. What is
 * replaced is only the model — `claude` on PATH is a stub that speaks the
 * protocol that `claude 2.1.221` was observed speaking on 2026-08-04.
 *
 * This is the file that pins the permission policy. The scripted-harness tests
 * elsewhere never spawn anything, so they cannot see an argv; the live suite
 * spends real quota and is opt-in. A stub on PATH is the only place a
 * deterministic run can assert that Novus asked for the flags it says it asks
 * for — which is the whole of the guarantee, because with the wrong flags the
 * CLI never asks anybody and every other test in this slice still passes.
 */

const MISSION_BRANCH = "novus/m-ap12cd34";
const MISSION_ID = "msn_approvaltest";
/** Worktrees are keyed by the lane, not the mission (D-074). */
const WORKSTREAM_ID = "wst_approval";

let repo: string;
let worktreeRoot: string;
let stubDir: string;
let argvPath: string;
let argvLogPath: string;
let stdinPath: string;
let originalPath: string | undefined;

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

type StubMode = "approval" | "ignores-interrupt" | "unknown-option" | "refuses-optional";

/**
 * A `claude` that speaks the stdio control protocol.
 *
 * The shapes below are copied from the probe transcript: a `system/init`, an
 * `assistant/tool_use`, a `control_request` with `subtype: "can_use_tool"` that
 * blocks until an answer arrives on stdin, and a final `result`. It exits when
 * stdin closes, which is what the real CLI does too.
 */
function installStub(mode: StubMode): void {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const ARGV = ${JSON.stringify(argvPath)};
const STDIN_LOG = ${JSON.stringify(stdinPath)};
const MODE = ${JSON.stringify(mode)};
const ARGV_LOG = ${JSON.stringify(argvLogPath)};
const args = process.argv.slice(2);
fs.writeFileSync(ARGV, JSON.stringify(args));
const attempts = fs.existsSync(ARGV_LOG) ? JSON.parse(fs.readFileSync(ARGV_LOG, "utf8")) : [];
attempts.push(args);
fs.writeFileSync(ARGV_LOG, JSON.stringify(attempts));
fs.writeFileSync(STDIN_LOG, "");

if (MODE === "unknown-option") {
  process.stderr.write("error: unknown option '--permission-prompt-tool'\\n");
  process.exit(1);
}

// An older CLI: it knows how to route permission, and has never heard of
// subagent forwarding. It refuses by name, which is what Novus reads.
if (MODE === "refuses-optional" && args.includes("--forward-subagent-text")) {
  process.stderr.write("error: unknown option '--forward-subagent-text'\\n");
  process.exit(1);
}

const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const target = process.cwd() + "/APPROVED.md";
let requested = false;
let buffer = "";

process.stdin.on("data", (chunk) => {
  fs.appendFileSync(STDIN_LOG, chunk.toString());
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) handle(line);
});
process.stdin.on("end", () => process.exit(0));

function handle(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === "user" && !requested) {
    requested = true;
    out({ type: "system", subtype: "init", session_id: "stub-session-1", model: "stub" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "About to write." }] } });
    out({
      type: "control_request",
      request_id: "stub-request-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        display_name: "Write",
        input: { file_path: target, content: "approved" },
        description: "APPROVED.md",
        permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        tool_use_id: "toolu_stub_1"
      }
    });
    return;
  }

  if (msg.type === "control_response" && msg.response && msg.response.request_id === "stub-request-1") {
    const decision = msg.response.response || {};
    if (decision.behavior === "allow") {
      fs.writeFileSync(target, "approved\\n");
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_stub_1", content: "written" }] } });
    } else {
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_stub_1", content: String(decision.message || ""), is_error: true }] } });
    }
    out({ type: "result", subtype: "success", is_error: false, result: "Done." });
    return;
  }

  if (msg.type === "control_request" && msg.request && msg.request.subtype === "interrupt") {
    if (MODE === "ignores-interrupt") return; // deliberately deaf; the kill is the point
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [], cancelled: [] } } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Interrupted." });
  }
}

// Never hang a test run for ever, whatever happens.
setTimeout(() => process.exit(3), 30000).unref();
`;
  const target = join(stubDir, "claude");
  writeFileSync(target, script);
  chmodSync(target, 0o755);
}

interface RunningFixture {
  events: RunnerEvent[];
  turn: RunningTurn;
  finished: Promise<TurnResult>;
}

function begin(overrides: Partial<Parameters<typeof startTurn>[0]> = {}): RunningFixture {
  const events: RunnerEvent[] = [];
  const turn = startTurn({
    executionId: "exe_approval",
    missionId: MISSION_ID,
    workstreamId: WORKSTREAM_ID,
    repositoryPath: repo,
    worktreeRoot,
    missionBranch: MISSION_BRANCH,
    direction: "Write APPROVED.md",
    model: "claude-fable-5",
    effort: "high",
    resumeSessionId: null,
    announceStart: true,
    fakeHarness: false,
    secretValues: () => [],
    emit: (event) => events.push(event),
    ...overrides
  });
  return { events, turn, finished: turn.finished };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const argv = (): string[] => JSON.parse(readFileSync(argvPath, "utf8")) as string[];

/** Every spawn of the stub, in order — so a retry can be told from a first try. */
const argvAttempts = (): string[][] => JSON.parse(readFileSync(argvLogPath, "utf8")) as string[][];

function payloadOf<K extends RunnerEvent["kind"]>(
  events: RunnerEvent[],
  kind: K
): Extract<RunnerEvent, { kind: K }>["payload"] | undefined {
  const found = events.find((event) => event.kind === kind);
  return found ? (found.payload as Extract<RunnerEvent, { kind: K }>["payload"]) : undefined;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-approval-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "novus-approval-worktrees-"));
  stubDir = mkdtempSync(join(tmpdir(), "novus-approval-bin-"));
  mkdirSync(stubDir, { recursive: true });
  argvPath = join(stubDir, "argv.json");
  argvLogPath = join(stubDir, "argv-log.json");
  stdinPath = join(stubDir, "stdin.log");

  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);

  // `harnessEnv` builds PATH from this process's, so the stub is found ahead of
  // any real installation — and the environment the turn constructs is still
  // the real one (D-041), which is part of what is being exercised.
  originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}${delimiter}${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

describe("the permission policy Novus pins", () => {
  it("asks the harness to route permission to Novus, and inherits nobody's settings", async () => {
    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    running.turn.respondApproval("stub-request-1", "approve", null);
    await running.finished;

    const args = argv();
    const pairOf = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

    // The control channel itself.
    expect(pairOf("--permission-prompt-tool")).toBe("stdio");
    expect(pairOf("--input-format")).toBe("stream-json");
    expect(pairOf("--output-format")).toBe("stream-json");

    // The two flags the guarantee rests on. Without the first, a repository's
    // own committed `.claude/settings.json` decides whether anyone is asked;
    // without the second, an inherited default does.
    expect(pairOf("--setting-sources")).toBe("");
    expect(pairOf("--permission-mode")).toBe("manual");

    // And the things that would quietly give the permission away.
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--allowed-tools");

    // The direction is not an argument any more: it travels on stdin, because
    // stdin has to stay open to carry the answer back.
    expect(args).not.toContain("Write APPROVED.md");
    const written = readFileSync(stdinPath, "utf8");
    expect(JSON.parse(written.split("\n")[0] ?? "{}")).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Write APPROVED.md" }] }
    });
  }, 40_000);

  it("a plan-profile turn runs the CLI's own plan mode; every other profile stays manual (D-115)", async () => {
    // Plan is the one profile that changes the flag: the CLI's plan mode
    // tells the model to propose. The router still denies the privileged act
    // the stub asks for — the flag is behaviour, the router is the guarantee —
    // so the turn completes with nothing written and the denial recorded.
    installStub("approval");
    const plan = begin({ permissionProfile: "plan" });
    const planResult = await plan.finished;
    const pairOf = (flag: string): string | undefined => {
      const args = argv();
      return args[args.indexOf(flag) + 1];
    };
    expect(pairOf("--permission-mode")).toBe("plan");
    expect(pairOf("--setting-sources")).toBe("");
    expect(pairOf("--permission-prompt-tool")).toBe("stdio");
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(false);
    expect(planResult.terminal.kind).toBe("execution.completed");
    expect(payloadOf(plan.events, "approval.policy")).toMatchObject({
      decision: "denied",
      profile: "plan"
    });

    // A trusting profile never becomes a CLI mode: the harness still asks on
    // this channel, and Novus answers. `dont_ask` runs under `manual`.
    installStub("approval");
    const trusted = begin({ permissionProfile: "dont_ask" });
    await trusted.finished;
    expect(pairOf("--permission-mode")).toBe("manual");
    const args = argv();
    expect(args).not.toContain("dontAsk");
    expect(args).not.toContain("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(true);
  }, 40_000);

  it("asks for the harness's own subagents to be forwarded, and runs without them if it must", async () => {
    // Asked for: a `Task` that runs for minutes is otherwise one tool row and
    // then silence, which reads as a wedged turn.
    installStub("approval");
    const first = begin();
    await waitFor("the approval to arrive", () => first.turn.pendingApprovals().length > 0);
    first.turn.respondApproval("stub-request-1", "approve", null);
    await first.finished;
    expect(argv()).toContain("--forward-subagent-text");

    // And done without, on a CLI that has never heard of it. The distinction
    // that matters: an optional flag degrades, the permission flags never do.
    rmSync(join(worktreeRoot, WORKSTREAM_ID), { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
    rmSync(argvLogPath, { force: true });
    installStub("refuses-optional");
    const second = begin();
    await waitFor("the retry's approval", () => second.turn.pendingApprovals().length > 0, 20_000);
    second.turn.respondApproval("stub-request-1", "approve", null);
    const result = await second.finished;

    const attempts = argvAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toContain("--forward-subagent-text");
    expect(attempts[1]).not.toContain("--forward-subagent-text");
    // The retry is the same supervised turn: nothing about the permission
    // policy moved to buy the second attempt.
    expect(attempts[1]).toContain("--permission-prompt-tool");
    expect(attempts[1]?.[attempts[1].indexOf("--permission-mode") + 1]).toBe("manual");
    expect(result.terminal.kind).toBe("execution.completed");
  }, 60_000);

  it("hands the project its own instructions back, which pinning the settings had cost", async () => {
    // `--setting-sources ""` is what stops a committed settings file deciding
    // who gets asked, and it also stopped `CLAUDE.md` loading — so a project
    // could no longer tell the agent its own conventions. This is that,
    // restored without re-admitting settings (D-064).
    // Committed to the mission branch, because that is what a project's
    // instructions are: repository content, checked out with the worktree.
    writeFileSync(join(repo, "CLAUDE.md"), "# House rules\n\nAlways use tabs.\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "rules"]);
    await git(repo, ["branch", "-f", MISSION_BRANCH, "HEAD"]);

    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    running.turn.respondApproval("stub-request-1", "approve", null);
    await running.finished;

    const args = argv();
    const worktree = join(worktreeRoot, WORKSTREAM_ID);
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe(
      realpathSync(join(worktree, "CLAUDE.md"))
    );
    // And it did not buy that back by loosening the thing that cost it.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("manual");
  }, 40_000);

  it("passes nothing when the project has no instructions, or they leave the worktree", async () => {
    const worktree = join(worktreeRoot, WORKSTREAM_ID);
    mkdirSync(worktree, { recursive: true });

    // Absent: the ordinary case, and the flag is simply not there.
    expect(projectInstructionsFile(worktree)).toBeNull();

    // A symlink out is an ordinary-looking relative path right up until
    // something reads it, which is why the check follows links and then asks
    // where it landed.
    const outside = mkdtempSync(join(tmpdir(), "novus-outside-"));
    writeFileSync(join(outside, "secrets.md"), "not the project's instructions\n");
    symlinkSync(join(outside, "secrets.md"), join(worktree, "CLAUDE.md"));
    expect(projectInstructionsFile(worktree)).toBeNull();
    rmSync(join(worktree, "CLAUDE.md"));

    // A symlink that stays inside is followed: this repository's own CLAUDE.md
    // is one, pointing at AGENTS.md beside it.
    writeFileSync(join(worktree, "AGENTS.md"), "# House rules\n");
    symlinkSync(join(worktree, "AGENTS.md"), join(worktree, "CLAUDE.md"));
    expect(projectInstructionsFile(worktree)).toBe(realpathSync(join(worktree, "AGENTS.md")));
    rmSync(join(worktree, "CLAUDE.md"));

    // And a generated one does not become the whole prompt.
    writeFileSync(join(worktree, "CLAUDE.md"), "x".repeat(200_000));
    expect(projectInstructionsFile(worktree)).toBeNull();
  });

  it("still passes --resume, so approval routing did not cost session continuity", async () => {
    installStub("approval");
    const running = begin({ resumeSessionId: "stub-session-1" });
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    running.turn.respondApproval("stub-request-1", "approve", null);
    await running.finished;
    const args = argv();
    expect(args[args.indexOf("--resume") + 1]).toBe("stub-session-1");
    expect(args).not.toContain("--session-id");
  }, 40_000);

  it("carries an enabled skill as a composed skills-only directory, and exactly the approved bytes (D-118)", async () => {
    // The skill is repository content on the mission branch, like CLAUDE.md.
    const body = "---\nname: zephyr-codes\ndescription: Codewords.\n---\n\nThe codeword is XILOPHONE-72.\n";
    mkdirSync(join(repo, ".claude", "skills", "zephyr-codes"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "zephyr-codes", "SKILL.md"), body);
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "skill"]);
    await git(repo, ["branch", "-f", MISSION_BRANCH, "HEAD"]);
    const digest = createHash("sha256").update(body).digest("hex");

    installStub("approval");
    const running = begin({ skills: [{ name: "zephyr-codes", digest }] });
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);

    // While the turn is blocked, the composed directory is what the CLI was
    // handed: Novus's own staging, never the worktree — and it contains the
    // plugin manifest Novus authored, the approved bytes, and *nothing else* —
    // no hooks, no .mcp.json, no commands, which is the structural half of
    // D-072's refusal still standing.
    const args = argv();
    const dir = args[args.indexOf("--plugin-dir") + 1] as string;
    expect(dir).toContain(".skills-staging");
    expect(dir.startsWith(join(worktreeRoot, WORKSTREAM_ID))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([".claude-plugin", "skills"]);
    expect(readdirSync(join(dir, ".claude-plugin"))).toEqual(["plugin.json"]);
    expect(readdirSync(join(dir, "skills"))).toEqual(["zephyr-codes"]);
    expect(readdirSync(join(dir, "skills", "zephyr-codes"))).toEqual(["SKILL.md"]);
    expect(readFileSync(join(dir, "skills", "zephyr-codes", "SKILL.md"), "utf8")).toBe(body);
    // The pinned policy is untouched beside it.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");

    running.turn.respondApproval("stub-request-1", "approve", null);
    await running.finished;
    // The staging is the turn's own, and it leaves with the turn.
    expect(existsSync(dir)).toBe(false);
    // The turn's record states what it carried.
    expect(payloadOf(running.events, "execution.running")).toMatchObject({
      skills: ["zephyr-codes"],
      skillsDropped: []
    });
  }, 40_000);

  it("drops a skill whose bytes changed since it was enabled, by name, and passes no directory", async () => {
    const body = "---\nname: zephyr-codes\n---\n\nRewritten since the review.\n";
    mkdirSync(join(repo, ".claude", "skills", "zephyr-codes"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "zephyr-codes", "SKILL.md"), body);
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "skill"]);
    await git(repo, ["branch", "-f", MISSION_BRANCH, "HEAD"]);

    installStub("approval");
    // Enabled at a digest the worktree no longer holds: the approval names
    // bytes nobody can produce, so nothing is loaded — never the new bytes.
    const running = begin({ skills: [{ name: "zephyr-codes", digest: "0".repeat(64) }] });
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    running.turn.respondApproval("stub-request-1", "deny", null);
    await running.finished;

    expect(argv()).not.toContain("--plugin-dir");
    expect(payloadOf(running.events, "execution.running")).toMatchObject({
      skills: [],
      skillsDropped: [{ name: "zephyr-codes", reason: "changed since it was enabled" }]
    });
  }, 40_000);
});

describe("answering one question", () => {
  it("reports the request, allows it, and the harness actually does the work", async () => {
    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);

    const requested = payloadOf(running.events, "approval.requested");
    expect(requested?.requestId).toBe("stub-request-1");
    expect(requested?.toolName).toBe("Write");
    expect(requested?.toolUseId).toBe("toolu_stub_1");
    // The path is masked and the file body is nowhere in it.
    expect(requested?.summary).toContain("the mission worktree");
    expect(JSON.stringify(running.events)).not.toContain("approved");

    expect(running.turn.respondApproval("stub-request-1", "approve", null)).toBe(true);
    const result = await running.finished;
    expect(result.terminal.kind).toBe("execution.completed");
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(true);
    // Nothing is left waiting, and no cancellation was manufactured.
    expect(running.turn.pendingApprovals()).toEqual([]);
    expect(running.events.some((event) => event.kind === "approval.cancelled")).toBe(false);
  }, 40_000);

  it("denies with the responder's words, writes nothing, and keeps the session", async () => {
    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    expect(running.turn.respondApproval("stub-request-1", "deny", "Not that file.")).toBe(true);
    const result = await running.finished;

    // The harness was told why, in the responder's own words.
    expect(readFileSync(stdinPath, "utf8")).toContain("Not that file.");
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(false);
    // A denial is not a failure, and it does not cost the conversation: the
    // session comes back so the next direction resumes it.
    expect(result.terminal.kind).toBe("execution.completed");
    expect(result.sessionId).toBe("stub-session-1");
  }, 40_000);

  it("answers once: a second decision changes nothing", async () => {
    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    expect(running.turn.respondApproval("stub-request-1", "approve", null)).toBe(true);
    // The duplicate finds nothing pending and writes nothing to the harness.
    expect(running.turn.respondApproval("stub-request-1", "deny", "changed my mind")).toBe(false);
    await running.finished;
    expect(readFileSync(stdinPath, "utf8")).not.toContain("changed my mind");
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(true);
  }, 40_000);

  it("refuses a decision for a question it was never asked", async () => {
    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);
    expect(running.turn.respondApproval("some-other-request", "approve", null)).toBe(false);
    running.turn.respondApproval("stub-request-1", "approve", null);
    await running.finished;
  }, 40_000);
});

describe("stopping a turn that is asking", () => {
  it("interrupts through the protocol, says so, and cancels the open question", async () => {
    installStub("approval");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);

    running.turn.stop("Stopped by a participant.");
    const result = await running.finished;

    expect(result.terminal.kind).toBe("execution.stopped");
    const stopped = result.terminal as Extract<RunnerEvent, { kind: "execution.stopped" }>;
    // The graceful path, which is what keeps the session resumable.
    expect(stopped.payload.via).toBe("protocol_interrupt");
    expect(readFileSync(stdinPath, "utf8")).toContain('"interrupt"');
    expect(result.sessionId).toBe("stub-session-1");

    // The question is settled rather than left pending for ever.
    const cancelled = payloadOf(running.events, "approval.cancelled");
    expect(cancelled?.requestId).toBe("stub-request-1");
    expect(running.turn.pendingApprovals()).toEqual([]);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(false);
  }, 40_000);

  it("kills a harness that ignores the interrupt, within a bounded wait", async () => {
    installStub("ignores-interrupt");
    const running = begin();
    await waitFor("the approval to arrive", () => running.turn.pendingApprovals().length > 0);

    const askedAt = Date.now();
    running.turn.stop("Stopped by a participant.");
    const result = await running.finished;
    const took = Date.now() - askedAt;

    expect(result.terminal.kind).toBe("execution.stopped");
    const stopped = result.terminal as Extract<RunnerEvent, { kind: "execution.stopped" }>;
    // Asked first, and then not asked: a Stop is not a request.
    expect(readFileSync(stdinPath, "utf8")).toContain('"interrupt"');
    expect(stopped.payload.via).toBe("process_signal");
    // Bounded: the grace period plus the kill, not the stub's own 30s ceiling.
    expect(took).toBeLessThan(12_000);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "APPROVED.md"))).toBe(false);
  }, 40_000);
});

describe("a harness that cannot route approvals", () => {
  it("fails the turn by name rather than running unsupervised", async () => {
    installStub("unknown-option");
    const running = begin();
    const result = await running.finished;

    expect(result.terminal.kind).toBe("execution.failed");
    const failed = result.terminal as Extract<RunnerEvent, { kind: "execution.failed" }>;
    expect(failed.payload.classification).toBe("unsupported_harness");
    expect(failed.payload.reason).toContain("approvals");
    // Exactly one spawn: the resume retry is not the answer to a refused flag.
    expect(argv()).toContain("--permission-prompt-tool");
  }, 40_000);
});
