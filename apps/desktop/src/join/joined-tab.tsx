import { useEffect, useMemo } from "react";

import {
  describeConnection,
  summarise,
  useGuestSession,
  usePresence,
  type ParsedInvite,
} from "@novus/session-client";

import type { TabStatus } from "../session-tab.tsx";
import { JoinedSurface } from "./joined-surface.tsx";
import { useJoinedActions } from "./use-joined-actions.ts";
import { useJoinedAuthority } from "./use-joined-authority.ts";
import { useMembership } from "./use-membership.ts";

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * A session this window joined, as opposed to one it hosts.
 *
 * Reads the same event log a hosting tab reads, through the shared
 * session-client (worker over loopback, or relay), and offers only what the
 * joiner's actual role allows: the worker's /me answer decides, and the
 * worker re-decides on every request regardless of what is rendered here.
 *
 * This file is the wiring — every read a joined window makes, and nothing
 * else. What it draws is `JoinedSurface`, which takes state instead of
 * fetching it so the rules about who may see which control can be tested.
 *
 * Three polls, matching the hosting window exactly: membership and presence
 * every four seconds, authority every three. All of them move under a joined
 * window without it doing anything — a handoff is a role change — so none of
 * them can be read once at open. Every control action refreshes authority on
 * its answer rather than waiting for the next tick.
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
  const authority = useJoinedAuthority(
    endpoint,
    sessionId,
    invite.token,
    relay,
  );
  const actions = useJoinedActions(
    endpoint,
    sessionId,
    invite.token,
    authority.refresh,
  );

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

  useEffect(() => {
    onStatus({
      runStatus: summary.runStatus,
      additions: summary.additions,
      deletions: summary.deletions,
      // A joined window shows the mission goal in its own header; the
      // sidebar names it by the invite label instead.
      goal: null,
    });
  }, [onStatus, summary.runStatus, summary.additions, summary.deletions]);

  useEffect(() => {
    if (session) {
      onLabel(basename(session.repositoryPath));
    }
  }, [onLabel, session]);

  return (
    <JoinedSurface
      active={active}
      relay={invite.kind === "relay"}
      label={
        session
          ? basename(session.repositoryPath)
          : invite.kind === "relay"
            ? "Through a relay"
            : (sessionId ?? "")
      }
      repositoryPath={session?.repositoryPath ?? null}
      report={report}
      summary={summary}
      events={events}
      onRetry={connection.kind === "stopped" ? null : retry}
      role={role}
      youId={authority.you ?? membership?.id ?? null}
      participants={presence}
      authority={authority}
      actions={actions}
    />
  );
};
