import type { MissionDetailResponse } from "@novus/contracts";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const EVENT_LABELS: Record<string, string> = {
  "mission.created": "created this mission"
};

/**
 * The New-mission room, honestly reduced to what exists: goal, success
 * criteria, and the durable history. Provisioning is not implemented, so no
 * provision action renders (PRODUCT.md non-goals: no fictional capabilities).
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
            <section className="mission-section">
              <h2>Success criteria</h2>
              <p data-testid="mission-criteria">{mission.successCriteria}</p>
            </section>
            <hr className="separator" />
            <section className="mission-section" style={{ marginTop: "var(--s-5)" }}>
              <h2>History</h2>
              {events.map((event) => (
                <div className="event-row" key={event.eventId} data-testid="event-row">
                  <span className="identity-mark">{mission.createdByLogin.slice(0, 2)}</span>
                  <span>
                    {mission.createdByLogin} {EVENT_LABELS[event.kind] ?? event.kind}
                  </span>
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
