import { useEffect } from "react";
import { clockTime } from "../format";
import { Markdown } from "./markdown";
import { workerFiles, workerState, type WorkerView } from "./direction-trace";

/**
 * One worker, stepped into (D-107, recomposed by D-108 on the owner's sight):
 * the same facts its row states, at reading size — what it was for, what it
 * did, what it handed back. `Esc` or Back to chat returns to the conversation
 * at the position the reader left, the way the row was entered with Enter.
 * While the worker is live the room's ordinary poll keeps this current.
 */
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

  const facts = [
    state,
    worker.at ? `started ${clockTime(worker.at)}` : null,
    worker.ended?.at ? `ended ${clockTime(worker.ended.at)}` : null
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
          {worker.steps.map((step, index) => (
            <li key={index} data-testid="worker-step">
              <span className="mono tool-name">{step.label}</span>
              {step.detail && <span className="tool-detail">{step.detail}</span>}
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
