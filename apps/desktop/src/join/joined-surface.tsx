import { useState } from "react";

import type { SessionEvent } from "@novus/contracts";
import type { Authority } from "@novus/contracts/protocol";
import {
  describeRole,
  roleAllows,
  type ConnectionReport,
  type ParticipantRole,
  type PresenceEntry,
  type TimelineSummary,
} from "@novus/session-client";

import {
  ControlBaton,
  ControlPanel,
  PendingDirection,
} from "../components/control-panel.tsx";
import { EvidenceInspector } from "../components/workroom/evidence-inspector.tsx";
import { TimelineView } from "../components/timeline-view.tsx";
import type { JoinedActions } from "./use-joined-actions.ts";
import type { JoinedEvidence } from "./use-joined-evidence.ts";

/**
 * Everything a joined window draws, given state rather than fetching it.
 *
 * Split out of `joined-tab.tsx` so the rules here can be tested. What is worth
 * defending is not layout: it is that a participant who may not act cannot see
 * the control at all, that a handoff stays three distinct states, and that a
 * relay join — a transport that physically cannot send anything back — offers
 * nothing that implies it can. Every one of those is a rule a later styling
 * pass can erase without failing anything else, so it is pinned in
 * `joined-surface.render.test.tsx`.
 *
 * Unauthorized actions are *absent*, not disabled. A greyed-out "Pause" still
 * tells a viewer that this screen pauses runs and they are being refused;
 * absence is the honest answer. The worker refuses these calls independently —
 * the missing button is the interface agreeing with the boundary, not being it.
 *
 * What is deliberately absent for everyone, because a joined window has no
 * host-side standing: opening repositories, the terminal, the file browser,
 * inviting, forking, and deciding between attempts.
 */

const sentenceCase = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

/** The floor `DecisionRationaleSchema` puts on a summary, mirrored so the form can. */
const RATIONALE_FLOOR = 12;

/**
 * How the frozen evidence on a completed mission reads.
 *
 * Three values because "nothing ran" and "something ran and failed" are
 * different facts. The one that matters most is the middle case: a mission
 * that was finished having verified nothing says so, in the same place it says
 * it was resolved, or the screen has quietly turned finishing into proof.
 */
const verificationLine = (
  verification: "verified" | "failing" | "unverified",
  filesChanged: number,
): { text: string; tone: string } => {
  const files = `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`;

  switch (verification) {
    case "verified":
      return {
        text: `${files}, and the checks that ran passed.`,
        tone: "evidence__line evidence__line--pass",
      };
    case "failing":
      return {
        text: `${files}, and the checks that ran did not pass.`,
        tone: "evidence__line evidence__line--fail",
      };
    case "unverified":
      return {
        text: `${files}, and nothing verified them.`,
        tone: "evidence__line evidence__line--unknown",
      };
  }
};

export type JoinedSurfaceProps = {
  active: boolean;
  /** A relay join: the log arrives, nothing can be sent back. */
  relay: boolean;
  /** What to call this mission in the bar. */
  label: string;
  /** For the bar's tooltip; null until the session is located. */
  repositoryPath: string | null;
  report: ConnectionReport;
  summary: TimelineSummary;
  events: SessionEvent[];
  /** Null while the client has stopped retrying on its own. */
  onRetry: (() => void) | null;
  /** Null means unknown, which is treated as watch-only. */
  role: ParticipantRole | null;
  /** Which participant this window is, for the roster's "(you)". */
  youId: string | null;
  participants: readonly PresenceEntry[];
  authority: Authority;
  actions: JoinedActions;
  /** The changes and verification this window may show. Empty for a relay join. */
  evidence: JoinedEvidence;
};

