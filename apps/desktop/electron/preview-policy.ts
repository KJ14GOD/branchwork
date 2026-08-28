import type { ProcessLog, ProcessLogChunk } from "@novus/contracts";
import { ApiError } from "./api-client";
import { parseLoopbackHttpUrl, sameLoopbackAddress } from "./workspace-processes";

/**
 * The embedded preview's policy (D-098) — every decision, none of the view.
 *
 * Split from `workspace-preview.ts` so the security-bearing answers are
 * testable in plain Node: the view module imports Electron at module scope
 * and only `main.ts` may touch it, while everything below is a pure function
 * of what it is handed. The malicious cases, the stale cases, and the
 * navigation containment are all decided here.
 */

/** What the validated request resolves to: the address rebuilt from parsed
 *  components, and the live process whose report justifies opening it. */
export interface PreviewTarget {
  url: URL;
  processId: string;
  processName: string;
}

/**
 * The one gate between "the renderer asked" and "a view exists". The URL
 * check and the live-process check are both here because both matter: the
 * first refuses `http://localhost@evil.example`, a scheme that is not
 * `http`/`https`, and anything carrying whitespace or control characters;
 * the second refuses an address that was once true — a process that ended,
 * a URL remembered from an earlier run, or one the renderer simply invented.
 */
export function resolvePreviewTarget(rawUrl: string, logs: ProcessLog[]): PreviewTarget {
  const parsed = parseLoopbackHttpUrl(rawUrl);
  if (parsed === null) {
    throw new ApiError(
      "preview_refused",
      "Novus shows a local preview only: a loopback http or https address, with no credentials in it.",
      409
    );
  }
  const live = logs.find(
    (log) =>
      log.kind === "run" &&
      (log.state === "starting" || log.state === "running") &&
      log.previewUrl !== null &&
      // Exact match, or the same loopback machine written another way
      // (localhost / 127.0.0.1 / [::1] on the same scheme and port, D-157).
      (log.previewUrl === rawUrl || sameLoopbackAddress(log.previewUrl, rawUrl))
  );
  if (live === undefined) {
    throw new ApiError(
      "preview_not_live",
      "Nothing running in this workspace reports that address. Start the app from Run to open its preview.",
      409
    );
  }
  return { url: parsed, processId: live.processId, processName: live.name };
}

/**
 * Whether `candidate` is on the approved origin: the same loopback
 * application the preview was opened on. Scheme and port have to agree —
 * `http://localhost:3000` and `http://localhost:9999` are different
 * applications — while the loopback hostname spellings are one machine
 * (D-157): an app opened on `localhost` that redirects itself to `127.0.0.1`
 * is still itself. Runs through the same parser as the open gate so
 * whitespace and credential smuggling are refused here identically.
 *
 * Since D-224 this no longer fences the person's own browsing — the top
 * frame may leave (`browserNavigationAllowed` decides how far). What stays
 * bound to this answer: the agent's drive verbs, and evidence capture —
 * both act only on the lane's own app.
 */
export function previewNavigationAllowed(approvedOrigin: string, candidate: string): boolean {
  const parsed = parseLoopbackHttpUrl(candidate);
  if (parsed === null) return false;
  return parsed.origin === approvedOrigin || sameLoopbackAddress(approvedOrigin, parsed.toString());
}

/**
 * Where the person's own browsing may take the top frame (D-224): any
 * credential-free `http`/`https` address, and nothing else. The web is
 * allowed; the platform is not — `file:`, `javascript:`, `about:`, smuggled
 * credentials, and control characters are refused exactly as the open gate
 * refuses them, because a browser chrome is not a reason to hand the guest
 * a scheme with local reach.
 */
export function browserNavigationAllowed(candidate: string): boolean {
  if (/[\s\u0000-\u001f\u007f]/.test(candidate)) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.username === "" && url.password === "";
}

/**
 * What the address bar's typing resolves to (D-224): a person types
 * `github.com/kj16` and means `https://github.com/kj16`, so a missing scheme
 * gets `https://` — never a search, never a guess beyond that. Returns the
 * normalized address, or null where nothing navigable was typed.
 */
export function resolveBrowseAddress(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return null;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!browserNavigationAllowed(candidate)) return null;
  return new URL(candidate).toString();
}

/**
 * The words a stopped process leaves on the preview. Null while the chunk
 * says the process is still alive — a preview only goes down over a process
 * that actually ended, never over one that merely printed something.
 */
export function describeProcessEnd(chunk: ProcessLogChunk): string | null {
  if (chunk.state === "starting" || chunk.state === "running") return null;
  if (chunk.state === "failed") {
    return chunk.exitCode !== null ? `The app exited with code ${chunk.exitCode}.` : "The app failed.";
  }
  if (chunk.ending === "cancelled") return "The app was stopped.";
  if (chunk.exitCode !== null) return `The app exited with code ${chunk.exitCode}.`;
  return "The app is no longer running.";
}
