import { clockTime } from "../format";
import { workerFiles, workerState, type WorkerView } from "./direction-trace";

/**
 * One worker, looked at closely (D-107): a zoomed rendering of the same facts
 * the technical disclosure's Workers rollup states — the Task call's own
 * description, its state in a word, the timeline of its tagged activity, the
 * files its own tool calls named, and the report its result handed back.
 *
 * It occupies the canvas and nothing else: no rail row, no tab, no baton, no
 * lane. Back to chat returns to the conversation where the reader left it.
 * While the worker is live the ordinary poll keeps this view current, because
 * it renders straight off the feed the room already derives.
 */
export function WorkerInspector({
  worker,
  settled,
  chatTitle,
  onBack
}: {
  worker: WorkerView;
  /** Whether the parent turn has settled, so state words stay honest. */
  settled: boolean;
  /** The conversation this worker's turn belongs to. */
  chatTitle: string | null;
  onBack: () => void;
}) {
  const state = workerState(worker, settled);
  const files = workerFiles(worker);
  return (
    <div className="worker-inspector" data-testid="worker-inspector">
      <header className="worker-inspector-head">
        <div>
          <h2 className="worker-inspector-title">{worker.purpose ?? "Worker"}</h2>
          <p className="worker-inspector-sub">
            {[
              "One of Claude Code's own workers",
              chatTitle ? `spawned by the turn in "${chatTitle}"` : null,
              state
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button className="btn btn-text" onClick={onBack} data-testid="worker-back">
          Back to chat
        </button>
      </header>

      {worker.ended?.failed && (
        <p className="inline-error" role="alert" data-testid="worker-failure">
          This worker failed{worker.ended.report ? ` — ${worker.ended.report}` : "."}
        </p>
      )}

      {worker.steps.length > 0 ? (
        <section className="worker-inspector-section">
          <h3 className="worker-inspector-label">Activity</h3>
          <ul className="tool-list">
            {worker.steps.map((step, index) => (
              <li key={index} data-testid="worker-step">
                <span className="mono tool-name">{step.label}</span>
                {step.detail && <span className="tool-detail">{step.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="quiet">
          {state === "working"
            ? "Nothing forwarded yet — the worker is still going."
            : "The harness forwarded none of this worker's activity."}
        </p>
      )}

      {files.length > 0 && (
        <section className="worker-inspector-section">
          <h3 className="worker-inspector-label">Files its own calls named</h3>
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
          <p className="worker-report prose" data-testid="worker-report">
            {worker.ended.report}
          </p>
        </section>
      )}

      <p className="quiet worker-inspector-foot">
        {[
          worker.at ? `Started ${clockTime(worker.at)}` : null,
          worker.ended?.at ? `ended ${clockTime(worker.ended.at)}` : null
        ]
          .filter(Boolean)
          .join(" · ") || "The stream stated no timestamps for this worker."}
        {" "}A worker has no branch, checkpoint, baton, or cost of its own — usage is stated per
        turn only (D-071, D-107).
      </p>
    </div>
  );
}
