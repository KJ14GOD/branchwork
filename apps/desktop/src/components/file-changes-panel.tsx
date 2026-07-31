import { useState } from "react";

import { DiffView, type PatchProposalView } from "@novus/ui";

import type { FileChangesState } from "../use-file-changes.ts";

/**
 * The right-hand changed-files panel.
 *
 * The counts draw exactly `GET /sessions/:id/files`, which is the worker's
 * own `RunProjection.filesChanged` (`apply_patch` only, summed across this
 * session's own turns) — the same numbers the compare screen and receipts
 * show, not a second tally kept in the renderer.
 *
 * A row opens the diff that produced it. Reporting that a file changed
 * without letting anyone look at the change was the wrong half of the job:
 * this product's thesis is choosing between attempts on the evidence, and a
 * path with a +/- beside it is a claim about evidence rather than the thing
 * itself. The diffs come from the timeline the caller already holds — see
 * `appliedDiffsByPath` — so opening one costs no request.
 */
export const FileChangesPanel = ({
  state,
  diffs,
}: {
  state: FileChangesState;
  /** Applied diffs by path. A file with no entry stays a flat row. */
  diffs: Map<string, PatchProposalView>;
}) => {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <aside className="files">
      <div className="files__head">
        <span className="eyebrow">Files changed</span>
        {state.files.length > 0 ? (
          <span className="files__totals">
            <span className="stat__add">+{state.additions}</span>{" "}
            <span className="stat__del">−{state.deletions}</span>
          </span>
        ) : null}
      </div>

      {state.error ? (
        <div className="files__empty files__empty--error">{state.error}</div>
      ) : state.files.length === 0 ? (
        <div className="files__empty">
          {state.loading
            ? "Reading…"
            : "No files changed yet. Applied patches show up here."}
        </div>
      ) : (
        <ul className="files__list">
          {state.files.map((file) => {
            const diff = diffs.get(file.path);
            const isOpen = open === file.path;

            return (
              <li className="files__item" key={file.path}>
                <button
                  type="button"
                  className={`files__row${isOpen ? " files__row--open" : ""}`}
                  // A file whose diff this client never saw is not clickable
                  // rather than clickable-and-empty: an expander that opens
                  // onto nothing reads as a bug every time.
                  disabled={!diff}
                  aria-expanded={diff ? isOpen : undefined}
                  onClick={() => setOpen(isOpen ? null : file.path)}
                  title={
                    diff ? file.path : `${file.path} — no diff in this session's log`
                  }
                >
                  <span className="files__chevron">
                    {diff ? (isOpen ? "▾" : "▸") : ""}
                  </span>
                  <span className="files__path">{file.path}</span>
                  <span className="files__counts">
                    <span className="stat__add">+{file.additions}</span>{" "}
                    <span className="stat__del">−{file.deletions}</span>
                  </span>
                </button>
                {isOpen && diff ? (
                  <div className="files__diff">
                    <DiffView patch={diff} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
};
