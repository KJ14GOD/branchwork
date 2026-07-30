/**
 * One row of the ordered log.
 *
 * A guest and a host looking at the same sequence number must be looking at the
 * same thing, or "we are both watching the run" stops being true. That used to
 * be enforced by copying this file between the two apps and hoping; it is now
 * enforced by there being one of it.
 *
 * What the two clients genuinely disagree about arrives as props. The host has
 * a raw payload dump behind its command palette and the guest deliberately has
 * no such control, so `raw` is optional and the guest simply never sets it.
 * Approval requests render as history in both: a guest sees that the host was
 * asked, and has nothing to answer with, so there is nothing to vary.
 */

import { useState } from "react";

import type { SessionEvent } from "@novus/contracts";

import { DiffView } from "./diff-view.tsx";
import { summariseCall, summariseToolResult } from "./tool-results.ts";
import { ToolResultPanel, type ToolPanels } from "./tool-result-panel.tsx";

const GLYPHS: Record<SessionEvent["type"], string> = {
  "session.created": "◇",
  "run.started": "▸",
  "run.progress": "·",
  "direction.submitted": "»",
  "tool.requested": "→",
  "tool.approval_requested": "?",
  "tool.approved": "●",
  "tool.denied": "⊘",
  "tool.completed": "✓",
  "tool.failed": "✗",
  "run.completed": "■",
  "run.failed": "✗",
  "receipt.created": "▣",
  "participant.joined": "◉",
  "participant.left": "◌",
  "control.requested": "✋",
  "control.transferred": "⇄",
  "direction.applied": "»",
  "checkpoint.created": "◈",
  "fork.created": "⑂",
  "decision.recorded": "☑",
  "run.cancel_requested": "◐",
  "run.cancelled": "◻",
};

export type EventRowProps = {
  event: SessionEvent;
  highlighted: boolean;
  /** The host's payload dump. The guest has no control for it and omits it. */
  raw?: boolean | undefined;
  /** The client's panels for the tools the two draw differently. */
  panels?: ToolPanels | undefined;
};

