/**
 * A diff, drawn the one way both clients draw it.
 *
 * The lines themselves are drawn by `DiffLines`, which `git_diff` reuses: a
 * patch has a path, an intent and counters to put above the diff, and a Git
 * diff has none of those, but below the header they are the same picture.
 */

import { useMemo } from "react";

import { CodeLine } from "./code-view.tsx";
import { highlightDiffLines, parseUnifiedDiff } from "./diff.ts";

/**
 * `path` is optional and only improves the result: it tells the tokenizer
 * which language a single-file patch is in. A `git diff` names its own files
 * in its headers and needs nothing; an unknown or absent path means the diff
 * renders exactly as it did before highlighting existed.
 *
 * Memoized on the diff text because a patch card re-renders whenever anything
 * around it does, and a diff's tokens depend on nothing else.
 */
export const DiffLines = ({ diff, path }: { diff: string; path?: string }) => {
  const lines = useMemo(
    () => highlightDiffLines(parseUnifiedDiff(diff), path ?? null),
    [diff, path],
  );

  return (
    <div className="diff">
      {lines.map((line, index) => (
        <div key={index} className={`diff__line diff__line--${line.kind}`}>
          <span className="diff__num">{line.beforeLine ?? ""}</span>
          <span className="diff__num">{line.afterLine ?? ""}</span>
          {/*
            The marker stays a plain text child of .diff__text, exactly where
            it was. Moving it into its own span would add a fourth child to a
            grid the guest's stylesheet declares as three columns — see the
            "packages/ui markup is shared" note in novus-ui/SKILL.md. The
            highlighted runs are spans *inside* this element, which the guest
            simply does not style, so a diff there renders as the plain text it
            renders today.
          */}
          <span className="diff__text">
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            <CodeLine text={line.text} tokens={line.tokens} />
          </span>
        </div>
      ))}
    </div>
  );
};

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
    <DiffLines diff={patch.diff} path={patch.path} />
  </div>
);
