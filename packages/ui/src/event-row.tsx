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
import { summariseReceipt } from "./receipt-summary.ts";
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
  "control.offered": "⇢",
  "control.accepted": "✓",
  "control.declined": "⊘",
  "control.withdrawn": "↺",
  "control.transferred": "⇄",
  "direction.queued": "»",
  "direction.applied": "»",
  "checkpoint.created": "◈",
  "fork.created": "⑂",
  "decision.recorded": "☑",
  "run.cancel_requested": "◐",
  "run.cancelled": "◻",
  "run.pause_requested": "◑",
  "run.paused": "‖",
  "run.resumed": "▹",
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
        // Never the goal: a session's goal is deliberately null — goals belong
        // to the runs inside it — so rendering it drew an empty row under a
        // bare glyph, once per open *and* once per resume. That stack of blank
        // diamonds at the top of every reopened session was this line.
        return (
          <span className="event__text event__text--muted">
            Session opened
            <span className="event__type">
              {" "}
              · {event.payload.session.repositoryPath}
            </span>
          </span>
        );

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
            Cancel requested
          </span>
        );

      case "run.cancelled":
        return (
          <span className="event__text event__text--muted">Stopped</span>
        );

      case "run.pause_requested":
        return (
          <span className="event__text event__text--muted">
            Pause requested
          </span>
        );

      case "run.paused":
        return (
          <span className="event__text event__text--muted">Paused</span>
        );

      case "run.resumed":
        return (
          <span className="event__text event__text--approved">Resumed</span>
        );

      case "participant.joined": {
        const { participant } = event.payload;

        return (
          <span className="event__text">
            {participant.name} joined
            <span className="event__type">
              {" "}
              · {participant.role}
              {participant.kind === "agent" ? " · Agent" : ""}
            </span>
          </span>
        );
      }

      case "participant.left":
        return (
          <span className="event__text event__text--muted">
            {event.payload.participantId} ·{" "}
            {event.payload.reason === "disconnected"
              ? "Connection dropped"
              : event.payload.reason === "removed"
                ? "Removed"
                : "Left"}
          </span>
        );

      case "control.requested":
        return (
          <span className="event__text">
            {event.payload.participantId} asked for control
            {event.payload.reason ? ` · ${event.payload.reason}` : ""}
          </span>
        );

      case "control.offered":
        return (
          <span className="event__text">
            Control offered to {event.payload.toParticipantId}
          </span>
        );

      case "control.accepted":
        // Not the transfer: acceptance commits the move, and the gap until
        // control.transferred is the wait for a safe boundary.
        return (
          <span className="event__text">
            {event.payload.participantId} accepted control
          </span>
        );

      case "control.declined":
        return (
          <span className="event__text event__text--muted">
            {event.payload.participantId} declined control
            {event.payload.reason ? ` · ${event.payload.reason}` : ""}
          </span>
        );

      case "control.withdrawn":
        return (
          <span className="event__text event__text--muted">
            Offer of control withdrawn
          </span>
        );

      case "control.transferred":
        return (
          <span className="event__text event__text--approved">
            Control moved from {event.payload.fromParticipantId} to{" "}
            {event.payload.toParticipantId}
          </span>
        );

      case "direction.queued":
        return (
          <span className="event__text event__text--muted">
            Queued for the next safe boundary · {event.payload.direction}
          </span>
        );

      case "direction.applied":
        // Separate from direction.submitted on purpose: this is the moment the
        // words actually reached the run, which is what the person who typed
        // them is waiting to see.
        return (
          <span className="event__text event__text--approved">
            Applied · {event.payload.direction}
          </span>
        );

      case "checkpoint.created": {
        const { checkpoint } = event.payload;

        return (
          <span className="event__text event__text--muted">
            Checkpoint at sequence {checkpoint.parentSequence}
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
              Chose {event.payload.runId}
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
            Chose {event.payload.runId}
            <span className="event__type"> · not applied — {outcome.reason}</span>
          </span>
        );
      }

      case "receipt.created": {
        const { receipt } = event.payload;
        // Verdict, spend and tone come from `summariseReceipt` so the rule
        // they encode — completion is not verification — lives somewhere a
        // test can reach. This row used to read only `receipt.tests`, so a run
        // that typechecked clean and built green rendered exactly like one
        // that checked nothing at all.
        const summary = summariseReceipt(receipt);

        return (
          <span className={`event__text event__text--${summary.tone}`}>
            {summary.parts.join(" · ")}
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
        // The model's own words, when the provider sent any alongside this
        // call, lead at full prominence — it is the one place in a tool
        // exchange the model actually explains itself, so it does not get
        // the muted treatment the mechanical call summary below it does.
        return (
          <>
            {event.payload.text ? (
              <p className="event__prose">{event.payload.text}</p>
            ) : null}
            <span className="event__text event__text--muted">
              <span className="tool__name">{event.payload.call.name}</span>{" "}
              {summariseCall(event.payload.call)}
            </span>
          </>
        );

      case "tool.completed": {
        const { result } = event.payload;

        // All three proposal tools, not just propose_patch. A proposal is the
        // artefact a human authorises `apply_patch` against, so a proposal
        // whose diff renders nowhere is a change approved blind — and that
        // mattered most for the one that cannot be undone by another edit:
        // a deletion used to reach this switch, match nothing, and fall
        // through to an empty panel.
        if (
          result.name === "propose_patch" ||
          result.name === "propose_new_file" ||
          result.name === "propose_deletion"
        ) {
          return (
            <DiffView
              patch={{
                path: result.output.path,
                intent: result.output.intent,
                status: result.output.status,
                diff: result.output.diff,
                additions: result.output.additions,
                deletions: result.output.deletions,
                kind:
                  result.name === "propose_new_file"
                    ? "create"
                    : result.name === "propose_deletion"
                      ? "delete"
                      : "edit",
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
