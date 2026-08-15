import { useCallback, useEffect, useRef, useState } from "react";
import {
  PIXELS_WARNING,
  type MissionDetailResponse,
  type PreviewBounds,
  type PreviewStatus,
  type RecordingStatus
} from "@novus/contracts";
import { novus } from "../bridge";
import { shortSha } from "../format";
import { liveRunProcess } from "./derive";
import { previewPresentation } from "./preview";
import { GatedAction } from "./gated";

/**
 * The preview surface (D-098): the room's window onto the running app.
 *
 * The page itself is a native view the main process owns; this component
 * reserves the rectangle, keeps the view placed over it, and says the states
 * in words. Two jobs matter here and both are about honesty:
 *
 *  - the reserved rectangle is *reserved*: the native view paints above every
 *    piece of DOM, so whenever anything of the room's own would overlap it —
 *    a dialog, a menu, the narrow-width dock — the view is taken off screen
 *    until the rectangle is clear again;
 *  - the head's state word is the **process's** own, in the runtime
 *    vocabulary (D-045) — the page loading never promotes it, so "starting"
 *    stays on screen until the declared signal answers, however rendered the
 *    page looks.
 */

const DENIAL = "Invoking a command this project declared needs the workspace.command capability.";

/** How often the rectangle is re-checked for something covering it. The cheap
 *  half of correctness: resize and layout changes land via the observer, and
 *  this catches overlays that change nothing about the rectangle itself. */
const COVER_CHECK_MS = 300;

