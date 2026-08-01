import { useState } from "react";

import type { GithubStatus } from "@novus/contracts/protocol";
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
/**
 * What was actually proven, above what was merely touched.
 *
 * STEERING's evidence inspector "supplies the proof" while the canvas explains
 * the decision. Changed files alone are not proof — they say something moved,
 * not that it works — so verification leads and the file list follows.
 *
 * Absent when there is nothing to say. An empty verification block on a
 * session that has not run anything is the kind of placeholder row this
 * project has already been told to stop drawing.
 */
const Verification = ({
  verdict,
  github,
}: {
  verdict: EvidenceVerdict | null;
  github: GithubStatus | null;
}) => {
  // Either half is worth showing on its own. Gating the whole block on the
  // local verdict hid GitHub's checks until the agent had run at least once,
  // and the two are unrelated — a branch's CI state is a fact about the
  // branch, not about whether anything has happened in this mission yet.
  if (verdict === null && github?.connected !== true) {
    return null;
  }

  return (
    <div className="evidence">
      {verdict === null ? null : (
        <div className="evidence__block">
          <span className="evidence__title">
            {/*
              One statement, not a heading over an empty region. The panel used
              to draw a "Verification" eyebrow and a "Files changed" eyebrow
              over two mostly-empty sections, which is more chrome than
              content — and the most common real answer, "nothing was
              verified", was the one it stated least clearly.
            */}
            {verdict.tests === null
              ? "Verification incomplete"
              : verdict.tests
                ? "Verified"
                : "Verification failing"}
          </span>
          <span
            className={
              verdict.tests === null
                ? "evidence__line evidence__line--unknown"
                : verdict.tests
                  ? "evidence__line evidence__line--pass"
                  : "evidence__line evidence__line--fail"
            }
          >
            {/*
              Never a tick for a run that tested nothing. The same rule the
              decision room and the exported receipt keep, in the third place
              a person could otherwise read "finished" as "verified".
            */}
            {verdict.tests === null
              ? verdict.approaches > 1
                ? `All ${verdict.approaches} approaches finished without running any tests.`
                : "This approach finished without running any tests."
              : verdict.tests
                ? `${verdict.testsRun} test run(s) passed.`
                : `${verdict.testsPassed} of ${verdict.testsRun} test run(s) passed.`}
          </span>
        </div>
      )}

      {github?.connected ? (
        <>
          <span className="evidence__title">Required checks</span>
          <span
            className={`evidence__line evidence__line--${
              github.verdict === "passing"
                ? "pass"
                : github.verdict === "failing"
                  ? "fail"
                  : "unknown"
            }`}
          >
            {/*
              "None" is never folded into passing. A branch nobody configured
              checks for has been verified by nothing — exactly as unproven as
              a run that skipped its tests.
            */}
            {github.verdict === "stale"
              ? "Checks last ran on a different commit — nothing has tested this code"
              : github.verdict === "none"
                ? "No checks configured for this branch"
                : github.verdict === "running"
                  ? `${github.checks.length} check(s) still running`
                  : github.verdict === "passing"
                    ? `${github.checks.length} check(s) passed on GitHub`
                    : `${github.checks.filter((check) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.state.toUpperCase())).length} of ${github.checks.length} check(s) not passing`}
          </span>
          {github.pullRequest ? (
            <span className="evidence__meta">
              #{github.pullRequest.number} {github.pullRequest.title}
            </span>
          ) : (
            // Said out loud. CI passing on a branch is not the same as anyone
            // agreeing to merge it, and a panel that showed only a green tick
            // would let the two be read as one thing.
            <span className="evidence__meta">
              No pull request open — these are the branch's own runs
            </span>
          )}
        </>
      ) : null}

      {verdict !== null && verdict.contested.length > 0 ? (
        <>
          <span className="evidence__title">Contested changes</span>
          {verdict.contested.map((path) => (
            <span className="evidence__path" key={path}>
              {path}
            </span>
          ))}
        </>
      ) : null}
    </div>
  );
};

export type EvidenceVerdict = {
  /** How many approaches this summarises, so the copy can say "all of them". */
  approaches: number;
  /** Null when nothing ran — not the same as failing, and never the same as passing. */
  tests: boolean | null;
  testsRun: number;
  testsPassed: number;
  /** Paths more than one approach changed. */
  contested: string[];
};

export const FileChangesPanel = ({
  state,
  diffs,
  verdict = null,
  github = null,
}: {
  state: FileChangesState;
  /** Applied diffs by path. A file with no entry stays a flat row. */
  diffs: Map<string, PatchProposalView>;
  /** Omitted by any caller that has no comparison to draw one from. */
  verdict?: EvidenceVerdict | null;
  /** Null when this repository has no GitHub remote, which is most of them. */
  github?: GithubStatus | null;
}) => {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <aside className="files">
      <Verification verdict={verdict} github={github} />

      <div className="files__head">
        <span className="evidence__title">Changed files</span>
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
