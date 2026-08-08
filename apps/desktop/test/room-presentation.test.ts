import { describe, expect, it } from "vitest";
import { MissionDetailResponseSchema, type MissionDetailResponse } from "@novus/contracts";
import {
  contestedAcrossSessions,
  controller,
  deriveStateLine,
  laneView,
  offerCountdownLabel,
  pendingDirections,
  queuedPositionLabel,
  runningSession,
  sessionActivity,
  sessionChangedFiles,
  sessionNeedsYou,
  sessionView,
  viewerIsController
} from "../src/components/derive";

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
