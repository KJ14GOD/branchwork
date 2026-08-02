import { useCallback, useEffect, useRef, useState } from "react";
import type { FileChange, FileDiffResponse, MissionDetailResponse } from "@novus/contracts";
import { novus } from "../bridge";
import { clockTime, plural, shortSha } from "../format";
import { changedFiles } from "./derive";
import { GatedAction } from "./gated";
import { Baton, HumanMark, roleLabel } from "./identity";

export type InspectorSection = "overview" | "changes" | "verification";

const SECTIONS: { id: InspectorSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "changes", label: "Changes" },
  { id: "verification", label: "Verification" }
];

type DiffLoad =
  | { kind: "loading" }
  | { kind: "loaded"; diff: FileDiffResponse }
  | { kind: "failed"; message: string };

/** A unified diff, tinted at 12% of --ok / --danger — the only place those
 *  tokens appear as backgrounds (DESIGN.md#component-behavior). The diff owns
 *  its own horizontal scroll; nothing else in the room scrolls sideways. */
function UnifiedDiff({ diff }: { diff: string }) {
  const lines = diff.replace(/\n+$/, "").split("\n");
  return (
    <div className="diff" data-testid="diff">
      {lines.map((line, index) => {
        const tone = line.startsWith("+++") || line.startsWith("---")
          ? "meta"
          : line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "ctx";
        return (
          <div key={index} className={`diff-line diff-${tone}`}>
            {line === "" ? " " : line}
          </div>
        );
      })}
    </div>
  );
}

