import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, readLayout } from "../src/layout";

/** A layout is read leniently (D-257): one bad field never costs the rest. */
describe("layout preferences (D-257)", () => {
  it("reads defaults from nothing and from noise", () => {
    expect(readLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(readLayout("not json")).toEqual(DEFAULT_LAYOUT);
    expect(readLayout(JSON.stringify({ dock: "ceiling", density: "dense", home: "kanban", motion: "bouncy", panel: "top" }))).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps every valid choice, and only those", () => {
    expect(readLayout(JSON.stringify({ dock: "left", panel: "left", density: "compact", home: "quiet", motion: "reduced" }))).toEqual({
      dock: "left",
      panel: "left",
      density: "compact",
      home: "quiet",
      motion: "reduced"
    });
    expect(readLayout(JSON.stringify({ density: "compact" })).dock).toBe("bottom");
  });
});
