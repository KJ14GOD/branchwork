import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerUseEnabled,
  fenceRefusal,
  handsAvailable,
  isEscapeShortcut,
  setComputerUseEnabled,
  type DesktopContext
} from "../electron/computer-use";

/**
 * The two structural guardrails on raw computer use (D-218), which are the
 * layers the owner's rule rests on: off by default and unreachable by the
 * agent, and a fence that refuses any action on Novus itself. Both are pure
 * logic and proven here without a Mac; the native input backend is the one
 * seam these do not cover, by design.
 */

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "novus-cu-"));
});
afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("the machine-local opt-in (D-218)", () => {
  it("is off until the machine's owner turns it on, and any read problem is off", () => {
    // Never set: off. The agent gets no hands on a machine nobody opted in.
    expect(computerUseEnabled(userData)).toBe(false);
    setComputerUseEnabled(userData, true);
    expect(computerUseEnabled(userData)).toBe(true);
    setComputerUseEnabled(userData, false);
    expect(computerUseEnabled(userData)).toBe(false);
    // A directory that does not exist reads as off rather than throwing.
    expect(computerUseEnabled(join(userData, "nope"))).toBe(false);
  });
});

describe("the structural fence (D-218, layer 2)", () => {
  const novusAt = (x: number, y: number): DesktopContext => ({
    novusWindows: [{ x, y, width: 400, height: 300 }],
    novusFrontmost: false
  });

  it("refuses a click that lands on a Novus window — its Approve button included", () => {
    const context = novusAt(100, 100);
    // Inside the Novus window: refused in words.
    expect(fenceRefusal({ kind: "point", x: 250, y: 200 }, context)).toContain("Novus");
    // Outside it — the app under test — allowed.
    expect(fenceRefusal({ kind: "point", x: 900, y: 700 }, context)).toBeNull();
    // On the exact edge counts as on Novus.
    expect(fenceRefusal({ kind: "point", x: 100, y: 100 }, context)).toContain("Novus");
  });

  it("refuses an ordinary keypress or typing while Novus is frontmost — it would go into the room", () => {
    expect(
      fenceRefusal({ kind: "key", combo: "a" }, { novusWindows: [], novusFrontmost: true })
    ).toContain("go to Novus");
    expect(
      fenceRefusal({ kind: "type" }, { novusWindows: [], novusFrontmost: true })
    ).toContain("typing would go into Novus");
    // With Novus in the background, both go to the app under test.
    expect(fenceRefusal({ kind: "key", combo: "a" }, { novusWindows: [], novusFrontmost: false })).toBeNull();
    expect(fenceRefusal({ kind: "type" }, { novusWindows: [], novusFrontmost: false })).toBeNull();
  });

  it("lets the two 'leave Novus' shortcuts through even while Novus is front (D-218 amended)", () => {
    const front = { novusWindows: [] as never[], novusFrontmost: true };
    // The agent's way off Novus: allowed even with Novus in front.
    expect(fenceRefusal({ kind: "key", combo: "cmd+space" }, front)).toBeNull();
    expect(fenceRefusal({ kind: "key", combo: "cmd+tab" }, front)).toBeNull();
    expect(fenceRefusal({ kind: "key", combo: "command+space" }, front)).toBeNull();
    // A harmful combo is NOT an escape and stays fenced while Novus is front.
    expect(fenceRefusal({ kind: "key", combo: "cmd+w" }, front)).toContain("go to Novus");
    expect(fenceRefusal({ kind: "key", combo: "cmd+q" }, front)).toContain("go to Novus");
  });

  it("always allows a screenshot — reading the screen presses nothing", () => {
    expect(
      fenceRefusal({ kind: "screenshot" }, { novusWindows: [{ x: 0, y: 0, width: 9999, height: 9999 }], novusFrontmost: true })
    ).toBeNull();
  });

  it("checks every Novus window, not just the first (several may be open)", () => {
    const context: DesktopContext = {
      novusWindows: [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 500, y: 500, width: 100, height: 100 }
      ],
      novusFrontmost: false
    };
    expect(fenceRefusal({ kind: "point", x: 550, y: 550 }, context)).toContain("Novus");
    expect(fenceRefusal({ kind: "point", x: 300, y: 300 }, context)).toBeNull();
  });
});

