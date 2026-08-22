import { describe, expect, it } from "vitest";
import { cycleKey } from "../src/components/rail-cycle";

/** The rail is a ring (D-212): ⌃⇥ walks its projects, wrapping. */
describe("walking the rail's projects", () => {
  const keys = ["local:alpha", "local:beta", "gh:gamma"];

  it("moves in rail order and wraps at both ends", () => {
    expect(cycleKey(keys, "local:alpha", 1)).toBe("local:beta");
    expect(cycleKey(keys, "gh:gamma", 1)).toBe("local:alpha");
    expect(cycleKey(keys, "local:alpha", -1)).toBe("gh:gamma");
  });

  it("lands on an end when nothing is selected, and goes nowhere with nothing listed", () => {
    expect(cycleKey(keys, null, 1)).toBe("local:alpha");
    expect(cycleKey(keys, null, -1)).toBe("gh:gamma");
    // A selection the rail no longer lists is treated as none.
    expect(cycleKey(keys, "local:gone", 1)).toBe("local:alpha");
    expect(cycleKey([], "local:alpha", 1)).toBeNull();
  });
});
