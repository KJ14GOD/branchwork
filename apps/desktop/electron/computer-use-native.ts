import { BrowserWindow, desktopCapturer, screen, systemPreferences } from "electron";
import { handsAvailable, type DesktopContext, type DesktopDriver } from "./computer-use";

/**
 * The main-process backend for raw computer use (D-218): the one part of the
 * feature that touches the real machine, kept behind the `DesktopDriver` seam
 * so every guardrail is proven against a fake and this is the only untested
 * adapter. Imports Electron, so `main.ts` is its only importer; the pure
 * guardrails live in `computer-use.ts`, which imports nothing of Electron.
 *
 * **Screen capture is real** through Electron's own `desktopCapturer` (macOS
 * Screen Recording permission required; a refusal surfaces in words). **Input
 * synthesis is wired** to `@nut-tree-fork/nut-js` — an **optional** native
 * dependency, so a machine without it (or one whose prebuilt binary will not
 * load under this Electron) degrades to eyes-only rather than failing: the
 * `require` is caught, `available()` reads false, and acting refuses in words.
 * On macOS the backend also needs **Accessibility permission**, the OS gate on
 * synthetic input that only the owner can grant. Proven to load under Electron
 * 37 with Accessibility granted; deliberately **not** exercised by moving the
 * real cursor in an automated test, because that would seize the owner's own
 * mouse — the one proof left to the person watching their own screen.
 */

/** Novus's own windows and whether it is frontmost, for the structural fence
 *  (D-218, layer 2). Bounds are the window frames in screen coordinates; a
 *  window with focus is the strongest signal Novus is the frontmost app. */
export function desktopContext(): DesktopContext {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return {
    novusWindows: windows.map((w) => w.getBounds()),
    novusFrontmost: windows.some((w) => w.isFocused())
  };
}

/**
 * Tries to load a native input backend. Returns null when none is installed —
 * which is the shipped state: Novus does not add a native input dependency on
 * the owner's behalf. When the owner installs and enables one, this is where
 * it is adapted; the shape is `{ move, click, type, key, scroll }` over screen
 * coordinates.
 */
type InputBackend = {
  move(x: number, y: number): Promise<void> | void;
  click(x: number, y: number, button: "left" | "right"): Promise<void> | void;
  type(text: string): Promise<void> | void;
  key(name: string): Promise<void> | void;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void> | void;
};

/** The nut-js module's shape, kept minimal and cast, because it is an optional
 *  native dependency the type system cannot assume is installed. */
export interface NutJs {
  mouse: {
    setPosition(point: unknown): Promise<unknown>;
    leftClick(): Promise<unknown>;
    rightClick(): Promise<unknown>;
    scrollDown(n: number): Promise<unknown>;
    scrollUp(n: number): Promise<unknown>;
    scrollLeft(n: number): Promise<unknown>;
    scrollRight(n: number): Promise<unknown>;
  };
  keyboard: {
    type(text: string): Promise<unknown>;
    pressKey(...keys: unknown[]): Promise<unknown>;
    releaseKey(...keys: unknown[]): Promise<unknown>;
  };
  Point: new (x: number, y: number) => unknown;
  Key: Record<string, unknown>;
}

/** The named keys and modifiers the agent may press, mapped to nut-js's own
 *  `Key` members. A combo like "cmd+c" is split on "+". */
const KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  "return": "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  cmd: "LeftCmd",
  command: "LeftCmd",
  ctrl: "LeftControl",
  control: "LeftControl",
  alt: "LeftAlt",
  option: "LeftAlt",
  shift: "LeftShift"
};

export function keyMember(nut: NutJs, token: string): unknown | null {
  const t = token.trim().toLowerCase();
  const aliased = KEY_ALIASES[t];
  if (aliased && aliased in nut.Key) return nut.Key[aliased];
  // A single letter or digit maps to its own Key member (A–Z, Num0–Num9).
  if (/^[a-z]$/.test(t) && t.toUpperCase() in nut.Key) return nut.Key[t.toUpperCase()];
  if (/^[0-9]$/.test(t) && `Num${t}` in nut.Key) return nut.Key[`Num${t}`];
  return null;
}

/** The modifier tokens, by their spoken names — everything else in a combo is
 *  the main key. */
const MODIFIER_TOKENS = new Set(["cmd", "command", "ctrl", "control", "alt", "option", "shift"]);

/**
 * A key combo resolved into nut-js's own argument order: the main key first,
 * then the modifiers as trailing flags (D-218 amended). `"cmd+space"` becomes
 * `[Space, LeftCmd]`, not `[LeftCmd, Space]` — the bug that made libnut read
 * Space as a modifier flag and throw. Null when any token is not a key.
 */