describe("when the agent actually has hands (D-218)", () => {
  it("needs macOS, a native backend, and Accessibility — all three, or only eyes", () => {
    expect(handsAvailable({ isMac: true, backendPresent: true, accessibilityTrusted: true })).toBe(true);
    // Any one missing: no hands.
    expect(handsAvailable({ isMac: false, backendPresent: true, accessibilityTrusted: true })).toBe(false);
    expect(handsAvailable({ isMac: true, backendPresent: false, accessibilityTrusted: true })).toBe(false);
    expect(handsAvailable({ isMac: true, backendPresent: true, accessibilityTrusted: false })).toBe(false);
  });
});

describe("the key mapping for computer_key (D-218)", () => {
  // keyMember only reads nut.Key, so a fake Key map exercises the aliasing,
  // letters, and digits without the native module. It imports the electron-
  // scoped module, which touches no Electron at load.
  it("maps named keys, aliases, letters, and digits — and refuses the unknown", async () => {
    const { keyMember } = await import("../electron/computer-use-native");
    const nut = {
      Key: { Enter: "K_Enter", Tab: "K_Tab", Escape: "K_Esc", LeftSuper: "K_Meta", A: "K_A", Num3: "K_3" }
    } as unknown as import("../electron/computer-use-native").NutJs;
    expect(keyMember(nut, "enter")).toBe("K_Enter");
    expect(keyMember(nut, "Return")).toBe("K_Enter"); // aliased to Enter
    // Command aliases to LeftSuper ("meta"), the flag libnut accepts — not
    // LeftCmd ("cmd"), which it rejects.
    expect(keyMember(nut, "cmd")).toBe("K_Meta");
    expect(keyMember(nut, "command")).toBe("K_Meta");
    expect(keyMember(nut, "a")).toBe("K_A");
    expect(keyMember(nut, "3")).toBe("K_3");
    // A key the map does not carry, or nonsense: null (refused upstream).
    expect(keyMember(nut, "f13")).toBeNull();
    expect(keyMember(nut, "")).toBeNull();
  });
});

describe("the escape-shortcut check (D-218 amended)", () => {
  it("recognizes only cmd+space and cmd+tab, in any order and either alias", () => {
    expect(isEscapeShortcut("cmd+space")).toBe(true);
    expect(isEscapeShortcut("space+cmd")).toBe(true);
    expect(isEscapeShortcut("command+tab")).toBe(true);
    expect(isEscapeShortcut("CMD+TAB")).toBe(true);
    // Not an escape — would operate or harm Novus, so it stays fenced.
    expect(isEscapeShortcut("cmd+w")).toBe(false);
    expect(isEscapeShortcut("cmd+q")).toBe(false);
    expect(isEscapeShortcut("cmd+space+shift")).toBe(false);
    expect(isEscapeShortcut("space")).toBe(false);
    expect(isEscapeShortcut("enter")).toBe(false);
  });
});

describe("key-combo ordering for the native backend (D-218 amended)", () => {
  it("puts the main key first and modifiers as trailing flags — nut-js's own order", async () => {
    const { orderedCombo } = await import("../electron/computer-use-native");
    const nut = {
      Key: { Space: "Space", LeftSuper: "LeftSuper", LeftShift: "LeftShift", Tab: "Tab", C: "C", Z: "Z", Enter: "Enter" }
    } as unknown as import("../electron/computer-use-native").NutJs;
    // Two bugs, both fixed: the main key comes first (so Space is not read as a
    // modifier), AND Command resolves to LeftSuper ("meta"), never LeftCmd
    // ("cmd"), which libnut rejects.
    expect(orderedCombo(nut, "cmd+space")).toEqual(["Space", "LeftSuper"]);
    expect(orderedCombo(nut, "space+cmd")).toEqual(["Space", "LeftSuper"]);
    expect(orderedCombo(nut, "cmd+tab")).toEqual(["Tab", "LeftSuper"]);
    expect(orderedCombo(nut, "cmd+c")).toEqual(["C", "LeftSuper"]);
    expect(orderedCombo(nut, "cmd+shift+z")).toEqual(["Z", "LeftSuper", "LeftShift"]);
    // A plain key: just itself.
    expect(orderedCombo(nut, "enter")).toEqual(["Enter"]);
    // Nonsense: null (refused).
    expect(orderedCombo(nut, "f13")).toBeNull();
  });
});
