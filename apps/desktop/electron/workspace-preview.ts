import { app, session, type BrowserWindow, type WebContents } from "electron";
import type { PreviewStatus, ProcessLogChunk } from "@novus/contracts";
import { describeProcessEnd, previewNavigationAllowed, type PreviewTarget } from "./preview-policy";
import { TOKEN_PREVIEW_CANVAS } from "./design-tokens";

/**
 * The embedded preview surface (D-098, rebuilt in D-163) — the view half.
 * Every decision it enforces is `preview-policy.ts`'s, tested in plain Node;
 * this module owns the main-process authority over the one embedded page and
 * may only be imported by `main.ts`, because it touches Electron at module
 * scope.
 *
 * D-163, owner-directed: the page renders through an in-DOM `webview` rather
 * than a native `WebContentsView`. The owner's words were the design — "two
 * independent processes, one on top of the other" — and the webview is
 * exactly that: its page keeps its own renderer process and its own
 * isolation, while the element composites in the room's own stacking order,
 * so a menu above the preview is simply above it. The native-overlay era's
 * whole apparatus — the rectangle keeper, the coverage hit-testing, the
 * placement heartbeat, the zoom conversion, the frozen-frame swap (D-158,
 * D-160) — stops existing rather than being patched again.
 *
 * The renderer holds the element; the main process holds every decision:
 *
 *  - the address must be one a **live** run process of this workstream
 *    actually reported (`resolvePreviewTarget`, called by `main.ts` before
 *    anything here runs), and a webview may attach only with exactly the
 *    approved address and partition — anything else is refused before it
 *    exists (`will-attach-webview`);
 *  - whatever attributes the renderer wrote, the attach hook strips them: no
 *    preload, no Node, sandboxed, isolated, an in-memory partition per
 *    workstream;
 *  - the attached page's top frame may navigate only within the approved
 *    origin; `window.open`, downloads, and permission requests are denied in
 *    this process, where the page cannot reach.
 *
 * The page loading is never presented as the application being ready:
 * readiness stays the declared signal's answer (D-045), and this module's
 * `ready` phase claims only that one HTTP response rendered.
 */

interface EmbeddedPreview {
  status: PreviewStatus;
  partition: string;
  /** The adopted webview's contents — null until the renderer's element
   *  attaches, and again after it unmounts. The approval outlives the
   *  element: a tab re-opened re-attaches under the same grant. */
  contents: WebContents | null;
}

let current: EmbeddedPreview | null = null;
const statusListeners = new Set<(status: PreviewStatus | null) => void>();
/** Partitions whose sessions already carry the deny-handlers, so re-adoption
 *  never stacks a second handler. */
const hardenedPartitions = new Set<string>();

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

function setPhase(preview: EmbeddedPreview, phase: PreviewStatus["phase"], detail: string | null): void {
  preview.status = { ...preview.status, phase, detail };
  announce();
}

/**
 * Approves a preview for a validated target. Reopening the same address while
 * its process is still the one on record keeps the standing approval — the
 * renderer's element re-attaches under it. A different address, or the same
 * address re-reported by a new process after a restart, replaces the
 * approval: the old state described a server that is gone.
 */
export function openEmbeddedPreview(workstreamId: string, target: PreviewTarget): PreviewStatus {
  const url = target.url.toString();
  if (
    current !== null &&
    current.status.workstreamId === workstreamId &&
    current.status.url === url &&
    current.status.processId === target.processId &&
    current.status.phase !== "stopped" &&
    current.status.phase !== "crashed"
  ) {
    announce();
    return { ...current.status };
  }

  closeEmbeddedPreview();
  current = {
    partition: `preview:${workstreamId}`,
    contents: null,
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
  announce();
  return { ...current.status };
}

/**
 * Wires the two hooks that make the renderer's `webview` element safe, called
 * once per host window by `main.ts`. `will-attach-webview` is the gate — a
 * webview whose address or partition is not the standing approval never comes
 * into existence, and whatever attributes the renderer wrote are replaced
 * with the locked-down set. `web-contents-created` is the adoption — the
 * attached page gets the same guards the native view carried.
 */
let appHooked = false;

export function registerPreviewWebviewHooks(window: BrowserWindow): void {
  // The one place the app learns a webview exists. Hooked here rather than at
  // module scope, so importing this module in plain-node tests touches no
  // Electron runtime.
  if (!appHooked) {
    appHooked = true;
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "webview") adoptPreviewWebview(contents);
    });
  }
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (
      current === null ||
      params.partition !== current.partition ||
      (params.src !== current.status.url && params.src !== current.status.origin)
    ) {
      event.preventDefault();
      return;
    }
    // The renderer's attributes are proposals; these are the terms. The page
    // is the project's own dev server: a plain, sandboxed web context and
    // nothing of Novus's — no preload, no Node, no bridge.
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // The page keeps living while its element is off screen — a person
    // reading the conversation has not paused their dev server's page, and a
    // capture photographs its live render, never a stale frame (D-123).
    webPreferences.backgroundThrottling = false;
  });
}

