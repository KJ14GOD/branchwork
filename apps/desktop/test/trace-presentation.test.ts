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

describe("the turn as it happened (D-203)", () => {
  it("keeps activity where it happened, so speech is never fused across the actions it narrates", () => {
    // Owner-hit on a fan-out turn: every step was lifted into one end-of-turn
    // disclosure, so a dozen messages that each arrived between actions fused
    // into one wall, and "let me verify that" sat hundreds of steps from the
    // verification it meant.
    const block = trace(
      detail([
        { kind: "harness.text", payload: { text: "Let me check the gate." } },
        { kind: "harness.tool", payload: { tool: "Read", detail: "scripts/gate.sh", toolUseId: "t1" } },
        { kind: "harness.tool", payload: { tool: "Read", detail: "scripts/gate.sh", toolUseId: "t2" } },
        { kind: "harness.tool", payload: { tool: "Bash", detail: "grep -c '^## D-' DECISIONS.md", toolUseId: "t3" } },
        { kind: "harness.text", payload: { text: "Confirmed: an existence check." } },
        { kind: "harness.text", payload: { text: "Moving on." } }
      ])
    );
    expect(block.segments.map((segment) => segment.kind)).toEqual(["harness", "activity", "harness"]);
    const [before, run, after] = block.segments;
    expect(before.kind === "harness" && before.texts).toEqual(["Let me check the gate."]);
    expect(run.kind === "activity" && run.steps.map((step) => step.label)).toEqual(["Read", "Read", "Bash"]);
    // Two texts with nothing between them are still one utterance.
    expect(after.kind === "harness" && after.texts).toEqual(["Confirmed: an existence check.", "Moving on."]);
    // The flat list still counts everything, for the record.
    expect(block.toolSteps).toHaveLength(3);
  });

  it("places a spawn where it happened, and groups consecutive spawns as one row group", () => {
    const block = trace(
      detail([
        { kind: "harness.text", payload: { text: "Fanning out." } },
        spawn("toolu_task_1", "Audit the control plane"),
        spawn("toolu_task_2", "Audit the desktop"),
        { kind: "harness.text", payload: { text: "Two agents running." } },
        childTool("toolu_task_1", "Read", "src/main.ts")
      ])
    );
    expect(block.segments.map((segment) => segment.kind)).toEqual(["harness", "workers", "harness"]);
    const rows = block.segments[1];
    expect(rows.kind === "workers" && rows.ids).toEqual(["toolu_task_1", "toolu_task_2"]);
    // A worker's own step joins the worker, never the turn's stream.
    expect(block.workers[0].steps).toHaveLength(1);
  });
});

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

  it("keeps a worker joined across a direction applied mid-turn (D-200)", () => {
    // Hit in the wild: steering a running turn applies a direction, which
    // opens a *new* trace block, and the subagent still working reports under
    // the same spawn id from then on. Looked up per block, its later steps and
    // its end landed in the new block as anonymous grouped activity — so the
    // worker view a person had open stopped growing while the room around it
    // plainly moved.
    const block = trace(
      detail([
        spawn("toolu_task_1", "Survey the repository"),
        childTool("toolu_task_1", "Read", "src/one.ts"),
        // Everything from here carries the second direction's cause.
        { ...childTool("toolu_task_1", "Read", "src/two.ts"), cause: { directionId: "dir_2", leaseId: null } },
        { ...childSaid("toolu_task_1", "Still reading."), cause: { directionId: "dir_2", leaseId: null } },
        { ...ended("toolu_task_1", false, "Twelve files summarized."), cause: { directionId: "dir_2", leaseId: null } }
      ])
    );
    // The worker stays where it was spawned, and it keeps growing there.
    expect(block.workers).toHaveLength(1);
    expect(block.workers[0].steps.map((step) => step.detail)).toEqual([
      "src/one.ts",
      "src/two.ts",
      "Still reading."
    ]);
    expect(block.workers[0].ended?.report).toBe("Twelve files summarized.");
    // And none of it leaked into the trace as unattributed activity.
    expect(block.toolSteps).toEqual([]);
  });

  it("carries a background worker's stated usage into the view, and nothing where none was stated (D-202)", () => {
    const block = trace(
      detail([
        spawn("toolu_bg_1", "Count lines"),
        {
          kind: "harness.worker.ended",
          payload: { toolUseId: "toolu_bg_1", failed: false, report: "2", usage: { totalTokens: 15972, toolUses: 1, durationMs: 4182 } }
        }
      ])
    );
    expect(block.workers[0].ended?.usage).toEqual({ totalTokens: 15972, toolUses: 1, durationMs: 4182 });
  });

  it("recognizes a spawn under the CLI's newer tool name, Agent (D-205)", () => {
    const block = trace(
      detail([
        {
          kind: "harness.tool",
          payload: { tool: "Agent", detail: "Survey the renderer", parentToolUseId: null, toolUseId: "toolu_agent_1" }
        },
        childTool("toolu_agent_1", "Read", "src/screens/project-room.tsx"),
        ended("toolu_agent_1", false, "One screen owns the room.")
      ])
    );
    expect(block.workers).toHaveLength(1);
    expect(block.workers[0].purpose).toBe("Survey the renderer");
    expect(block.workers[0].steps.map((step) => step.label)).toEqual(["Read"]);
    expect(block.workers[0].ended?.report).toBe("One screen owns the room.");
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
    // `usage: null` is "nothing stated" (D-202): a synchronous spawn's result
    // carries no figures, and none are invented.
    expect(done.ended).toEqual({ failed: false, report: "All 14 tests pass.", at: done.ended?.at, usage: null });
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

  it("states carried and dropped slash commands the same way (D-187)", () => {
    const block = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            slashCommands: ["relnotes"],
            slashCommandsDropped: [{ name: "deploy", reason: "changed since it was enabled" }]
          }
        }
      ])
    );
    const notes = block.segments.filter((segment) => segment.kind === "note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ text: "Slash commands carried: relnotes", tone: "neutral" });
    expect(notes[1]).toMatchObject({
      text: 'Slash command not carried — "deploy": changed since it was enabled',
      tone: "warn"
    });
  });

  it("states carried and dropped MCP servers the same way (D-119)", () => {
    const block = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            mcpServers: ["docs"],
            mcpServersDropped: [{ name: "search", reason: "changed since it was enabled" }]
          }
        }
      ])
    );
    const notes = block.segments.filter((segment) => segment.kind === "note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ text: "MCP servers carried: docs", tone: "neutral" });
    expect(notes[1]).toMatchObject({
      text: 'MCP server not carried — "search": changed since it was enabled',
      tone: "warn"
    });
  });

  it("names the accounts a turn carried, stripping the claude.ai prefix (D-217)", () => {
    const block = trace(
      detail([
        {
          kind: "execution.running",
          payload: {
            harness: "claude-code",
            model: "claude-fable-5",
            effort: "high",
            connectors: ["claude.ai Gmail", "claude.ai Google Drive"]
          }
        }
      ])
    );
    const notes = block.segments.filter((segment) => segment.kind === "note");
    // No runner owner on this fixture, so no "— {who}'s" suffix; the accounts
    // themselves read by their service names.
    expect(notes.some((note) => note.text === "Accounts carried: Gmail, Google Drive")).toBe(true);
    expect(notes.find((note) => note.text.startsWith("Accounts carried"))?.tone).toBe("neutral");
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

describe("a built-in command's answer is a printout (D-216)", () => {
  const withBuiltins = (body: string): MissionDetailResponse => {
    const base = detail([]);
    return MissionDetailResponseSchema.parse({
      ...base,
      directions: [{ ...base.directions[0]!, body }],
      workspace: {
        workspaceId: "wsp_one",
        workstreamId: "wst_one",
        location: "local",
        readiness: "ready",
        portRangeStart: null,
        portRangeEnd: null,
        setupError: null,
        configuredAt: null,
        declared: [],
        declaredAt: null,
        globalSlashCommands: ["usage", "compact"]
      }
    });
  };

  it("marks a turn that invoked one of the harness's own commands, and nothing else", () => {
    expect(trace(withBuiltins("/usage")).printout).toBe(true);
    expect(trace(withBuiltins("/usage --verbose")).printout).toBe(true);
    // A project command is a prompt template; its answer is prose.
    expect(trace(withBuiltins("/novus-project-skills:relnotes now")).printout).toBe(false);
    // Words are words.
    expect(trace(withBuiltins("usage looks high, check it")).printout).toBe(false);
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
