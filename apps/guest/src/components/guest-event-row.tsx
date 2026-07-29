/**
 * The guest's event row: the shared row, plus the panels only the guest draws.
 *
 * `@novus/ui` owns the row itself, so a guest and a host looking at the same
 * sequence number are looking at the same thing by construction rather than by
 * two files being kept in step. What is left here is the handful of tools the
 * guest answers more fully than the host, and they stay here because markup
 * belongs beside the stylesheet that dresses it — `panel`, `entries` and
 * `kv__value--unknown` exist in this app's CSS and nowhere else.
 *
 * The guest spells more out because it can do less: it cannot re-run the tool,
 * open the directory, or read the diff anywhere but here. It also never asks
 * for the raw payload dump the host has behind its palette, which is why the
 * shared row's `raw` prop simply goes unset.
 */

import type { ToolResult } from "@novus/contracts";
import {
  DiffLines,
  EventRow as SharedEventRow,
  describeWorkingTree,
  type EventRowProps,
} from "@novus/ui";

const guestPanels = (result: ToolResult) => {
  if (result.name === "list_directory") {
    const { entries } = result.output;

    return (
      <div className="panel">
        <div className="kv">
          <span className="kv__key">path</span>
          <span className="kv__value">{result.output.path}</span>
        </div>
        {entries.length === 0 ? (
          <div className="panel__note">This directory is empty.</div>
        ) : (
          <ul className="entries">
            {entries.map((entry) => (
              <li className="entries__row" key={`${entry.kind}:${entry.name}`}>
                {/* The trailing slash is the same shorthand a shell uses, and
                    the kind is still spelled out — a symlink to a directory is
                    not a directory, and the agent's next call depends on it. */}
                <span className="entries__name">
                  {entry.name}
                  {entry.kind === "directory" ? "/" : ""}
                </span>
                <span className="entries__kind">{entry.kind}</span>
              </li>
            ))}
          </ul>
        )}
        {result.output.truncated ? (
          <div className="panel__note">
            … more entries than the tool returns; this listing is not the whole
            directory.
          </div>
        ) : null}
      </div>
    );
  }

  if (result.name === "git_status") {
    const tree = describeWorkingTree(result.output);

    return (
      <div className="panel">
        <div className="kv">
          <span className="kv__key">branch</span>
          <span className="kv__value">{tree.branch}</span>
          <span className="kv__key">state</span>
          <span
            className={
              tree.certainty === "unknown"
                ? "kv__value kv__value--unknown"
                : "kv__value"
            }
          >
            {tree.state}
          </span>
        </div>
        {result.output.files.length > 0 ? (
          <ul className="matches">
            {result.output.files.map((file) => (
              <li className="matches__row" key={`${file.status}:${file.path}`}>
                <span className="matches__path">{file.path}</span>
                <span className="matches__line">{file.status}</span>
                <span className="matches__text">
                  {file.staged ? "staged" : "unstaged"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (result.name === "git_diff") {
    const scope = result.output.staged ? "staged" : "unstaged";

    if (result.output.diff.trim() === "") {
      return <div className="panel__note">No {scope} changes in the diff.</div>;
    }

    return (
      <div className="patch">
        <div className="patch__head">
          <span className="patch__path">
            {result.output.filesChanged} file
            {result.output.filesChanged === 1 ? "" : "s"}
          </span>
          <span className="patch__badge">{scope}</span>
        </div>
        <DiffLines diff={result.output.diff} />
        {result.output.truncated ? (
          <div className="panel__note panel__note--inset">
            … the diff is longer than the tool returns, and the rest is not
            shown here.
          </div>
        ) : null}
      </div>
    );
  }

  // apply_patch and propose_patch draw themselves in the row above rather than
  // in a panel, so there is nothing left for this to open.
  return null;
};

export const EventRow = (props: Omit<EventRowProps, "panels" | "raw">) => (
  <SharedEventRow {...props} panels={guestPanels} />
);