export const EventRow = ({
  event,
  highlighted,
  raw = false,
  panels,
}: EventRowProps) => {
  const [expanded, setExpanded] = useState(false);

  const body = () => {
    if (raw) {
      return (
        <pre className="kv__value">{JSON.stringify(event.payload, null, 2)}</pre>
      );
    }

    switch (event.type) {
      case "session.created":
        return <span className="event__text">{event.payload.session.goal}</span>;

      case "run.started":
        return (
          <span className="event__text">
            {event.payload.run.goal}
            <span className="event__type">
              {" "}
              · {event.payload.run.model.provider}/{event.payload.run.model.model}
            </span>
          </span>
        );

      case "run.progress":
        return (
          <span className="event__text event__text--muted">
            {event.payload.message}
          </span>
        );

      case "direction.submitted":
        return <span className="event__text">{event.payload.direction}</span>;

      case "run.completed":
        return <span className="event__text">{event.payload.summary}</span>;

      case "tool.approval_requested":
        return (
          <span className="event__text event__text--muted">
            <span className="tool__name">{event.payload.call.name}</span>{" "}
            requires {event.payload.toolClass} approval
          </span>
        );

      case "tool.approved":
        return (
          <span className="event__text event__text--approved">
            Approved by {event.payload.approvedBy}
          </span>
        );

      case "tool.denied":
        return (
          <span className="event__text event__text--error">
            Denied by {event.payload.deniedBy} — {event.payload.reason}
          </span>
        );

      case "tool.failed":
        return (
          <span className="event__text event__text--error">
            <span className="tool__name">{event.payload.name}</span>{" "}
            {event.payload.message}
          </span>
        );

      case "run.failed":
        return (
          <span className="event__text event__text--error">
            {event.payload.reason}
          </span>
        );

      case "run.cancel_requested":
        return (
          <span className="event__text event__text--muted">
            cancel requested
          </span>
        );

      case "run.cancelled":
        return (
          <span className="event__text event__text--muted">stopped</span>
        );

      case "participant.joined": {
        const { participant } = event.payload;

        return (
          <span className="event__text">
            {participant.name} joined
            <span className="event__type">
              {" "}
              · {participant.role}
              {participant.kind === "agent" ? " · agent" : ""}
            </span>
          </span>
        );
      }

      case "participant.left":
        return (
          <span className="event__text event__text--muted">
            {event.payload.participantId} ·{" "}
            {event.payload.reason === "disconnected"
              ? "connection dropped"
              : event.payload.reason === "removed"
                ? "removed"
                : "left"}
          </span>
        );

      case "control.requested":
        return (
          <span className="event__text">
            {event.payload.participantId} asked for control
            {event.payload.reason ? ` · ${event.payload.reason}` : ""}
          </span>
        );

      case "control.transferred":
        return (
          <span className="event__text event__text--approved">
            control moved from {event.payload.fromParticipantId} to{" "}
            {event.payload.toParticipantId}
          </span>
        );

      case "direction.applied":
        // Separate from direction.submitted on purpose: this is the moment the
        // words actually reached the run, which is what the person who typed
        // them is waiting to see.
        return (
          <span className="event__text event__text--approved">
            applied · {event.payload.direction}
          </span>
        );

      case "checkpoint.created": {
        const { checkpoint } = event.payload;

        return (
          <span className="event__text event__text--muted">
            checkpoint at sequence {checkpoint.parentSequence}
            <span className="event__type">
              {" "}
              · base {checkpoint.base.revision.slice(0, 8)}
              {checkpoint.base.patch ? " + uncommitted" : ""}
            </span>
          </span>
        );
      }

      case "fork.created": {
        const { fork } = event.payload;

        return (
          <span className="event__text">
            {fork.label}
            <span className="event__type">
              {" "}
              · {fork.branch} · ports {fork.devPorts.join(", ")}
            </span>
          </span>
        );
      }

      case "decision.recorded": {
        const { outcome } = event.payload;

        if (outcome.applied) {
          return (
            <span className="event__text event__text--approved">
              chose {event.payload.runId}
              <span className="event__type">
                {" "}
                · applied {outcome.files.length} file
                {outcome.files.length === 1 ? "" : "s"}
              </span>
            </span>
          );
        }

        return (
          <span className="event__text event__text--error">
            chose {event.payload.runId}
            <span className="event__type"> · not applied — {outcome.reason}</span>
          </span>
        );
      }

      case "receipt.created": {
        const { receipt } = event.payload;
        const failing = receipt.tests.filter((test) => !test.passed).length;
        const tokens = receipt.usage.inputTokens + receipt.usage.outputTokens;
        // A green suite that ran before the final edit says nothing about the
        // diff this receipt is attached to, so it does not get to read as a
        // plain pass.
        const verdict =
          receipt.tests.length === 0
            ? "tests not run"
            : failing > 0
              ? `${failing} of ${receipt.tests.length} test runs failed`
              : receipt.testsFollowedFinalChange === false
                ? "tests passed, but before the last change"
                : `${receipt.tests.length} test run${receipt.tests.length === 1 ? "" : "s"} passed`;

        // Lead with what a reviewer checks first: did it change anything, and
        // did the tests agree.
        const parts = [
          `${receipt.filesChanged.length} file${receipt.filesChanged.length === 1 ? "" : "s"} changed`,
          verdict,
          `${receipt.usage.modelCalls} model call${receipt.usage.modelCalls === 1 ? "" : "s"}`,
          // "Effective" because cached tokens are counted at what they bill —
          // a tenth for a cache read — so this is spend, not a raw count.
          receipt.usage.callsMissingUsage > 0
            ? `≥${tokens} effective tokens`
            : `${tokens} effective tokens`,
          `${Math.round(receipt.elapsedMs / 100) / 10}s`,
        ];

        return (
          <span
            className={
              failing > 0
                ? "event__text event__text--error"
                : "event__text event__text--muted"
            }
          >
            {parts.join(" · ")}
            {receipt.base.revision ? (
              <span className="event__type">
                {" "}
                · base {receipt.base.revision.slice(0, 8)}
                {receipt.base.dirty === true
                  ? " + uncommitted"
                  : receipt.base.dirty === null
                    ? " + unknown state"
                    : ""}
              </span>
            ) : null}
          </span>
        );
      }

      case "tool.requested":
        return (
          <span className="event__text event__text--muted">
            <span className="tool__name">{event.payload.call.name}</span>{" "}
            {summariseCall(event.payload.call)}
          </span>
        );

      case "tool.completed": {
        const { result } = event.payload;

        if (result.name === "propose_patch") {
          return (
            <DiffView
              patch={{
                path: result.output.path,
                intent: result.output.intent,
                status: result.output.status,
                diff: result.output.diff,
                additions: result.output.additions,
                deletions: result.output.deletions,
              }}
            />
          );
        }

        if (result.name === "apply_patch") {
          return (
            <span className="event__text">
              Applied {result.output.path}{" "}
              <span className="patch__count patch__count--add">
                +{result.output.additions}
              </span>{" "}
              <span className="patch__count patch__count--del">
                −{result.output.deletions}
              </span>
            </span>
          );
        }

        return (
          <div className="tool">
            <button
              className="tool__head"
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              <span className="tool__chevron">{expanded ? "▾" : "▸"}</span>
              <span className="tool__name">{result.name}</span>
              <span className="tool__summary">
                {summariseToolResult(result)}
              </span>
            </button>
            {expanded ? (
              <div className="tool__panel">
                <ToolResultPanel result={result} panels={panels} />
              </div>
            ) : null}
          </div>
        );
      }
    }
  };

  return (
    <div
      className={`event${highlighted ? " event--highlight" : ""}`}
      id={`event-${event.sequence}`}
    >
      <span className="event__seq">{event.sequence}</span>
      <div className="event__body">
        <div className="event__head">
          <span className="event__glyph">{GLYPHS[event.type]}</span>
          <div style={{ minWidth: 0, flex: 1 }}>{body()}</div>
        </div>
      </div>
    </div>
  );
};
