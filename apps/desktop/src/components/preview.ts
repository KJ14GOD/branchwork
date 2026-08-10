import type { PreviewStatus, WorkspaceProcess } from "@novus/contracts";

/**
 * What the preview surface says, derived and pure (D-098).
 *
 * Two sources, kept honestly apart. The **process** owns the head's state
 * word — the same runtime vocabulary the Output section uses (D-045), so
 * *starting* is the declared readiness signal still unanswered and *running,
 * not answering* is its deadline passed — and the **page** owns the panel:
 * whether the rectangle holds the app or an explanation. A page that loaded
 * proves one HTTP response rendered; it never promotes the process's word,
 * because readiness is declared, not inferred.
 */

/**
 * The preview rides the room's one "something open over the canvas" mechanism:
 * selecting it stores this sentinel where a file tab's key would go, so every
 * existing way of choosing another canvas — a file, a session, Compare, the
 * way back to the mission — already deselects it without knowing it exists.
 */
export const PREVIEW_TAB_KEY = "::preview";

/** The pull request's own tab rides the same mechanism (D-100, the
 *  Conductor shape): opened only by a person, deselected by everything that
 *  selects another canvas. */
export const PULL_TAB_KEY = "::pull";

/** One open preview tab: an address in one lane's workspace, captured when it
 *  was opened, exactly as a file tab captures its lane (D-084, D-098). */
export interface OpenPreviewTab {
  url: string;
  workstreamId: string | null;
  /** The run command's name, kept on the tab so a stopped app can still be
   *  offered again by name. */
  name: string;
}

export interface PreviewPanel {
  /** The one sentence, `--text-1`. */
  title: string;
  /** The supporting fact, when there is one. */
  detail: string | null;
  /** The correct next action, and only the correct one: reload a page that
   *  failed, run the app again once it stopped, reopen once a live process
   *  reports an address again. Null when nothing helps (the app is starting;
   *  waiting is the action). */
  action: "reload" | "run_again" | "reopen" | null;
}

export interface PreviewPresentation {
  /** The head's state word, in words, never a dot (DESIGN.md#status-semantics). */
  word: string;
  /** Null while the embedded page itself is on screen. */
  panel: PreviewPanel | null;
}

/** The process's own state word — identical vocabulary to the Output section. */
export function processWord(process: WorkspaceProcess | null): string {
  if (process === null) return "stopped";
  if (process.state === "starting") return "starting";
  if (process.state === "running") {
    return process.readiness === "unreachable" ? "running, not answering" : "running";
  }
  if (process.state === "failed") {
    return process.exitCode !== null ? `exited ${process.exitCode}` : "failed";
  }
  if (process.state === "exited") {
    return process.exitCode !== null ? `exited ${process.exitCode}` : "exited";
  }
  return "stopped";
}

/**
 * @param status  the embedded view's own report, null while none exists
 * @param process the lane's live run process from the room's poll, null once
 *                it ended — the poll's word may trail the push by a beat, so
 *                a stopped page wins over a process the poll still shows
 * @param openError what the open call refused with, shown in place of a page
 */
export function previewPresentation(
  status: PreviewStatus | null,
  process: WorkspaceProcess | null,
  openError: string | null = null
): PreviewPresentation {
  if (openError !== null) {
    return {
      word: processWord(process),
      panel: {
        title: "This preview could not open.",
        detail: openError,
        action: process?.previewUrl ? "reopen" : "run_again"
      }
    };
  }
  if (status === null) {
    return {
      word: processWord(process),
      panel: { title: "Opening the preview…", detail: null, action: null }
    };
  }
  switch (status.phase) {
    case "loading":
    case "ready":
      return { word: processWord(process), panel: null };
    case "unreachable":
      return {
        word: processWord(process),
        panel: {
          title: "The page did not answer.",
          detail: status.detail,
          // While the app is still starting, waiting is the action; once its
          // signal answered, a retry is.
          action: process?.state === "starting" ? null : "reload"
        }
      };
    case "crashed":
      return {
        word: processWord(process),
        panel: { title: "The preview's page crashed.", detail: status.detail, action: "reload" }
      };
    case "stopped":
      return {
        word: "stopped",
        panel: {
          title: status.detail ?? "The app is no longer running.",
          detail: null,
          // A new live process reporting an address means the preview can
          // simply reopen on it; otherwise the honest next act is running the
          // app again — never pretending the page is still being served.
          action:
            process !== null &&
            (process.state === "starting" || process.state === "running") &&
            process.previewUrl !== null
              ? "reopen"
              : "run_again"
        }
      };
  }
}
