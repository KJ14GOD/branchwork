import { useEffect } from "react";
import { clockTime } from "../format";
import { Markdown } from "./markdown";
import { workerFiles, workerState, type WorkerView } from "./direction-trace";
import type { ToolStep } from "./derive-feed";

/**
 * One worker, stepped into (D-107, recomposed by D-108 on the owner's sight):
 * the same facts its row states, at reading size — what it was for, what it
 * did, what it handed back. `Esc` or Back to chat returns to the conversation
 * at the position the reader left, the way the row was entered with Enter.
 * While the worker is live the room's ordinary poll keeps this current.
 */
/** Consecutive identical steps as one entry with a count. Exported for the
 *  test; the rule is the comment at its use. */
export function collapseRepeats(steps: ToolStep[]): { step: ToolStep; count: number }[] {
  const out: { step: ToolStep; count: number }[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (last && last.step.label === step.label && last.step.detail === step.detail) last.count += 1;
    else out.push({ step, count: 1 });
  }
  return out;
}

export function WorkerInspector({
  worker,
  settled,
  onBack
}: {
  worker: WorkerView;
  /** Whether the parent turn has settled, so the state word stays honest. */
  settled: boolean;
  onBack: () => void;
}) {
  const state = workerState(worker, settled);
  const files = workerFiles(worker);

  // Enter steps in; Esc steps out. The keyboard is the whole point (D-108).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // What the CLI stated the worker spent (D-202), in the facts line and only
  // when stated: a figure here is the vendor's, never one Novus computed.
  const usage = worker.ended?.usage ?? null;
  const spent = usage
    ? [
        usage.totalTokens !== null ? `${usage.totalTokens.toLocaleString()} tokens` : null,
        usage.toolUses !== null ? `${usage.toolUses} tool ${usage.toolUses === 1 ? "use" : "uses"}` : null,
        usage.durationMs !== null ? `${Math.max(1, Math.round(usage.durationMs / 1000))}s` : null
      ].filter(Boolean)
    : [];
  const facts = [
    state,
    worker.at ? `started ${clockTime(worker.at)}` : null,
    worker.ended?.at ? `ended ${clockTime(worker.ended.at)}` : null,
    ...spent
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="worker-inspector" data-testid="worker-inspector">
      <header className="worker-inspector-head">
        <div>
          <h2 className="worker-inspector-title">{worker.purpose ?? "Worker"}</h2>
          {facts && <p className="worker-inspector-sub">{facts}</p>}
        </div>
        <button className="btn btn-text" onClick={onBack} data-testid="worker-back">
          Back to chat
        </button>
      </header>

      {worker.ended?.failed && (
        <p className="inline-error" role="alert" data-testid="worker-failure">
          Failed{worker.ended.report ? ` — ${worker.ended.report}` : "."}
        </p>
      )}

      {worker.steps.length > 0 ? (
        <ul className="tool-list worker-timeline">
          {/* Identical consecutive steps fold into one row with a count
              (D-203): a file read twenty-one times in a row is one fact, and
              twenty-one rows of it hid the steps around them. Only identical
              rows fold — a different file is a different fact. */}
          {collapseRepeats(worker.steps).map((entry, index) => (
            <li key={index} data-testid="worker-step">
              <span className="mono tool-name">{entry.step.label}</span>
              {entry.step.detail && <span className="tool-detail">{entry.step.detail}</span>}
              {entry.count > 1 && (
                <span className="tool-repeat" data-testid="worker-step-repeat">
                  ×{entry.count}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">
          {state === "working"
            ? "Nothing forwarded yet — the worker is still going."
            : "Claude Code forwarded none of this worker's activity."}
        </p>
      )}

      {files.length > 0 && (
        <section className="worker-inspector-section">
          <h3 className="worker-inspector-label">Files</h3>
          <ul className="tool-list">
            {files.map((file) => (
              <li key={file} data-testid="worker-file">
                <span className="mono tool-name">{file}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {worker.ended && !worker.ended.failed && worker.ended.report && (
        <section className="worker-inspector-section">
          <h3 className="worker-inspector-label">Report</h3>
          <div className="worker-report prose" data-testid="worker-report">
            {/* A worker's report is Claude-written markdown (D-145). */}
            <Markdown source={worker.ended.report} />
          </div>
        </section>
      )}
    </div>
  );
}
