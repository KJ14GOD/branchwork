import { app, session, type BrowserWindow, type WebContents } from "electron";
import type { PreviewStatus, ProcessLogChunk } from "@novus/contracts";
import {
  browserNavigationAllowed,
  describeProcessEnd,
  previewNavigationAllowed,
  resolveBrowseAddress,
  type PreviewTarget
} from "./preview-policy";
import { TOKEN_PREVIEW_CANVAS } from "./design-tokens";

/**
 * The embedded preview surface (D-098, rebuilt in D-163, browsing since
 * D-224, tabs since D-225) — the view half. Every decision it enforces is
 * `preview-policy.ts`'s, tested in plain Node; this module owns the
 * main-process authority over the embedded pages and may only be imported by
 * `main.ts`, because it touches Electron at module scope.
 *
 * D-163, owner-directed: pages render through in-DOM `webview` elements —
 * each keeps its own renderer process and its own isolation, while the
 * element composites in the room's own stacking order.
 *
 * The renderer holds the elements; the main process holds every decision:
 *
 *  - the surface opens only on an address a **live** run process of this
 *    workstream actually reported (`resolvePreviewTarget`, called by
 *    `main.ts` before anything here runs), and a webview may attach only
 *    with the exact address of a tab this module already registered —
 *    anything else is refused before it exists (`will-attach-webview`);
 *  - whatever attributes the renderer wrote, the attach hook strips them: no
 *    preload, no Node, sandboxed, isolated, an in-memory partition per
 *    workstream shared by the lane's tabs;
 *  - a page's top frame may navigate to any credential-free http(s) address
 *    — the person's own browsing (D-224) — while `file:`, `javascript:`,
 *    and every other local-reach scheme stay refused; a new **tab** exists
 *    only through this module's own verb (D-225), `window.open` opens no
 *    second window (a navigable address loads in place), and downloads and
 *    permission requests are denied in this process, where the page cannot
 *    reach;
 *  - the approved origin stays the surface's identity: the agent's drive
 *    verbs and evidence capture act only on the **active** tab, and only
 *    while it is on that origin.
 *
 * The page loading is never presented as the application being ready:
 * readiness stays the declared signal's answer (D-045), and this module's
 * `ready` phase claims only that one HTTP response rendered.
 */

/** One page of the surface (D-225). `src` is the exact address its element
 *  must attach with — the will-attach gate's term for this tab. */
interface PreviewTab {
  tabId: string;
  src: string;
  contents: WebContents | null;
  currentUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  pagePhase: "loading" | "ready" | "unreachable" | "crashed";
  pageDetail: string | null;
}

interface EmbeddedPreview {
  workstreamId: string;
  partition: string;
  /** The validated opening address and its origin — the surface's identity. */
  url: string;
  origin: string;
  processId: string;
  processName: string;
  tabs: PreviewTab[];
  activeTabId: string;
  /** How the reporting process ended, once it did — overrides every page
   *  phase, because a page nothing serves must not read as fine. */
  stoppedDetail: string | null;
  agentDriving: boolean;
  agentPoint: { x: number; y: number } | null;
}

/** More would be a browser product; the preview is a surface with a few
 *  pages. Refused in words at the cap. */
const TAB_CAP = 8;

let current: EmbeddedPreview | null = null;
let tabCounter = 0;
const statusListeners = new Set<(status: PreviewStatus | null) => void>();
/** Partitions whose sessions already carry the deny-handlers, so re-adoption
 *  never stacks a second handler. */
const hardenedPartitions = new Set<string>();

function makeTab(src: string): PreviewTab {
  tabCounter += 1;
  return {
    tabId: `tab_${tabCounter}`,
    src,
    contents: null,
    currentUrl: src,
    title: "",
    canGoBack: false,
    canGoForward: false,
    pagePhase: "loading",
    pageDetail: null
  };
}

function activeTab(preview: EmbeddedPreview): PreviewTab {
  const found = preview.tabs.find((tab) => tab.tabId === preview.activeTabId) ?? preview.tabs[0];
  if (found === undefined) throw new Error("a preview always holds at least one tab");
  return found;
}

