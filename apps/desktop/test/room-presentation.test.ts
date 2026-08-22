import { describe, expect, it } from "vitest";
import { MissionDetailResponseSchema, type MissionDetailResponse } from "@novus/contracts";
import {
  activeExecution,
  checkpointFiles,
  checkpointPrompt,
  contestedAcrossSessions,
  controller,
  keptWorkspace,
  deriveStateLine,
  laneView,
  mcpRows,
  nextEnabledMcp,
  nextEnabledSkills,
  offerCountdownLabel,
  pendingDirections,
  queuedPositionLabel,
  runningSession,
  sessionActivity,
  sessionChangedFiles,
  sessionChecks,
  sessionNeedsYou,
  sessionOfCheck,
  sessionView,
  globalSkillRows,
  nextEnabledGlobalSkills,
  nextEnabledSlashCommands,
  slashCommandCompletions,
  slashCommandRows,
  skillRows,
  usageSoFar,
  viewerIsController
} from "../src/components/derive";
import { labelsFor } from "../src/components/extension-labels";
import { clockTime } from "../src/format";

/**
 * The multiplayer room's projections: who is in control, what the state line
 * says while people share one lane, how a queued direction is presented, and
 * which rows carry "needs you". These are the renderer's own derivations — no
 * window, no fetching — and every fixture is parsed through the contract
 * schema, so a shape this suite invents cannot drift from the wire.
 */

const SHA = "a".repeat(40);
const T = (minute: number) => `2026-08-08T10:${String(minute).padStart(2, "0")}:00.000Z`;

const KARTIK = "usr_kartik";
const MAYA = "usr_maya";

function participant(overrides: Record<string, unknown> = {}) {
  return {
    userId: KARTIK,
    login: "kartik",
    name: null,
    role: "mission_admin",
    joinedAt: T(0),
    isController: false,
    connection: "connected",
    ...overrides
  };
}

function direction(overrides: Record<string, unknown> = {}) {
  return {
    directionId: "dir_1",
    workstreamId: "wst_one",
    sessionId: "csn_one",
    authorUserId: MAYA,
    authorLogin: "maya",
    body: "Add a health endpoint",
    state: "queued",
    ordinal: 1,
    submittedAt: T(1),
    appliedAt: null,
    resolutionReason: null,
    consumedByExecutionId: null,
    ...overrides
  };
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "exe_1",
    workstreamId: "wst_one",
    sessionId: "csn_one",
    access: "write",
    harness: "claude-code",
    model: "claude-sonnet-5",
    effort: "medium",
    runnerId: "rnr_one",
    startingDirectionId: "dir_1",
    state: "running",
    startedBy: KARTIK,
    startedByLogin: "kartik",
    createdAt: T(2),
    startedAt: T(2),
    endedAt: null,
    harnessSessionId: null,
    resumedSession: false,
    exitOutcome: null,
    failureReason: null,
    latestCheckpointSha: null,
    usage: {},
    ...overrides
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "apr_1",
    executionId: "exe_1",
    workstreamId: "wst_one",
    harnessRequestId: "req-1",
    toolUseId: null,
    toolName: "Write",
    displayName: "Write a file",
    summary: "Write HELLO.md (12 lines)",
    state: "pending",
    requestedAt: T(3),
    respondedByLogin: null,
    respondedAt: null,
    resolution: null,
    ...overrides
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "csn_one",
    workstreamId: "wst_one",
    title: "Implement the endpoint",
    createdBy: KARTIK,
    createdByLogin: "kartik",
    createdAt: T(0),
    scope: null,
    ...overrides
  };
}

function workstream(overrides: Record<string, unknown> = {}) {
  return {
    workstreamId: "wst_one",
    missionId: "msn_one",
    name: "Current work",
    baseRef: "main",
    baseSha: SHA,
    missionBranch: "novus/msn_one",
    branchStatus: "created",
    branchError: null,
    ...overrides
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt_1",
    missionId: "msn_one",
    seq: 1,
    kind: "participant.joined",
    actor: { kind: "user", id: KARTIK, login: "kartik" },
    cause: { directionId: null, leaseId: null },
    executionId: null,
    workstreamId: null,
    payload: {},
    schemaVersion: 1,
    occurredAt: T(0),
    ...overrides
  };
}

/** One mission, one lane, two people, kartik holding the baton — parsed
 *  through the contract so the fixture is a real MissionDetailResponse. */
function detail(overrides: Record<string, unknown> = {}): MissionDetailResponse {
  return MissionDetailResponseSchema.parse({
    mission: {
      missionId: "msn_one",
      orgId: "org_one",
      goal: "Add a health endpoint",
      successCriteria: "GET /health answers 200",
      primaryState: "ready_for_instruction",
      createdBy: KARTIK,
      createdByLogin: "kartik",
      createdAt: T(0),
      repository: null,
      archivedAt: null,
      archivedByLogin: null,
      attention: null
    },
    workstream: workstream(),
    workstreams: [workstream()],
    sessions: [session()],
    approaches: [],
    contested: [],
    decisions: [],
    preparedPullRequest: null,
    events: [],
    participants: [
      participant({ isController: true }),
      participant({ userId: MAYA, login: "maya", role: "contributor" })
    ],
    directions: [],
    executions: [],
    control: {
      leaseId: "lease-1",
      holderUserId: KARTIK,
      holderLogin: "kartik",
      state: "held",
      openRequests: [],
      liveOffer: null
    },
    checkpoints: [],
    checks: [],
    approvals: [],
    runner: {
      runnerId: "rnr_one",
      kind: "local",
      label: "Kartik's Mac",
      ownerLogin: "kartik",
      online: true,
      lastSeenAt: T(3)
    },
    workspace: null,
    processes: [],
    capabilities: ["direction.submit", "control.request"],
    viewerUserId: MAYA,
    state: "ready_for_instruction",
    overlays: [],
    ...overrides
  });
}

