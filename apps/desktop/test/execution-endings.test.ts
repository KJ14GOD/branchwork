import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { RunnerEvent } from "@novus/contracts";
import { startTurn, type TurnResult } from "../electron/execution";

/**
 * How a turn is allowed to end (D-109), through the real spawn path.
 *
 * The CLI's final `result` line says how the turn ended, and for a long time
 * only its `is_error` flag was read: a turn that ran out of its turn budget
 * exited 0 and was presented as "Work finished", a stream that died before
 * the result line was presented the same way, and a billing refusal wore the
 * "sign in again" sentence. Each stub below emits one observed ending shape;
 * what is asserted is the exact terminal event a person's room will read.
 */

const MISSION_BRANCH = "novus/m-en12cd34";

let repo: string;
let worktreeRoot: string;
let stubDir: string;
let originalPath: string | undefined;

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

type StubEnding = "max-turns" | "silent-end" | "credit-balance" | "slow-success" | "background-agent";

/** A `claude` that ends the turn one specific way, then exits. */
function installStub(ending: StubEnding): void {
  const script = `#!/usr/bin/env node
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const ENDING = ${JSON.stringify(ending)};
process.stdin.on("data", () => {
  out({ type: "system", subtype: "init", session_id: "stub-endings-1", model: "stub" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Partway through." }] } });
  if (ENDING === "max-turns") {
    out({ type: "result", subtype: "error_max_turns", is_error: true, result: "Reached max turns." });
    process.exit(0);
  }
  if (ENDING === "credit-balance") {
    process.stderr.write("Your credit balance is too low to run this request.\\n");
    process.exit(1);
  }
  if (ENDING === "background-agent") {
    // 2.1.239's own shape (D-202): the model spawns an agent the CLI takes
    // into the background, gets the launch receipt, and ends its turn to
    // wait — a result line with the task still pending. The real CLI then
    // delivers the notification and runs a follow-up turn on the same stdin.
    // This stub makes the hazard observable: it exits the moment stdin
    // closes, so closing on the waiting result loses the follow-up entirely.
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Agent", input: { description: "Count lines" } }] } });
    out({ type: "system", subtype: "task_started", task_id: "task_bg", tool_use_id: "toolu_bg", is_backgrounded: true });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Async agent launched successfully." }] }, tool_use_result: { isAsync: true, status: "async_launched", agentId: "task_bg" } });
    out({ type: "result", subtype: "success", is_error: false, result: "Waiting for the agent." });
    let closed = false;
    process.stdin.on("end", () => { closed = true; });
    setTimeout(() => {
      if (closed) process.exit(0); // the hazard: the follow-up never happens
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      out({ type: "system", subtype: "task_notification", task_id: "task_bg", tool_use_id: "toolu_bg", status: "completed", summary: "2", usage: { total_tokens: 100, tool_uses: 1, duration_ms: 300 } });
      out({ type: "assistant", message: { content: [{ type: "text", text: "notes.txt has 2 lines." }] } });
      out({ type: "result", subtype: "success", is_error: false, result: "Done." });
      process.stdin.on("end", () => process.exit(0));
    }, 400);
    return;
  }
  if (ENDING === "slow-success") {
    // A long quiet tool call: nothing on stdout for a while, then done.
    setTimeout(() => {
      out({ type: "result", subtype: "success", is_error: false, result: "Done." });
      process.exit(0);
    }, 400);
    return;
  }
  // silent-end: the stream just stops, cleanly, with no result line at all.
  process.exit(0);
});
setTimeout(() => process.exit(3), 20000).unref();
`;
  const target = join(stubDir, "claude");
  writeFileSync(target, script);
  chmodSync(target, 0o755);
}

