import { describe, expect, it } from "vitest";
import { MissionSchema, type Mission } from "@novus/contracts";
import { boardColumnOf, boardColumns } from "../src/components/derive";
import { boardCardLine } from "../src/components/home-board";
import { agoLabel } from "../src/format";

/**
 * The Home board's projections (D-120): which computed column a mission's own
 * projected state puts it in, the glance order inside a column, and the card's
 * one colored line. Renderer derivations only; every fixture parses through
 * the contract schema so a shape invented here cannot drift from the wire.
 */

const T = (minute: number) => `2026-08-13T09:${String(minute).padStart(2, "0")}:00.000Z`;

function mission(overrides: Record<string, unknown> = {}): Mission {
  return MissionSchema.parse({
    missionId: "msn_one",
    orgId: "org_one",
    goal: "Add a health endpoint",
    successCriteria: "GET /health answers 200",
    primaryState: "ready_for_instruction",
    createdBy: "usr_kartik",
    createdByLogin: "kartik",
    createdAt: T(0),
    repository: {
      repoId: "rep_one",
      provider: "local",
      providerRepoId: "local-1",
      name: "novus/local",
      defaultBranch: "main"
    },
    archivedAt: null,
    archivedByLogin: null,
    attention: null,
    ...overrides
  });
}

describe("which column a mission lands in", () => {
  it("maps the projected state and nothing else — the server's precedence already decided", () => {
    expect(boardColumnOf(mission({ primaryState: "needs_approval" }))).toBe("needs_you");
    expect(boardColumnOf(mission({ primaryState: "verification_failed" }))).toBe("needs_you");
    expect(boardColumnOf(mission({ primaryState: "agent_running" }))).toBe("running");
    expect(boardColumnOf(mission({ primaryState: "provisioning_workspace" }))).toBe("running");
    expect(boardColumnOf(mission({ primaryState: "decision_recorded" }))).toBe("decided");
    expect(boardColumnOf(mission({ primaryState: "pull_request_open" }))).toBe("decided");
    expect(boardColumnOf(mission({ primaryState: "ready_for_instruction" }))).toBe("waiting");
    expect(boardColumnOf(mission({ primaryState: "work_completed_unverified" }))).toBe("waiting");
    // Terminal is a person's own fact (D-121), and nothing outranks it.
    expect(boardColumnOf(mission({ primaryState: "completed" }))).toBe("complete");
    expect(boardColumnOf(mission({ primaryState: "cancelled" }))).toBe("complete");
  });

  it("words a finished card quietly, with the person who ended it", () => {
    expect(
      boardCardLine(
        mission({ primaryState: "completed", closedOutcome: "completed", closedByLogin: "kartik" })
      )
    ).toEqual({ text: "completed by kartik — receipt saved", tone: "quiet" });
    expect(
      boardCardLine(
        mission({ primaryState: "cancelled", closedOutcome: "cancelled", closedByLogin: "maya" })
      )?.text
    ).toBe("cancelled by maya");
  });

  it("orders a column by last activity, newest first, with creation as the fallback", () => {
    const columns = boardColumns([
      mission({ missionId: "msn_stale", lastActivityAt: T(1) }),
      mission({ missionId: "msn_fresh", lastActivityAt: T(30) }),
      mission({ missionId: "msn_silent", createdAt: T(10), lastActivityAt: null })
    ]);
    const waiting = columns.find((column) => column.id === "waiting");
    expect(waiting?.missions.map((row) => row.missionId)).toEqual([
      "msn_fresh",
      "msn_silent",
      "msn_stale"
    ]);
    // Column order is fixed: what needs you first, the finished work last.
    expect(columns.map((column) => column.id)).toEqual([
      "needs_you",
      "running",
      "waiting",
      "decided",
      "complete"
    ]);
  });
});

describe("the card's one colored line", () => {
  it("names the attention and where it is, the lane only once siblings exist", () => {
    const single = boardCardLine(
      mission({
        primaryState: "needs_approval",
        attention: {
          workstreamId: "wst_one",
          workstreamName: "Current work",
          sessionId: "csn_one",
          sessionTitle: "add tests"
        }
      })
    );
    expect(single).toEqual({ text: "waiting for an approval — “add tests”", tone: "warn" });
    const forked = boardCardLine(
      mission({
        primaryState: "needs_approval",
        workstreamCount: 2,
        attention: {
          workstreamId: "wst_two",
          workstreamName: "Alternative",
          sessionId: "csn_two",
          sessionTitle: "add tests"
        }
      })
    );
    expect(forked?.text).toBe("waiting for an approval — Alternative · “add tests”");
  });

  it("says what runs quietly, what was decided plainly, and nothing for a plain wait", () => {
    const running = boardCardLine(
      mission({
        primaryState: "agent_running",
        working: {
          workstreamId: "wst_one",
          workstreamName: "Current work",
          sessionId: "csn_one",
          sessionTitle: "wire the endpoint"
        }
      })
    );
    expect(running).toEqual({ text: "working — “wire the endpoint”", tone: "quiet" });
    expect(boardCardLine(mission({ primaryState: "decision_recorded" }))?.text).toBe(
      "decision recorded — not published yet"
    );
    expect(boardCardLine(mission({ primaryState: "ready_for_instruction" }))).toBeNull();
  });
});

describe("the card's relative time", () => {
  it("speaks the glance grammar: now, minutes, hours, days, then the short date", () => {
    const now = Date.parse(T(30));
    expect(agoLabel(T(30), now)).toBe("now");
    expect(agoLabel(T(20), now)).toBe("10m");
    expect(agoLabel("2026-08-13T05:30:00.000Z", now)).toBe("4h");
    expect(agoLabel("2026-08-10T09:30:00.000Z", now)).toBe("3d");
    expect(agoLabel("2026-07-26T09:30:00.000Z", now)).toMatch(/Jul/);
  });
});
