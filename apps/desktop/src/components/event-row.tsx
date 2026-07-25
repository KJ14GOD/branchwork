import { useState } from "react";

import type { SessionEvent } from "@novus/contracts";

import { DiffView } from "./diff-view.tsx";

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
};

const summariseCall = (call: Extract<SessionEvent, { type: "tool.requested" }>["payload"]["call"]): string => {
  if (call.name === "read_file") {
    return call.input.path;
  }

  if (call.name === "search_repository") {
    return `"${call.input.query}"${call.input.path ? ` in ${call.input.path}` : ""}`;
  }

  if (call.name === "propose_patch") {
    return `${call.input.path} · ${call.input.edits.length} edit${call.input.edits.length === 1 ? "" : "s"}`;
  }

  return call.input.patchId;
};

const ToolResultPanel = ({
  result,
}: {
  result: Extract<SessionEvent, { type: "tool.completed" }>["payload"]["result"];
}) => {
  if (result.name === "read_file") {
    const lineCount = result.output.content.split("\n").length;

    return (
      <div className="kv">
        <span className="kv__key">path</span>
        <span className="kv__value">{result.output.path}</span>
        <span className="kv__key">lines</span>
        <span className="kv__value">{lineCount}</span>
        <span className="kv__key">bytes</span>
        <span className="kv__value">{result.output.content.length}</span>
      </div>
    );
  }

  if (result.name === "search_repository") {
    if (result.output.matches.length === 0) {
      return <div className="kv__key">no matches</div>;
    }

    return (
      <ul className="matches">
        {result.output.matches.map((match, index) => (
          <li className="matches__row" key={`${match.path}:${match.line}:${index}`}>
            <span className="matches__path">{match.path}</span>
            <span className="matches__line">{match.line}</span>
            <span className="matches__text">{match.text.trim()}</span>
          </li>
        ))}
      </ul>
    );
  }

  return null;
};

export const EventRow = ({
  event,
  raw,
  highlighted,
}: {
  event: SessionEvent;
  raw: boolean;
  highlighted: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);

  const body = () => {
    if (raw) {
      return (
        <pre className="kv__value">{JSON.stringify(event.payload, null, 2)}</pre>
      );
    }

    switch (event.type) {
      case "session.created":
        return (
          <span className="event__text">
            {event.payload.session.goal}
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

        const summary =
          result.name === "read_file"
            ? result.output.path
            : `${result.output.matches.length} match${result.output.matches.length === 1 ? "" : "es"} for "${result.output.query}"`;

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
              <span className="tool__summary">{summary}</span>
            </button>
            {expanded ? (
              <div className="tool__panel">
                <ToolResultPanel result={result} />
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
