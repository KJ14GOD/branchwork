import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODELS,
  CreateMissionInputSchema,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EventSchema,
  IpcAuthStatusSchema,
  IpcDirectInputSchema,
  MissionSchema,
  ModelIdSchema,
  ReportRunnerEventsInputSchema,
  RunnerEventSchema
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