async function run(heartbeatMs?: number): Promise<{ events: RunnerEvent[]; result: TurnResult }> {
  const events: RunnerEvent[] = [];
  const turn = startTurn({
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    executionId: "exe_endings",
    missionId: "msn_endingstest",
    workstreamId: "wst_endings",
    repositoryPath: repo,
    worktreeRoot,
    missionBranch: MISSION_BRANCH,
    direction: "Keep going until done",
    model: "claude-fable-5",
    effort: "high",
    resumeSessionId: null,
    announceStart: true,
    fakeHarness: false,
    secretValues: () => [],
    emit: (event) => events.push(event)
  });
  const result = await turn.finished;
  return { events, result };
}

const terminalOf = (events: RunnerEvent[], result: TurnResult) =>
  [...events, result.terminal].find((event) =>
    ["execution.completed", "execution.failed", "execution.interrupted", "execution.stopped"].includes(
      event.kind
    )
  ) ?? result.terminal;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-endings-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "novus-endings-worktrees-"));
  stubDir = mkdtempSync(join(tmpdir(), "novus-endings-bin-"));
  mkdirSync(stubDir, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
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

describe("how a turn is allowed to end (D-109)", () => {
  it("a turn that ran out of its turn budget is interrupted and resumable — never 'Work finished'", async () => {
    installStub("max-turns");
    const { events, result } = await run();
    const terminal = terminalOf(events, result);
    expect(terminal.kind).toBe("execution.interrupted");
    expect((terminal.payload as { reason: string }).reason).toContain("turn budget");
    expect((terminal.payload as { reason: string }).reason).toContain("continue");
    // The session survives, so directing again genuinely continues.
    expect(result.sessionId).toBe("stub-endings-1");
  }, 30_000);

  it("a stream that ends without a result line is interrupted — a missing outcome is not a success", async () => {
    installStub("silent-end");
    const { events, result } = await run();
    const terminal = terminalOf(events, result);
    expect(terminal.kind).toBe("execution.interrupted");
    expect((terminal.payload as { reason: string }).reason).toContain("without reporting an outcome");
  }, 30_000);

  it("states its pulse while the process is alive, and stops when the turn ends (D-114)", async () => {
    installStub("slow-success");
    const { events, result } = await run(50);
    expect(terminalOf(events, result).kind).toBe("execution.completed");
    const pulses = events.filter((event) => event.kind === "execution.heartbeat").length;
    // A 400ms quiet stretch at a 50ms pulse: several beats, exact count owed
    // to nobody — the claim is "alive says so", not a metronome.
    expect(pulses).toBeGreaterThanOrEqual(2);
    // And the pulse died with the turn: waiting another stretch adds none.
    await new Promise((settle) => setTimeout(settle, 200));
    expect(events.filter((event) => event.kind === "execution.heartbeat").length).toBe(pulses);
  }, 30_000);

  it("keeps stdin open while an agent works in the background, so the follow-up turn arrives (D-202)", async () => {
    installStub("background-agent");
    const { events, result } = await run();
    // The follow-up turn's words and the worker's real end both reached the
    // room — which they cannot if stdin closed on the waiting result.
    const texts = events.filter((event) => event.kind === "harness.text").map((event) => (event.payload as { text: string }).text);
    expect(texts).toContain("notes.txt has 2 lines.");
    const ended = events.find((event) => event.kind === "harness.worker.ended");
    expect(ended?.payload).toEqual({
      toolUseId: "toolu_bg",
      failed: false,
      report: "2",
      usage: { totalTokens: 100, toolUses: 1, durationMs: 300 }
    });
    // And the turn still ended cleanly once nothing was pending.
    expect(terminalOf(events, result).kind).toBe("execution.completed");
  }, 30_000);

  it("a billing refusal names money, not sign-in", async () => {
    installStub("credit-balance");
    const { events, result } = await run();
    const terminal = terminalOf(events, result);
    expect(terminal.kind).toBe("execution.failed");
    const payload = terminal.payload as { classification: string; reason: string };
    expect(payload.classification).toBe("billing");
    expect(payload.reason).toContain("credit balance");
    expect(payload.reason).not.toContain("Sign in");
  }, 30_000);
});