describe("one turn's own footprint (D-213)", () => {
  const file = (changeId: string, path: string, changeState: string, additions: number) => ({
    changeId,
    path,
    previousPath: null,
    changeState,
    additions,
    deletions: 0,
    binary: false,
    truncated: false
  });
  const checkpoint = (overrides: Record<string, unknown> = {}) => ({
    checkpointId: "ckp_1",
    executionId: "exe_1",
    outcome: "committed",
    sha: SHA,
    parentSha: null,
    branch: "novus/msn_one",
    filesChanged: 2,
    additions: 3,
    deletions: 0,
    withheldSecrets: 0,
    uncommitted: false,
    environment: "kartik-macbook",
    error: null,
    createdAt: T(5),
    files: [file("chg_b", "src/b.ts", "added", 2), file("chg_a", "src/a.ts", "modified", 1)],
    ...overrides
  });

  it("lists a checkpoint's own files, in path order, and names the prompt that asked for them", () => {
    const fixture = detail({
      directions: [direction({ directionId: "dir_1", state: "applied", body: "Add a health endpoint, and   keep it small" })],
      executions: [execution({ startingDirectionId: "dir_1", state: "completed" })],
      checkpoints: [checkpoint()]
    });
    expect(checkpointFiles(fixture, "ckp_1").map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(checkpointPrompt(fixture, "ckp_1")).toEqual({
      words: "Add a health endpoint, and keep it small",
      at: T(5)
    });
  });

  it("answers nothing for a checkpoint the detail does not hold, and no words for a turn with no direction", () => {
    const fixture = detail({
      executions: [execution({ startingDirectionId: null, state: "completed" })],
      checkpoints: [checkpoint()]
    });
    expect(checkpointFiles(fixture, "ckp_missing")).toEqual([]);
    // The files are still the turn's; only the words are unknown.
    expect(checkpointFiles(fixture, "ckp_1")).toHaveLength(2);
    expect(checkpointPrompt(fixture, "ckp_1")).toBeNull();
  });

  it("bounds the words to a line", () => {
    const long = "x".repeat(200);
    const fixture = detail({
      directions: [direction({ directionId: "dir_1", state: "applied", body: long })],
      executions: [execution({ startingDirectionId: "dir_1", state: "completed" })],
      checkpoints: [checkpoint()]
    });
    expect(checkpointPrompt(fixture, "ckp_1")?.words.length).toBe(72);
  });
});

describe("who is in control", () => {
  it("names the participant holding the baton, and nobody when the lease is unheld", () => {
    expect(controller(detail())?.login).toBe("kartik");

    const unheld = detail({
      participants: [participant(), participant({ userId: MAYA, login: "maya", role: "contributor" })],
      control: {
        leaseId: null,
        holderUserId: null,
        holderLogin: null,
        state: null,
        openRequests: [],
        liveOffer: null
      }
    });
    expect(controller(unheld)).toBeNull();
  });

  it("computes the viewer's own standing from the lease, not from role", () => {
    expect(viewerIsController(detail())).toBe(false);
    expect(viewerIsController(detail({ viewerUserId: KARTIK }))).toBe(true);
  });
});

describe("queued direction presentation", () => {
  it("numbers a direction only while more than one waits — a queue of one is not a queue", () => {
    const one = detail({ directions: [direction()] });
    expect(queuedPositionLabel(one, "dir_1")).toBeNull();

    const two = detail({
      directions: [
        direction({ directionId: "dir_2", ordinal: 2, body: "Then add a test" }),
        direction()
      ]
    });
    expect(queuedPositionLabel(two, "dir_1")).toBe("1 of 2");
    expect(queuedPositionLabel(two, "dir_2")).toBe("2 of 2");
  });

  it("never numbers direction that is already history", () => {
    const mixed = detail({
      directions: [
        direction({ directionId: "dir_0", ordinal: 0, state: "applied", appliedAt: T(2) }),
        direction(),
        direction({ directionId: "dir_2", ordinal: 2 })
      ]
    });
    expect(queuedPositionLabel(mixed, "dir_0")).toBeNull();
    expect(pendingDirections(mixed)).toHaveLength(2);
  });

  it("says who the queue is waiting for in the state line", () => {
    const waiting = detail({
      directions: [direction()],
      overlays: ["direction_queued"]
    });
    const line = deriveStateLine(waiting);
    expect(line.name).toBe("Waiting for kartik");
    expect(line.detail).toBe("1 direction is queued");
    expect(line.tone).toBe("warn");

    const two = detail({
      directions: [direction(), direction({ directionId: "dir_2", ordinal: 2 })],
      overlays: ["direction_queued"]
    });
    expect(deriveStateLine(two).detail).toBe("2 directions are queued");
  });

  it("does not claim anyone is waited on while the agent is already working", () => {
    const running = detail({
      state: "agent_running",
      directions: [direction()],
      executions: [execution()],
      overlays: ["direction_queued"]
    });
    expect(deriveStateLine(running).name).toBe("Running");
  });

  it("states the backlog behind a working turn as a quiet suffix (D-112)", () => {
    const running = detail({
      state: "agent_running",
      directions: [direction(), direction({ directionId: "dir_2", ordinal: 2 })],
      executions: [execution()],
      overlays: ["direction_queued"]
    });
    const line = deriveStateLine(running);
    expect(line.name).toBe("Running");
    expect(line.suffix).toBe("2 directions queued");

    // Nothing queued, nothing said: the suffix never renders a zero.
    const clear = detail({ state: "agent_running", executions: [execution()] });
    expect(deriveStateLine(clear).suffix).toBeNull();
  });
});

describe("the stalled suffix and the pulse (D-114)", () => {
  it("says the process is alive only on a fresh heartbeat, and a pulse never counts as progress", () => {
    const base = {
      state: "agent_running",
      executions: [execution()],
      overlays: ["execution_stalled"]
    };
    // No pulse at all: the plain stalled sentence.
    const quietDeath = deriveStateLine(detail({ ...base, events: [event({ executionId: "exe_1" })] }));
    expect(quietDeath.suffix).toContain("no progress reported");
    expect(quietDeath.suffix).not.toContain("alive");

    // A fresh pulse: alive, still stalled — the heartbeat moved neither the
    // overlay nor the "since" clock.
    const breathing = deriveStateLine(
      detail({
        ...base,
        events: [
          event({ executionId: "exe_1", occurredAt: T(2) }),
          event({
            eventId: "evt_pulse",
            seq: 2,
            kind: "execution.heartbeat",
            executionId: "exe_1",
            occurredAt: new Date().toISOString()
          })
        ]
      })
    );
    expect(breathing.suffix).toContain("no progress reported");
    expect(breathing.suffix).toContain("the process is alive");
    // The since-time is the transcript's last word, not the pulse's.
    expect(breathing.suffix).toContain(clockTime(T(2)));
  });
});

describe("what the lane has spent so far (D-113)", () => {
  it("adds up turns, harness time, and cost — with null never becoming zero", () => {
    const spent = usageSoFar(
      detail({
        executions: [
          execution({ usage: { costUsd: 0.42, durationMs: 60_000 } }),
          execution({
            executionId: "exe_2",
            usage: { costUsd: 0.08, durationMs: 30_000 }
          }),
          // A turn that reported nothing adds nothing — and subtracts nothing.
          execution({ executionId: "exe_3", usage: {} })
        ]
      })
    );
    expect(spent.turns).toBe(3);
    expect(spent.costUsd).toBeCloseTo(0.5);
    expect(spent.durationMs).toBe(90_000);
  });

  it("says nothing about a lane that has reported nothing", () => {
    const silent = usageSoFar(detail({ executions: [execution({ usage: {} })] }));
    expect(silent.turns).toBe(1);
    // Not stated is not free: null, never zero (D-071).
    expect(silent.costUsd).toBeNull();
    expect(silent.durationMs).toBeNull();
    expect(usageSoFar(detail({})).turns).toBe(0);
  });
});

describe("approval presentation", () => {
  it("names the act the harness is asking to take, never just the category", () => {
    const asking = detail({
      state: "needs_approval",
      executions: [execution({ state: "needs_approval" })],
      approvals: [approval()]
    });
    const line = deriveStateLine(asking);
    expect(line.name).toBe("Needs approval");
    expect(line.detail).toBe("Claude Code asks to write a file");
    expect(line.tone).toBe("warn");
    // A blocked turn is still a live turn: Stop stays offered, because a turn
    // that keeps asking must not become unstoppable between its questions
    // (D-205 — the server settles the open question in the same stop).
    expect(line.action).toEqual({ label: "Stop", kind: "stop" });
  });

  it("says which conversation asked once the lane holds more than one", () => {
    const twoSessions = detail({
      state: "needs_approval",
      sessions: [session(), session({ sessionId: "csn_two", title: "Add tests", createdAt: T(1) })],
      executions: [execution({ state: "needs_approval", sessionId: "csn_two" })],
      approvals: [approval()]
    });
    expect(deriveStateLine(twoSessions).detail).toBe(
      'Claude Code asks to write a file in "Add tests"'
    );
  });

  it("tells the room to claim the baton when a question waits and nobody holds it", () => {
    const orphaned = detail({
      state: "needs_approval",
      executions: [execution({ state: "needs_approval" })],
      approvals: [approval()],
      control: {
        leaseId: null,
        holderUserId: null,
        holderLogin: null,
        state: null,
        openRequests: [],
        liveOffer: null
      }
    });
    expect(deriveStateLine(orphaned).suffix).toBe("no one holds the baton — claim it to answer");
  });
});

describe("connection and handoff presentation", () => {
  it("replaces the whole line when the runner is offline — a dead machine invalidates every claim", () => {
    const offline = detail({
      state: "agent_running",
      executions: [execution()],
      overlays: ["runner_offline"]
    });
    const line = deriveStateLine(offline);
    expect(line.name).toBe("Runner offline");
    expect(line.detail).toContain("last event received at");
    expect(line.working).toBe(false);
    expect(line.action).toBeNull();
  });

  it("says plainly when no machine has ever reported", () => {
    const silent = detail({ overlays: ["runner_offline"], runner: null });
    expect(deriveStateLine(silent).detail).toBe(
      "no events have been received from this machine"
    );
  });

  it("names the recipient while a handoff waits for a safe boundary", () => {
    const handing = detail({
      state: "agent_running",
      executions: [execution()],
      overlays: ["handoff_waiting_for_boundary"],
      control: {
        leaseId: "lease-1",
        holderUserId: KARTIK,
        holderLogin: "kartik",
        state: "releasing",
        openRequests: [],
        liveOffer: {
          offerId: "hof_1",
          fromUserId: KARTIK,
          fromLogin: "kartik",
          toUserId: MAYA,
          toLogin: "maya",
          state: "waiting_for_boundary",
          createdAt: T(3),
          expiresAt: T(9)
        }
      }
    });
    expect(deriveStateLine(handing).suffix).toBe(
      "Handing control to maya at the next safe point"
    );
  });

  it("states when a running turn stopped reporting, with the time it was last heard", () => {
    const stalled = detail({
      state: "agent_running",
      executions: [execution()],
      events: [event({ kind: "harness.text", executionId: "exe_1", workstreamId: "wst_one", seq: 2, occurredAt: T(4) })],
      overlays: ["execution_stalled"]
    });
    expect(deriveStateLine(stalled).suffix).toMatch(/^no progress reported since /);
  });
});

describe("background attention", () => {
  it("marks a session as needing a person exactly when its turn is blocked on one", () => {
    const blocked = detail({
      sessions: [session(), session({ sessionId: "csn_two", title: "Add tests", createdAt: T(1) })],
      executions: [execution({ state: "needs_approval", sessionId: "csn_two" })]
    });
    expect(sessionNeedsYou(blocked, "csn_two")).toBe(true);
    expect(sessionNeedsYou(blocked, "csn_one")).toBe(false);

    const askingForDirection = detail({
      executions: [execution({ state: "needs_direction" })]
    });
    expect(sessionNeedsYou(askingForDirection, "csn_one")).toBe(true);
  });

  it("does not cry for attention over a turn that is merely working", () => {
    const working = detail({ executions: [execution({ state: "running" })] });
    expect(sessionNeedsYou(working, "csn_one")).toBe(false);
  });

  it("names the working conversation in the sentence once the lane holds several", () => {
    const twoSessions = detail({
      state: "agent_running",
      sessions: [session(), session({ sessionId: "csn_two", title: "Add tests", createdAt: T(1) })],
      executions: [execution({ sessionId: "csn_two" })]
    });
    expect(runningSession(twoSessions)?.title).toBe("Add tests");
    expect(deriveStateLine(twoSessions).detail).toBe('Claude Code is working in "Add tests"');

    const oneSession = detail({ state: "agent_running", executions: [execution()] });
    expect(deriveStateLine(oneSession).detail).toBe("Claude Code is working");
  });
});

describe("what one lane's room may show", () => {
  const laneB = workstream({ workstreamId: "wst_two", name: "Alternative" });

  it("filters a sibling lane's directions, executions, and approvals out of the lane view", () => {
    const twoLanes = detail({
      workstreams: [workstream(), laneB],
      directions: [
        direction(),
        direction({ directionId: "dir_b", workstreamId: "wst_two", sessionId: "csn_b", ordinal: 2 })
      ],
      executions: [
        execution({ state: "needs_approval" }),
        execution({ executionId: "exe_b", workstreamId: "wst_two", sessionId: "csn_b" })
      ],
      approvals: [approval(), approval({ approvalId: "apr_b", executionId: "exe_b", workstreamId: "wst_two" })],
      sessions: [session(), session({ sessionId: "csn_b", workstreamId: "wst_two", title: "Other lane" })]
    });
    const lane = laneView(twoLanes);
    expect(lane.directions.map((d) => d.directionId)).toEqual(["dir_1"]);
    expect(lane.executions.map((e) => e.executionId)).toEqual(["exe_1"]);
    expect(lane.approvals.map((a) => a.approvalId)).toEqual(["apr_1"]);
  });

  it("keeps mission-level events in every lane's story and drops a sibling's", () => {
    const twoLanes = detail({
      workstreams: [workstream(), laneB],
      events: [
        event(),
        event({ eventId: "evt_b", seq: 2, kind: "harness.text", workstreamId: "wst_two", executionId: "exe_b" })
      ]
    });
    expect(laneView(twoLanes).events.map((e) => e.eventId)).toEqual(["evt_1"]);
  });

  it("narrows the canvas to one conversation while control moments stay in every session's story", () => {
    const twoSessions = detail({
      sessions: [session(), session({ sessionId: "csn_two", title: "Add tests", createdAt: T(1) })],
      directions: [direction(), direction({ directionId: "dir_2", sessionId: "csn_two", ordinal: 2 })],
      executions: [
        execution({ state: "completed", endedAt: T(3) }),
        execution({ executionId: "exe_2", sessionId: "csn_two", createdAt: T(4), startedAt: T(4) })
      ],
      events: [
        event({ eventId: "evt_ctrl", kind: "control.transferred", seq: 1 }),
        event({
          eventId: "evt_one",
          kind: "harness.text",
          seq: 2,
          executionId: "exe_1",
          workstreamId: "wst_one"
        }),
        event({
          eventId: "evt_two",
          kind: "harness.text",
          seq: 3,
          executionId: "exe_2",
          workstreamId: "wst_one"
        })
      ]
    });
    const conversation = sessionView(twoSessions, "csn_two");
    expect(conversation.directions.map((d) => d.directionId)).toEqual(["dir_2"]);
    expect(conversation.executions.map((e) => e.executionId)).toEqual(["exe_2"]);
    expect(conversation.events.map((e) => e.eventId)).toEqual(["evt_ctrl", "evt_two"]);
  });
});

describe("the offer's expiry countdown (D-092)", () => {
  const offer = (state: string) => ({ state, expiresAt: T(10) });

  it("counts minutes while minutes remain, seconds under the last one", () => {
    expect(offerCountdownLabel(offer("open"), Date.parse(T(3)))).toBe("expires in 7m");
    expect(offerCountdownLabel(offer("open"), Date.parse(T(10)) - 40_000)).toBe("expires in 40s");
  });

  it("says nothing once past expiry — the feed's expired line takes over", () => {
    expect(offerCountdownLabel(offer("open"), Date.parse(T(10)))).toBeNull();
    expect(offerCountdownLabel(offer("open"), Date.parse(T(11)))).toBeNull();
  });

  it("only an open offer counts down: an accepted grant is durable and waits", () => {
    expect(offerCountdownLabel(offer("accepted"), Date.parse(T(3)))).toBeNull();
    expect(offerCountdownLabel(offer("waiting_for_boundary"), Date.parse(T(3)))).toBeNull();
  });
});

describe("per-participant connection state arrives on the wire (D-091)", () => {
  it("parses the three states the contract admits, and refuses a room without one", () => {
    const room = detail({
      participants: [
        participant({ isController: true }),
        participant({ userId: MAYA, login: "maya", role: "contributor", connection: "offline" })
      ]
    });
    const maya = room.participants.find((person) => person.userId === MAYA);
    expect(maya?.connection).toBe("offline");
    expect(() =>
      detail({ participants: [participant({ connection: "away" })] })
    ).toThrow();
    expect(() => {
      const bare: Record<string, unknown> = participant();
      delete bare.connection;
      return detail({ participants: [bare] });
    }).toThrow();
  });
});

describe("each chat's own word and footprint (D-094)", () => {
  const fileOf = (path: string, changeId: string) => ({
    changeId,
    path,
    previousPath: null,
    changeState: "modified",
    additions: 3,
    deletions: 1,
    binary: false,
    truncated: false
  });
  const checkpointOf = (
    checkpointId: string,
    executionId: string,
    createdAt: string,
    paths: string[]
  ) => ({
    checkpointId,
    executionId,
    outcome: "committed",
    sha: SHA,
    parentSha: null,
    branch: "novus/msn_one",
    filesChanged: paths.length,
    additions: 3,
    deletions: 1,
    withheldSecrets: 0,
    uncommitted: false,
    environment: "local",
    error: null,
    createdAt,
    files: paths.map((path, index) => fileOf(path, `chg_${checkpointId}${index}`))
  });
  /** Two chats in the lane; the second holds whatever the test stages. */
  const twoChats = (overrides: Record<string, unknown> = {}) =>
    detail({
      sessions: [session(), session({ sessionId: "csn_two", title: "Tests" })],
      ...overrides
    });

  it("a live turn reads working, with the turn's freshest reported moment", () => {
    const room = twoChats({
      executions: [execution({ sessionId: "csn_two", state: "running" })],
      events: [
        event({ eventId: "evt_a", kind: "harness.text", seq: 2, executionId: "exe_1", occurredAt: T(4) }),
        event({ eventId: "evt_b", kind: "harness.text", seq: 3, executionId: "exe_1", occurredAt: T(6) })
      ]
    });
    expect(sessionActivity(room, "csn_two")).toEqual({
      state: "working",
      label: "working",
      lastHeardAt: T(6)
    });
    expect(sessionActivity(room, "csn_one")).toEqual({ state: "idle", label: null, lastHeardAt: null });
  });

  it("a blocked turn reads needs you, outranking working", () => {
    const room = twoChats({
      executions: [execution({ sessionId: "csn_two", state: "needs_approval" })]
    });
    expect(sessionActivity(room, "csn_two").state).toBe("needs_you");
    expect(sessionActivity(room, "csn_two").label).toBe("needs you");
  });

  it("waiting direction reads queued, counted only past one", () => {
    const one = twoChats({ directions: [direction({ sessionId: "csn_two" })] });
    expect(sessionActivity(one, "csn_two").label).toBe("queued");
    const two = twoChats({
      directions: [
        direction({ sessionId: "csn_two" }),
        direction({ directionId: "dir_2", ordinal: 2, sessionId: "csn_two", state: "submitted" })
      ]
    });
    expect(sessionActivity(two, "csn_two").label).toBe("queued · 2");
  });

  it("credits a chat only with its own turns' files, latest checkpoint winning", () => {
    const room = twoChats({
      executions: [
        execution({ state: "completed", endedAt: T(3) }),
        execution({ executionId: "exe_2", sessionId: "csn_two", state: "completed", endedAt: T(5) })
      ],
      checkpoints: [
        checkpointOf("ckp_1", "exe_1", T(3), ["src/auth.ts", "src/session.ts"]),
        checkpointOf("ckp_2", "exe_2", T(5), ["src/auth.ts"])
      ]
    });
    expect(sessionChangedFiles(room, "csn_one").map((file) => file.path)).toEqual([
      "src/auth.ts",
      "src/session.ts"
    ]);
    expect(sessionChangedFiles(room, "csn_two").map((file) => file.path)).toEqual(["src/auth.ts"]);
    const contested = contestedAcrossSessions(room);
    expect(contested).toHaveLength(1);
    expect(contested[0]?.path).toBe("src/auth.ts");
    expect(contested[0]?.sessions.map((s) => s.sessionId)).toEqual(["csn_one", "csn_two"]);
  });

  it("warns about nothing when the chats stay on separate ground", () => {
    const room = twoChats({
      executions: [
        execution({ state: "completed" }),
        execution({ executionId: "exe_2", sessionId: "csn_two", state: "completed" })
      ],
      checkpoints: [
        checkpointOf("ckp_1", "exe_1", T(3), ["src/auth.ts"]),
        checkpointOf("ckp_2", "exe_2", T(5), ["test/auth.test.ts"])
      ]
    });
    expect(contestedAcrossSessions(room)).toEqual([]);
  });
});

describe("the workspace's turn is the write turn (D-095)", () => {
  const twoChats = (executions: unknown[]) =>
    detail({
      sessions: [session(), session({ sessionId: "csn_two", title: "Review" })],
      executions
    });

  it("a read turn alongside is its chat's word, never the workspace's turn", () => {
    const room = twoChats([
      execution({ state: "running" }),
      execution({ executionId: "exe_2", sessionId: "csn_two", access: "read", state: "running" })
    ]);
    // The workspace's turn is the write one, however much newer the read is;
    // the read turn's liveness belongs to its own chat's row.
    expect(activeExecution(room)?.executionId).toBe("exe_1");
    expect(sessionActivity(room, "csn_two").state).toBe("working");
  });

  it("with only a read turn live, the workspace has no turn at all", () => {
    const room = twoChats([
      execution({ state: "completed", endedAt: T(3) }),
      execution({ executionId: "exe_2", sessionId: "csn_two", access: "read", state: "running" })
    ]);
    expect(activeExecution(room)).toBeNull();
    expect(sessionActivity(room, "csn_two").state).toBe("working");
  });
});

describe("a check is attributed to the chat whose checkpoint it ran at (D-096)", () => {
  const SHA_A = "b".repeat(40);
  const SHA_B = "c".repeat(40);
  const checkOf = (checkId: string, checkpointSha: string | null, outcome = "passed") => ({
    checkId,
    executionId: null,
    workstreamId: "wst_one",
    name: "tests",
    category: "test",
    outcome,
    origin: "automatic",
    requestedByLogin: null,
    command: "pnpm test",
    ending: "exit",
    exitCode: outcome === "passed" ? 0 : 1,
    output: null,
    truncated: false,
    environment: "local",
    startedAt: T(4),
    completedAt: T(5),
    durationMs: 60_000,
    checkpointSha,
    stale: false,
    observedAt: T(5)
  });
  const checkpointOf = (checkpointId: string, executionId: string, sha: string) => ({
    checkpointId,
    executionId,
    outcome: "committed",
    sha,
    parentSha: null,
    branch: "novus/msn_one",
    filesChanged: 1,
    additions: 3,
    deletions: 1,
    withheldSecrets: 0,
    uncommitted: false,
    environment: "local",
    error: null,
    createdAt: T(3),
    files: []
  });
  const room = () =>
    detail({
      sessions: [session(), session({ sessionId: "csn_two", title: "Tests" })],
      executions: [
        execution({ state: "completed", endedAt: T(3) }),
        execution({ executionId: "exe_2", sessionId: "csn_two", state: "completed", endedAt: T(4) })
      ],
      checkpoints: [checkpointOf("ckp_1", "exe_1", SHA_A), checkpointOf("ckp_2", "exe_2", SHA_B)],
      checks: [
        checkOf("chk_a", SHA_A),
        checkOf("chk_b", SHA_B, "failed"),
        // No revision recorded: history, but nobody's checkpoint.
        checkOf("chk_none", null)
      ]
    });

  it("joins check → revision → checkpoint → turn → chat, and never crosses chats", () => {
    const fixture = room();
    expect(sessionChecks(fixture, "csn_one").map((check) => check.checkId)).toEqual(["chk_a"]);
    expect(sessionChecks(fixture, "csn_two").map((check) => check.checkId)).toEqual(["chk_b"]);
    expect(sessionOfCheck(fixture, fixture.checks[2]!)).toBeNull();
  });

  it("a revision no checkpoint of the payload claims belongs to nobody", () => {
    const fixture = detail({
      checks: [checkOf("chk_orphan", "d".repeat(40))]
    });
    expect(sessionOfCheck(fixture, fixture.checks[0]!)).toBeNull();
  });
});

describe("the lane's skills surface (D-118)", () => {
  const digest = "d".repeat(64);
  const moved = "e".repeat(64);
  const workspaceWith = (skills: unknown[]) => ({
    workspaceId: "wsp_one",
    workstreamId: "wst_one",
    location: "local",
    readiness: "ready",
    portRangeStart: null,
    portRangeEnd: null,
    setupError: null,
    configuredAt: T(1),
    declared: [],
    declaredAt: T(1),
    skills
  });

  it("wears the lane's standing answer on every published row, and keeps a vanished grant visible in warn", () => {
    const fixture = detail({
      workspace: workspaceWith([
        { name: "zephyr-codes", description: "Codewords.", digest, bytes: 40 },
        { name: "rewritten", description: null, digest: moved, bytes: 40 },
        { name: "untouched", description: null, digest, bytes: 40 }
      ]),
      workstream: workstream({
        enabledSkills: [
          { name: "zephyr-codes", digest },
          // Enabled at bytes the manifest no longer carries.
          { name: "rewritten", digest },
          // Enabled, and the project deleted it.
          { name: "gone", digest }
        ]
      })
    });
    expect(skillRows(fixture)).toEqual([
      { name: "zephyr-codes", description: "Codewords.", state: "enabled", digest, modelInvocable: true },
      { name: "rewritten", description: null, state: "changed", digest: moved, modelInvocable: true },
      { name: "untouched", description: null, state: "off", digest, modelInvocable: true },
      { name: "gone", description: null, state: "vanished", digest: null }
    ]);
    // A project that declares none, with nothing enabled, puts nothing here.
    expect(skillRows(detail())).toEqual([]);
  });

  it("computes the set an act submits: only reviewable entries survive, and enabling a changed skill re-pins the new bytes", () => {
    const fixture = detail({
      workspace: workspaceWith([
        { name: "zephyr-codes", description: null, digest, bytes: 40 },
        { name: "rewritten", description: null, digest: moved, bytes: 40 }
      ]),
      workstream: workstream({
        enabledSkills: [
          { name: "zephyr-codes", digest },
          { name: "rewritten", digest },
          { name: "gone", digest }
        ]
      })
    });
    // Enabling the changed one pins the manifest's current digest; the stale
    // and vanished entries do not survive the submit, because the route
    // refuses what cannot be reviewed (D-118).
    expect(nextEnabledSkills(fixture, { enable: "rewritten" })).toEqual([
      { name: "zephyr-codes", digest },
      { name: "rewritten", digest: moved }
    ]);
    expect(nextEnabledSkills(fixture, { disable: "zephyr-codes" })).toEqual([]);
    // Enabling something unpublished submits only what stands.
    expect(nextEnabledSkills(fixture, { enable: "gone" })).toEqual([
      { name: "zephyr-codes", digest }
    ]);
  });

  it("derives the slash-command surface the same way, and offers the composer only what stands (D-187)", () => {
    const fixture = detail({
      workspace: {
        ...workspaceWith([]),
        slashCommands: [
          { name: "relnotes", description: "Release notes.", digest, bytes: 40 },
          { name: "rewritten", description: null, digest: moved, bytes: 40 },
          { name: "unreviewed", description: null, digest, bytes: 40 }
        ]
      },
      workstream: workstream({
        enabledSlashCommands: [
          { name: "relnotes", digest },
          // Enabled at bytes the manifest no longer carries.
          { name: "rewritten", digest }
        ]
      })
    });
    expect(slashCommandRows(fixture)).toEqual([
      { name: "relnotes", description: "Release notes.", state: "enabled", digest },
      { name: "rewritten", description: null, state: "changed", digest: moved },
      { name: "unreviewed", description: null, state: "off", digest }
    ]);
    // Everything declared is carried, so everything declared is offered
    // (D-193): commands by their registered invocation, in manifest order.
    expect(slashCommandCompletions(fixture)).toEqual([
      { name: "relnotes", description: "Release notes.", insert: "/novus-project-skills:relnotes" },
      { name: "rewritten", description: null, insert: "/novus-project-skills:rewritten" },
      { name: "unreviewed", description: null, insert: "/novus-project-skills:unreviewed" }
    ]);
    expect(nextEnabledSlashCommands(fixture, { enable: "unreviewed" })).toEqual([
      { name: "relnotes", digest },
      { name: "unreviewed", digest }
    ]);
  });

  it("resolves the labels one extension wears, keeping the collections apart (D-195)", () => {
    const fixture = detail({
      extensionLabels: [
        { labelId: "lbl_one", name: "review", color: "cyan" },
        { labelId: "lbl_two", name: "writing", color: "magenta" }
      ],
      extensionLabelAssignments: [
        { labelId: "lbl_one", source: "repo", name: "novus-ui" },
        { labelId: "lbl_two", source: "machine", name: "novus-ui" }
      ]
    });
    // Same name, different collection: a repository skill never wears the
    // machine skill's labels, which is the whole point of the key.
    expect(labelsFor(fixture, "repo", "novus-ui")).toEqual([
      { labelId: "lbl_one", name: "review", color: "cyan" }
    ]);
    expect(labelsFor(fixture, "machine", "novus-ui")).toEqual([
      { labelId: "lbl_two", name: "writing", color: "magenta" }
    ]);
    expect(labelsFor(fixture, "repo", "unlabelled")).toEqual([]);
  });

  it("offers skills beside commands, each inserting what invokes it (D-193)", () => {
    const fixture = detail({
      workspace: {
        ...workspaceWith([{ name: "zephyr-codes", description: "Codewords.", digest, bytes: 40 }]),
        globalSkills: [{ name: "unslop", description: "Cut AI tells.", digest, bytes: 40 }]
      }
    });
    // A skill has no registered command: picking one writes the sentence that
    // starts it, and the harness's own Skill tool reaches for it.
    expect(slashCommandCompletions(fixture)).toEqual([
      { name: "zephyr-codes", description: "Codewords.", insert: "Use the zephyr-codes skill:" },
      { name: "unslop", description: "Cut AI tells.", insert: "Use the unslop skill:" }
    ]);
  });

  it("offers the CLI's own commands after the project's, plainly invocable and deduplicated (D-188)", () => {
    const fixture = detail({
      workspace: {
        ...workspaceWith([]),
        slashCommands: [{ name: "compact", description: "The project's own.", digest, bytes: 40 }],
        globalSlashCommands: ["compact", "review"]
      },
      workstream: workstream({
        enabledSlashCommands: [{ name: "compact", digest }]
      })
    });
    expect(slashCommandCompletions(fixture)).toEqual([
      { name: "compact", description: "The project's own.", insert: "/novus-project-skills:compact" },
      { name: "review", description: null, insert: "/review" }
    ]);
  });

  it("renders the machine's own skills as genuinely enableable rows (D-191, correcting D-186)", () => {
    // Measured against claude 2.1.237: these do NOT load by themselves under
    // the pinned argv, so Novus carries the enabled ones and the row is a
    // real control rather than a caption saying "always on".
    const fixture = detail({
      workspace: {
        ...workspaceWith([]),
        globalSkills: [
          { name: "unslop", description: "Cut AI tells.", digest, bytes: 40 },
          { name: "thermo", description: null, digest, bytes: 40, modelInvocable: false }
        ]
      },
      workstream: workstream({ enabledGlobalSkills: [{ name: "unslop", digest }] })
    });
    expect(globalSkillRows(fixture)).toEqual([
      { name: "unslop", description: "Cut AI tells.", state: "enabled", digest, modelInvocable: true },
      // Its SKILL.md forbids model invocation (D-192), so the row will say
      // it runs only when a person names it.
      { name: "thermo", description: null, state: "off", digest, modelInvocable: false }
    ]);
    expect(nextEnabledGlobalSkills(fixture, { enable: "thermo" })).toEqual([
      { name: "unslop", digest },
      { name: "thermo", digest }
    ]);
    expect(nextEnabledGlobalSkills(fixture, { disable: "unslop" })).toEqual([]);
    // No workspace published yet: this machine has offered nothing.
    expect(globalSkillRows(detail())).toEqual([]);
  });
});

describe("the lane's MCP servers surface (D-119)", () => {
  const digest = "d".repeat(64);
  it("describes each server by its observable behavior, and the acts submit only what stands", () => {
    const fixture = detail({
      workspace: {
        workspaceId: "wsp_one",
        workstreamId: "wst_one",
        location: "local",
        readiness: "ready",
        portRangeStart: null,
        portRangeEnd: null,
        setupError: null,
        configuredAt: T(1),
        declared: [],
        declaredAt: T(1),
        mcpServers: [
          { name: "docs", transport: "stdio", command: "node mcp/docs.js", args: [], env: [], url: null, digest },
          { name: "search", transport: "http", command: null, args: [], env: [], url: "https://mcp.example.com/v1", digest }
        ]
      },
      workstream: workstream({ enabledMcpServers: [{ name: "docs", digest }] })
    });
    expect(mcpRows(fixture)).toEqual([
      { name: "docs", description: "runs node mcp/docs.js", state: "enabled", digest },
      { name: "search", description: "connects to mcp.example.com", state: "off", digest }
    ]);
    expect(nextEnabledMcp(fixture, { enable: "search" })).toEqual([
      { name: "docs", digest },
      { name: "search", digest }
    ]);
    expect(nextEnabledMcp(fixture, { disable: "docs" })).toEqual([]);
    expect(mcpRows(detail())).toEqual([]);
  });
});

/**
 * A workspace this machine kept rather than removed (D-181).
 *
 * The release refuses to delete uncommitted work, which is right — and until
 * this existed the refusal lived only in the event log, so a person closed a
 * mission, saw nothing, and had no idea their unsaved files were still sitting
 * in a folder. A protection nobody is told about is half a protection.
 *
 * Only `kept` earns a surface: released and absent are the workspace being
 * gone, which is what ending a mission is supposed to do.
 */
describe("a workspace kept because work was uncommitted", () => {
  const released = (outcome: string, uncommitted: number, workstreamId = "wst_one") => ({
    eventId: `evt_${outcome}_${uncommitted}`,
    missionId: "msn_one",
    workstreamId,
    executionId: null,
    seq: 90 + uncommitted,
    kind: "workspace.released",
    actor: { kind: "runner", id: "rnr_one", login: null },
    cause: { directionId: null, leaseId: null, offerId: null },
    payload: { outcome, reason: null, uncommitted, attachmentsRemoved: 0 },
    schemaVersion: 1,
    occurredAt: T(9),
    recordedAt: T(9)
  });

  it("says so, with the count, when the machine kept it", () => {
    const view = detail({ events: [released("kept", 3)] });
    expect(keptWorkspace(view, "wst_one")).toEqual({ uncommitted: 3 });
  });

  it("says nothing when the workspace was removed as it should be", () => {
    expect(keptWorkspace(detail({ events: [released("released", 0)] }), "wst_one")).toBeNull();
    expect(keptWorkspace(detail({ events: [released("absent", 0)] }), "wst_one")).toBeNull();
  });

  it("says nothing before a mission has ended at all", () => {
    expect(keptWorkspace(detail(), "wst_one")).toBeNull();
  });

  it("takes the newest answer, because a close can be attempted twice", () => {
    // Kept first, then settled and removed: the lane is clean now, and a
    // surface still saying otherwise would send somebody looking for a folder
    // that is gone.
    const view = detail({ events: [released("kept", 3), released("released", 0)] });
    expect(keptWorkspace(view, "wst_one")).toBeNull();
  });

  it("never reports another lane's workspace", () => {
    const view = detail({ events: [released("kept", 2, "wst_other")] });
    expect(keptWorkspace(view, "wst_one")).toBeNull();
  });
});