export function PreviewSurface({
  missionId,
  workstreamId,
  url,
  name,
  detail,
  onReopen
}: {
  missionId: string;
  /** The lane the preview was opened from — its identity, like a file tab's. */
  workstreamId: string | null;
  url: string;
  /** The run command's name as the tab recorded it — the fallback identity
   *  once the process is gone and nothing live can be asked. */
  name: string;
  /** The lane's own view of the mission, for the process's state word and the
   *  Run-again gate. */
  detail: MissionDetailResponse | null;
  /** A stopped app that is serving again reopens on the fresh address; the
   *  tab's own record follows it. */
  onReopen: (url: string) => void;
}) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The last capture's quiet confirmation; clears itself. */
  const [captured, setCaptured] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const running = detail ? liveRunProcess(detail) : null;
  const view = previewPresentation(status, running, openError);

  const measure = useCallback((): PreviewBounds | null => {
    const element = bodyRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, []);

  const open = useCallback(async () => {
    const bounds = measure();
    if (bounds === null) return;
    setOpenError(null);
    const result = await novus().workspace.preview.open({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      url,
      bounds
    });
    if (result.ok) {
      setStatus(result.value);
    } else {
      setStatus(null);
      setOpenError(result.message);
    }
  }, [missionId, workstreamId, url, measure]);

  // Opening is showing: mount asks for the view, unmount takes it off screen
  // — and only off screen. The view and the process both survive the tab
  // losing the canvas; closing the tab is the shell's own act.
  useEffect(() => {
    void open();
    return () => {
      void novus().workspace.preview.hide();
    };
  }, [open]);

  useEffect(() => novus().workspace.preview.onStatus((next) => setStatus(next)), []);

  // The rectangle's keeper. The native view cannot be covered by DOM, so the
  // rule is: while every sample point of the reserved rectangle is actually
  // this surface's own DOM, the view sits on it; the moment anything else is
  // on top — a dialog, a popover, the dock-as-overlay below 900px, the rail
  // overlay — the view hides until the rectangle is clear again.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let hidden = false;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const inset = 8;
      const points: [number, number][] = [
        [rect.x + rect.width / 2, rect.y + rect.height / 2],
        [rect.x + inset, rect.y + inset],
        [rect.x + rect.width - inset, rect.y + inset],
        [rect.x + inset, rect.y + rect.height - inset],
        [rect.x + rect.width - inset, rect.y + rect.height - inset]
      ];
      const covered = points.some(([x, y]) => {
        const top = document.elementFromPoint(x, y);
        return top !== null && !element.contains(top);
      });
      if (covered) {
        if (!hidden) {
          hidden = true;
          void novus().workspace.preview.hide();
        }
        return;
      }
      hidden = false;
      void novus().workspace.preview.setBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener("resize", sync);
    const timer = setInterval(sync, COVER_CHECK_MS);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      clearInterval(timer);
    };
  }, []);

  const runAgain = async () => {
    const commandName = status?.processName ?? running?.name ?? name;
    if (!detail) return;
    const result = await novus().workspace.command({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      kind: "run",
      name: commandName
    });
    setNote(result.ok ? null : result.message);
  };

  const openExternal = async () => {
    const result = await novus().workspace.openPreview({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      url: status?.url ?? url
    });
    setNote(result.ok ? null : result.message);
  };

  const reload = () => void novus().workspace.preview.reload();

  // Capturing (D-122): the renderer names the lane and nothing else; the main
  // process judges the preview, reads the revision, and stores the evidence.
  const capture = async () => {
    setCaptured(null);
    setNote(null);
    const result = await novus().artifacts.capture({
      missionId,
      ...(workstreamId ? { workstreamId } : {})
    });
    if (!result.ok) {
      setNote(result.message);
      return;
    }
    setCaptured(
      result.value.revisionSha
        ? `Captured at ${shortSha(result.value.revisionSha)} — in Evidence.`
        : "Captured — in Evidence."
    );
  };

  useEffect(() => {
    if (captured === null) return;
    const timer = setTimeout(() => setCaptured(null), 6_000);
    return () => clearTimeout(timer);
  }, [captured]);

  // Recording (D-123): the machine-local state, subscribed live, with the
  // elapsed time ticking beside the word while one runs.
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState("0:00");
  useEffect(() => {
    void novus()
      .artifacts.recordingStatus()
      .then((result) => {
        if (result.ok) setRecording(result.value);
      });
    return novus().artifacts.onRecording((status) => setRecording(status));
  }, []);
  useEffect(() => {
    if (recording === null) return;
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(recording.startedAt)) / 1000));
      setElapsedLabel(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const startRecording = async () => {
    setNote(null);
    const result = await novus().artifacts.startRecording({
      missionId,
      ...(workstreamId ? { workstreamId } : {})
    });
    if (!result.ok) setNote(result.message);
  };

  const stopRecording = async () => {
    const result = await novus().artifacts.stopRecording();
    if (!result.ok) {
      setNote(result.message);
      return;
    }
    setCaptured(
      result.value.state === "interrupted"
        ? "Recording saved, marked interrupted — in Evidence."
        : "Recording saved — in Evidence."
    );
  };

  const cancelRecording = async () => {
    const result = await novus().artifacts.cancelRecording();
    if (!result.ok) setNote(result.message);
  };

  const reopenTarget = running?.previewUrl ?? null;

  return (
    <section className="preview-surface" aria-label="App preview" data-testid="preview-surface">
      <header className="preview-head">
        <span className="file-chip mono" title={status?.url ?? url}>
          {status?.origin ?? url}
        </span>
        {/* The process's own word, the runtime vocabulary — never the page's. */}
        <span className="file-meta" data-testid="preview-word">
          {view.word}
        </span>
        <span className="head-spacer" />
        {captured && (
          <span className="file-meta" data-testid="preview-captured">
            {captured}
          </span>
        )}
        {recording !== null ? (
          <>
            <span className="recording-word" data-testid="recording-word">
              {recording.state === "finalizing" ? "Saving recording…" : `Recording · ${elapsedLabel}`}
            </span>
            <button
              className="btn btn-secondary"
              onClick={() => void stopRecording()}
              disabled={recording.state === "finalizing"}
              data-testid="recording-stop"
            >
              Stop recording
            </button>
            <button
              className="btn btn-text"
              onClick={() => void cancelRecording()}
              disabled={recording.state === "finalizing"}
              data-testid="recording-cancel"
            >
              Cancel
            </button>
          </>
        ) : (
          detail && (
            <>
              <GatedAction
                capability="artifact.capture"
                capabilities={detail.capabilities}
                denialReason="Capturing evidence needs the artifact.capture capability."
                holderLogin={detail.control.holderLogin}
                onClick={() => void capture()}
                variant="text"
                testid="preview-capture"
              >
                Capture screenshot
              </GatedAction>
              <GatedAction
                capability="artifact.capture"
                capabilities={detail.capabilities}
                denialReason="Capturing evidence needs the artifact.capture capability."
                holderLogin={detail.control.holderLogin}
                onClick={() => void startRecording()}
                variant="text"
                testid="recording-start"
              >
                Start recording
              </GatedAction>
            </>
          )
        )}
        <button className="btn btn-text" onClick={reload} data-testid="preview-reload">
          Reload
        </button>
        <button className="btn btn-text" onClick={() => void openExternal()} data-testid="preview-external">
          Open in browser
        </button>
      </header>
      {/* The standing human warning at the capture point (D-123): the pixels
          are the application's own, and Novus does not scan them. */}
      {detail && (
        <p className="preview-capture-warning" data-testid="preview-capture-warning">
          {PIXELS_WARNING}
        </p>
      )}
      {note && (
        <p className="inline-error preview-note" role="alert">
          {note}
          <button className="btn btn-text" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </p>
      )}
      {/* The reserved rectangle. While the page is on screen the native view
          sits exactly over this; in every other state these words do. */}
      <div className="preview-body" ref={bodyRef} data-testid="preview-body" data-phase={status?.phase ?? "none"}>
        {view.panel && (
          <div className="preview-panel" data-testid="preview-panel">
            <p className="preview-panel-title">{view.panel.title}</p>
            {view.panel.detail && <p className="preview-panel-detail">{view.panel.detail}</p>}
            {view.panel.action === "reload" && (
              <button className="btn btn-secondary" onClick={reload} data-testid="preview-retry">
                Reload
              </button>
            )}
            {view.panel.action === "run_again" && detail && (
              <GatedAction
                capability="workspace.command"
                capabilities={detail.capabilities}
                denialReason={DENIAL}
                holderLogin={detail.control.holderLogin}
                onClick={() => void runAgain()}
                variant="secondary"
                testid="preview-run-again"
              >
                {`Run ${status?.processName ?? running?.name ?? name} again`}
              </GatedAction>
            )}
            {view.panel.action === "reopen" && reopenTarget !== null && (
              <button
                className="btn btn-secondary"
                // The same address served by a new process re-validates and
                // reopens in place; a new address moves the tab's own record.
                onClick={() => (reopenTarget === url ? void open() : onReopen(reopenTarget))}
                data-testid="preview-reopen"
              >
                Open preview
              </button>
            )}
            {/* Stopping lives on Run; this surface never grows a Stop, and
                closing it never stops anything (D-098). */}
          </div>
        )}
      </div>
    </section>
  );
}