/** Adopts a created webview's contents, from the app-level hook in
 *  `main.ts`. An unapproved webview — none standing, or a foreign partition —
 *  is closed on sight rather than guarded. */
export function adoptPreviewWebview(contents: WebContents): void {
  const preview = current;
  if (preview === null || contents.session !== session.fromPartition(preview.partition)) {
    contents.close();
    return;
  }
  preview.contents = contents;

  if (!hardenedPartitions.has(preview.partition)) {
    hardenedPartitions.add(preview.partition);
    // The page may ask for nothing the operating system grants: camera,
    // microphone, notifications, clipboard — all denied without a dialog.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // And it may write nothing to disk: a preview is looked at, not saved from.
    contents.session.on("will-download", (event) => event.preventDefault());
  }

  const guard = (event: { preventDefault: () => void }, destination: string): void => {
    if (!previewNavigationAllowed(preview.status.origin, destination)) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url: destination }) => {
    // A link that stays on the approved origin opens in place — the preview
    // is one page deep, not a tab strip. Everything else opens nowhere.
    if (previewNavigationAllowed(preview.status.origin, destination)) {
      void contents.loadURL(destination);
    }
    return { action: "deny" };
  });

  contents.on("did-start-loading", () => {
    if (current === preview && preview.status.phase !== "stopped") setPhase(preview, "loading", null);
  });
  contents.on("dom-ready", () => {
    // The guest's canvas is composited transparent, and only the host
    // element's CSS paints white beneath it — a backdrop capturePage() and
    // the recorder never see, so a page that declares no background captured
    // as black frames with its dark text invisible. This gives the guest
    // itself the browser-default white those pages are designed against, in
    // a named layer at zero specificity: any page that declares any
    // background at all still wins the cascade. Re-inserted per navigation,
    // which is what dom-ready fires on.
    void contents.insertCSS(
      `@layer novus-preview-canvas { :where(html) { background-color: ${TOKEN_PREVIEW_CANVAS}; } }`
    );
  });
  contents.on("did-finish-load", () => {
    if (current === preview && preview.status.phase !== "stopped") setPhase(preview, "ready", null);
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
    if (!isMainFrame || errorCode === -3) return;
    if (current === preview && preview.status.phase !== "stopped") {
      setPhase(preview, "unreachable", errorDescription.slice(0, 400));
    }
  });
  contents.on("render-process-gone", (_event, details) => {
    if (current === preview && preview.status.phase !== "stopped") {
      setPhase(preview, "crashed", `The preview's own page process ended (${details.reason}).`);
    }
  });
  contents.on("destroyed", () => {
    // The element unmounted — the tab lost the canvas, not the person's
    // place: the approval stands and a remounted element re-attaches.
    if (current === preview && preview.contents === contents) preview.contents = null;
  });
}


export function reloadEmbeddedPreview(): void {
  if (current === null || current.contents === null || current.contents.isDestroyed()) return;
  if (current.status.phase === "stopped") return; // nothing is serving; reopening is the verb
  setPhase(current, "loading", null);
  current.contents.reload();
}

/** Discards the approval. Never touches the process: closing a preview is
 *  closing a window onto the app, not stopping the app (D-098). */
export function closeEmbeddedPreview(): void {
  if (current === null) return;
  const preview = current;
  current = null;
  if (preview.contents !== null && !preview.contents.isDestroyed()) preview.contents.close();
  announce();
}

/**
 * The capture authority's one window onto pixels (D-123): the embedded
 * preview's own page, photographed by the main process. The renderer never
 * names a target — the only thing this can capture is the page this module
 * already validated and adopted. Refused in words when no page is showing.
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
  if (current.status.phase !== "ready" || current.contents === null || current.contents.isDestroyed()) {
    return { ok: false, refusal: "The preview has no loaded page to capture." };
  }
  const image = await current.contents.capturePage();
  if (image.isEmpty()) {
    return { ok: false, refusal: "The preview rendered nothing to capture." };
  }
  return { ok: true, image, status: { ...current.status } };
}

/** The live page's contents for the recording pipeline (D-123) — handed only
 *  to the display-media handler the main process itself installs, never to a
 *  renderer. Null unless this exact lane's preview is showing a page. */
export function previewContentsForRecording(
  workstreamId: string
): { contents: Electron.WebContents; status: PreviewStatus } | null {
  if (current === null || current.status.workstreamId !== workstreamId) return null;
  if (current.status.phase !== "ready" || current.contents === null || current.contents.isDestroyed()) {
    return null;
  }
  return { contents: current.contents, status: { ...current.status } };
}

/**
 * The supervisor's own news, fed through from the one process-log stream
 * `main.ts` already subscribes to. When the process behind the preview stops
 * — exited, failed, or stopped by a person — the preview says so plainly
 * instead of showing a page nothing is serving, and the words carry how it
 * ended. The state and the next action belong to the renderer's own surface.
 */
export function noteProcessChunk(chunk: ProcessLogChunk): void {
  if (current === null) return;
  if (chunk.processId !== current.status.processId) return;
  if (current.status.phase === "stopped") return;
  const said = describeProcessEnd(chunk);
  if (said === null) return;
  setPhase(current, "stopped", said);
}
