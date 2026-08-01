import { useState, type ReactNode } from "react";

import type { GithubStatus } from "@novus/contracts/protocol";

import type { TreeEntry } from "../bridge.ts";
import type { FileChangesState } from "../use-file-changes.ts";
import type { FileTreeState } from "../use-file-tree.ts";

/**
 * The right-hand inspector: what the repository *is*, what this session
 * *changed*, and what has *verified* it — three answers to three different
 * questions, one at a time.
 *
 * They are tabs rather than three stacked sections because they are read one
 * at a time and each wants the full height: a tree that has to share a column
 * with a check list is a tree you cannot see the shape of. The panel is a
 * plane, not a stack of boxes — the tab row and the dock separate by space
 * and background, and the only border in here is the one against the canvas.
 *
 * All of the tab state is local. Which tab someone is on is a reading
 * position, not session state: nothing outside this panel behaves
 * differently because Checks is showing, so nothing outside it needs to know.
 */

type Tab = "files" | "changes" | "checks";
type DockTab = "setup" | "run" | "terminal";

/** GitHub check states this repository already treats as "not a failure". */
const PASSING_STATES = ["SUCCESS", "SKIPPED", "NEUTRAL"];

/**
 * GitHub's state literals, said as English.
 *
 * Anything unrecognised falls through to the literal itself rather than to a
 * guess — inventing "passed" for a state this build has never seen is exactly
 * the class of lie the `stale` verdict exists to prevent.
 */
const CHECK_STATE_WORDS: Record<string, string> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  ERROR: "errored",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed out",
  IN_PROGRESS: "running",
  QUEUED: "queued",
  PENDING: "pending",
  SKIPPED: "skipped",
  NEUTRAL: "neutral",
};

const checkStateWord = (state: string): string =>
  CHECK_STATE_WORDS[state.toUpperCase()] ?? state.toLowerCase().replace(/_/g, " ");

/**
 * The type indicator: a file's extension, as text.
 *
 * Not an icon. On a strictly monochrome palette a shape has to carry the
 * whole distinction between a dozen file types, which reads as decoration
 * rather than information — and the extension is the thing a person was going
 * to read off the name anyway. Files with no extension get nothing; a dash in
 * that column would be a placeholder standing in for an absent fact.
 */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(dot + 1) : "";
};

/**
 * The tree, depth-first, as rows.
 *
 * A plain function rather than a component so the recursion cannot remount a
 * subtree on every keystroke elsewhere in the panel, and so this file keeps
 * the one component it advertises.
 */
const treeRows = (
  entries: TreeEntry[],
  depth: number,
  tree: FileTreeState,
  onOpenFile: (path: string) => void,
): ReactNode[] =>
  entries.flatMap((entry) => {
    const isDirectory = entry.kind === "directory";
    const expanded = isDirectory && tree.expandedPaths.has(entry.path);
    const children = tree.childrenByPath[entry.path];

    const row = (
      <button
        type="button"
        key={entry.path}
        className={
          tree.selectedPath === entry.path ? "tree__row tree__row--selected" : "tree__row"
        }
        // Indentation is geometry, not a token: the step has to line the
        // chevrons of a nesting level up with each other, which is a pixel
        // relationship rather than a spacing decision.
        style={{ paddingLeft: 10 + depth * 14 }}
        aria-expanded={isDirectory ? expanded : undefined}
        title={entry.path}
        onClick={() =>
          isDirectory ? tree.toggleDirectory(entry.path) : onOpenFile(entry.path)
        }
      >
        <span className="tree__chevron" aria-hidden="true">
          {isDirectory ? (expanded ? "▾" : "▸") : ""}
        </span>
        <span className="tree__name">{entry.name}</span>
        {isDirectory ? null : (
          <span className="tree__kind">{extensionOf(entry.name)}</span>
        )}
        {isDirectory && tree.loadingPaths.has(entry.path) ? (
          <span className="tree__loading">…</span>
        ) : null}
      </button>
    );

    return expanded && children
      ? [row, ...treeRows(children, depth + 1, tree, onOpenFile)]
      : [row];
  });

