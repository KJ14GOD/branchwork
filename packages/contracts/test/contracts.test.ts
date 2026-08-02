import { describe, expect, it } from "vitest";
import {
  CreateMissionInputSchema,
  EventSchema,
  IpcAuthStatusSchema,
  MissionSchema
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
      createdAt: new Date().toISOString()
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
