import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

/** How each modifier is spelled in AppleScript's `using {…}` clause. */
const APPLE_MODIFIERS: Record<string, string> = {
  cmd: "command down",
  command: "command down",
  ctrl: "control down",
  control: "control down",
  alt: "option down",
  option: "option down",
  shift: "shift down"
};

/** macOS virtual key codes for the named keys the agent may press; anything
 *  else that is a single character is typed with `keystroke`. */
const KEY_CODES: Record<string, number> = {
  space: 49,
  enter: 36,
  return: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  backspace: 51,
  delete: 51,
  forwarddelete: 117,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121
};

/**
 * Builds the AppleScript that presses one key combo through System Events —
 * the reliable macOS path (D-218 amended 2026-08-24). nut-js's own modifier
 * mechanism is broken under Electron: it rejects the Command flag with
 * "Invalid key flag specified" (proven live), while `keystroke` / `key code …
 * using {command down}` sets the modifier the way the OS expects and actually
 * triggers system shortcuts like ⌘-space. Returns null when the combo names no
 * key. Only Accessibility permission is needed, which the app already holds.
 */
export function appleScriptForKey(name: string): string | null {
  const tokens = name
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const mods: string[] = [];
  let main: string | null = null;
  for (const token of tokens) {
    const modifier = APPLE_MODIFIERS[token];
    if (modifier !== undefined) mods.push(modifier);
    else if (main === null) main = token;
    else return null; // two non-modifiers is not a combo we send
  }
  if (main === null) return null;
  let action: string;
  if (KEY_CODES[main] !== undefined) action = `key code ${KEY_CODES[main]}`;
  else if ([...main].length === 1) action = `keystroke ${JSON.stringify(main)}`;
  else return null;
  const using = mods.length > 0 ? ` using {${mods.join(", ")}}` : "";
  return `tell application "System Events" to ${action}${using}`;
}

/** Escapes text for an AppleScript double-quoted string. */
function appleScriptString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const runOsa = promisify(execFile);

/** Presses a key combo via AppleScript. Throws if the combo names no key. */
async function osaKey(name: string): Promise<void> {
  const script = appleScriptForKey(name);
  if (script === null) throw new Error(`Not a key this Mac presses: ${name.slice(0, 40)}`);
  await runOsa("osascript", ["-e", script]);
}

/** Types text via AppleScript's keystroke — no modifier flags involved. */
async function osaType(text: string): Promise<void> {
  await runOsa("osascript", [
    "-e",
    `tell application "System Events" to keystroke "${appleScriptString(text)}"`
  ]);
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
    // Keyboard goes through AppleScript, not nut-js: nut-js's modifier-flag
    // mechanism is broken under Electron (D-218 amended). Mouse stays on
    // nut-js, which has no such problem.
    type: (text) => osaType(text),
    key: (name) => osaKey(name),
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
  // desktopCapturer occasionally returns an empty frame under load or right
  // after the app takes focus — a transient, not a permission problem. Retry a
  // few times before giving up (D-218 amended: this "flapping" was reported as
  // a permission error because an empty frame threw that message).
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
    const source = sources[0];
    if (source && !source.thumbnail.isEmpty()) {
      return { dataUrl: source.thumbnail.toDataURL(), width, height };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Only after real retries do we decide why. If the OS says the permission is
  // missing, say that; otherwise it is a transient empty capture, not a grant
  // problem — the honest distinction the old code collapsed.
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    throw new Error(
      "Screen Recording permission is not granted for Novus. Turn it on in System Settings → Privacy & Security → Screen Recording, then restart the app."
    );
  }
  throw new Error("The screen capture came back empty this time (a transient failure). Try the screenshot again.");
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
