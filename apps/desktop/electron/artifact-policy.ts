import type { ProcessLog, PreviewStatus } from "@novus/contracts";
export { PIXELS_WARNING, RECORDING_CLAIM, SCREENSHOT_CLAIM } from "@novus/contracts";

/**
 * Capture policy (D-123) — every refusal, none of the view. Split from the
 * capture mechanics exactly as `preview-policy.ts` is split from the preview
 * view, so the security-bearing answers are testable in plain Node.
 *
 * The rule being enforced: Novus captures **the approved Preview surface of
 * the named lane's live process, showing a page, right now** — and nothing
 * else, ever. The desktop, other windows, the terminal, dialogs, secret
 * surfaces, and arbitrary sites are not "refused" so much as structurally
 * absent: the only pixels the capture authority can reach are the embedded
 * view's own, and these checks are what keep even those honest.
 */

/**
 * Why a capture of `workstreamId`'s preview must be refused right now, in
 * words — or null when it may proceed. `status` is the embedded preview's
 * current state; `logs` are the lane's own process logs, which is the same
 * source the preview was validated against when it opened (D-098).
 */
export function captureRefusal(
  status: PreviewStatus | null,
  workstreamId: string,
  logs: ProcessLog[]
): string | null {
  if (status === null) {
    return "No preview is open. Open the running app's preview to capture it.";
  }
  if (status.workstreamId !== workstreamId) {
    return "The open preview belongs to another lane. Open this lane's preview to capture it.";
  }
  if (status.phase === "loading") {
    return "The preview is still loading; there is no page on screen to capture yet.";
  }
  if (status.phase === "unreachable") {
    return "The preview's address did not answer; there is nothing on screen to capture.";
  }
  if (status.phase === "crashed") {
    return "The preview's page crashed; there is nothing on screen to capture.";
  }
  if (status.phase === "stopped") {
    return "The app behind this preview has stopped. A stale preview is not evidence.";
  }
  // The reporting process must still be live *now*: the preview notes a
  // stopped process itself, but a capture between the exit and that note must
  // not slip through as current evidence.
  const live = logs.some(
    (log) =>
      log.processId === status.processId &&
      log.kind === "run" &&
      (log.state === "starting" || log.state === "running")
  );
  if (!live) {
    return "The process that reported this address has ended. A stale preview is not evidence.";
  }
  return null;
}

/** The capture's process-side provenance, read from the same log row that
 *  justified the preview: declared readiness and the process's own name. */
export function captureProvenance(
  status: PreviewStatus,
  logs: ProcessLog[]
): { processId: string; processName: string; origin: string; readiness: ProcessLog["readiness"] } {
  const live = logs.find((log) => log.processId === status.processId);
  return {
    processId: status.processId,
    processName: status.processName,
    origin: status.origin,
    readiness: live?.readiness ?? "not_required"
  };
}

/** A concise generated label; never a filename and never user input. */
export function artifactLabel(kind: "screenshot" | "recording", processName: string): string {
  return `${kind === "screenshot" ? "Screenshot" : "Recording"} · ${processName}`.slice(0, 120);
}