export function orderedCombo(nut: NutJs, name: string): unknown[] | null {
  const tokens = name
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const mods: unknown[] = [];
  const mains: unknown[] = [];
  for (const token of tokens) {
    const key = keyMember(nut, token);
    if (key === null) return null;
    (MODIFIER_TOKENS.has(token) ? mods : mains).push(key);
  }
  // The last non-modifier is the key being pressed; a combo that is only
  // modifiers (rare) presses those alone.
  const main = mains[mains.length - 1];
  if (main === undefined) return mods.length > 0 ? mods : null;
  return [main, ...mods];
}

/**
 * Loads the optional native input backend and adapts it. Returns null when the
 * dependency is absent or cannot load under Electron's ABI (a rebuild may be
 * needed) — the graceful path the seam is built for: no crash, no hands, an
 * honest refusal. When it loads, this is where nut-js becomes the InputBackend.
 */
function loadInputBackend(): InputBackend | null {
  let nut: NutJs;
  try {
    // Optional dependency (D-218): `require`, not `import`, so a machine
    // without it — or one whose native binary will not load under Electron —
    // falls to null here rather than failing the whole module.
    nut = require("@nut-tree-fork/nut-js") as NutJs;
    if (!nut || !nut.mouse || !nut.keyboard) return null;
  } catch {
    return null;
  }
  return {
    move: async (x, y) => void (await nut.mouse.setPosition(new nut.Point(x, y))),
    click: async (x, y, button) => {
      await nut.mouse.setPosition(new nut.Point(x, y));
      await (button === "right" ? nut.mouse.rightClick() : nut.mouse.leftClick());
    },
    type: async (text) => void (await nut.keyboard.type(text)),
    key: async (name) => {
      const ordered = orderedCombo(nut, name);
      if (ordered === null) throw new Error(`Not a key this Mac presses: ${name.slice(0, 40)}`);
      // nut-js/libnut takes `pressKey(mainKey, ...modifiers)` — the key first,
      // the modifiers as trailing flags. Passing a modifier first makes the
      // real key be read as a modifier flag ("Invalid key flag specified");
      // orderedCombo puts the main key first (D-218 amended 2026-08-24).
      await nut.keyboard.pressKey(...ordered);
      await nut.keyboard.releaseKey(...ordered);
    },
    scroll: async (_x, _y, dx, dy) => {
      if (dy > 0) await nut.mouse.scrollDown(dy);
      else if (dy < 0) await nut.mouse.scrollUp(-dy);
      if (dx > 0) await nut.mouse.scrollRight(dx);
      else if (dx < 0) await nut.mouse.scrollLeft(-dx);
    }
  };
}

/** macOS Accessibility permission — the OS gate on synthetic input. Read
 *  without prompting; `requestAccessibility` opens System Settings. Only the
 *  owner can grant it. Non-macOS has no such client and reads false. */
export function accessibilityTrusted(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return false;
  }
}

/** Opens the Accessibility pane and prompts, if not already trusted. Returns
 *  the current trust (still false right after prompting — the OS grant lands
 *  when the person flips the switch). */
export function requestAccessibility(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return systemPreferences.isTrustedAccessibilityClient(true);
  } catch {
    return false;
  }
}

/** macOS Screen Recording permission — the OS gate on capturing the screen,
 *  separate from Accessibility (which gates input). `computer_screenshot`
 *  needs this; the input tools do not. Non-macOS reports "granted" (no gate). */
export function screenRecordingGranted(): boolean {
  if (process.platform !== "darwin") return true;
  try {
    return systemPreferences.getMediaAccessStatus("screen") === "granted";
  } catch {
    return false;
  }
}

/** A full-screen capture at the display's real pixel size, in the coordinate
 *  space actions use (screen points). */
async function captureScreen(): Promise<{ dataUrl: string; width: number; height: number }> {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height }
  });
  const source = sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(
      "The screen could not be captured. On macOS this needs Screen Recording permission for Novus."
    );
  }
  return { dataUrl: source.thumbnail.toDataURL(), width, height };
}

export function createNativeDesktopDriver(): DesktopDriver {
  const backend = loadInputBackend();
  const refuse = (): never => {
    const why =
      backend === null
        ? "the input backend is not loaded (install it, or rebuild it for Electron)"
        : process.platform !== "darwin"
          ? "only macOS is wired"
          : "macOS Accessibility permission is not granted (turn it on for Novus in System Settings)";
    throw new Error(`Raw computer use is on, but the agent has no hands yet — ${why}. Only the screenshot works.`);
  };
  const ready = () =>
    handsAvailable({
      isMac: process.platform === "darwin",
      backendPresent: backend !== null,
      accessibilityTrusted: accessibilityTrusted()
    });
  const act = async (fn: () => Promise<void> | void): Promise<void> => {
    if (!ready()) refuse();
    await fn();
  };
  return {
    screenshot: captureScreen,
    moveTo: (x, y) => act(() => backend!.move(x, y)),
    click: (x, y, button) => act(() => backend!.click(x, y, button)),
    type: (text) => act(() => backend!.type(text)),
    key: (name) => act(() => backend!.key(name)),
    scroll: (x, y, dx, dy) => act(() => backend!.scroll(x, y, dx, dy)),
    available: ready
  };
}
