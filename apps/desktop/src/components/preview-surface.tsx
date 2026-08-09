import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionDetailResponse, PreviewBounds, PreviewStatus } from "@novus/contracts";
import { novus } from "../bridge";
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
        <button className="btn btn-text" onClick={reload} data-testid="preview-reload">
          Reload
        </button>
        <button className="btn btn-text" onClick={() => void openExternal()} data-testid="preview-external">
          Open in browser
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
