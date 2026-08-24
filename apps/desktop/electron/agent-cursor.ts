import { BrowserWindow } from "electron";
import { TOKEN_ACCENT } from "./design-tokens";

/**
 * The visible cursor for raw computer use (D-218): while the agent operates
 * the Mac, a marker follows where it is acting, so a person watching sees the
 * hand as well as the result — the affordance the owner named ("like Codex,
 * you can see its cursor around moving").
 *
 * A small, frameless, transparent, always-on-top, click-through window that
 * carries a single ring. Click-through (`setIgnoreMouseEvents`) is essential:
 * the overlay must never eat a click meant for the app the agent — or the
 * person — is using. It is Novus's own window, so the structural fence
 * (`computer-use.ts`) would refuse an agent action that lands on it; a person
 * never interacts with it either.
 */

let overlay: BrowserWindow | null = null;

const RING = 34;

function ensureOverlay(): BrowserWindow {
  if (overlay !== null && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    width: RING,
    height: RING,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // No web content of Novus's; a static ring drawn in the page itself.
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, "screen-saver");
  // A ring drawn with inline SVG — the accent from the token layer would need
  // the renderer's stylesheet, which this bare window does not load, so the
  // one colour here is the accent's own value, documented as the exception a
  // chromeless overlay is.
  // The accent token, URL-encoded for the data: URL. A chromeless overlay
  // cannot reach the stylesheet, so the one value is sourced from the shared
  // token mirror rather than written raw.
  const stroke = TOKEN_ACCENT.replace("#", "%23");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RING}" height="${RING}">` +
    `<circle cx="${RING / 2}" cy="${RING / 2}" r="${RING / 2 - 3}" fill="none" stroke="${stroke}" stroke-width="3"/></svg>`;
  void overlay.loadURL(
    `data:text/html,<body style="margin:0;background:transparent;overflow:hidden"><img src="data:image/svg+xml,${svg}"></body>`
  );
  return overlay;
}

/** Place the marker centred on a screen point, and show it. */
export function showAgentCursor(x: number, y: number): void {
  const win = ensureOverlay();
  win.setBounds({ x: Math.round(x - RING / 2), y: Math.round(y - RING / 2), width: RING, height: RING });
  if (!win.isVisible()) win.showInactive();
}

/** Take the marker down — the turn ended or the agent stopped acting. */
export function hideAgentCursor(): void {
  if (overlay !== null && !overlay.isDestroyed()) overlay.hide();
}

/** Test/shutdown hook. */
export function destroyAgentCursor(): void {
  if (overlay !== null && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}