/** The one shape the renderer reads: the active tab's page in the standing
 *  fields, every tab summarized beside it (D-225). */
function statusOf(preview: EmbeddedPreview): PreviewStatus {
  const active = activeTab(preview);
  return {
    workstreamId: preview.workstreamId,
    url: preview.url,
    origin: preview.origin,
    processId: preview.processId,
    processName: preview.processName,
    currentUrl: active.currentUrl,
    canGoBack: active.canGoBack,
    canGoForward: active.canGoForward,
    phase: preview.stoppedDetail !== null ? "stopped" : active.pagePhase,
    detail: preview.stoppedDetail ?? active.pageDetail,
    agentDriving: preview.agentDriving,
    agentPoint: preview.agentPoint,
    tabs: preview.tabs.map((tab) => ({
      tabId: tab.tabId,
      src: tab.src,
      title: tab.title,
      currentUrl: tab.currentUrl
    })),
    activeTabId: preview.activeTabId
  };
}

export function onEmbeddedPreviewStatus(listener: (status: PreviewStatus | null) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function announce(): void {
  const status = current === null ? null : statusOf(current);
  for (const listener of statusListeners) {
    try {
      listener(status === null ? null : { ...status });
    } catch {
      /* a broken listener must not take the preview down with it */
    }
  }
}

export function embeddedPreviewStatus(): PreviewStatus | null {
  return current === null ? null : statusOf(current);
}

/**
 * Approves a preview for a validated target. Reopening the same address while
 * its process is still the one on record keeps the standing approval — the
 * renderer's elements re-attach under it, tabs and all. A different address,
 * or the same address re-reported by a new process after a restart, replaces
 * the approval: the old state described a server that is gone.
 */
export function openEmbeddedPreview(workstreamId: string, target: PreviewTarget): PreviewStatus {
  const url = target.url.toString();
  if (
    current !== null &&
    current.workstreamId === workstreamId &&
    current.url === url &&
    current.processId === target.processId &&
    current.stoppedDetail === null &&
    activeTab(current).pagePhase !== "crashed"
  ) {
    announce();
    return statusOf(current);
  }

  closeEmbeddedPreview();
  const first = makeTab(url);
  current = {
    workstreamId,
    partition: `preview:${workstreamId}`,
    url,
    origin: target.url.origin,
    processId: target.processId,
    processName: target.processName,
    tabs: [first],
    activeTabId: first.tabId,
    stoppedDetail: null,
    agentDriving: false,
    agentPoint: null
  };
  announce();
  return statusOf(current);
}

/**
 * Wires the two hooks that make the renderer's `webview` elements safe,
 * called once per host window by `main.ts`. `will-attach-webview` is the
 * gate — a webview whose address and partition are not a registered tab's
 * never comes into existence, and whatever attributes the renderer wrote are
 * replaced with the locked-down set. `web-contents-created` is the adoption.
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
    const pending =
      current !== null && params.partition === current.partition
        ? current.tabs.find((tab) => tab.contents === null && params.src === tab.src)
        : undefined;
    if (pending === undefined) {
      event.preventDefault();
      return;
    }
    // The renderer's attributes are proposals; these are the terms: a plain,
    // sandboxed web context and nothing of Novus's — no preload, no Node,
    // no bridge.
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
 *  `main.ts`, matching it to the pending tab whose address it attached with.
 *  An unapproved webview — none standing, a foreign partition, no pending
 *  tab — is closed on sight rather than guarded. */
export function adoptPreviewWebview(contents: WebContents): void {
  const preview = current;
  if (preview === null || contents.session !== session.fromPartition(preview.partition)) {
    contents.close();
    return;
  }
  // The attach gate admitted it for exactly one pending tab's address; the
  // oldest still-empty tab is that one (elements attach in creation order).
  const tab = preview.tabs.find((candidate) => candidate.contents === null);
  if (tab === undefined) {
    contents.close();
    return;
  }
  tab.contents = contents;

  if (!hardenedPartitions.has(preview.partition)) {
    hardenedPartitions.add(preview.partition);
    // The page may ask for nothing the operating system grants: camera,
    // microphone, notifications, clipboard — all denied without a dialog.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // And it may write nothing to disk: a preview is looked at, not saved from.
    contents.session.on("will-download", (event) => event.preventDefault());
  }

  // The person may browse (D-224): any credential-free http(s) address. The
  // platform stays refused — file:, javascript:, about:, smuggled
  // credentials never load, browser chrome or not.
  const guard = (event: { preventDefault: () => void }, destination: string): void => {
    if (!browserNavigationAllowed(destination)) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.setWindowOpenHandler(({ url: destination }) => {
    // A navigable link opens in place — a tab exists only through the tab
    // verb, a person's own act (D-225). Everything else opens nowhere.
    if (browserNavigationAllowed(destination)) {
      void contents.loadURL(destination);
    }
    return { action: "deny" };
  });

  const live = (): boolean =>
    current === preview && preview.tabs.includes(tab) && !contents.isDestroyed();

  // The address bar and the tab row tell the truth about where this page is
  // (D-224/D-225), and back/forward say whether its history can move.
  const noteLocation = (): void => {
    if (!live()) return;
    tab.currentUrl = contents.getURL().slice(0, 2000);
    tab.canGoBack = contents.navigationHistory.canGoBack();
    tab.canGoForward = contents.navigationHistory.canGoForward();
    announce();
  };
  contents.on("did-navigate", noteLocation);
  contents.on("did-navigate-in-page", noteLocation);
  contents.on("page-title-updated", (_event, title) => {
    if (!live()) return;
    tab.title = title.slice(0, 300);
    announce();
  });

  contents.on("did-start-loading", () => {
    if (!live()) return;
    tab.pagePhase = "loading";
    tab.pageDetail = null;
    announce();
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
    if (!live()) return;
    tab.pagePhase = "ready";
    tab.pageDetail = null;
    announce();
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
    if (!isMainFrame || errorCode === -3) return;
    if (!live()) return;
    tab.pagePhase = "unreachable";
    tab.pageDetail = errorDescription.slice(0, 400);
    announce();
  });
  contents.on("render-process-gone", (_event, details) => {
    if (!live()) return;
    tab.pagePhase = "crashed";
    tab.pageDetail = `The preview's own page process ended (${details.reason}).`;
    announce();
  });
  contents.on("destroyed", () => {
    // The element unmounted — the canvas lost the tab, not the person's
    // place: the approval stands and a remounted element re-attaches.
    if (current === preview && tab.contents === contents) tab.contents = null;
  });
}

/** The active tab's living contents, or null. Every person-verb below acts on
 *  the active tab: what is acted on is what is on screen. */
function activeContents(): { preview: EmbeddedPreview; tab: PreviewTab; contents: WebContents } | null {
  if (current === null) return null;
  const tab = activeTab(current);
  if (tab.contents === null || tab.contents.isDestroyed()) return null;
  return { preview: current, tab, contents: tab.contents };
}

export function reloadEmbeddedPreview(): void {
  const active = activeContents();
  if (active === null || active.preview.stoppedDetail !== null) return; // nothing serving; reopening is the verb
  active.tab.pagePhase = "loading";
  active.tab.pageDetail = null;
  announce();
  active.contents.reload();
}

/**
 * The person's own navigation (D-224): what the address bar submits, acting
 * on the active tab. A missing scheme means https; anything that is not a
 * credential-free http(s) address is refused in words. This is a person's
 * act on their own machine — the agent's way of moving the page is
 * `navigatePreview`, which stays confined to the approved origin.
 */
export function browsePreview(typed: string): { ok: true } | { ok: false; refusal: string } {
  const active = activeContents();
  if (active === null) {
    return { ok: false, refusal: "No page is showing to navigate." };
  }
  if (active.preview.stoppedDetail !== null) {
    return { ok: false, refusal: "The app behind this preview stopped. Reopen it to browse." };
  }
  const destination = resolveBrowseAddress(typed);
  if (destination === null) {
    return {
      ok: false,
      refusal: `Not a navigable address: ${typed.slice(0, 200)}. The preview browses http and https only.`
    };
  }
  active.tab.pagePhase = "loading";
  active.tab.pageDetail = null;
  announce();
  void active.contents.loadURL(destination);
  return { ok: true };
}

/** Step the active tab's own history (D-224). Where there is nothing to step
 *  to, nothing happens — the controls disable themselves off the status. */
export function browsePreviewHistory(direction: "back" | "forward"): void {
  const active = activeContents();
  if (active === null) return;
  const history = active.contents.navigationHistory;
  if (direction === "back" && history.canGoBack()) history.goBack();
  if (direction === "forward" && history.canGoForward()) history.goForward();
}

/**
 * A person opens another page of the surface (D-225). With no address it
 * opens on the app itself; with one, anywhere the browse policy allows. The
 * tab is registered here first — the will-attach gate admits an element only
 * for a tab this module already holds, so the renderer can never conjure one.
 */
export function newEmbeddedPreviewTab(typed?: string): { ok: true } | { ok: false; refusal: string } {
  if (current === null) return { ok: false, refusal: "No preview is open to add a tab to." };
  if (current.stoppedDetail !== null) {
    return { ok: false, refusal: "The app behind this preview stopped. Reopen it first." };
  }
  if (current.tabs.length >= TAB_CAP) {
    return { ok: false, refusal: `This preview holds at most ${TAB_CAP} tabs.` };
  }
  const destination = typed === undefined ? current.url : resolveBrowseAddress(typed);
  if (destination === null) {
    return {
      ok: false,
      refusal: `Not a navigable address: ${(typed ?? "").slice(0, 200)}. The preview browses http and https only.`
    };
  }
  const tab = makeTab(destination);
  current.tabs.push(tab);
  current.activeTabId = tab.tabId;
  announce();
  return { ok: true };
}

/** Puts a tab on the canvas (D-225). A stray id is a no-op, not an error —
 *  the renderer reads ids off the same status this writes. */
export function selectEmbeddedPreviewTab(tabId: string): void {
  if (current === null) return;
  if (!current.tabs.some((tab) => tab.tabId === tabId)) return;
  current.activeTabId = tabId;
  announce();
}

/** Closes one tab and its page (D-225). The last tab is the surface itself —
 *  closing it is the preview tab's own close, not this verb's. */
export function closeEmbeddedPreviewTab(tabId: string): { ok: true } | { ok: false; refusal: string } {
  if (current === null) return { ok: false, refusal: "No preview is open." };
  const index = current.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index === -1) return { ok: false, refusal: "No such tab." };
  if (current.tabs.length === 1) {
    return { ok: false, refusal: "The last tab is the preview itself — close the Preview tab instead." };
  }
  const closed = current.tabs.splice(index, 1)[0];
  const fallback = current.tabs[Math.max(0, index - 1)];
  if (closed === undefined || fallback === undefined) return { ok: false, refusal: "No such tab." };
  if (current.activeTabId === closed.tabId) {
    current.activeTabId = fallback.tabId;
  }
  if (closed.contents !== null && !closed.contents.isDestroyed()) closed.contents.close();
  announce();
  return { ok: true };
}

/** Discards the approval and every tab. Never touches the process: closing a
 *  preview is closing a window onto the app, not stopping the app (D-098). */
export function closeEmbeddedPreview(): void {
  if (current === null) return;
  const preview = current;
  current = null;
  for (const tab of preview.tabs) {
    if (tab.contents !== null && !tab.contents.isDestroyed()) tab.contents.close();
  }
  announce();
}

/**
 * The agent's hands on the preview (D-218). The renderer never names a
 * target; the only page these can touch is the active tab this module
 * already validated and adopted, and every one is refused in words when no
 * page is showing — the same gate `capturePreviewImage` uses. The endpoint
 * behind these is grant-checked (D-218's turn grant) before any is called.
 *
 * These drive the *fenced* browser: the agent acts only while the active tab
 * is on the approved loopback origin (D-224), so driving grants it no reach
 * it did not already have — it is the agent's own dev server. Raw computer
 * use, which can reach the whole machine, is a separate, guardrailed
 * surface (D-218) and lives nowhere near this module.
 */

/** Marks the preview as agent-driven (D-218), so the room shows it and offers
 *  the cut-off, and remembers where the agent last acted for the cursor dot.
 *  A null point clears the dot without changing the driving state. */
export function setPreviewAgentDriving(
  workstreamId: string,
  driving: boolean,
  point: { x: number; y: number } | null = null
): void {
  if (current === null || current.workstreamId !== workstreamId) return;
  current.agentDriving = driving;
  current.agentPoint = driving ? (point ?? current.agentPoint) : null;
  announce();
}

/** The one validity gate every drive verb shares: this exact lane's preview,
 *  a live loaded active page, and a living guest process. */
function drivable(
  workstreamId: string
): { contents: WebContents; origin: string } | { refusal: string } {
  if (current === null || current.workstreamId !== workstreamId) {
    return { refusal: "No preview is open for this lane. Open the app's preview first." };
  }
  const tab = activeTab(current);
  if (
    current.stoppedDetail !== null ||
    tab.pagePhase !== "ready" ||
    tab.contents === null ||
    tab.contents.isDestroyed()
  ) {
    return { refusal: "The preview has no loaded page to act on." };
  }
  return { contents: tab.contents, origin: current.origin };
}

/**
 * The stricter gate the acting verbs share (D-224): the active page must
 * also be on the approved origin. A person may browse the surface anywhere;
 * the agent's hands stay the *fenced* browser D-218 promised — it acts only
 * on the lane's own app, and `browser_navigate` (which passes only the plain
 * gate) is its one way home from wherever the person went.
 */
function drivableOnOrigin(
  workstreamId: string
): { contents: WebContents; origin: string } | { refusal: string } {
  const gate = drivable(workstreamId);
  if ("refusal" in gate) return gate;
  if (!previewNavigationAllowed(gate.origin, gate.contents.getURL())) {
    return {
      refusal: `The preview is browsed away from the app (a person's own navigation). The agent acts only on ${gate.origin} — navigate back to it first.`
    };
  }
  return gate;
}

/** Navigate the fenced page within its approved origin (D-218). A path or a
 *  same-origin URL only — anything else is refused, the open gate's own rule. */
export async function navigatePreview(
  workstreamId: string,
  to: string
): Promise<{ ok: true; url: string } | { ok: false; refusal: string }> {
  const gate = drivable(workstreamId);
  if ("refusal" in gate) return { ok: false, refusal: gate.refusal };
  let destination: string;
  try {
    destination = new URL(to, `${gate.origin}/`).toString();
  } catch {
    return { ok: false, refusal: `Not a navigable address: ${to.slice(0, 200)}` };
  }
  if (!previewNavigationAllowed(gate.origin, destination)) {
    return {
      ok: false,
      refusal: `The preview stays on ${gate.origin}. It cannot navigate to ${destination.slice(0, 200)}.`
    };
  }
  await gate.contents.loadURL(destination);
  return { ok: true, url: destination };
}

/** Click at a point in the page's own CSS pixels (D-218). */
export async function clickPreview(
  workstreamId: string,
  x: number,
  y: number
): Promise<{ ok: true } | { ok: false; refusal: string }> {
  const gate = drivableOnOrigin(workstreamId);
  if ("refusal" in gate) return { ok: false, refusal: gate.refusal };
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { ok: false, refusal: "A click needs a point inside the page." };
  }
  const at = { x: Math.round(x), y: Math.round(y) };
  gate.contents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
  gate.contents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  gate.contents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  setPreviewAgentDriving(workstreamId, true, at);
  return { ok: true };
}

