import type { FileChangesState } from "../use-file-changes.ts";

/**
 * The right-hand changed-files list — Novus's honest equivalent of
 * Conductor's per-file +/- panel.
 *
 * "Honest" because it draws exactly `GET /sessions/:id/files`, which is the
 * worker's own `RunProjection.filesChanged` (`apply_patch` only, summed
 * across this session's own turns) — the same numbers the compare screen and
 * receipts already show, not a second tally kept in the renderer.
 */
export const FileChangesPanel = ({ state }: { state: FileChangesState }) => (
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
        {state.loading ? "Reading…" : "No files changed yet. Applied patches show up here."}
      </div>
    ) : (
      <ul className="files__list">
        {state.files.map((file) => (
          <li className="files__row" key={file.path}>
            <span className="files__path" title={file.path}>
              {file.path}
            </span>
            <span className="files__counts">
              <span className="stat__add">+{file.additions}</span>{" "}
              <span className="stat__del">−{file.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
    )}
  </aside>
);
