import { useEffect, useMemo, useRef, useState } from "react";
import type { ProcessKind, ProcessLog } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * Setup, run, and verification output for the machine that produced it
 * (D-045).
 *
 * This is the runtime dock's other half, and the split it exists to keep
 * honest. The activity stream shows the **milestone** — a check ran, and
 * passed. The evidence panel shows the **bounded result** that supports that
 * claim. This shows the **detailed local output**, in full, on the machine
 * that ran it — and nowhere else: it never travels to the control plane, so a
 * remote participant reads the evidence, not an unrestricted stream.
 *
 * A process that ended stays here. "It failed, and the output is gone" is the
 * state this view exists to prevent.
 */

const KIND_LABEL: Record<ProcessKind, string> = {
  setup: "Setup",
  run: "The app",
  verification: "Checks"
};

/** How a process ended, in words. A deadline and a cancellation are not
 *  failures, and a room that calls them one cannot say what happened. */
export function endingLabel(log: ProcessLog): string {
  if (log.state === "starting") return "starting";
  if (log.state === "running") return log.readiness === "unreachable" ? "running, not answering" : "running";
  switch (log.ending) {
    case "timeout":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case "spawn_failed":
      return "could not start";
    case "signal":
      return "killed";
    default:
      return log.exitCode === null
        ? "ended"
        : log.exitCode === 0
          ? "exited 0"
          : `exited ${log.exitCode}`;
  }
}


export function ProcessLogView({ missionId, kind }: { missionId: string; kind: ProcessKind }) {
  const [logs, setLogs] = useState<ProcessLog[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await novus().workspace.logs(missionId);
      if (!live) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setLogs(result.value);
    })();
    return () => {
      live = false;
    };
  }, [missionId]);

  // Streamed from this machine's own main process, exactly like the terminal's.
  useEffect(() => {
    return novus().workspace.onLog((chunk) => {
      setLogs((previous) => {
        const index = previous.findIndex((log) => log.processId === chunk.processId);
        if (index === -1) {
          // A process that started while this view was open: ask once for the
          // whole list rather than inventing a row from a chunk.
          void novus()
            .workspace.logs(missionId)
            .then((result) => {
              if (result.ok) setLogs(result.value);
            });
          return previous;
        }
        const next = [...previous];
        const current = previous[index];
        if (!current) return previous;
        next[index] = {
          ...current,
          output: current.output + chunk.data,
          state: chunk.state,
          readiness: chunk.readiness,
          exitCode: chunk.exitCode,
          ending: chunk.ending
        };
        return next;
      });
    });
  }, [missionId]);

  const ofKind = useMemo(
    () =>
      logs
        .filter((log) => log.kind === kind)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [logs, kind]
  );

  const active = ofKind.find((log) => log.processId === selected) ?? ofKind[0] ?? null;

  useEffect(() => {
    const element = screenRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [active?.output]);

  const onScroll = () => {
    const element = screenRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 24;
  };

  if (error !== null) {
    return (
      <p className="inline-error dock-error" role="alert" data-testid="dock-error">
        {error}
      </p>
    );
  }

  if (active === null) {
    return (
      <div className="dock-empty" data-testid="dock-empty">
        <p>
          {KIND_LABEL[kind]} has not run on this machine yet. Output appears here while it runs and stays
          afterwards.
        </p>
      </div>
    );
  }

  return (
    <>
      {ofKind.length > 1 && (
        <div className="dock-runs" role="tablist" aria-label={`${KIND_LABEL[kind]} runs`}>
          {ofKind.map((log) => (
            <button
              key={log.processId}
              role="tab"
              aria-selected={log.processId === active.processId}
              className={log.processId === active.processId ? "dock-run active" : "dock-run"}
              onClick={() => setSelected(log.processId)}
              data-testid="dock-run"
            >
              <span className="dock-run-name">{log.name}</span>
              <span className="dock-run-state">{endingLabel(log)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="dock-summary" data-testid="dock-summary">
        <span className="dock-command mono">{active.command}</span>
        <span className="dock-state" data-testid="dock-state">
          {endingLabel(active)}
        </span>
        {active.failureReason && (
          <span className="dock-reason" data-testid="dock-reason">
            {active.failureReason}
          </span>
        )}
        {active.truncated && <span className="dock-reason">earlier output dropped</span>}
      </div>

      <pre
        className="dock-output mono"
        ref={screenRef}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={`${active.name} output`}
        data-testid="dock-output"
      >
        {active.output}
      </pre>
    </>
  );
}
