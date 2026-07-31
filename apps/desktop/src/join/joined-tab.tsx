import { useEffect, useMemo, useState } from "react";

import {
  describeConnection,
  describeRole,
  roleAllows,
  summarise,
  useGuestSession,
  usePresence,
  type ParsedInvite,
} from "@novus/session-client";

import type { TabStatus } from "../session-tab.tsx";
import { useJoinedActions } from "./use-joined-actions.ts";
import { useMembership } from "./use-membership.ts";

import { TimelineView } from "../components/timeline-view.tsx";

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

const sentenceCase = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

/**
 * A session this window joined, as opposed to one it hosts.
 *
 * Reads the same event log a hosting tab reads, through the shared
 * session-client (worker over loopback, or relay), and offers only what the
 * joiner's actual role allows: the worker's /me answer decides, and the
 * worker re-decides on every request regardless of what is rendered here.
 * What is deliberately absent, because a joined window has no host-side
 * standing: opening repositories, the terminal, the file browser, inviting,
 * forking, and deciding between attempts. A relay join is watch-only in
 * both directions and says so.
 */
export const JoinedTab = ({
  invite,
  active,
  onStatus,
  onLabel,
}: {
  invite: ParsedInvite;
  active: boolean;
  /** Reports live status upward for the tab strip's chip. */
  onStatus: (status: TabStatus) => void;
  /** Reports a human-readable name once the session is located. */
  onLabel: (label: string) => void;
}) => {
  const endpoint = invite.kind === "worker" ? invite.endpoint : null;
  const sessionId = invite.kind === "worker" ? invite.sessionId : null;
  const relay = invite.kind === "relay" ? invite.relay : null;

  const { events, connection, session, retry } = useGuestSession(
    // The hook requires an endpoint string; for a relay join it is never
    // contacted (the relay branch short-circuits before any worker call).
    endpoint ?? "http://127.0.0.1:4319",
    sessionId,
    invite.token,
    relay,
  );
  const presence = usePresence(endpoint ?? "", sessionId, invite.token, relay);
  const membership = useMembership(endpoint, sessionId, invite.token);
  const actions = useJoinedActions(endpoint, sessionId, invite.token);

  const summary = useMemo(() => summarise(events), [events]);
  const report = describeConnection(
    connection,
    endpoint ?? relay ?? "",
    sessionId ?? "the relayed mission",
  );

  // Unknown role means watch-only: the safe direction to be wrong in. A
  // relay join never learns a role and never posts — the relay carries the
  // event log outbound and nothing else.
  const role = invite.kind === "relay" ? null : (membership?.role ?? null);
  const canDirect = role !== null && roleAllows(role, "direct");
  const canSteer = role !== null && roleAllows(role, "steer");

  const latestRun = events.findLast((event) => event.type === "run.started");
  const runId =
    latestRun?.type === "run.started" ? latestRun.payload.run.id : null;
  const running =
    summary.runStatus === "working" || summary.runStatus === "paused";

  const [direction, setDirection] = useState("");
  const [directed, setDirected] = useState(false);
  const [groupOverrides, setGroupOverrides] = useState(
    () => new Map<number, boolean>(),
  );

  useEffect(() => {
    onStatus({
      runStatus: summary.runStatus,
      additions: summary.additions,
      deletions: summary.deletions,
    });
  }, [onStatus, summary.runStatus, summary.additions, summary.deletions]);

  useEffect(() => {
    if (session) {
      onLabel(basename(session.repositoryPath));
    }
  }, [onLabel, session]);

  const sendDirection = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!direction.trim()) {
      return;
    }

    if (await actions.direct(direction.trim())) {
      setDirection("");
      setDirected(true);
    }
  };

  return (
    <div
      className="tab-content"
      style={{ display: active ? "grid" : "none" }}
    >
      <div className="session-bar">
        <span className="chip">Joined</span>
        <span title={session?.repositoryPath ?? undefined}>
          {session
            ? basename(session.repositoryPath)
            : invite.kind === "relay"
              ? "Through a relay"
              : (sessionId ?? "")}
        </span>
        <span className={`status status--${report.tone}`}>
          <span className="status__dot" />
          {report.label}
        </span>
        <span>{sentenceCase(summary.runStatus)}</span>
        <span className="titlebar__spacer" />
        <span title="What your invite allows. The host's worker enforces this on every request — this label only decides what is offered here.">
          {invite.kind === "relay"
            ? "Relay — watch only"
            : role
              ? describeRole(role)
              : "Role unknown — watch only"}
        </span>
      </div>

      <div
        className="body"
        style={{ gridTemplateColumns: "var(--rail-w) 1fr" }}
      >
        <aside className="rail">
          <div className="rail__section">
            <div className="eyebrow">Goal</div>
            <div>{summary.goal ?? "No run has started in this mission."}</div>
          </div>

          <div className="rail__section">
            <div className="eyebrow">Run</div>
            <div className="stat">
              <span>events</span>
              <span className="stat__value">{summary.events}</span>
            </div>
            <div className="stat">
              <span>tool calls</span>
              <span className="stat__value">{summary.toolCalls.length}</span>
            </div>
            <div className="stat">
              <span>patches</span>
              <span className="stat__value">{summary.patches.length}</span>
            </div>
            <div className="stat">
              <span>elapsed</span>
              <span className="stat__value">{summary.elapsed}</span>
            </div>
          </div>

          {canSteer && runId !== null && running ? (
            <div className="rail__section">
              <div className="eyebrow">Run control</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {summary.runStatus === "paused" ? (
                  <button
                    className="button"
                    type="button"
                    onClick={() => void actions.resume(runId)}
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    className="button"
                    type="button"
                    onClick={() => void actions.pause(runId)}
                  >
                    Pause
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  onClick={() => void actions.cancel(runId)}
                  title="Stop this run at its next safe boundary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {presence.length > 0 ? (
            <div className="rail__section">
              <div className="eyebrow">Participants</div>
              {presence.map((participant) => (
                <div className="stat" key={participant.id}>
                  <span>
                    {participant.name}
                    {membership && participant.id === membership.id
                      ? " (you)"
                      : ""}
                  </span>
                  <span className="stat__value">
                    {participant.role}
                    {participant.connected ? " · here" : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <main className="timeline">
          {events.length === 0 ? (
            <div style={{ padding: 24, maxWidth: 560 }}>
              <p>{report.emptyTimeline}</p>
              {connection.kind === "stopped" ? null : (
                <button className="button" type="button" onClick={retry}>
                  Retry now
                </button>
              )}
            </div>
          ) : (
            <TimelineView
              events={events}
              busy={summary.runStatus === "working"}
              raw={false}
              highlighted={null}
              groupOverrides={groupOverrides}
              onToggleGroup={(key, currentlyOpen) =>
                setGroupOverrides(
                  (previous) => new Map(previous).set(key, !currentlyOpen),
                )
              }
            />
          )}
        </main>
      </div>

      {canDirect ? (
        <form
          onSubmit={(event) => void sendDirection(event)}
          style={{
            display: "flex",
            gap: 8,
            padding: 12,
            borderTop: "1px solid var(--border)",
            alignItems: "center",
          }}
        >
          <input
            className="open__input"
            style={{ flex: 1 }}
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value);
              setDirected(false);
            }}
            placeholder="Add direction — folded in at the run's next safe boundary"
            spellCheck={false}
          />
          <button
            className="button button--primary"
            type="submit"
            disabled={!direction.trim()}
          >
            Direct
          </button>
          {directed ? <span className="eyebrow">Recorded</span> : null}
          {actions.error ? (
            <span className="open__error">{actions.error}</span>
          ) : null}
        </form>
      ) : (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <span className="eyebrow">
            {invite.kind === "relay"
              ? "Watching through a relay — this connection cannot send anything back."
              : "Watching — your role does not include adding direction."}
          </span>
          {actions.error ? (
            <span className="open__error"> {actions.error}</span>
          ) : null}
        </div>
      )}
    </div>
  );
};
