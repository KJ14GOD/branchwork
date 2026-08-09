import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@novus/contracts";
import { startTurn, type TurnResult } from "../electron/execution";

/**
 * One turn end to end through the deterministic harness: the same worktree,
 * the same parser, the same real git checkpoint the live path uses, with only
 * the model call replaced. What is being proved is that a turn always ends
 * with a named outcome and that nothing it reports names this machine.
 */

const MISSION_BRANCH = "novus/m-ab12cd34";
const MISSION_ID = "msn_testexecution";
/** Worktrees are keyed by the lane, not the mission (D-074). */
const WORKSTREAM_ID = "wst_execution";

let repo: string;
let worktreeRoot: string;

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

interface Turn {
  events: RunnerEvent[];
  result: TurnResult;
}

async function runFakeTurn(
  overrides: Partial<Parameters<typeof startTurn>[0]> = {},
  observe?: (event: RunnerEvent, stop: (reason: string) => void) => void
): Promise<Turn> {
  const events: RunnerEvent[] = [];
  const running = startTurn({
    executionId: "exe_test",
    missionId: MISSION_ID,
    workstreamId: WORKSTREAM_ID,
    repositoryPath: repo,
    worktreeRoot,
    missionBranch: MISSION_BRANCH,
    direction: "Add a health check endpoint",
    model: "claude-fable-5",
    effort: "high",
    resumeSessionId: null,
    announceStart: true,
    fakeHarness: true,
    secretValues: () => [],
    emit: (event) => {
      events.push(event);
      observe?.(event, (reason) => running.stop(reason));
    },
    ...overrides
  });
  return { events, result: await running.finished };
}

function payloadOf<K extends RunnerEvent["kind"]>(
  events: RunnerEvent[],
  kind: K
): Extract<RunnerEvent, { kind: K }>["payload"] | undefined {
  const found = events.find((event) => event.kind === kind);
  return found ? (found.payload as Extract<RunnerEvent, { kind: K }>["payload"]) : undefined;
}

