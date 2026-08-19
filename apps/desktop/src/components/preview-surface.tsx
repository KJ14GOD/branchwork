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
  /** The frozen-frame swap (D-160): the view's own pixels as a still while an
   *  overlay is above the rectangle. Null when the live view is on screen;
   *  the ref mirrors the state so the keeper's tick can read it without
   *  re-subscribing. */
  const [frozen, setFrozen] = useState<string | null>(null);
  const frozenRef = useRef<string | null>(null);
  const freezingRef = useRef(false);

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
    if (typeof ResizeObserver === "undefined") return;
    // Stateless on purpose (D-158): every tick re-resolves the element and
    // states the whole truth — hide, or these exact bounds. A remembered
    // "already hidden" flag once wedged the view: something else re-attached
    // it (a reopen, a re-render) while the flag said hidden, and the keeper
    // never spoke again, leaving stale bounds painted over the inspector.
    // hide() and setBounds() are idempotent; repeating them is cheap, and
    // repeating them is what makes the rectangle self-healing.
    const sync = () => {
      const element = bodyRef.current;
      // A rectangle that cannot be measured is a rectangle that must not be
      // painted: a detached or collapsed body means the surface is not
      // honestly on screen, whatever the view remembers.
      if (!element || !element.isConnected) {
        void novus().workspace.preview.hide();
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        void novus().workspace.preview.hide();
        return;
      }
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
      // Sample points catch broad coverage; a small menu slips between them
      // (the open-in menu lost its lower rows this way), so anything the room
      // presents as an overlay is also checked by geometry.
      const overlaid =
        covered ||
        [...document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"], .theme-popover')].some(
          (overlay) => {
            if (element.contains(overlay)) return false;
            const o = overlay.getBoundingClientRect();
            return (
              o.width > 0 &&
              o.height > 0 &&
              o.x < rect.x + rect.width &&
              o.x + o.width > rect.x &&
              o.y < rect.y + rect.height &&
              o.y + o.height > rect.y
            );
          }
        );
      // The frozen-frame swap (D-160, owner-directed): DOM can never paint
      // above the native view, so while anything overlaps the rectangle the
      // view's own pixels stand in as a still image and the view leaves the
      // screen — the page appears exactly where it was, the overlay reads as
      // above it, and nothing moves or reflows. The live view returns the
      // tick the rectangle clears.
      if (overlaid) {
        if (frozenRef.current === null && !freezingRef.current) {
          freezingRef.current = true;
          void novus()
            .workspace.preview.snapshot()
            .then((result) => {
              freezingRef.current = false;
              const still = result.ok ? result.value : null;
              frozenRef.current = still ?? "";
              setFrozen(still);
              void novus().workspace.preview.hide();
            });
        } else {
          void novus().workspace.preview.hide();
        }
        return;
      }
      if (frozenRef.current !== null) {
        frozenRef.current = null;
        setFrozen(null);
      }
      void novus().workspace.preview.setBounds({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      });
    };
    const observer = new ResizeObserver(sync);
    if (bodyRef.current) observer.observe(bodyRef.current);
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
              {/* The capture warning rides the capture controls themselves
                  (D-161): still at the capture point, no longer a standing
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
      {/* The reserved rectangle. While the page is on screen the native view
          sits exactly over this; in every other state these words do. */}
      <div className="preview-body" ref={bodyRef} data-testid="preview-body" data-phase={status?.phase ?? "none"}>
        {/* The page's own last pixels, standing in while an overlay is above
            the rectangle (D-160). Inside the reserved element on purpose: the
            keeper's coverage check ignores its own children. */}
        {frozen && (
          <img className="preview-frozen" src={frozen} alt="" aria-hidden="true" data-testid="preview-frozen" />
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
