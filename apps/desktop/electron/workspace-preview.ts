import { WebContentsView, type BrowserWindow } from "electron";
import type { PreviewBounds, PreviewStatus, ProcessLogChunk } from "@novus/contracts";
import { ApiError } from "./api-client";
import { describeProcessEnd, previewNavigationAllowed, type PreviewTarget } from "./preview-policy";

/**
 * The embedded preview surface (D-098) — the view half. Every decision it
 * enforces is `preview-policy.ts`'s, tested in plain Node; this module owns
 * the one native `WebContentsView` and may only be imported by `main.ts`,
 * because it touches Electron at module scope.
 *
 * One view, owned entirely by this process, showing a running local
 * application inside the window. The renderer reserves a rectangle and reads
 * a status; it never holds the view, never navigates it, and cannot hand it
 * an address the room did not already show. Every gate D-045 put in front of
 * the external-browser bridge stands here too, plus the ones an embedded page
 * needs:
 *
 *  - the address must be one a **live** run process of this workstream
 *    actually reported (`resolvePreviewTarget`, called by `main.ts` before
 *    anything here runs);
 *  - the top frame may navigate only within the approved origin. Everything
 *    else — other hosts, other ports, other schemes, `window.open` — is
 *    denied in this process, where the page cannot reach;
 *  - the embedded page gets no preload, no Node, no `window.novus`, an
 *    isolated in-memory session per workstream, no permission grants, and no
 *    downloads. It is a page from the person's own dev server, treated with
 *    exactly the trust that deserves: none.
 *
 * The page loading is never presented as the application being ready:
 * readiness stays the declared signal's answer (D-045), and this module's
 * `ready` phase claims only that one HTTP response rendered.
 */

interface EmbeddedPreview {
  view: WebContentsView;
  status: PreviewStatus;
  bounds: PreviewBounds;
  attached: boolean;
}

let host: BrowserWindow | null = null;
let current: EmbeddedPreview | null = null;
const statusListeners = new Set<(status: PreviewStatus | null) => void>();

/**
 * The keeper's heartbeat (D-158). The renderer places the rectangle every few
 * hundred milliseconds while its surface is honestly on screen; a native view
 * whose placements stop arriving has lost its keeper — a reloaded renderer, a
 * closed tab, a crashed page — and a view with no keeper must not stay
 * painted over whatever renders next. Detached, never closed: the page and
 * the process live on, and the next placement shows the view again.
 */
const KEEPER_SILENCE_MS = 1500;
let lastPlacedAt = 0;
let heartbeat: NodeJS.Timeout | null = null;

function notePlacement(): void {
  lastPlacedAt = Date.now();
  if (heartbeat === null) {
    heartbeat = setInterval(() => {
      if (current === null || !current.attached) return;
      if (Date.now() - lastPlacedAt > KEEPER_SILENCE_MS) detach(current);
    }, KEEPER_SILENCE_MS / 3);
    heartbeat.unref();
  }
}

export function onEmbeddedPreviewStatus(listener: (status: PreviewStatus | null) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function announce(): void {
  const status = current === null ? null : { ...current.status };
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch {
      /* a broken listener must not take the preview down with it */
    }
  }
}

export function embeddedPreviewStatus(): PreviewStatus | null {
  return current === null ? null : { ...current.status };
}

/** The window the view attaches to. Set once at window creation; a closed
 *  window discards the view with it. */
export function attachPreviewHost(window: BrowserWindow): void {
  host = window;
  window.on("closed", () => {
    if (host === window) {
      host = null;
      current = null;
    }
  });
  // A renderer that navigates or reloads takes every rectangle claim with it:
  // the fresh page starts with no preview on screen and asks again if it
  // wants one (D-158).
  window.webContents.on("did-start-loading", () => {
    if (current !== null) detach(current);
  });
}

function setPhase(preview: EmbeddedPreview, phase: PreviewStatus["phase"], detail: string | null): void {
  preview.status = { ...preview.status, phase, detail };
  // A native view sits above the renderer's DOM, so a state the renderer must
  // explain in words is a state the view cannot be covering: anything that is
  // not a page on screen takes the view down and gives the rectangle back.
  if (phase === "loading" || phase === "ready") {
    attach(preview);
  } else {
    detach(preview);
  }
  announce();
}

