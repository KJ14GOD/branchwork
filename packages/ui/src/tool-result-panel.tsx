/**
 * The panel a completed tool opens into.
 *
 * Three of the tools are drawn differently by the two clients on purpose, and
 * the difference is not cosmetic drift: the guest renders `list_directory`,
 * `git_status` and `git_diff` into a fuller panel with its own vocabulary of
 * CSS classes, because a guest cannot re-run the tool and has only what the row
 * shows it. The host is terser because it can open the file itself.
 *
 * So this component holds the tools both clients agree on and hands the rest
 * back to the caller. Markup lives in the same package as the stylesheet that
 * dresses it, which is why the divergent three stay in the apps: `.panel` and
 * `.entries` exist only in the guest's stylesheet, and would render as unstyled
 * boxes in the host.
 */

import type { ReactNode } from "react";

import type { ToolResult } from "@novus/contracts";

/**
 * A client's answer for the tools this panel does not draw. Returning null is a
 * legitimate answer — the patch tools draw themselves in the row above, so
 * there is nothing left for a panel to open.
 */
export type ToolPanels = (result: ToolResult) => ReactNode;

export const ToolResultPanel = ({
  result,
  panels,
}: {
  result: ToolResult;
  // Spelled `| undefined` because `exactOptionalPropertyTypes` is on: the row
  // forwards a prop it may not have been given, and that is a different thing
  // from the prop being absent.
  panels?: ToolPanels | undefined;
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

  if (result.name === "list_provider_models") {
    return (
      <div className="kv">
        <span className="kv__key">provider</span>
        <span className="kv__value">{result.output.provider}</span>
        <span className="kv__key">models</span>
        <span className="kv__value">{result.output.models.length}</span>
        {result.output.models.length > 0 && (
          <>
            <span className="kv__key">ids</span>
            <pre className="kv__value">{result.output.models.join("\n")}</pre>
          </>
        )}
      </div>
    );
  }

  // run_build shares run_command/run_tests's outcome shape, so it reads the
  // same way — the verdict first, then whatever the command actually said.
  if (result.name === "run_build") {
    const streams = [result.output.stderr, result.output.stdout]
      .filter(Boolean)
      .join("\n");

    return (
      <div className="kv">
        <span className="kv__key">command</span>
        <span className="kv__value">{result.output.command}</span>
        <span className="kv__key">outcome</span>
        <span className="kv__value">
          {result.output.succeeded ? "built · " : "failed · "}
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

  if (result.name === "run_diagnostics") {
    return (
      <div className="kv">
        <span className="kv__key">{result.output.kind}</span>
        <span className="kv__value">
          {result.output.ok ? "clean" : "problems found"}
          {" · "}
          {Math.round(result.output.durationMs / 100) / 10}s
        </span>
        <span className="kv__key">command</span>
        <span className="kv__value">{result.output.command}</span>
        {result.output.diagnostics.length > 0 && (
          <>
            <span className="kv__key">found</span>
            <ul className="matches">
              {result.output.diagnostics.map((diagnostic, index) => (
                <li
                  className="matches__row"
                  key={`${diagnostic.path}:${diagnostic.line ?? 0}:${index}`}
                >
                  <span className="matches__path">{diagnostic.path}</span>
                  <span className="matches__line">{diagnostic.line ?? ""}</span>
                  <span className="matches__text">{diagnostic.message}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  if (result.name === "dev_server") {
    const { output } = result;

    return (
      <div className="kv">
        <span className="kv__key">action</span>
        <span className="kv__value">{output.action}</span>
        {output.action === "start" ? (
          <>
            <span className="kv__key">command</span>
            <span className="kv__value">{output.command}</span>
            <span className="kv__key">port</span>
            <span className="kv__value">
              {output.port} · {output.state}
            </span>
          </>
        ) : null}
      </div>
    );
  }

  if (result.name === "git_branches") {
    return (
      <div className="kv">
        <span className="kv__key">current</span>
        <span className="kv__value">
          {result.output.current ?? "detached HEAD"}
        </span>
        <span className="kv__key">branches</span>
        <ul className="matches">
          {result.output.branches.map((branch) => (
            <li className="matches__row" key={branch.name}>
              <span className="matches__path">
                {branch.isCurrent ? "▸ " : ""}
                {branch.name}
              </span>
              <span className="matches__line">
                {branch.revision.slice(0, 8)}
              </span>
              <span className="matches__text">
                {branch.subject}
                {branch.upstream ? ` · ${branch.upstream}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return panels ? panels(result) : null;
};