/** Any string that would tell a reader where this machine keeps its files. */
function absolutePaths(events: RunnerEvent[]): string[] {
  const offenders: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (/(^|[\s"'(])(\/(Users|home|private|var|tmp|opt)\/)/.test(value) || /^([A-Za-z]:\\)/.test(value)) {
        offenders.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
  };
  for (const event of events) walk(event.payload);
  return offenders;
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-turn-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "novus-turn-worktrees-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
});

describe("a complete turn", () => {
  it("reports the lifecycle, the boundary, and a committed checkpoint", async () => {
    const { events, result } = await runFakeTurn();
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("execution.starting");
    expect(kinds).toContain("execution.running");
    expect(kinds).toContain("harness.session");
    expect(kinds).toContain("harness.text");
    expect(kinds).toContain("harness.tool");

    // The boundary is declared once the harness has actually stopped working,
    // and before anything terminal: a pending handoff waits for exactly this.
    expect(kinds.indexOf("boundary.reached")).toBeGreaterThan(kinds.indexOf("harness.text"));
    expect(kinds.indexOf("boundary.reached")).toBeLessThan(kinds.indexOf("workspace.checkpoint"));
    expect(payloadOf(events, "boundary.reached")).toEqual({ reason: "turn complete" });

    const checkpoint = payloadOf(events, "workspace.checkpoint");
    expect(checkpoint?.outcome).toBe("committed");
    expect(checkpoint?.branch).toBe(MISSION_BRANCH);
    expect(checkpoint?.files.map((file) => file.path)).toEqual(["NOVUS_FAKE_TURN.md"]);
    expect(result.terminal.kind).toBe("execution.completed");

    // The commit is real, on the mission branch, attributed to Novus.
    const log = await git(repo, ["log", "-1", "--format=%s%n%an", MISSION_BRANCH]);
    expect(log).toContain("Checkpoint: Add a health check endpoint");
    expect(log).toContain("Novus");
  });

  it("names no absolute local path in anything it reports", async () => {
    const { events } = await runFakeTurn();
    expect(absolutePaths(events)).toEqual([]);
    // The scripted harness deliberately hands the parser an absolute path.
    expect(payloadOf(events, "harness.tool")?.detail).toBe("the mission worktree/NOVUS_FAKE_TURN.md");
  });

  it("still checkpoints when the turn changed nothing", async () => {
    await runFakeTurn();
    const { events, result } = await runFakeTurn({ announceStart: false });
    const checkpoint = payloadOf(events, "workspace.checkpoint");
    expect(checkpoint?.outcome).toBe("clean");
    expect(checkpoint?.sha).toBeNull();
    expect(checkpoint?.files).toEqual([]);
    expect(result.terminal.kind).toBe("execution.completed");
    expect(events.some((event) => event.kind === "execution.starting")).toBe(false);
  });

  it("reuses the worktree across turns and rebuilds one that vanished", async () => {
    await runFakeTurn();
    const worktree = join(worktreeRoot, WORKSTREAM_ID);
    expect(existsSync(worktree)).toBe(true);
    rmSync(worktree, { recursive: true, force: true });

    const { result } = await runFakeTurn({ announceStart: false, direction: "Second pass" });
    expect(result.terminal.kind).toBe("execution.completed");
    expect(existsSync(join(worktree, "NOVUS_FAKE_TURN.md"))).toBe(true);
  });
});

describe("outcomes that are not completion", () => {
  it("never calls a turn completed when its checkpoint failed", async () => {
    const { events, result } = await runFakeTurn({}, (event) => {
      // The worktree disappears at the boundary, exactly when the checkpoint
      // is about to run: the harness succeeded, the evidence did not.
      if (event.kind === "boundary.reached") {
        rmSync(join(worktreeRoot, WORKSTREAM_ID), { recursive: true, force: true });
      }
    });
    const checkpoint = payloadOf(events, "workspace.checkpoint");
    expect(checkpoint?.outcome).toBe("failed");
    expect(checkpoint?.uncommitted).toBe(true);
    expect(result.terminal.kind).toBe("execution.failed");
    if (result.terminal.kind !== "execution.failed") throw new Error("expected a failure");
    expect(result.terminal.payload.classification).toBe("checkpoint_failed");
  });

  it("reports a stop as stopped, with the reason it was given", async () => {
    const { events, result } = await runFakeTurn({}, (event, stop) => {
      if (event.kind === "execution.running") stop("Stopped by a participant.");
    });
    expect(result.terminal.kind).toBe("execution.stopped");
    if (result.terminal.kind !== "execution.stopped") throw new Error("expected a stop");
    expect(result.terminal.payload.reason).toBe("Stopped by a participant.");
    // Even a stopped turn declares its boundary and its checkpoint.
    expect(events.map((event) => event.kind)).toContain("boundary.reached");
    expect(events.map((event) => event.kind)).toContain("workspace.checkpoint");
  });

  it("refuses a branch name the server did not allocate", async () => {
    const { events, result } = await runFakeTurn({ missionBranch: "main" });
    expect(result.terminal.kind).toBe("execution.failed");
    if (result.terminal.kind !== "execution.failed") throw new Error("expected a failure");
    expect(result.terminal.payload.classification).toBe("internal");
    // A turn that ends before the harness starts still declares a boundary,
    // so a pending control transfer is not left waiting on a dead execution.
    expect(events.map((event) => event.kind)).toContain("boundary.reached");
  });

  it("fails a turn whose repository is not there, rather than hanging", async () => {
    const { result } = await runFakeTurn({ repositoryPath: join(worktreeRoot, "nowhere") });
    expect(result.terminal.kind).toBe("execution.failed");
  });
});

describe("what the transcript is allowed to repeat", () => {
  /**
   * The harness talks more than anything else in the product, and what it says
   * is durable, distributed to every participant, and projected into receipts.
   * It was also, until D-052, the one reported surface that had only its paths
   * masked — so a turn that ran `env`, or quoted a config file it had just
   * read, put the value into the room in plain text.
   *
   * The fixture value below is not a credential and never was.
   */
  const HELD = "sk-not-a-real-value-000000";

  it("removes a held value from every string it reports", async () => {
    const { events } = await runFakeTurn({
      direction: `echo the token ${HELD} back to me`,
      secretValues: () => [HELD]
    });

    // Asserted over the whole serialized event stream rather than over the
    // fields we happened to think of, because the point is that there is no
    // string-shaped hole anywhere in it.
    const wire = JSON.stringify(events);
    expect(wire).not.toContain(HELD);
    expect(wire).toContain("[redacted]");
  });

  it("removes it from a turn that fails, where the reason is the error text", async () => {
    const { events } = await runFakeTurn({
      repositoryPath: join(worktreeRoot, "not-a-repository"),
      direction: `use ${HELD}`,
      secretValues: () => [HELD]
    });
    expect(JSON.stringify(events)).not.toContain(HELD);
  });

  it("still masks this machine's paths, which is the half that already worked", async () => {
    const { events } = await runFakeTurn({ secretValues: () => [HELD] });
    expect(absolutePaths(events)).toEqual([]);
  });

  it("reads the values at emit time, so one supplied mid-turn protects the rest of it", async () => {
    let supplied: string[] = [];
    const { events } = await runFakeTurn(
      { direction: `echo ${HELD}`, secretValues: () => supplied },
      () => {
        supplied = [HELD];
      }
    );
    // The first event is emitted before the observer has run, so this asserts
    // the closure is consulted per emit rather than captured once at start.
    expect(JSON.stringify(events.slice(1))).not.toContain(HELD);
  });
});

describe("a read-alongside turn (D-095)", () => {
  it("denies its own permission question at this machine, publishes no approval, and writes nothing", async () => {
    const { events, result } = await runFakeTurn({ access: "read", fakeApproval: true });

    // The question was answered deny here, the moment it arrived: no card
    // ever reaches the room, and the file the fake harness would have
    // written on approval does not exist.
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(false);

    // The turn still ends as a completed answer, not a failure: being told
    // no is the read turn's ordinary life.
    expect(result.terminal.kind).toBe("execution.completed");
  });

  it("captures no checkpoint and declares no boundary", async () => {
    const { events, result } = await runFakeTurn({ access: "read", fakeApproval: true });

    // No checkpoint: committing the worktree now would record whatever the
    // write turn has half-done as this chat's evidence.
    expect(events.some((event) => event.kind === "workspace.checkpoint")).toBe(false);
    expect(result.checkpoint).toBeNull();
    // No boundary: a read turn ending says nothing about whether the write
    // turn is at a safe point, and a waiting handoff must not complete on it.
    expect(events.some((event) => event.kind === "boundary.reached")).toBe(false);
  });

});

describe("a scoped turn (D-097)", () => {
  it("auto-allows a write inside its scope: no card, no prompt boundary, the file lands", async () => {
    const { events, result } = await runFakeTurn({
      direction: "[fake-write:server/api.md] build the server half",
      scope: ["server/**"],
      fakeApproval: true
    });
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    // The stream's "permission prompt pending" boundary is suppressed with
    // the card — nothing pended — while the honest turn-complete boundary of
    // a write turn stays.
    const boundaries = events
      .filter((event) => event.kind === "boundary.reached")
      .map((event) => (event.payload as { reason: string }).reason);
    expect(boundaries).toEqual(["turn complete"]);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "server/api.md"))).toBe(true);
    expect(result.terminal.kind).toBe("execution.completed");
    expect(result.checkpoint?.filesChanged).toBe(1);
  });

  it("auto-denies a write outside its scope, with the reason, and nothing is written", async () => {
    const { events, result } = await runFakeTurn({
      direction: "[fake-write:docs/notes.md] wander off",
      scope: ["server/**"],
      fakeApproval: true
    });
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "docs/notes.md"))).toBe(false);
    // Being told no is a scoped turn's ordinary life, not a failure.
    expect(result.terminal.kind).toBe("execution.completed");
  });
});
