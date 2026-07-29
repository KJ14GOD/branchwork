import { useState } from "react";

import type { SessionEvent } from "@novus/contracts";

import { DiffView } from "./diff-view.tsx";

/**
 * One row of the ordered log, drawn the way the host draws it.
 *
 * A guest and a host looking at the same sequence number must be looking at the
 * same thing, or "we are both watching the run" stops being true. That is why
 * this is a copy of the host's row and not a simplified guest version: the
 * moment the two summarise an event differently, they are two accounts of the
 * run rather than one.
 *
 * Approval requests render as history here. A guest sees that the host was
 * asked; it has nothing to answer with.
 */

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
};

const summariseCall = (
  call: Extract<SessionEvent, { type: "tool.requested" }>["payload"]["call"],
): string => {
  if (call.name === "read_file") {
    return call.input.path;
  }

  if (call.name === "search_repository") {
    return `"${call.input.query}"${call.input.path ? ` in ${call.input.path}` : ""}`;
  }

  if (call.name === "propose_patch") {
    return `${call.input.path} · ${call.input.edits.length} edit${call.input.edits.length === 1 ? "" : "s"}`;
  }

  if (call.name === "run_command") {
    return [call.input.command, ...call.input.args].join(" ");
  }

  if (call.name === "run_tests") {
    return call.input.args.length > 0 ? call.input.args.join(" ") : "full suite";
  }

  if (call.name === "list_directory") {
    return call.input.path ?? ".";
  }

  if (call.name === "git_status") {
    return "working tree";
  }

  if (call.name === "git_diff") {
    return [call.input.staged ? "staged" : "unstaged", call.input.path]
      .filter(Boolean)
      .join(" · ");
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
          <li
            className="matches__row"
            key={`${match.path}:${match.line}:${index}`}
          >
            <span className="matches__path">{match.path}</span>
            <span className="matches__line">{match.line}</span>
            <span className="matches__text">{match.text.trim()}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (result.name === "run_command" || result.name === "run_tests") {
    // stderr first: when a command fails the reason is almost always there, and
    // a long stdout would otherwise push it out of view.
    const streams = [result.output.stderr, result.output.stdout]
      .filter(Boolean)
      .join("\n");
    const verdict =
      result.name === "run_tests"
        ? result.output.passed
          ? "passed · "
          : "failed · "
        : "";

    return (
      <div className="kv">
        <span className="kv__key">command</span>
        <span className="kv__value">{result.output.command}</span>
        <span className="kv__key">outcome</span>
        <span className="kv__value">
          {verdict}
          {result.output.timedOut
            ? "timed out"
            : result.output.exitCode === null
              ? "killed"
              : `exit ${result.output.exitCode}`}
          {" · "}
          {Math.round(result.output.durationMs / 100) / 10}s
        </span>
        {streams && (
          <>
            <span className="kv__key">output</span>
            <pre className="kv__value">
              {streams}
              {result.output.truncated ? "\n… truncated" : ""}
            </pre>
          </>
        )}
      </div>
    );
  }

  return null;
};

export const EventRow = ({
  event,
  highlighted,
}: {
  event: SessionEvent;
  highlighted: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);

  const body = () => {
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

        const parts = [
          `${receipt.filesChanged.length} file${receipt.filesChanged.length === 1 ? "" : "s"} changed`,
          verdict,
          `${receipt.usage.modelCalls} model call${receipt.usage.modelCalls === 1 ? "" : "s"}`,
          receipt.usage.callsMissingUsage > 0
            ? `≥${tokens} tokens`
            : `${tokens} tokens`,
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

        const summary =
          result.name === "read_file"
            ? result.output.path
            : result.name === "search_repository"
              ? `${result.output.matches.length} match${result.output.matches.length === 1 ? "" : "es"} for "${result.output.query}"`
              : result.name === "run_tests"
                ? result.output.passed
                  ? "tests passed"
                  : "tests failed"
                : result.name === "list_directory"
                  ? `${result.output.entries.length} entr${result.output.entries.length === 1 ? "y" : "ies"}`
                  : result.name === "git_status"
                    ? result.output.clean === null
                      ? "status unavailable"
                      : result.output.clean
                        ? "working tree clean"
                        : `${result.output.files.length} file${result.output.files.length === 1 ? "" : "s"} dirty`
                    : result.name === "git_diff"
                      ? `${result.output.filesChanged} file${result.output.filesChanged === 1 ? "" : "s"} in diff`
                      : result.output.command;

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
