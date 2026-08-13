import { describe, expect, it } from "vitest";
import { MissionDetailResponseSchema, type MissionDetailResponse } from "@novus/contracts";
import { buildFeed, workerFiles, workerState } from "../src/components/direction-trace";

/**
 * The trace's worker projection (D-107): a turn's tagged subagent activity
 * grouped by the ids the stream stated — the spawn joined to its children,
 * the end to its spawn — with everything unprovable left exactly as grouped
 * activity. Renderer derivations only; every fixture parses through the
 * contract schema so a shape invented here cannot drift from the wire.
 */

const T = (minute: number) => `2026-08-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
const SHA = "a".repeat(40);
const KARTIK = "usr_kartik";

function direction(overrides: Record<string, unknown> = {}) {
  return {
    directionId: "dir_1",
    workstreamId: "wst_one",
    sessionId: "csn_one",
    authorUserId: KARTIK,
    authorLogin: "kartik",
    body: "Refactor the auth module",
    state: "applied",
    ordinal: 1,
    submittedAt: T(1),
    appliedAt: T(2),
    resolutionReason: null,
    consumedByExecutionId: "exe_1",
    ...overrides
  };
}

let seq = 0;
function event(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    eventId: `evt_${seq}`,
    missionId: "msn_one",
    seq,
    kind: "harness.text",
    actor: { kind: "harness", id: "claude-code", login: null },
    cause: { directionId: "dir_1", leaseId: null },
    executionId: "exe_1",
    workstreamId: "wst_one",
    payload: {},
    schemaVersion: 1,
    occurredAt: T(seq + 2),
    ...overrides
  };
}

function detail(events: Record<string, unknown>[]): MissionDetailResponse {
  seq = 0;
  const built = events.map((overrides) => event(overrides));
  return MissionDetailResponseSchema.parse({
    mission: {
      missionId: "msn_one",
      orgId: "org_one",
      goal: "Refactor the auth module",
      successCriteria: "Tests stay green",
      primaryState: "agent_running",
      createdBy: KARTIK,
      createdByLogin: "kartik",
      createdAt: T(0),
      repository: null,
      archivedAt: null,
      archivedByLogin: null,
      attention: null
    },
    workstream: {
      workstreamId: "wst_one",
      missionId: "msn_one",
      name: "Current work",
      baseRef: "main",
      baseSha: SHA,
      missionBranch: "novus/msn_one",
      branchStatus: "created",
      branchError: null
    },
    workstreams: [],
    sessions: [],
    approaches: [],
    contested: [],
    decisions: [],
    preparedPullRequest: null,
    events: built,
    participants: [],
    directions: [direction()],
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
    runner: null,
    workspace: null,
    processes: [],
    capabilities: [],
    viewerUserId: KARTIK,
    state: "agent_running",
    overlays: []
  });
}

const spawn = (id: string, description: string) => ({
  kind: "harness.tool",
  payload: { tool: "Task", detail: description, parentToolUseId: null, toolUseId: id }
});
const childTool = (parent: string, tool: string, detail: string) => ({
  kind: "harness.tool",
  payload: { tool, detail, parentToolUseId: parent, toolUseId: null }
});
const childSaid = (parent: string, text: string) => ({
  kind: "harness.text",
  payload: { text, parentToolUseId: parent }
});
const ended = (id: string, failed: boolean, report: string | null) => ({
  kind: "harness.worker.ended",
  payload: { toolUseId: id, failed, report }
});

function trace(feedDetail: MissionDetailResponse) {
  const block = buildFeed(feedDetail).blocks.find((candidate) => candidate.kind === "trace");
  if (!block || block.kind !== "trace") throw new Error("no trace block");
  return block;
}

describe("the harness's workers, joined from what the stream stated (D-107)", () => {
  it("groups a worker's tagged steps under the Task call that spawned it", () => {
    const block = trace(
      detail([
        spawn("toolu_task_1", "Research the repository"),
        childSaid("toolu_task_1", "Found three call sites."),
        childTool("toolu_task_1", "Grep", "authorize("),
        { kind: "harness.tool", payload: { tool: "Read", detail: "src/auth.ts", toolUseId: "t2" } }
      ])
    );
    expect(block.workers).toHaveLength(1);
    expect(block.workers[0].purpose).toBe("Research the repository");
    expect(block.workers[0].steps.map((step) => step.label)).toEqual(["said", "Grep"]);
    // The harness's own step stays a flat step; the Task spawn row moved into
    // the worker and is not duplicated as a flat step.
    expect(block.toolSteps.map((step) => step.label)).toEqual(["Read"]);
  });

  it("keeps two concurrent workers distinguishable by their own ids", () => {
    const block = trace(
      detail([
        spawn("toolu_task_1", "Run API tests"),
        spawn("toolu_task_2", "Review changed files"),
        childTool("toolu_task_2", "Read", "src/auth.ts"),
        childTool("toolu_task_1", "Read", "test/api.test.ts"),
        childSaid("toolu_task_1", "14 tests pass.")
      ])
    );
    expect(block.workers.map((worker) => worker.purpose)).toEqual([
      "Run API tests",
      "Review changed files"
    ]);
    expect(block.workers[0].steps.map((step) => step.detail)).toEqual([
      "test/api.test.ts",
      "14 tests pass."
    ]);
    expect(block.workers[1].steps.map((step) => step.detail)).toEqual(["src/auth.ts"]);
  });

  it("carries the end as stated — outcome flag and report — and words the states honestly", () => {
    const block = trace(
      detail([
        spawn("toolu_task_1", "Run API tests"),
        spawn("toolu_task_2", "Review changed files"),
        spawn("toolu_task_3", "Research the repository"),
        ended("toolu_task_1", false, "All 14 tests pass."),
        ended("toolu_task_2", true, "Agent crashed.")
      ])
    );
    const [done, failed, live] = block.workers;
    expect(done.ended).toEqual({ failed: false, report: "All 14 tests pass.", at: done.ended?.at });
    expect(workerState(done, block.settled)).toBe("done");
    expect(workerState(failed, block.settled)).toBe("failed");
    // No end has been stated and the turn is live: the worker is working.
    expect(workerState(live, block.settled)).toBe("working");
  });

  it("stops claiming `working` once the turn itself settled without the end arriving", () => {
    const block = trace(
      detail([
        spawn("toolu_task_1", "Research the repository"),
        { kind: "execution.completed", payload: {} }
      ])
    );
    expect(block.settled).toBe(true);
    // An unstated end is not a state: no word at all, never an invented one.
    expect(workerState(block.workers[0], block.settled)).toBeNull();
  });

  it("leaves activity whose parent joins to no recorded spawn as grouped activity, claiming nothing", () => {
    const block = trace(
      detail([
        childSaid("toolu_unknown", "Found three call sites."),
        childTool("toolu_unknown", "Grep", "authorize(")
      ])
    );
    expect(block.workers).toHaveLength(0);
    expect(block.toolSteps.map((step) => step.nested)).toEqual([true, true]);
  });

  it("renders nothing for an end whose start was never recorded", () => {
    const block = trace(detail([ended("toolu_never_seen", true, "boom")]));
    expect(block.workers).toHaveLength(0);
    expect(block.toolSteps).toHaveLength(0);
  });

  it("names a worker's files only from its own tool calls", () => {
    const block = trace(
      detail([
        spawn("toolu_task_1", "Apply the fix"),
        childTool("toolu_task_1", "Read", "src/auth.ts"),
        childTool("toolu_task_1", "Write", "src/auth.ts"),
        childTool("toolu_task_1", "Edit", "src/session.ts"),
        childTool("toolu_task_1", "Write", "src/auth.ts")
      ])
    );
    expect(workerFiles(block.workers[0])).toEqual(["src/auth.ts", "src/session.ts"]);
  });
});

describe("project skills in the room (D-118)", () => {
  it("states what the turn carried as apparatus, and says nothing when nothing was", () => {
    const carried = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            skills: ["zephyr-codes", "release-notes"],
            skillsDropped: []
          }
        }
      ])
    );
    const notes = carried.segments.filter((segment) => segment.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      text: "Project skills carried: zephyr-codes, release-notes",
      tone: "neutral"
    });

    const none = trace(
      detail([
        {
          kind: "execution.running",
          payload: { harness: "claude-code", model: "claude-fable-5", effort: "high" }
        }
      ])
    );
    expect(none.segments.filter((segment) => segment.kind === "note")).toHaveLength(0);
  });

  it("names a dropped skill with its reason, in the warn tone — a dead grant is news", () => {
    const block = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            skills: [],
            skillsDropped: [{ name: "zephyr-codes", reason: "changed since it was enabled" }]
          }
        }
      ])
    );
    const notes = block.segments.filter((segment) => segment.kind === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      text: 'Project skill not carried — "zephyr-codes": changed since it was enabled',
      tone: "warn"
    });
  });
});

describe("permission profiles in the room (D-115)", () => {
  it("puts the profile on the turn's machinery line, and says nothing for manual", () => {
    const profiled = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            permissionProfile: "accept_edits"
          }
        }
      ])
    );
    expect(profiled.machinery).toBe("claude-fable-5 · effort high · Accept edits");
    const manual = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            permissionProfile: "manual"
          }
        }
      ])
    );
    // Manual is the default and says nothing: the pre-profile line, exactly.
    expect(manual.machinery).toBe("claude-fable-5 · effort high");
  });

  it("renders a policy-decided answer as apparatus with the profile named, never as a card", () => {
    const block = trace(
      detail([
        {
          kind: "approval.policy",
          actor: { kind: "runner", id: "rnr_1", login: null },
          payload: {
            requestId: "req-1",
            toolName: "Write",
            decision: "allowed",
            profile: "accept_edits",
            summary: "Write NOTES.md"
          }
        }
      ])
    );
    expect(block.toolSteps).toHaveLength(1);
    expect(block.toolSteps[0].label).toBe("allowed by policy · Write");
    expect(block.toolSteps[0].detail).toBe("Write NOTES.md (Accept edits)");
  });

  it("says a plan refusal the same way, denied", () => {
    const block = trace(
      detail([
        {
          kind: "approval.policy",
          actor: { kind: "runner", id: "rnr_1", login: null },
          payload: {
            requestId: "req-1",
            toolName: "Write",
            decision: "denied",
            profile: "plan",
            summary: "Write NOTES.md"
          }
        }
      ])
    );
    expect(block.toolSteps[0].label).toBe("refused by policy · Write");
    expect(block.toolSteps[0].detail).toBe("Write NOTES.md (Plan)");
  });

  it("renders a profile change as the room's own sentence, with the dangerous one carrying its meaning", () => {
    const feed = buildFeed(
      detail([
        {
          kind: "policy.changed",
          actor: { kind: "user", id: KARTIK, login: "kartik" },
          cause: { directionId: null, leaseId: null },
          executionId: null,
          payload: { workstreamId: "wst_one", from: "manual", to: "plan", acknowledged: null }
        },
        {
          kind: "policy.changed",
          actor: { kind: "user", id: KARTIK, login: "kartik" },
          cause: { directionId: null, leaseId: null },
          executionId: null,
          payload: {
            workstreamId: "wst_one",
            from: "plan",
            to: "dont_ask",
            acknowledged: "Every act…"
          }
        }
      ])
    );
    const lines = feed.blocks
      .filter((block) => block.kind === "control")
      .map((block) => (block.kind === "control" ? block.text : ""));
    expect(lines[0]).toBe("kartik set permissions to Plan");
    expect(lines[1]).toBe(
      "kartik set permissions to Don't ask — every act the harness asks about is approved by policy, on the record"
    );
  });
});
