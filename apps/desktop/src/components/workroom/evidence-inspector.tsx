import type { GithubStatus } from "@novus/contracts/protocol";

/**
 * Verification, changes, and open risk — when any of those exist.
 *
 * The inspector used to be a permanent third column reading "No files changed
 * yet" and "No checks configured" on a mission that had not started. A panel
 * that is empty most of the time teaches people not to look at it, which is
 * the opposite of what an evidence panel is for. It is mounted only when it
 * has something to say, and the centre takes the width back.
 *
 * Order is deliberate: what was *proven* comes before what was *touched*.
 * Changed files say something moved; only verification says it works.
 */

export type EvidenceFacts = {
  /** Null when nothing ran. Never the same as false, never the same as true. */
  verified: boolean | null;
  /**
   * Why it is unverified, when it is — and the reason this is not a boolean.
   *
   * "No checks have run" and "the checks ran before the last edit" are
   * different things to tell somebody, and only the second is worth re-running
   * the suite over. Saying the first to a person who watched the suite go
   * green ten minutes ago reads as the product having lost their result.
   */
  reason: "none-ran" | "stale" | null;
  /**
   * Every kind of check, not only tests: a clean typecheck or a green build
   * verifies too. Named for what it counts, after a spell as `testsRun` while
   * it was already counting builds.
   */
  checksRun: number;
  checksPassed: number;
  files: { path: string; additions: number; deletions: number }[];
  /** Paths more than one workstream changed. */
  contested: string[];
  /** Anything a person should know before trusting the above. */
  risks: string[];
};

export const VerificationSummary = ({ facts }: { facts: EvidenceFacts }) => (
  <section className="evidence__block">
    <h3 className="evidence__heading">Verification</h3>

    {facts.verified === null ? (
      // The state most easily misread as success. Said plainly, and dim
      // rather than green or red: an absence of evidence is not a result.
      // Two sentences, because there are two ways to get here and telling
      // somebody who watched a suite pass that no checks have run is the
      // product appearing to have lost their result.
      <p className="evidence__line evidence__line--unknown">
        {facts.reason === "stale"
          ? `Nothing has verified these changes. ${facts.checksRun} check${
              facts.checksRun === 1 ? "" : "s"
            } ran, but before the last edit.`
          : "Nothing has verified these changes. No checks have run."}
      </p>
    ) : facts.verified ? (
      <p className="evidence__line evidence__line--pass">
        <span className="evidence__glyph" aria-hidden="true">
          ✓
        </span>
        {facts.checksPassed} of {facts.checksRun} checks passed
      </p>
    ) : (
      <p className="evidence__line evidence__line--fail">
        <span className="evidence__glyph" aria-hidden="true">
          ✕
        </span>
        {facts.checksPassed} of {facts.checksRun} checks passed
      </p>
    )}
  </section>
);

export const EvidenceInspector = ({
  facts,
  github,
}: {
  facts: EvidenceFacts;
  github: GithubStatus | null;
}) => (
  <aside className="evidence evidence--panel">
    <h2 className="rail__eyebrow">Evidence</h2>

    <VerificationSummary facts={facts} />

    {github?.connected ? (
      <section className="evidence__block">
        <h3 className="evidence__heading">Required checks</h3>
        <p
          className={
            github.verdict === "passing"
              ? "evidence__line evidence__line--pass"
              : github.verdict === "failing"
                ? "evidence__line evidence__line--fail"
                : "evidence__line evidence__line--unknown"
          }
        >
          {github.verdict === "stale"
            ? "Checks last ran on a different commit — nothing has tested this code"
            : github.verdict === "none"
              ? "No checks configured for this branch"
              : github.verdict === "running"
                ? `${github.checks.length} still running`
                : github.verdict === "passing"
                  ? `${github.checks.length} passed on GitHub`
                  : `${github.checks.length} not passing`}
        </p>
      </section>
    ) : null}

    {facts.files.length > 0 ? (
      <section className="evidence__block">
        <h3 className="evidence__heading">Changes</h3>
        <p className="evidence__meta">
          {facts.files.length} file{facts.files.length === 1 ? "" : "s"} changed
        </p>
        <ul className="evidence__files">
          {facts.files.map((file) => (
            <li
              className={
                facts.contested.includes(file.path)
                  ? "evidence__file evidence__file--contested"
                  : "evidence__file"
              }
              key={file.path}
            >
              <span className="evidence__path">{file.path}</span>
              <span className="evidence__add">+{file.additions}</span>
              <span className="evidence__del">−{file.deletions}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null}

    {facts.risks.length > 0 ? (
      <section className="evidence__block">
        <h3 className="evidence__heading">Open risk</h3>
        {facts.risks.map((risk) => (
          <p className="evidence__line evidence__line--risk" key={risk}>
            {risk}
          </p>
        ))}
      </section>
    ) : null}
  </aside>
);