function ChangeRow({
  file,
  expanded,
  onToggle,
  load
}: {
  file: FileChange;
  expanded: boolean;
  onToggle: () => void;
  load: DiffLoad | undefined;
}) {
  return (
    <div className="change-item">
      <button
        className={expanded ? "change-row selected" : "change-row"}
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="change-row"
      >
        <span className="mono change-path" title={file.path}>
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </span>
        <span className="change-state">{file.changeState}</span>
        <span className="change-counts mono">
          <span className="count-add">+{file.additions}</span>
          <span className="count-del">−{file.deletions}</span>
        </span>
      </button>
      {expanded && (
        <div className="change-diff">
          {file.binary ? (
            <p className="quiet">Binary file — no diff to show.</p>
          ) : load === undefined || load.kind === "loading" ? (
            <p className="quiet">Loading the diff…</p>
          ) : load.kind === "failed" ? (
            <p className="inline-error" role="alert">
              {load.message}
            </p>
          ) : load.diff.diff === null ? (
            <p className="quiet">No diff was recorded for this file.</p>
          ) : (
            <>
              <UnifiedDiff diff={load.diff.diff} />
              {load.diff.truncated && <p className="quiet">This diff was truncated when it was recorded.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Changes and Verification, plus the machinery that never belongs in the
 * mission header (DESIGN.md prohibited pattern 12): a contextual inspector,
 * an overlay and not a permanent column (DESIGN.md#layout).
 */
export function Inspector({
  detail,
  section,
  onSection,
  onClose,
  onDetail,
  onRevoke
}: {
  detail: MissionDetailResponse;
  section: InspectorSection;
  onSection: (section: InspectorSection) => void;
  onClose: () => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onRevoke: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, DiffLoad>>({});
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const files = changedFiles(detail);
  const { mission, workstream } = detail;

  // Esc closes; Tab is trapped inside the drawer (DESIGN.md#keyboard).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  const toggleFile = useCallback(
    async (file: FileChange) => {
      if (expanded === file.changeId) {
        setExpanded(null);
        return;
      }
      setExpanded(file.changeId);
      if (diffs[file.changeId] || file.binary) return;
      setDiffs((prev) => ({ ...prev, [file.changeId]: { kind: "loading" } }));
      const result = await novus().evidence.fileDiff(file.changeId);
      setDiffs((prev) => ({
        ...prev,
        [file.changeId]: result.ok
          ? { kind: "loaded", diff: result.value }
          : { kind: "failed", message: result.message }
      }));
    },
    [diffs, expanded]
  );

  const retryBranch = async () => {
    if (!workstream) return;
    setRetrying(true);
    setRetryError(null);
    const result = await novus().missions.retryBranch(workstream.workstreamId);
    setRetrying(false);
    if (result.ok) onDetail({ ...detail, workstream: result.value });
    else setRetryError(result.message);
  };

  return (
    <>
      <div className="scrim" onClick={onClose} data-testid="inspector-scrim" />
      <aside
        className="inspector"
        role="dialog"
        aria-modal="true"
        aria-label="Mission inspector"
        ref={panelRef}
        data-testid="inspector"
      >
        <div className="inspector-head">
          <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
            {SECTIONS.map((option) => (
              <button
                key={option.id}
                role="tab"
                aria-selected={section === option.id}
                className={section === option.id ? "inspector-tab active" : "inspector-tab"}
                onClick={() => onSection(option.id)}
                data-testid={`inspector-tab-${option.id}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button className="btn btn-text" onClick={onClose} data-testid="inspector-close">
            Close
          </button>
        </div>

        <div className="inspector-scroll">
          {section === "overview" && (
            <div data-testid="inspector-overview">
              <div className="kv" data-testid="repo-block">
                <span className="kv-label">Repository</span>
                <span className="kv-value" data-testid="repo-name">
                  {mission.repository?.name ?? "No repository recorded"}
                </span>

                {workstream && (
                  <>
                    <span className="kv-label">Mission branch</span>
                    <span className="kv-value mono" data-testid="ws-branch">
                      {workstream.missionBranch}
                    </span>

                    <span className="kv-label">Base</span>
                    <span className="kv-value mono" data-testid="ws-base" title={workstream.baseSha}>
                      {workstream.baseRef} · {shortSha(workstream.baseSha)}
                    </span>

                    <span className="kv-label">Branch</span>
                    <span className="kv-value" data-testid="ws-branch-status">
                      {workstream.branchStatus === "created" && "Created"}
                      {workstream.branchStatus === "pending" && "Pending"}
                      {workstream.branchStatus === "failed" && (
                        <>
                          <span className="inline-error" data-testid="branch-error">
                            {workstream.branchError ?? "Branch creation failed."}
                          </span>{" "}
                          <button
                            className="btn btn-text"
                            onClick={() => void retryBranch()}
                            disabled={retrying}
                            data-testid="retry-branch"
                          >
                            Retry
                          </button>
                          {retryError && (
                            <span className="inline-error" role="alert" data-testid="retry-error">
                              {retryError}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </>
                )}

                <span className="kv-label">Runner</span>
                <span className="kv-value" data-testid="runner-status">
                  {detail.runner ? (
                    <>
                      <span className={detail.runner.online ? "status-dot active" : "status-dot danger"} />
                      {detail.runner.label} · {detail.runner.online ? "online" : "offline"}
                      {!detail.runner.online && detail.runner.lastSeenAt
                        ? ` · last heard ${clockTime(detail.runner.lastSeenAt)}`
                        : ""}
                    </>
                  ) : (
                    "No runner has registered for this workstream."
                  )}
                </span>
              </div>

              <h3 className="inspector-heading">Participants</h3>
              <ul className="participant-list" data-testid="participant-list">
                {detail.participants.map((participant) => (
                  <li key={participant.userId} className="participant-row">
                    <HumanMark login={participant.login} name={participant.name} />
                    <span className="participant-name">{participant.name ?? participant.login}</span>
                    {participant.isController && <Baton holderUserId={participant.userId} />}
                    <span className="participant-role">{roleLabel(participant.role)}</span>
                  </li>
                ))}
                {detail.participants.length === 0 && <li className="quiet">No participants recorded.</li>}
              </ul>
              {detail.control.holderLogin && (
                <div className="inspector-actions">
                  <GatedAction
                    capability="control.revoke"
                    capabilities={detail.capabilities}
                    denialReason="Only a Mission Admin can revoke control."
                    holderLogin={detail.control.holderLogin}
                    onClick={onRevoke}
                    variant="secondary"
                    testid="revoke-control"
                  >
                    Revoke control
                  </GatedAction>
                </div>
              )}
            </div>
          )}

          {section === "changes" && (
            <div data-testid="inspector-changes">
              {files.length === 0 ? (
                <p className="quiet" data-testid="changes-empty">
                  No files have changed yet.
                </p>
              ) : (
                <>
                  <p className="inspector-summary">
                    {plural(files.length, "file")} changed on{" "}
                    <span className="mono">{workstream?.missionBranch ?? "the mission branch"}</span>
                  </p>
                  {files.map((file) => (
                    <ChangeRow
                      key={file.changeId}
                      file={file}
                      expanded={expanded === file.changeId}
                      onToggle={() => void toggleFile(file)}
                      load={diffs[file.changeId]}
                    />
                  ))}
                </>
              )}
            </div>
          )}

          {section === "verification" && (
            <div data-testid="inspector-verification">
              {detail.checks.length === 0 ? (
                <p className="quiet" data-testid="checks-empty">
                  No checks observed.
                </p>
              ) : (
                <div className="ledger" data-testid="ledger">
                  {detail.checks.map((check) => (
                    <div key={check.checkId} className="ledger-entry">
                      <div className="ledger-row">
                        <span className="mono ledger-name" title={check.command}>
                          {check.name}
                        </span>
                        <span className={`mono ledger-outcome outcome-${check.outcome}`}>{check.outcome}</span>
                      </div>
                      <div className="ledger-origin">Reported by {check.environment}</div>
                      {check.output && (check.outcome === "failed" || check.outcome === "errored") && (
                        <details className="disclosure">
                          <summary>Output</summary>
                          <pre className="mono check-output">{check.output}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
