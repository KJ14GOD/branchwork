import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODELS,
  CapabilitySchema,
  CreateMissionInputSchema,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DirectionInputSchema,
  DirectionSchema,
  EventSchema,
  ExecutionSchema,
  IpcAuthStatusSchema,
  IpcDirectInputSchema,
  MAX_APPROVAL_SUMMARY,
  MissionSchema,
  ModelIdSchema,
  ReportRunnerEventsInputSchema,
  RespondApprovalInputSchema,
  RunnerEventSchema,
  SessionSchema
} from "../src/index.js";

describe("contracts", () => {
  it("rejects a mission with an empty goal", () => {
    expect(CreateMissionInputSchema.safeParse({ goal: "  ", successCriteria: "x" }).success).toBe(false);
  });

  it("rejects a mission over the goal length ceiling", () => {
    expect(
      CreateMissionInputSchema.safeParse({ goal: "g".repeat(501), successCriteria: "x" }).success
    ).toBe(false);
  });

  it("accepts a canonical mission shape", () => {
    const parsed = MissionSchema.safeParse({
      missionId: "msn_abc",
      orgId: "org_abc",
      goal: "Rotate signing keys",
      successCriteria: "All services on the new key; old key revoked",
      primaryState: "new_mission",
      createdBy: "usr_abc",
      createdByLogin: "kartik",
      createdAt: new Date().toISOString(),
      // In the ordinary list: not filed away, by nobody (D-063).
      archivedAt: null,
      archivedByLogin: null,
      repository: {
        repoId: "rep_abc",
        provider: "github",
        providerRepoId: "9001",
        name: "novus/demo-app",
        defaultBranch: "main"
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a canonical session shape, and refuses the auth session's prefix", () => {
    const session = {
      sessionId: "csn_abc",
      workstreamId: "wst_abc",
      // Untitled until its first direction: a title is words, never a field.
      title: null,
      createdBy: "usr_abc",
      createdByLogin: "kartik",
      createdAt: new Date().toISOString()
    };
    expect(SessionSchema.safeParse(session).success).toBe(true);
    // `ses_` has always been the auth session's; a conversation is `csn_`, and
    // the two must never parse as each other (D-083).
    expect(SessionSchema.safeParse({ ...session, sessionId: "ses_abc" }).success).toBe(false);
  });

  it("pins every direction and execution to a session, and carries a named session through input", () => {
    const direction = {
      directionId: "dir_abc",
      workstreamId: "wst_abc",
      sessionId: "csn_abc",
      authorUserId: "usr_abc",
      authorLogin: "kartik",
      body: "Keep going",
      state: "queued",
      ordinal: 1,
      submittedAt: new Date().toISOString(),
      appliedAt: null,
      resolutionReason: null,
      consumedByExecutionId: null
    };
    expect(DirectionSchema.safeParse(direction).success).toBe(true);
    // A direction without a session would be a thread belonging to nobody —
    // rows from before sessions are migrated, never nulled (D-083).
    const unpinned: Record<string, unknown> = { ...direction };
    delete unpinned.sessionId;
    expect(DirectionSchema.safeParse(unpinned).success).toBe(false);

    const execution = {
      executionId: "exe_abc",
      workstreamId: "wst_abc",
      sessionId: "csn_abc",
      harness: "claude-code",
      model: "claude-fable-5",
      effort: "high",
      runnerId: null,
      startingDirectionId: null,
      state: "running",
      startedBy: "usr_abc",
      startedByLogin: "kartik",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      harnessSessionId: null,
      resumedSession: false,
      exitOutcome: null,
      failureReason: null,
      latestCheckpointSha: null,
      usage: {}
    };
    expect(ExecutionSchema.safeParse(execution).success).toBe(true);
    expect(ExecutionSchema.safeParse({ ...execution, sessionId: undefined }).success).toBe(false);

    // Naming a session survives the parse, and asking for none asks for none:
    // `newSession` defaults off so nothing that predates sessions changes.
    const input = DirectionInputSchema.safeParse({ body: "Keep going", sessionId: "csn_abc" });
    expect(input.success && input.data.sessionId).toBe("csn_abc");
    expect(input.success && input.data.newSession).toBe(false);
  });

  it("rejects an event with an unattributed actor", () => {
    const parsed = EventSchema.safeParse({
      eventId: "evt_1",
      missionId: "msn_1",
      seq: 1,
      kind: "mission.created",
      actor: { kind: "nobody", id: "x" },
      cause: { directionId: null, leaseId: null },
      executionId: null,
      payload: {},
      schemaVersion: 1,
      occurredAt: new Date().toISOString()
    });
    expect(parsed.success).toBe(false);
  });

  it("only admits declared auth states across IPC", () => {
    expect(IpcAuthStatusSchema.safeParse({ state: "signed_out" }).success).toBe(true);
    expect(IpcAuthStatusSchema.safeParse({ state: "mystery" }).success).toBe(false);
  });
});

describe("the model allowlist", () => {
  // These six ids were each verified live against the Claude Code CLI. The
  // renderer, the IPC boundary, and the execution adapter must all read the
  // same list, or a menu entry becomes a flag the CLI rejects.
  it("keeps the labelled list and the validated enum identical and in order", () => {
    expect(ModelIdSchema.options).toEqual(CLAUDE_MODELS.map((model) => model.id));
  });

  it("refuses a model id that is not on the list", () => {
    expect(ModelIdSchema.safeParse("claude-opus-9").success).toBe(false);
    expect(ModelIdSchema.safeParse("sonnet").success).toBe(false);
  });

  it("defaults direction to an allowlisted model and effort", () => {
    const parsed = IpcDirectInputSchema.safeParse({ missionId: "msn_1", body: "do the thing" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.model).toBe(DEFAULT_MODEL);
    expect(parsed.data.effort).toBe(DEFAULT_EFFORT);
    expect(ModelIdSchema.options).toContain(DEFAULT_MODEL);
  });
});

describe("the runner event union", () => {
  // A runner may only say things Novus has a shape for. Arbitrary kinds are how
  // a compromised runner would write whatever it liked into the durable record.
  it("refuses an undeclared event kind", () => {
    expect(RunnerEventSchema.safeParse({ kind: "harness.thoughts", payload: {} }).success).toBe(false);
    expect(RunnerEventSchema.safeParse({ kind: "mission.created", payload: {} }).success).toBe(false);
  });

  it("refuses unknown fields inside a declared payload", () => {
    const parsed = RunnerEventSchema.safeParse({
      kind: "harness.text",
      payload: { text: "hello", secret: "shh" }
    });
    expect(parsed.success).toBe(false);
  });

  it("bounds harness text", () => {
    expect(
      RunnerEventSchema.safeParse({ kind: "harness.text", payload: { text: "x".repeat(8_001) } }).success
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({ kind: "harness.text", payload: { text: "x".repeat(8_000) } }).success
    ).toBe(true);
  });

  it("bounds a checkpoint's file count and per-file diff", () => {
    const file = {
      path: "src/a.ts",
      changeState: "modified",
      additions: 1,
      deletions: 0,
      diff: "x".repeat(12_001)
    };
    const payload = {
      outcome: "committed",
      branch: "novus/m-1",
      files: [file]
    };
    expect(RunnerEventSchema.safeParse({ kind: "workspace.checkpoint", payload }).success).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        kind: "workspace.checkpoint",
        payload: { ...payload, files: Array.from({ length: 151 }, () => ({ ...file, diff: "ok" })) }
      }).success
    ).toBe(false);
  });

  it("requires a classified failure rather than free text", () => {
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.failed",
        payload: { classification: "vibes", reason: "it broke" }
      }).success
    ).toBe(false);
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.failed",
        payload: { classification: "nonzero_exit", reason: "exit 1" }
      }).success
    ).toBe(true);
  });

  it("bounds a harness approval's summary, and keeps its raw input out of the shape", () => {
    const payload = {
      requestId: "21740bb3-0000-0000-0000-000000000000",
      toolUseId: "toolu_01",
      toolName: "Write",
      displayName: "Write",
      summary: "the mission worktree/PROBE.md"
    };
    expect(RunnerEventSchema.safeParse({ kind: "approval.requested", payload }).success).toBe(true);
    // A file's contents can be megabytes. What travels is a summary.
    expect(
      RunnerEventSchema.safeParse({
        kind: "approval.requested",
        payload: { ...payload, summary: "x".repeat(MAX_APPROVAL_SUMMARY + 1) }
      }).success
    ).toBe(false);
    // `.strict()`: a runner cannot smuggle the tool input alongside it.
    expect(
      RunnerEventSchema.safeParse({
        kind: "approval.requested",
        payload: { ...payload, input: { file_path: "/Users/someone/.ssh/id_rsa", content: "-----BEGIN" } }
      }).success
    ).toBe(false);
  });

  it("names which path ended a stopped turn, and defaults to the forced one", () => {
    const graceful = RunnerEventSchema.safeParse({
      kind: "execution.stopped",
      payload: { reason: "Stopped by a participant.", via: "protocol_interrupt" }
    });
    expect(graceful.success && graceful.data.payload).toEqual({
      reason: "Stopped by a participant.",
      via: "protocol_interrupt"
    });
    // An older runner that says nothing is read as the kill it was doing.
    const legacy = RunnerEventSchema.safeParse({
      kind: "execution.stopped",
      payload: { reason: "Stopped by a participant." }
    });
    expect(legacy.success && legacy.data.payload.via).toBe("process_signal");
    expect(
      RunnerEventSchema.safeParse({
        kind: "execution.stopped",
        payload: { reason: "x", via: "vibes" }
      }).success
    ).toBe(false);
  });

  it("gives approval.respond to the lease and to no role", () => {
    // The capability exists as an enforceable verb, and PRODUCT.md's table puts
    // it in the lease column alone. The server-side half of that is asserted in
    // the control-plane suite; this only pins the vocabulary.
    expect(CapabilitySchema.safeParse("approval.respond").success).toBe(true);
    expect(RespondApprovalInputSchema.safeParse({ decision: "approve" }).success).toBe(true);
    expect(RespondApprovalInputSchema.safeParse({ decision: "deny", reason: "not that file" }).success).toBe(
      true
    );
    // There is no third answer: no "always allow", and nothing remembered.
    expect(RespondApprovalInputSchema.safeParse({ decision: "always_allow" }).success).toBe(false);
  });

  it("requires a positive origin sequence on every reported event", () => {
    const ok = ReportRunnerEventsInputSchema.safeParse({
      executionId: "exe_1",
      events: [{ originSeq: 1, event: { kind: "execution.starting", payload: {} } }]
    });
    expect(ok.success).toBe(true);
    const bad = ReportRunnerEventsInputSchema.safeParse({
      executionId: "exe_1",
      events: [{ originSeq: 0, event: { kind: "execution.starting", payload: {} } }]
    });
    expect(bad.success).toBe(false);
  });
});