/** Type text into whatever the page has focused (D-218). */
export function typePreview(
  workstreamId: string,
  text: string
): { ok: true } | { ok: false; refusal: string } {
  const gate = drivableOnOrigin(workstreamId);
  if ("refusal" in gate) return { ok: false, refusal: gate.refusal };
  for (const character of [...text].slice(0, 10_000)) {
    gate.contents.sendInputEvent({ type: "char", keyCode: character });
  }
  return { ok: true };
}

/** A named key — Enter, Tab, Backspace, an arrow (D-218). */
const NAMED_KEYS: Record<string, string> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right"
};

export function pressPreviewKey(
  workstreamId: string,
  key: string
): { ok: true } | { ok: false; refusal: string } {
  const gate = drivableOnOrigin(workstreamId);
  if ("refusal" in gate) return { ok: false, refusal: gate.refusal };
  const keyCode = NAMED_KEYS[key.toLowerCase().trim()];
  if (keyCode === undefined) {
    return { ok: false, refusal: `Not a key this preview presses: ${key.slice(0, 40)}` };
  }
  gate.contents.sendInputEvent({ type: "keyDown", keyCode });
  gate.contents.sendInputEvent({ type: "keyUp", keyCode });
  return { ok: true };
}

/** A bounded text snapshot of the page, so the agent can read what it is
 *  looking at without a screenshot (D-218). The page is the agent's own dev
 *  server; its text is not evidence and is not stored. */
