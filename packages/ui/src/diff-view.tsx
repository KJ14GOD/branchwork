/**
 * A diff, drawn the one way both clients draw it.
 *
 * The lines themselves are drawn by `DiffLines`, which `git_diff` reuses: a
 * patch has a path, an intent and counters to put above the diff, and a Git
 * diff has none of those, but below the header they are the same picture.
 */

import { parseUnifiedDiff } from "./diff.ts";

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
  /**
   * What the proposal does to the file, when it is not an ordinary edit.
   *
   * A deletion's diff is every line prefixed `-`, which at a glance is
   * indistinguishable from an edit that happens to remove a lot — and the
   * person reading it is deciding whether to authorise it. Optional so
   * existing callers keep meaning "edit".
   */
  kind?: "edit" | "create" | "delete";
};

export const DiffView = ({ patch }: { patch: PatchProposalView }) => (
  <div className="patch">
    <div className="patch__head">
      {patch.kind === "delete" || patch.kind === "create" ? (
        // Said in words, before the counts. A deletion renders as an
        // all-red diff, which reads the same as a large edit right up
        // until you have already approved it.
        <span
          className={`patch__badge patch__badge--${patch.kind === "delete" ? "delete" : "create"}`}
        >
          {patch.kind === "delete" ? "Delete file" : "New file"}
        </span>
      ) : null}
      <span className="patch__path">{patch.path}</span>
      <span className="patch__count patch__count--add">+{patch.additions}</span>
      <span className="patch__count patch__count--del">−{patch.deletions}</span>
      <span className="patch__badge">{patch.status}</span>
    </div>
    <div className="patch__intent">{patch.intent}</div>
    <DiffLines diff={patch.diff} />
  </div>
);
