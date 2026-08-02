import { useState } from "react";
import type { MissionDetailResponse, MissionEvent, Workstream } from "@novus/contracts";
import { novus } from "../bridge";
import { shortSha } from "./create-mission";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Human microcopy for the durable history, keyed by event kind. */
function eventText(event: MissionEvent, createdByLogin: string): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case "mission.created":
      return `${createdByLogin} created this mission`;
    case "workstream.created": {
      const branch = typeof payload.missionBranch === "string" ? payload.missionBranch : "a branch";
      const ref = typeof payload.baseRef === "string" ? payload.baseRef : "base";
      const sha = typeof payload.baseSha === "string" ? ` @ ${shortSha(payload.baseSha)}` : "";
      return `${createdByLogin} allocated branch ${branch} from ${ref}${sha}`;
    }
    case "workstream.branch_created":
      return "branch created";
    case "workstream.branch_failed":
      return "branch creation failed";
    default:
      return event.kind;
  }
}

/**
 * The repository-continuity block (DESIGN.md#component-behavior): compact
 * label/value rows one level below the mission's primary state. Renders
 * nothing for missions created before repository connection existed.
 */
function RepositoryBlock({ detail }: { detail: MissionDetailResponse }) {
  const { mission } = detail;
  const [workstream, setWorkstream] = useState<Workstream | null>(detail.workstream);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!mission.repository || !workstream) return null;

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    const result = await novus().missions.retryBranch(workstream.workstreamId);
    setRetrying(false);
    if (result.ok) setWorkstream(result.value);
    else {
      setRetryError(
        result.code === "offline" ? "Can't reach Novus. Check your connection and try again." : result.message
      );
    }
  };

  return (
    <div className="repo-block" data-testid="repo-block">
      <span className="repo-label">Repository</span>
      <span className="repo-value" data-testid="repo-name">{mission.repository.name}</span>

      <span className="repo-label">Base</span>
      <span className="repo-value mono" data-testid="ws-base" title={workstream.baseSha}>
        {workstream.baseRef} · {shortSha(workstream.baseSha)}
      </span>

      <span className="repo-label">Mission branch</span>
      <span className="repo-value mono" data-testid="ws-branch">{workstream.missionBranch}</span>

      <span className="repo-label">Branch status</span>
      <span className="repo-value" data-testid="ws-branch-status">
        {workstream.branchStatus === "created" && <span className="branch-created">✓ Branch created</span>}
        {workstream.branchStatus === "pending" && <span className="branch-pending">Branch pending</span>}
        {workstream.branchStatus === "failed" && (
          <>
            <span className="inline-error" data-testid="branch-error">
              {workstream.branchError ?? "Branch creation failed."}
            </span>{" "}
            <button className="btn btn-text" onClick={retry} disabled={retrying} data-testid="retry-branch">
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
    </div>
  );
}

/**
 * The New-mission room, honestly reduced to what exists: goal, success
 * criteria, repository continuity, and the durable history. Provisioning is
 * not implemented, so no provision action renders (PRODUCT.md non-goals: no
 * fictional capabilities).
 */
export function MissionView({
  detail,
  onBack
}: {
  detail: MissionDetailResponse;
  onBack: () => void;
}) {
  const { mission, events } = detail;
  return (
    <>
      <header className="topbar">
        <span className="brand">Novus</span>
        <span className="spacer" />
      </header>
      <main className="content">
        <div className="mission-view" data-testid="mission-view">
          <button className="btn btn-text back" onClick={onBack} data-testid="back">
            ← Missions
          </button>
          <div className="scroll">
            <h1 data-testid="mission-goal">{mission.goal}</h1>
            <div className="state-line">
              <span className="status-dot neutral" />
              <span className="state-name">New mission</span>
              <span>— workspace setup arrives in a later slice.</span>
            </div>
            <RepositoryBlock detail={detail} />
            <section className="mission-section">
              <h2>Success criteria</h2>
              <p data-testid="mission-criteria">{mission.successCriteria}</p>
            </section>
            <hr className="separator" />
            <section className="mission-section" style={{ marginTop: "var(--s-5)" }}>
              <h2>History</h2>
              {events.map((event) => (
                <div className="event-row" key={event.eventId} data-testid="event-row">
                  {event.actor.kind === "user" ? (
                    <span className="identity-mark">{mission.createdByLogin.slice(0, 2)}</span>
                  ) : (
                    <span className="identity-mark system-mark">nv</span>
                  )}
                  <span>{eventText(event, mission.createdByLogin)}</span>
                  <span className="row-meta">{formatWhen(event.occurredAt)}</span>
                </div>
              ))}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
