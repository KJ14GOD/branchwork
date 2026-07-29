/**
 * Renders a proposed patch the way the host renders it.
 *
 * Copied from the desktop renderer rather than shared. A guest and a host now
 * draw the same diff, which is the second implementation that would justify
 * lifting this into a UI package — but that is a change to the host app, and
 * the host app belongs to whoever is editing it. Extract it once, deliberately,
 * with both callers in front of you.
 *
 * The lines themselves are drawn by `DiffLines`, which `git_diff` reuses: a
 * patch has a path, an intent and counters to put above the diff, and a Git
 * diff has none of those, but below the header they are the same picture.
 */

import { parseUnifiedDiff } from "../diff.ts";

export const DiffLines = ({ diff }: { diff: string }) => (
  <div className="diff">
    {parseUnifiedDiff(diff).map((line, index) => (
      <div key={index} className={`diff__line diff__line--${line.kind}`}>
        <span className="diff__num">{line.beforeLine ?? ""}</span>
        <span className="diff__num">{line.afterLine ?? ""}</span>
        <span className="diff__text">
          {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
          {line.text}
        </span>
      </div>
    ))}
  </div>
);

export type PatchProposalView = {
  path: string;
  intent: string;
  status: string;
  diff: string;
  additions: number;
  deletions: number;
};

export const DiffView = ({ patch }: { patch: PatchProposalView }) => (
  <div className="patch">
    <div className="patch__head">
      <span className="patch__path">{patch.path}</span>
      <span className="patch__count patch__count--add">+{patch.additions}</span>
      <span className="patch__count patch__count--del">−{patch.deletions}</span>
      <span className="patch__badge">{patch.status}</span>
    </div>
    <div className="patch__intent">{patch.intent}</div>
    <DiffLines diff={patch.diff} />
  </div>
);