export const Inspector = ({
  tree,
  onOpenFile,
  changes,
  github,
  setup,
  run,
  terminal,
}: {
  tree: FileTreeState;
  /**
   * Opening a file is the caller's business — this panel does not decide
   * whether that means a viewer, a new tab, or a jump inside a diff.
   */
  onOpenFile: (path: string) => void;
  /** The worker's own `filesChanged` projection, not a tally kept in here. */
  changes: FileChangesState;
  /** Null when this build has not asked GitHub anything yet. */
  github: GithubStatus | null;
  setup: ReactNode;
  run: ReactNode;
  terminal: ReactNode;
}) => {
  const [tab, setTab] = useState<Tab>("files");
  const [dockTab, setDockTab] = useState<DockTab>("run");
  const [dockOpen, setDockOpen] = useState(true);

  const changedCount = changes.files.length;

  const tabButton = (id: Tab, label: string, count: number | null) => (
    <button
      type="button"
      role="tab"
      id={`inspector-tab-${id}`}
      aria-selected={tab === id}
      aria-controls="inspector-body"
      className={tab === id ? "inspector__tab inspector__tab--active" : "inspector__tab"}
      onClick={() => setTab(id)}
    >
      {label}
      {/*
        The count appears only when there is something to count. A permanent
        "Changes 0" is a placeholder row wearing a badge, and it trains people
        to stop reading the number that matters.
      */}
      {count !== null && count > 0 ? (
        <span className="inspector__count">{count}</span>
      ) : null}
    </button>
  );

  const dockButton = (id: DockTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={dockTab === id}
      className={
        dockTab === id ? "inspector__tab inspector__tab--active" : "inspector__tab"
      }
      onClick={() => {
        setDockTab(id);
        // Picking a pane in a shut dock means "show me that pane", never
        // "change what will be showing the next time I open this".
        setDockOpen(true);
      }}
    >
      {label}
    </button>
  );

  return (
    <aside className="inspector">
      <div className="inspector__tabs" role="tablist" aria-label="Inspector">
        {tabButton("files", "All files", null)}
        {tabButton("changes", "Changes", changedCount)}
        {tabButton("checks", "Checks", null)}
      </div>

      <div
        className="inspector__body"
        id="inspector-body"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${tab}`}
      >
        {tab === "files" ? (
          tree.rootError ? (
            <p className="tree__empty tree__empty--error">{tree.rootError}</p>
          ) : tree.rootEntries.length === 0 ? (
            <p className="tree__empty">
              {tree.rootLoading ? "Reading…" : "Empty repository"}
            </p>
          ) : (
            <div className="tree__body">
              {treeRows(tree.rootEntries, 0, tree, onOpenFile)}
            </div>
          )
        ) : null}

        {tab === "changes" ? (
          changes.error ? (
            <p className="changes__empty changes__empty--error">{changes.error}</p>
          ) : changedCount === 0 ? (
            <p className="changes__empty">
              {changes.loading
                ? "Reading…"
                : "Nothing changed yet. Applied patches show up here."}
            </p>
          ) : (
            <>
              <p className="changes__totals">
                {/*
                  Deliberately not the verified green. A line was added, which
                  says something moved — it does not say anything works, and
                  green in this product is reserved for what has been proven.
                */}
                <span className="changes__add">+{changes.additions}</span>
                <span className="changes__del">−{changes.deletions}</span>
              </p>
              <ul className="changes__list">
                {changes.files.map((file) => (
                  <li className="changes__item" key={file.path}>
                    <button
                      type="button"
                      className="changes__row"
                      title={file.path}
                      onClick={() => onOpenFile(file.path)}
                    >
                      <span className="changes__path">{file.path}</span>
                      <span className="changes__counts">
                        <span className="changes__add">+{file.additions}</span>
                        <span className="changes__del">−{file.deletions}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : null}

        {tab === "checks" ? (
          github === null || !github.connected ? (
            // Said plainly, with the reason the worker gave. A checks tab that
            // drew an empty list here would read as "no checks failed", which
            // is a claim nobody has made.
            <p className="checks__empty">
              GitHub is not connected, so nothing here has been checked by it.
              {github === null ? null : ` ${github.reason}`}
            </p>
          ) : (
            <>
              <p
                className={`checks__verdict checks__verdict--${
                  github.verdict === "passing"
                    ? "pass"
                    : github.verdict === "failing"
                      ? "fail"
                      : "unknown"
                }`}
              >
                {/*
                  `none` and `stale` are never folded into passing. A branch
                  nobody configured checks for, and a branch whose green run
                  was against a different commit, have both been verified by
                  nothing.
                */}
                {github.verdict === "stale"
                  ? "Checks last ran on a different commit — nothing has tested this code"
                  : github.verdict === "none"
                    ? "No required checks are configured for this branch"
                    : github.verdict === "running"
                      ? `${github.checks.length} check(s) still running`
                      : github.verdict === "passing"
                        ? `${github.checks.length} check(s) passed on GitHub`
                        : `${
                            github.checks.filter(
                              (check) =>
                                !PASSING_STATES.includes(check.state.toUpperCase()),
                            ).length
                          } of ${github.checks.length} check(s) not passing`}
              </p>

              <p className="checks__meta">
                {github.pullRequest
                  ? `#${github.pullRequest.number} ${github.pullRequest.title}`
                  : // CI passing is not anyone agreeing to merge. Left unsaid,
                    // a green line would let the two be read as one thing.
                    "No pull request open — these are the branch's own runs"}
              </p>

              {github.checks.length > 0 ? (
                <ul className="checks__list">
                  {github.checks.map((check) => (
                    <li className="checks__item" key={`${check.name}:${check.url ?? ""}`}>
                      <span className="checks__name">{check.name}</span>
                      <span
                        className={`checks__state checks__state--${
                          PASSING_STATES.includes(check.state.toUpperCase())
                            ? "pass"
                            : ["IN_PROGRESS", "QUEUED", "PENDING"].includes(
                                  check.state.toUpperCase(),
                                )
                              ? "running"
                              : "fail"
                        }`}
                      >
                        {checkStateWord(check.state)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )
        ) : null}
      </div>

      <div className="inspector__dock">
        <div className="inspector__dock-tabs" role="tablist" aria-label="Workbench">
          {dockButton("setup", "Setup")}
          {dockButton("run", "Run")}
          {dockButton("terminal", "Terminal")}

          <button
            type="button"
            className="inspector__collapse"
            aria-expanded={dockOpen}
            aria-label={dockOpen ? "Collapse the dock" : "Expand the dock"}
            title={dockOpen ? "Collapse" : "Expand"}
            onClick={() => setDockOpen((open) => !open)}
          >
            <span aria-hidden="true">{dockOpen ? "▾" : "▴"}</span>
          </button>
        </div>

        {/*
          Every pane stays mounted and is hidden with the `hidden` attribute
          rather than unmounted, including while the whole dock is shut. The
          terminal is passed in from outside and owns a live process: dropping
          it on a tab switch would kill the session and lose the scrollback,
          and a run's output that disappears because someone looked at Setup
          is not a panel anyone trusts twice.
        */}
        <div className="inspector__dock-body" hidden={!dockOpen || dockTab !== "setup"}>
          {setup}
        </div>
        <div className="inspector__dock-body" hidden={!dockOpen || dockTab !== "run"}>
          {run}
        </div>
        <div
          className="inspector__dock-body"
          hidden={!dockOpen || dockTab !== "terminal"}
        >
          {terminal}
        </div>
      </div>
    </aside>
  );
};