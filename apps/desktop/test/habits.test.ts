import { describe, expect, it } from "vitest";
import { habitWords, readHabits, winnerOf, WINDOW, MAJORITY } from "../src/habits";

/** The room's habits (D-258): the majority rule, and a store read leniently. */
describe("habits (D-258)", () => {
  it("adopts a choice that wins five of the last seven, and nothing less", () => {
    expect(winnerOf(["changes", "changes", "changes", "changes", "changes"])).toBe("changes");
    expect(winnerOf(["changes", "changes", "changes", "changes"])).toBe(null);
    expect(winnerOf(["changes", "overview", "changes", "overview", "changes", "overview", "changes"])).toBe(null);
    expect(winnerOf(["overview", "overview", "changes", "changes", "changes", "changes", "changes"])).toBe("changes");
    // Only the last seven count: five old "changes" are outrun by newer "overview".
    expect(winnerOf(["changes", "changes", "changes", "changes", "changes", "overview", "overview", "overview", "overview"])).toBe(null);
    expect(WINDOW).toBe(7);
    expect(MAJORITY).toBe(5);
  });

  it("reads a stored state leniently", () => {
    const state = readHabits(JSON.stringify({
      noticing: false,
      observed: { firstSection: ["changes", "bogus", "overview"], panelOnFinish: "not a list" },
      adopted: { terminalOnRun: { value: "yes", told: "maybe" }, firstSection: { value: "nope" } },
      pinned: { panelOnFinish: true, firstSection: "yes" }
    }));
    expect(state.noticing).toBe(false);
    expect(state.observed.firstSection).toEqual(["changes", "overview"]);
    expect(state.observed.panelOnFinish).toEqual([]);
    expect(state.adopted.terminalOnRun).toEqual({ value: "yes", told: false });
    expect(state.adopted.firstSection).toBeUndefined();
    expect(state.pinned).toEqual({ panelOnFinish: true });
    expect(readHabits(null).noticing).toBe(true);
    expect(readHabits("garbage").observed.terminalOnRun).toEqual([]);
  });

  it("says each adoption in words", () => {
    expect(habitWords("firstSection", "changes")).toBe("The evidence panel opens on Changes first");
    expect(habitWords("panelOnFinish", "yes")).toBe("The evidence panel opens when a turn finishes");
    expect(habitWords("terminalOnRun", "no")).toBe("The terminal stays closed when a run starts");
  });
});
