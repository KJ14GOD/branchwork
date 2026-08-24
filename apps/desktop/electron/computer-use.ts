import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Raw computer use (D-218): the agent operating the whole Mac — mouse and
 * keyboard, anywhere on screen — as opposed to the fenced browser (D-218's
 * browser tools), which can reach nothing but one loopback page.
 *
 * The author's recorded position stands in the code as it did in the room:
 * raw computer use cannot be *perfectly* fenced, because the OS delivers
 * input by screen position and there is no reliable "act anywhere except
 * Novus." The guardrail is therefore built in layers, and its weight is
 * **structure**, not the system prompt (D-062's standing principle: words
 * are not authority). This module owns the two structural layers that live
 * outside the endpoint's grant machinery:
 *
 *  1. **The machine-local opt-in.** Off by default and per person: a Mac does
 *     not accept an agent's hands until its owner turns this on, here, in
 *     Novus's own settings. The agent cannot reach this switch — it is a file
 *     on disk the harness process never reads and the router never exposes —
 *     which is the owner's rule ("never let it turn its own permission on").
 *  2. **The "never touch Novus" fence.** Every action is checked against
 *     Novus's own window bounds before it reaches the OS: an action landing on
 *     Novus — its approval card included — is refused. This is enforcement, not
 *     a sentence. **Honest gap, recorded rather than hidden**: an agent could
 *     send Novus to the background first, and occlusion and multiple displays
 *     bend bounds; this narrows the exposure sharply but does not close it, the
 *     residue raw computer use carries by nature.
 *
 * The endpoint's per-turn grant and mid-turn cut-off (the same shape the
 * browser session uses) are layers 3 and 4; the Novus-injected system prompt
 * is the last and weakest line. All four must hold for an action to run.
 *
 * The pure logic here is testable without a Mac. The one thing that is not —
 * synthesizing real input and capturing the real screen — lives behind the
 * `DesktopDriver` seam, so the guardrails are proven against a fake driver
 * and the native backend is a thin, clearly-marked adapter.
 */

/** Machine-local, off by default. The agent never reads or writes this. */
const OPT_IN_FILE = "computer-use.json";

function optInPath(userDataPath: string): string {
  return join(userDataPath, OPT_IN_FILE);
}

/** Whether this Mac's owner has turned on raw computer use (D-218). Any read
 *  problem is treated as off — the safe default is always no hands. */
export function computerUseEnabled(userDataPath: string): boolean {
  try {
    const path = optInPath(userDataPath);
    if (!existsSync(path)) return false;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
    return raw.enabled === true;
  } catch {
    return false;
  }
}

/** The person's own choice, recorded machine-locally. */
export function setComputerUseEnabled(userDataPath: string, enabled: boolean): void {
  writeFileSync(optInPath(userDataPath), JSON.stringify({ enabled }));
}

/** A rectangle in screen coordinates. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the main process knows at the moment of an action, supplied to the
 *  fence so the fence itself stays pure. */
export interface DesktopContext {
  /** Novus's own window rectangles, in screen coordinates. */
  novusWindows: ScreenRect[];
  /** True when a Novus window is the frontmost application — the strongest
   *  signal that an action is aimed at Novus rather than the app under test. */
  novusFrontmost: boolean;
}

function inside(point: { x: number; y: number }, rect: ScreenRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * The structural fence (D-218, layer 2). A pointer action is refused when it
 * lands on any Novus window, and a keyboard action is refused while Novus is
 * frontmost — because keys with no coordinate go to whatever has focus, and if
 * that is Novus the agent is typing into the room. Returns the refusal in
 * words, or null to allow.
 *
 * This is the honest fence, and its own limit is stated in the module comment:
 * it cannot stop an agent that first sends Novus to the background.
 */
export function fenceRefusal(
  action:
    | { kind: "point"; x: number; y: number }
    | { kind: "key"; combo: string }
    | { kind: "type" }
    | { kind: "screenshot" },
  context: DesktopContext
): string | null {
  // A screenshot reads; it presses nothing. It is allowed (the agent must see
  // the screen to act), and the endpoint redacts nothing from it — the
  // interface warns that the screen may hold sensitive pixels, D-123's stance.
  if (action.kind === "screenshot") return null;
  if (action.kind === "point") {
    for (const rect of context.novusWindows) {
      if (inside(action, rect)) {
        return "That point is on Novus's own window. The agent may operate the Mac, but never Novus itself.";
      }
    }
    return null;
  }
  if (action.kind === "key") {
    // The two "leave Novus" shortcuts — ⌘-space (Spotlight) and ⌘-tab (app
    // switch) — only move focus AWAY from Novus and can operate nothing of it,
    // so they are allowed even while Novus is front: the agent's one door off
    // Novus, without which it is trapped whenever a person is looking at the
    // room (D-218 amended). Every other key while Novus is front is refused —
    // it could type into the room or keyboard-approve an action.
    if (isEscapeShortcut(action.combo)) return null;
    if (context.novusFrontmost) {
      return "Novus is frontmost, so this key would go to Novus. Press cmd+space or cmd+tab to move to another app first.";
    }
    return null;
  }
  // Typing text: never a way off Novus, so it is refused while Novus is front —
  // the text would land in the room's own fields.
  if (context.novusFrontmost) {
    return "Novus is frontmost, so typing would go into Novus. Move to another app first (cmd+space or cmd+tab).";
  }
  return null;
}

/** The two shortcuts that move focus away from Novus and can operate nothing
 *  of it (D-218 amended). Modifier order and the cmd/command alias do not
 *  matter; anything else — including ⌘-W or ⌘-Q, which would harm Novus — is
 *  not an escape and stays fenced. */
export function isEscapeShortcut(combo: string): boolean {
  const norm = combo
    .toLowerCase()
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => (token === "command" ? "cmd" : token))
    .sort()
    .join("+");
  return norm === "cmd+space" || norm === "cmd+tab";
}

/**
 * Whether the agent can actually act on the Mac (D-218) — pure so the
 * composition is tested even though its inputs come from the native backend.
 * All three must hold: this is macOS (the only platform wired), a native
 * input backend loaded, and macOS Accessibility permission is granted (the OS
 * gate on synthetic input — only the owner can grant it, in System Settings).
 * The screenshot needs none of this; acting needs all of it.
 */
export function handsAvailable(state: {
  isMac: boolean;
  backendPresent: boolean;
  accessibilityTrusted: boolean;
}): boolean {
  return state.isMac && state.backendPresent && state.accessibilityTrusted;
}

/** The verbs the desktop backend performs. Injected so every guardrail is
 *  proven against a fake, and the native adapter is the only untested seam. */
export interface DesktopDriver {
  /** A full-screen capture the agent reads to decide where to act. Returns a
   *  PNG data URL and the screen's own size in the coordinate space actions
   *  use. */
  screenshot(): Promise<{ dataUrl: string; width: number; height: number }>;
  moveTo(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: "left" | "right"): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  /** True when this backend can actually synthesize input on this machine —
   *  false when the native input dependency is absent or macOS Accessibility
   *  permission has not been granted. A false backend refuses every acting
   *  verb in words rather than pretending. */
  available(): boolean;
}
