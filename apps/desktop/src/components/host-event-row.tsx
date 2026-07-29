/**
 * The host's event row: the shared row, plus the panels only the host draws.
 *
 * `@novus/ui` owns the row itself, so the host and the guest cannot drift into
 * two accounts of the same sequence number again. What is left here is the
 * handful of tools the two clients answer differently, and they stay here
 * because markup belongs beside the stylesheet that dresses it — these panels
 * speak the host's `matches` and `kv` vocabulary, and the guest's `panel` and
 * `entries` classes do not exist in this app's CSS.
 *
 * The host is terser than the guest on purpose. A host can open the file, run
 * the command again, or scroll the real diff in its own editor; the guest has
 * only what the row hands it, so the guest spells more of it out.
 */

import type { ToolResult } from "@novus/contracts";
import { EventRow as SharedEventRow, type EventRowProps } from "@novus/ui";

const hostPanels = (result: ToolResult) => {
  if (result.name === "list_directory") {
    if (result.output.entries.length === 0) {
      return <div className="kv__key">empty directory</div>;
    }

    return (
      <ul className="matches">
        {result.output.entries.map((entry) => (
          <li className="matches__row" key={entry.name}>
            <span className="matches__line">
              {entry.kind === "directory" ? "dir" : entry.kind === "symlink" ? "link" : "file"}
            </span>
            <span className="matches__text">{entry.name}</span>
          </li>
        ))}
        {result.output.truncated ? (
          <li className="matches__row">
            <span className="matches__text">… truncated</span>
          </li>
        ) : null}
      </ul>
    );
  }

  if (result.name === "git_status") {
    // clean === null means the check could not run. It must never render as a
    // clean tree, which would say nothing changed when nothing is known.
    if (result.output.clean === null) {
      return <div className="kv__key">status unavailable</div>;
    }

    if (result.output.files.length === 0) {
      return <div className="kv__key">working tree clean</div>;
    }

    return (
      <ul className="matches">
        {result.output.files.map((file) => (
          <li className="matches__row" key={file.path}>
            <span className="matches__line">{file.status}</span>
            <span className="matches__path">{file.path}</span>
            <span className="matches__text">
              {file.staged ? "staged" : "unstaged"}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (result.name === "git_diff") {
    if (!result.output.diff) {
      return <div className="kv__key">no differences</div>;
    }

    // Not DiffView: that renders one file's proposal, with a path and an
    // add/delete count in its header. A git diff spans whatever changed.
    return (
      <div className="kv">
        <span className="kv__key">files</span>
        <span className="kv__value">
          {result.output.filesChanged} · {result.output.staged ? "staged" : "unstaged"}
        </span>
        <span className="kv__key">diff</span>
        <pre className="kv__value">
          {result.output.diff}
          {result.output.truncated ? "\n… truncated" : ""}
        </pre>
      </div>
    );
  }

  return null;
};

export const EventRow = (props: Omit<EventRowProps, "panels">) => (
  <SharedEventRow {...props} panels={hostPanels} />
);