function attach(preview: EmbeddedPreview): void {
  notePlacement();
  if (host === null || preview.attached) return;
  host.contentView.addChildView(preview.view);
  applyBounds(preview);
  preview.attached = true;
}

function detach(preview: EmbeddedPreview): void {
  if (host === null || !preview.attached) return;
  host.contentView.removeChildView(preview.view);
  preview.attached = false;
}

function applyBounds(preview: EmbeddedPreview): void {
  // The renderer measures in page pixels; a native view is placed in
  // device-independent ones, and the two differ by exactly the page zoom
  // (D-160) — a person who pressed Cmd+plus once had every placement land
  // offset, painting the view over whatever sat beside the room. Converted
  // here, the one chokepoint every placement passes through, re-read on each
  // placement so a zoom change corrects within a keeper tick.
  const zoom = host?.webContents.getZoomFactor() ?? 1;
  preview.view.setBounds({
    x: Math.round(preview.bounds.x * zoom),
    y: Math.round(preview.bounds.y * zoom),
    width: Math.max(0, Math.round(preview.bounds.width * zoom)),
    height: Math.max(0, Math.round(preview.bounds.height * zoom))
  });
}

/**
 * Shows the embedded preview for a validated target. Reopening the same
 * address while its process is still the one on record reuses the existing
 * view exactly as it was — reopening is showing, never restarting. A
 * different address, or the same address re-reported by a new process after a
 * restart, discards the old view: its state described a server that is gone.
 */
export function openEmbeddedPreview(
  workstreamId: string,
  target: PreviewTarget,
  bounds: PreviewBounds
): PreviewStatus {
  if (host === null) {
    throw new ApiError("preview_refused", "There is no window to show a preview in.", 409);
  }
  const url = target.url.toString();
  if (
    current !== null &&
    current.status.workstreamId === workstreamId &&
    current.status.url === url &&
    current.status.processId === target.processId &&
    current.status.phase !== "stopped" &&
    current.status.phase !== "crashed"
  ) {
    current.bounds = bounds;
    applyBounds(current);
    attach(current);
    announce();
    return { ...current.status };
  }

  closeEmbeddedPreview();

  const view = new WebContentsView({
    webPreferences: {
      // The page is the project's own dev server: it gets a plain, sandboxed
      // web context and nothing of Novus's — no preload, no Node, no bridge.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Its own in-memory session per workstream: no cookies or storage are
      // shared with the app shell or persisted anywhere.
      partition: `preview:${workstreamId}`,
      // The page keeps living while the rectangle is off screen — a person
      // reading the conversation has not paused their dev server's page, and
      // a capture of the open preview (D-123) photographs its live render,
      // never a stale frame.
      backgroundThrottling: false
    }
  });

  const preview: EmbeddedPreview = {
    view,
    bounds,
    attached: false,
    status: {
      workstreamId,
      url,
      origin: target.url.origin,
      processId: target.processId,
      processName: target.processName,
      phase: "loading",
      detail: null
    }
  };
  current = preview;

  const wc = view.webContents;
  const session = wc.session;
  // The page may ask for nothing the operating system grants: camera,
  // microphone, notifications, clipboard — all denied without a dialog.
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // And it may write nothing to disk: a preview is looked at, not saved from.
  session.on("will-download", (event) => event.preventDefault());

  const guard = (event: { preventDefault: () => void }, destination: string): void => {
    if (!previewNavigationAllowed(preview.status.origin, destination)) event.preventDefault();
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.setWindowOpenHandler(({ url: destination }) => {
    // A link that stays on the approved origin opens in place — the preview is
    // one page deep, not a tab strip. Everything else opens nowhere.
    if (previewNavigationAllowed(preview.status.origin, destination)) {
      void wc.loadURL(destination);
    }
    return { action: "deny" };
  });

  wc.on("did-start-loading", () => {
    if (current === preview && preview.status.phase !== "stopped") {
      setPhase(preview, "loading", null);
    }
  });
  wc.on("did-finish-load", () => {
    if (current === preview && preview.status.phase !== "stopped") {
      setPhase(preview, "ready", null);
    }
  });
  wc.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
    if (!isMainFrame || errorCode === -3) return;
    if (current === preview && preview.status.phase !== "stopped") {
      setPhase(preview, "unreachable", errorDescription.slice(0, 400));
    }
  });
  wc.on("render-process-gone", (_event, details) => {
    if (current === preview && preview.status.phase !== "stopped") {
      setPhase(preview, "crashed", `The preview's own page process ended (${details.reason}).`);
    }
  });

  setPhase(preview, "loading", null);
  void wc.loadURL(url);
  return { ...preview.status };
}

