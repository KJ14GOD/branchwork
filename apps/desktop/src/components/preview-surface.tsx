import { useCallback, useEffect, useRef, useState } from "react";
import {
  PIXELS_WARNING,
  type MissionDetailResponse,
  type PreviewStatus,
  type RecordingStatus
} from "@novus/contracts";
import { novus } from "../bridge";
import { shortSha } from "../format";
import { liveRunProcess } from "./derive";
import { previewPresentation } from "./preview";
import { GatedAction } from "./gated";

/**
 * The preview surface (D-098, rebuilt in D-163): the room's window onto the
 * running app.
 *
 * The page renders through an in-DOM `webview` — its own isolated process,
 * composited in the room's own stacking order, so a menu or dialog above the
 * preview is simply above it. The main process approves the address before
 * the element may attach and clamps everything about it (`will-attach-webview`);
 * this component renders the approved element and says the states in words.
 * The head's state word is the **process's** own, in the runtime vocabulary
 * (D-045) — the page loading never promotes it, so "starting" stays on screen
 * until the declared signal answers, however rendered the page looks.
 */

// The webview element, for JSX: Electron's tag, not a component. Only the
// attributes this surface actually writes are typed, and the main process
// replaces whatever is written with the locked-down set regardless.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}

const DENIAL = "Invoking a command this project declared needs the workspace.command capability.";

/** The head's action glyphs — the file view's stroke set (D-151), so the
 *  preview's chrome reads as the app's own and never a browser's. */
function CameraGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.6l1-1.5h3.8l1 1.5h1.6A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
      <circle cx="8" cy="8.5" r="2.4" />
    </svg>
  );
}

function RecordGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ReloadGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
      <path d="M13.4 1.8v2.8h-2.8" />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7A1.5 1.5 0 0 0 12.5 12V9.5" />
      <path d="M9.5 2.5h4v4M13.2 2.8 8 8" />
    </svg>
  );
}

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

  const open = useCallback(async () => {
    setOpenError(null);
    const result = await novus().workspace.preview.open({
      missionId,
      ...(workstreamId ? { workstreamId } : {}),
      url
    });
    if (result.ok) {
      setStatus(result.value);
    } else {
      setStatus(null);
      setOpenError(result.message);
    }
  }, [missionId, workstreamId, url]);

  // Opening asks for the approval; the element below attaches under it
  // (D-163). Unmounting removes the element and its page process with it;
  // the approval stands, so a re-opened tab re-attaches where it left off is
  // not promised — the page reloads, which is what a closed-and-reopened
  // window onto an app honestly does.
  useEffect(() => {
    void open();
  }, [open]);

  useEffect(() => novus().workspace.preview.onStatus((next) => setStatus(next)), []);

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
    // A screenshot's toast from moments ago must not survive into a
    // recording's own words: this surface no longer remounts on every canvas
    // switch (D-170), so a stale message would otherwise sit here until its
    // own 6-second timer caught up.
    setCaptured(null);
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
              {/* The capture warning rides the capture controls themselves
                  (D-164): still at the capture point, no longer a standing
                  row stealing the page's height. */}
              <GatedAction
                capability="artifact.capture"
                capabilities={detail.capabilities}
                denialReason="Capturing evidence needs the artifact.capture capability."
                holderLogin={detail.control.holderLogin}
                onClick={() => void capture()}
                variant="icon"
                label="Capture screenshot"
                hint={`Capture screenshot — ${PIXELS_WARNING}`}
                testid="preview-capture"
              >
                <CameraGlyph />
              </GatedAction>
              <GatedAction
                capability="artifact.capture"
                capabilities={detail.capabilities}
                denialReason="Capturing evidence needs the artifact.capture capability."
                holderLogin={detail.control.holderLogin}
                onClick={() => void startRecording()}
                variant="icon"
                label="Start recording"
                hint={`Start recording — ${PIXELS_WARNING}`}
                testid="recording-start"
              >
                <RecordGlyph />
              </GatedAction>
            </>
          )
        )}
        <button
          className="icon-button"
          onClick={reload}
          title="Reload"
          aria-label="Reload"
          data-testid="preview-reload"
        >
          <ReloadGlyph />
        </button>
        <button
          className="icon-button"
          onClick={() => void openExternal()}
          title="Open in browser"
          aria-label="Open in browser"
          data-testid="preview-external"
        >
          <ExternalGlyph />
        </button>
      </header>
      {note && (
        <p className="inline-error preview-note" role="alert">
          {note}
          <button className="btn btn-text" onClick={() => setNote(null)}>
            Dismiss
          </button>
        </p>
      )}
      {/* The page, in the room's own stacking order (D-163). While it is on
          screen it fills this element; in every other state the words do. */}
      <div className="preview-body" ref={bodyRef} data-testid="preview-body" data-phase={status?.phase ?? "none"}>
        {status && (status.phase === "loading" || status.phase === "ready") && (
          <webview
            className="preview-webview"
            src={status.url}
            partition={`preview:${status.workstreamId}`}
            data-testid="preview-webview"
          />
        )}
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