export const JoinedSurface = ({
  active,
  relay,
  label,
  repositoryPath,
  report,
  summary,
  events,
  onRetry,
  role,
  youId,
  participants,
  authority,
  actions,
  evidence,
}: JoinedSurfaceProps) => {
  const [direction, setDirection] = useState("");
  const [sent, setSent] = useState(false);
  const [ending, setEnding] = useState("");
  const [reopening, setReopening] = useState("");
  const [groupOverrides, setGroupOverrides] = useState(
    () => new Map<number, boolean>(),
  );

  // A relay join never learns a role and never posts, so it is watch-only in
  // both directions regardless of what the invite said.
  const canDirect = !relay && role !== null && roleAllows(role, "direct");
  const canSteer = !relay && role !== null && roleAllows(role, "steer");
  /**
   * Ending the mission is `approve`, which is the worker's own gate for
   * `/complete` and `/reopen` — a reviewer can, a viewer cannot.
   *
   * Mirrored here only to decide what to offer. The worker re-decides on every
   * request, so a table that drifts makes this screen wrong about what to
   * show and never wrong about what happens.
   */
  const canFinish = !relay && role !== null && roleAllows(role, "approve");

  // Guarded by `missionOutcome`, which is `summarise`'s fold — last event
  // wins and a reopening beats the completion before it. Reading the event
  // for its prose rather than re-deciding whether the mission is over keeps
  // one rule in one place.
  const finished =
    summary.missionOutcome === null
      ? null
      : (events.findLast((event) => event.type === "mission.completed") ?? null);
  const completion =
    finished?.type === "mission.completed" ? finished.payload : null;

  const latestRun = events.findLast((event) => event.type === "run.started");
  const runId =
    latestRun?.type === "run.started" ? latestRun.payload.run.id : null;
  const running =
    summary.runStatus === "working" || summary.runStatus === "paused";

  const sendDirection = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!direction.trim()) {
      return;
    }

    if (await actions.direct(direction.trim())) {
      setDirection("");
      setSent(true);
    }
  };

  // Cleared only when the worker took it. A summary discarded on a refusal is
  // a person's sentence thrown away for them.
  const end = async (outcome: "resolved" | "abandoned") => {
    if (await actions.finish(outcome, ending.trim())) {
      setEnding("");
    }
  };

  const reopen = async () => {
    if (await actions.reopen(reopening.trim())) {
      setReopening("");
    }
  };

  return (
    <div className="tab-content" style={{ display: active ? "grid" : "none" }}>
      <div className="session-bar">
        <span className="chip">Joined</span>
        <span title={repositoryPath ?? undefined}>{label}</span>
        <span className={`status status--${report.tone}`}>
          <span className="status__dot" />
          {report.label}
        </span>
        <span>{sentenceCase(summary.runStatus)}</span>
        {/*
          Beside the run's status, never instead of it. A mission resolved
          after a failed run is an ordinary ending — the team fixed it by hand
          and said so — and one chip that replaced the other could only tell
          that story by suppressing half of it.
        */}
        {summary.missionOutcome ? (
          <span className="chip">
            Mission {summary.missionOutcome}
          </span>
        ) : null}
        <span className="titlebar__spacer" />
        {/* Renders nothing when this window is nobody — a relay join, or a
            worker with no participant registry. */}
        <ControlBaton authority={authority} participants={participants} />
        <span title="What your invite allows. The host's worker enforces this on every request — this label only decides what is offered here.">
          {relay
            ? "Relay — watch only"
            : role
              ? describeRole(role)
              : "Role unknown — watch only"}
        </span>
      </div>

      {/*
        The evidence column is mounted only when there is evidence. A panel
        reading "no files changed" and "no checks configured" on a mission that
        has not started teaches people not to look at it, which is the opposite
        of what an evidence panel is for — and the centre takes the width back.
      */}
      <div
        className="body"
        style={{
          gridTemplateColumns: evidence.any
            ? "var(--rail-w) 1fr var(--rail-w)"
            : "var(--rail-w) 1fr",
        }}
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

          {/*
            How this mission ended, for everybody, and the way back for
            whoever may take it.

            The outcome and the evidence are shown together on purpose. The
            evidence is the frozen copy from the event, not a fresh reading of
            the repository: a mission finished with nothing verified must go on
            saying so, or the next unrelated test run silently upgrades it to
            green.
          */}
          {completion ? (
            <div className="rail__section">
              <div className="eyebrow">Mission {completion.outcome}</div>
              <div>{completion.summary}</div>
              <span
                className={
                  verificationLine(
                    completion.verification,
                    completion.filesChanged,
                  ).tone
                }
              >
                {
                  verificationLine(
                    completion.verification,
                    completion.filesChanged,
                  ).text
                }
              </span>
              {canFinish ? (
                <>
                  <input
                    className="open__input"
                    value={reopening}
                    onChange={(event) => setReopening(event.target.value)}
                    placeholder="Why it is not finished after all"
                    spellCheck={false}
                  />
                  <button
                    className="button"
                    type="button"
                    disabled={reopening.trim().length < RATIONALE_FLOOR}
                    onClick={() => void reopen()}
                  >
                    Reopen mission
                  </button>
                </>
              ) : null}
            </div>
          ) : canFinish ? (
            <div className="rail__section">
              <div className="eyebrow">Finish mission</div>
              <input
                className="open__input"
                value={ending}
                onChange={(event) => setEnding(event.target.value)}
                placeholder="What happened, in a sentence"
                spellCheck={false}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={ending.trim().length < RATIONALE_FLOOR}
                  onClick={() => void end("resolved")}
                >
                  Resolved
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={ending.trim().length < RATIONALE_FLOOR}
                  onClick={() => void end("abandoned")}
                >
                  Abandoned
                </button>
              </div>
              {/*
                Said before anybody presses it. Finishing records what the
                evidence says at this moment; it is not a claim that the work
                is proven, and the button must not be read as one.
              */}
              <span className="eyebrow">
                This records what the evidence says right now. It does not make
                it green.
              </span>
            </div>
          ) : null}

          {/*
            Authority, above the roster, because "who may act" is the thing a
            person needs before "who is here". The same component the hosting
            window uses: a joined participant is a participant, and the
            lifecycle they are inside is the same lifecycle. It renders nothing
            at all when this window is nobody, which is what a relay join is.
          */}
          <ControlPanel
            authority={authority}
            participants={participants}
            onOffer={(participantId) => void actions.offerControl(participantId)}
            onRequest={(reason) => void actions.requestControl(reason)}
            onAnswer={(offerEventId, answer) =>
              void actions.answerHandoff(offerEventId, answer)
            }
          />

          <PendingDirection pending={authority.pendingDirection} />

          {participants.length > 0 ? (
            <div className="rail__section">
              <div className="eyebrow">Participants</div>
              {participants.map((participant) => (
                <div className="stat" key={participant.id}>
                  <span>
                    {participant.name}
                    {youId !== null && participant.id === youId ? " (you)" : ""}
                  </span>
                  <span className="stat__value">
                    {participant.role}
                    {participant.connected ? " · here" : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {relay ? (
            <div className="rail__section">
              <div className="eyebrow">Relay</div>
              {/*
                Said plainly rather than implied by the absence of buttons. A
                relay carries one session's log outbound and authorises nothing
                else, so there is no channel for a request, a handoff answer or
                a direction to travel on — and a person who can see the run but
                not act on it deserves to know which of the two reasons applies
                to them.
              */}
              <div>
                Watching through a relay. This connection only carries the log
                outbound, so control, direction and run actions cannot be sent
                back yet — join over the host's own address to act.
              </div>
            </div>
          ) : null}
        </aside>

        <main className="timeline">
          {events.length === 0 ? (
            <div style={{ padding: 24, maxWidth: 560 }}>
              <p>{report.emptyTimeline}</p>
              {onRetry ? (
                <button className="button" type="button" onClick={onRetry}>
                  Retry now
                </button>
              ) : null}
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

        {/*
          The host's own evidence panel, not a joined copy of it. Same
          component, same three-way verification rule, fed from the same two
          worker reads — a teammate asked to agree a mission is done is looking
          at the host's facts rather than at a second rendering of them.

          GitHub's checks are deliberately not read here: `/github` shells out
          to `gh` on the host and a joined window has no standing to make the
          host run a command. What is drawn is what the session's own log
          already knows.
        */}
        {evidence.any ? (
          <EvidenceInspector facts={evidence.facts} github={null} />
        ) : null}
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
              setSent(false);
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
          {/*
            Sent, not "recorded" or "queued". Which of those two it became is
            the worker's answer and it is on screen a moment later under
            Direction — this only acknowledges that the send landed, and
            claiming more than that here would be guessing at the difference
            the panel exists to draw.
          */}
          {sent ? <span className="eyebrow">Sent</span> : null}
          {actions.error ? (
            <span className="open__error">{actions.error}</span>
          ) : null}
        </form>
      ) : (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <span className="eyebrow">
            {relay
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