export function setEmbeddedPreviewBounds(bounds: PreviewBounds): void {
  if (current === null) return;
  notePlacement();
  current.bounds = bounds;
  applyBounds(current);
  // Placing the rectangle is also showing it — but only for a view that has a
  // page to show; a stopped or crashed preview stays words until reopened.
  if (current.status.phase === "loading" || current.status.phase === "ready") attach(current);
}

export function hideEmbeddedPreview(): void {
  if (current === null) return;
  detach(current);
}

/**
 * The view's current pixels for the frozen-frame swap (D-160): while a menu
 * or dialog sits over the rectangle, the renderer shows this still and the
 * native view leaves the screen, so the overlay reads as being above the
 * page. Presentation only — no provenance, no redaction, no storage — which
 * is why it is not the D-123 capture path: these pixels go to the same
 * renderer that was already displaying them, and nowhere else.
 */
export async function snapshotEmbeddedPreview(): Promise<string | null> {
  if (current === null) return null;
  if (current.status.phase !== "loading" && current.status.phase !== "ready") return null;
  const image = await current.view.webContents.capturePage();
  if (image.isEmpty()) return null;
  return image.toDataURL();
}

export function reloadEmbeddedPreview(): void {
  if (current === null) return;
  if (current.status.phase === "stopped") return; // nothing is serving; reopening is the verb
  setPhase(current, "loading", null);
  current.view.webContents.reload();
}

/** Discards the view. Never touches the process: closing a preview is closing
 *  a window onto the app, not stopping the app (D-098). */
export function closeEmbeddedPreview(): void {
  if (current === null) return;
  const preview = current;
  current = null;
  detach(preview);
  preview.view.webContents.close();
  announce();
}

/**
 * The capture authority's one window onto pixels (D-123): the embedded
 * preview's own page, photographed by the main process. The renderer never
 * names a target — the only thing this can capture is the view this module
 * already validated and owns. Refused in words when the view is not showing
 * a page on screen: what nobody can see, Novus does not photograph.
 */
export async function capturePreviewImage(
  workstreamId: string
): Promise<
  | { ok: true; image: Electron.NativeImage; status: PreviewStatus }
  | { ok: false; refusal: string }
> {
  if (current === null || current.status.workstreamId !== workstreamId) {
    return { ok: false, refusal: "No preview is open for this lane." };
  }
  if (current.status.phase !== "ready") {
    return { ok: false, refusal: "The preview has no loaded page to capture." };
  }
  // Open is the requirement, not visible: the view is the approved surface
  // whether or not its rectangle is on the canvas this instant, and its page
  // keeps rendering (backgroundThrottling is off). A capture races nothing.
  const image = await current.view.webContents.capturePage();
  if (image.isEmpty()) {
    return { ok: false, refusal: "The preview rendered nothing to capture." };
  }
  return { ok: true, image, status: { ...current.status } };
}

/** The live view's contents for the recording pipeline (D-123) — handed only
 *  to the display-media handler the main process itself installs, never to a
 *  renderer. Null unless this exact lane's preview is showing a page. */
export function previewContentsForRecording(
  workstreamId: string
): { contents: Electron.WebContents; status: PreviewStatus } | null {
  if (current === null || current.status.workstreamId !== workstreamId) return null;
  if (current.status.phase !== "ready") return null;
  return { contents: current.view.webContents, status: { ...current.status } };
}

/**
 * The supervisor's own news, fed through from the one process-log stream
 * `main.ts` already subscribes to. When the process behind the preview stops
 * — exited, failed, or stopped by a person — the preview says so plainly
 * instead of showing a page nothing is serving, and the words carry how it
 * ended. The view comes down; the state and the next action belong to the
 * renderer's own surface.
 */
export function noteProcessChunk(chunk: ProcessLogChunk): void {
  if (current === null) return;
  if (chunk.processId !== current.status.processId) return;
  if (current.status.phase === "stopped") return;
  const said = describeProcessEnd(chunk);
  if (said === null) return;
  setPhase(current, "stopped", said);
}
