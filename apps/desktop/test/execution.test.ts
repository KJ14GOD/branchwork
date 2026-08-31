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
  observe?: (
    event: RunnerEvent,
    stop: (reason: string) => void,
    respond: (requestId: string, decision: "approve" | "deny") => void
  ) => void
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
      observe?.(
        event,
        (reason) => running.stop(reason),
        (requestId, decision) => running.respondApproval(requestId, decision, null)
      );
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
  it("a dialect that cannot steer says false, so the words stay queued (D-231)", async () => {
    // The fake and the Claude wire share the honest answer: steering is
    // Codex's verb, and a steer against anything else reports false rather
    // than pretending — the caller then queues, which is what sending
    // always did.
    let steered: boolean | null = null;
    const running = startTurn({
      executionId: "exe_steer",
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
        if (event.kind === "harness.session" && steered === null) steered = running.steer("more words");
      }
    });
    await running.finished;
    expect(steered).toBe(false);
  });

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

describe("a profiled turn (D-115)", () => {
  it("accept_edits answers a file edit itself, on the record: no card, the file lands, the grant recorded", async () => {
    const { events, result } = await runFakeTurn({
      permissionProfile: "accept_edits",
      fakeApproval: true
    });
    // No card, and no false "permission prompt pending" boundary — nothing
    // pended. The honest turn-complete boundary stays.
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    const boundaries = events
      .filter((event) => event.kind === "boundary.reached")
      .map((event) => (event.payload as { reason: string }).reason);
    expect(boundaries).toEqual(["turn complete"]);
    // The act happened, and the record says the policy answered it.
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(true);
    const decided = payloadOf(events, "approval.policy");
    expect(decided).toMatchObject({
      toolName: "Write",
      decision: "allowed",
      profile: "accept_edits"
    });
    expect(decided?.summary).toContain("NOVUS_FAKE_TURN.md");
    expect(result.terminal.kind).toBe("execution.completed");
  });

  it("accept_edits still hands a shell command to a person", async () => {
    const { events } = await runFakeTurn(
      {
        direction: "[fake-ask:Bash] run the script",
        permissionProfile: "accept_edits",
        fakeApproval: true
      },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "deny");
        }
      }
    );
    // The card is real: a shell command is not an edit, and the profile's
    // standing answer does not cover it.
    expect(events.some((event) => event.kind === "approval.requested")).toBe(true);
    expect(events.some((event) => event.kind === "approval.policy")).toBe(false);
  });

  it("auto answers everything but a shell command", async () => {
    const write = await runFakeTurn({ permissionProfile: "auto", fakeApproval: true });
    expect(write.events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(payloadOf(write.events, "approval.policy")).toMatchObject({
      decision: "allowed",
      profile: "auto"
    });

    const shell = await runFakeTurn(
      {
        direction: "[fake-ask:Bash] run the script",
        permissionProfile: "auto",
        fakeApproval: true
      },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "approve");
        }
      }
    );
    // The one line between auto and dont_ask: a shell command declares its
    // targets nowhere, so it is still a human question.
    expect(shell.events.some((event) => event.kind === "approval.requested")).toBe(true);
    expect(shell.events.some((event) => event.kind === "approval.policy")).toBe(false);
  });

  it("auto never answers an MCP tool: enabling a server put its tools in the room (D-119)", async () => {
    // An MCP tool's effects are declared nowhere Novus can read — the shell's
    // problem exactly — so `auto` hands it to a person like Bash, and only
    // dont_ask answers it by policy, on the record.
    const asked = await runFakeTurn(
      {
        direction: "[fake-ask:mcp__docs__echo] look it up",
        permissionProfile: "auto",
        fakeApproval: true
      },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "deny");
        }
      }
    );
    expect(asked.events.some((event) => event.kind === "approval.requested")).toBe(true);
    expect(asked.events.some((event) => event.kind === "approval.policy")).toBe(false);

    const trusted = await runFakeTurn({
      direction: "[fake-ask:mcp__docs__echo] look it up",
      permissionProfile: "dont_ask",
      fakeApproval: true
    });
    expect(trusted.events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(payloadOf(trusted.events, "approval.policy")).toMatchObject({
      toolName: "mcp__docs__echo",
      decision: "allowed",
      profile: "dont_ask"
    });
  });

  it("a lent account's tool reaches the room even under dont_ask (D-217): spending someone's own inbox is never a standing answer", async () => {
    // The connector's tool wears its prefix; the turn carries it as lent, so
    // the ladder must not let dont_ask answer it — it falls to a person.
    const asked = await runFakeTurn(
      {
        direction: "[fake-ask:mcp__claude_ai_Gmail__send_email] mail the team",
        permissionProfile: "dont_ask",
        connectors: ["claude.ai Gmail"],
        fakeApproval: true
      },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "deny");
        }
      }
    );
    expect(asked.events.some((event) => event.kind === "approval.requested")).toBe(true);
    expect(asked.events.some((event) => event.kind === "approval.policy")).toBe(false);

    // A non-lent connector's tool under dont_ask is answered by policy like
    // any other MCP tool — the rule is specific to what was lent.
    const other = await runFakeTurn({
      direction: "[fake-ask:mcp__docs__echo] look it up",
      permissionProfile: "dont_ask",
      connectors: ["claude.ai Gmail"],
      fakeApproval: true
    });
    expect(other.events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(payloadOf(other.events, "approval.policy")).toMatchObject({ toolName: "mcp__docs__echo" });
  });

  it("names the accounts a turn carried on execution.running (D-217), and a read turn carries none", async () => {
    const write = await runFakeTurn({ connectors: ["claude.ai Gmail", "claude.ai Google Drive"] });
    expect((payloadOf(write.events, "execution.running") as { connectors: string[] }).connectors).toEqual([
      "claude.ai Gmail",
      "claude.ai Google Drive"
    ]);
    const read = await runFakeTurn({ access: "read", connectors: ["claude.ai Gmail"] });
    expect((payloadOf(read.events, "execution.running") as { connectors: string[] }).connectors).toEqual([]);
  });

  it("raw computer use is refused outright when the Mac has not opted in — never even asked (D-218)", async () => {
    const off = await runFakeTurn(
      {
        direction: "[fake-ask:mcp__novus__computer_click] click somewhere",
        computerUseEnabled: () => false,
        computerSession: () => null,
        fakeApproval: true
      }
    );
    // No card reaches the room: the machine has not consented to hands at all.
    expect(off.events.some((event) => event.kind === "approval.requested")).toBe(false);
  });

  it("with the Mac opted in, computer use follows the browser's session ladder (D-218)", async () => {
    // Opted in but not yet granted: the first act is a person's question.
    const asked = await runFakeTurn(
      {
        direction: "[fake-ask:mcp__novus__computer_click] click somewhere",
        computerUseEnabled: () => true,
        computerSession: () => null,
        fakeApproval: true
      },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "deny");
        }
      }
    );
    expect(asked.events.some((event) => event.kind === "approval.requested")).toBe(true);

    // Granted this turn: silent allow, no card.
    const granted = await runFakeTurn({
      direction: "[fake-ask:mcp__novus__computer_click] click again",
      computerUseEnabled: () => true,
      computerSession: () => "granted",
      fakeApproval: true
    });
    expect(granted.events.some((event) => event.kind === "approval.requested")).toBe(false);

    // Revoked: denied without a card.
    const revoked = await runFakeTurn({
      direction: "[fake-ask:mcp__novus__computer_click] click yet again",
      computerUseEnabled: () => true,
      computerSession: () => "revoked",
      fakeApproval: true
    });
    expect(revoked.events.some((event) => event.kind === "approval.requested")).toBe(false);
  });

  it("a granted browser session auto-allows without a card, revoked denies, absent asks (D-218)", async () => {
    // Granted this turn: the person already said yes to browsing, so a browser
    // tool is allowed silently — no card in the room.
    const granted = await runFakeTurn({
      direction: "[fake-ask:mcp__novus__browser_click] click the toggle",
      browserSession: () => "granted",
      fakeApproval: true
    });
    expect(granted.events.some((event) => event.kind === "approval.requested")).toBe(false);

    // Revoked this turn: a person cut it off, so the next action is denied —
    // still no card, because the answer is already known.
    const revoked = await runFakeTurn({
      direction: "[fake-ask:mcp__novus__browser_click] click again",
      browserSession: () => "revoked",
      fakeApproval: true
    });
    expect(revoked.events.some((event) => event.kind === "approval.requested")).toBe(false);

    // Not yet granted: the first browse of the turn is a person's question.
    const asked = await runFakeTurn(
      {
        direction: "[fake-ask:mcp__novus__browser_click] click the toggle",
        browserSession: () => null,
        fakeApproval: true
      },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "deny");
        }
      }
    );
    expect(asked.events.some((event) => event.kind === "approval.requested")).toBe(true);
  });

  it("dont_ask answers a shell command too — and the grant is still recorded", async () => {
    const { events, result } = await runFakeTurn({
      direction: "[fake-ask:Bash] run the script",
      permissionProfile: "dont_ask",
      fakeApproval: true
    });
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(payloadOf(events, "approval.policy")).toMatchObject({
      toolName: "Bash",
      decision: "allowed",
      profile: "dont_ask"
    });
    expect(result.terminal.kind).toBe("execution.completed");
  });

  it("reports every allow to onToolAllowed — a person's answer and a profile's alike — and never a deny (D-123)", async () => {
    const personAllows: string[] = [];
    await runFakeTurn(
      { fakeApproval: true, onToolAllowed: (tool) => personAllows.push(tool) },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "approve");
        }
      }
    );
    expect(personAllows).toEqual(["Write"]);

    const policyAllows: string[] = [];
    await runFakeTurn({
      direction: "[fake-ask:mcp__novus__capture_screenshot] show me",
      permissionProfile: "dont_ask",
      fakeApproval: true,
      onToolAllowed: (tool) => policyAllows.push(tool)
    });
    expect(policyAllows).toEqual(["mcp__novus__capture_screenshot"]);

    const denies: string[] = [];
    await runFakeTurn(
      { fakeApproval: true, onToolAllowed: (tool) => denies.push(tool) },
      (event, _stop, respond) => {
        if (event.kind === "approval.requested") {
          respond((event.payload as { requestId: string }).requestId, "deny");
        }
      }
    );
    expect(denies).toEqual([]);
  });

  it("plan denies every privileged act with the instruction to propose, and nothing is written", async () => {
    const { events, result } = await runFakeTurn({
      permissionProfile: "plan",
      fakeApproval: true
    });
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(false);
    expect(payloadOf(events, "approval.policy")).toMatchObject({
      toolName: "Write",
      decision: "denied",
      profile: "plan"
    });
    // The refusal reached the model on the harness's own channel: the fake
    // echoes the denial message it was given, which carries the instruction.
    const spoken = events
      .filter((event) => event.kind === "harness.text")
      .map((event) => (event.payload as { text: string }).text)
      .join("\n");
    expect(spoken).toContain("Plan profile");
    // A plan turn ends as an ordinary answer with a clean checkpoint: being
    // told no is its whole life, and nothing changed.
    expect(result.terminal.kind).toBe("execution.completed");
    expect(result.checkpoint?.filesChanged).toBe(0);
  });

  it("containment outranks trust: a read turn under dont_ask is still denied, silently", async () => {
    const { events } = await runFakeTurn({
      access: "read",
      permissionProfile: "dont_ask",
      fakeApproval: true
    });
    // D-095's rules hold whatever the lane trusts: no card, no policy row —
    // the read turn's denials keep their recorded silence — and no file.
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(events.some((event) => event.kind === "approval.policy")).toBe(false);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "NOVUS_FAKE_TURN.md"))).toBe(false);
  });

  it("ownership outranks trust: an out-of-scope write under dont_ask is still refused", async () => {
    const { events } = await runFakeTurn({
      direction: "[fake-write:docs/notes.md] wander off",
      scope: ["server/**"],
      permissionProfile: "dont_ask",
      fakeApproval: true
    });
    // The scope is a sibling's territory, not a trust dial (D-097): the
    // refusal stands, in D-097's own recorded silence, and nothing lands.
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(events.some((event) => event.kind === "approval.policy")).toBe(false);
    expect(existsSync(join(worktreeRoot, WORKSTREAM_ID, "docs/notes.md"))).toBe(false);
  });

  it("states the profile it ran under on the running event", async () => {
    const { events } = await runFakeTurn({ permissionProfile: "accept_edits" });
    expect(payloadOf(events, "execution.running")).toMatchObject({
      permissionProfile: "accept_edits"
    });
    const { events: defaulted } = await runFakeTurn();
    expect(payloadOf(defaulted, "execution.running")).toMatchObject({
      permissionProfile: "manual"
    });
  });
});