export async function readPreview(
  workstreamId: string
): Promise<{ ok: true; title: string; url: string; text: string } | { ok: false; refusal: string }> {
  const gate = drivableOnOrigin(workstreamId);
  if ("refusal" in gate) return { ok: false, refusal: gate.refusal };
  const snapshot = (await gate.contents.executeJavaScript(
    `({ title: document.title, url: location.href, text: (document.body && document.body.innerText || "").slice(0, 8000) })`,
    true
  )) as { title?: unknown; url?: unknown; text?: unknown };
  return {
    ok: true,
    title: typeof snapshot.title === "string" ? snapshot.title.slice(0, 300) : "",
    url: typeof snapshot.url === "string" ? snapshot.url.slice(0, 300) : gate.origin,
    text: typeof snapshot.text === "string" ? snapshot.text : ""
  };
}

/**
 * The capture authority's one window onto pixels (D-123): the active tab of
 * the embedded preview, photographed by the main process. The renderer never
 * names a target — the only thing this can capture is a page this module
 * already validated and adopted. Refused in words when no page is showing.
 */
export async function capturePreviewImage(
  workstreamId: string
): Promise<
  | { ok: true; image: Electron.NativeImage; status: PreviewStatus }
  | { ok: false; refusal: string }
> {
  if (current === null || current.workstreamId !== workstreamId) {
    return { ok: false, refusal: "No preview is open for this lane." };
  }
  const tab = activeTab(current);
  if (
    current.stoppedDetail !== null ||
    tab.pagePhase !== "ready" ||
    tab.contents === null ||
    tab.contents.isDestroyed()
  ) {
    return { ok: false, refusal: "The preview has no loaded page to capture." };
  }
  // Evidence binds to the lane's own app (D-122): a capture of wherever the
  // person browsed to (D-224) attributed to this process and origin would be
  // exactly the provenance lie the artifact system exists to prevent.
  if (!previewNavigationAllowed(current.origin, tab.contents.getURL())) {
    return {
      ok: false,
      refusal: `The preview is browsed away from the app. Evidence captures only ${current.origin} — go back to it first.`
    };
  }
  const image = await tab.contents.capturePage();
  if (image.isEmpty()) {
    return { ok: false, refusal: "The preview rendered nothing to capture." };
  }
  return { ok: true, image, status: statusOf(current) };
}

/** The active tab's contents for the recording pipeline (D-123) — handed
 *  only to the display-media handler the main process itself installs, never
 *  to a renderer. Null unless this exact lane's preview is showing the app. */
export function previewContentsForRecording(
  workstreamId: string
): { contents: WebContents; status: PreviewStatus } | null {
  if (current === null || current.workstreamId !== workstreamId) return null;
  const tab = activeTab(current);
  if (
    current.stoppedDetail !== null ||
    tab.pagePhase !== "ready" ||
    tab.contents === null ||
    tab.contents.isDestroyed()
  ) {
    return null;
  }
  // The same origin bind a capture carries (D-122, D-224): a recording is
  // evidence, and evidence photographs only the lane's own app.
  if (!previewNavigationAllowed(current.origin, tab.contents.getURL())) return null;
  return { contents: tab.contents, status: statusOf(current) };
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
  if (chunk.processId !== current.processId) return;
  if (current.stoppedDetail !== null) return;
  const said = describeProcessEnd(chunk);
  if (said === null) return;
  current.stoppedDetail = said;
  announce();
}
