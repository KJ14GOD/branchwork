/**
 * Unified diff, parsed for display.
 *
 * Lives apart from the component that draws it because two tools now produce
 * diffs and only one of them is a single-file patch. `git_diff` returns what
 * Git returns: several files, each introduced by headers that are not diff
 * lines at all. Treating an unrecognised line as context and slicing its first
 * character off — which is what a patch-shaped parser does — printed
 * "iff --git a/x b/x" and quietly dropped a character from every header in the
 * output.
 *
 * So the state is tracked rather than guessed. Inside a hunk, the first column
 * is the marker Git wrote; outside one, the line is a header and is passed
 * through whole.
 */

export type DiffLineKind = "meta" | "hunk" | "context" | "add" | "del";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};

// The counts are optional in Git's output: a hunk of exactly one line is
// written "@@ -1 +1 @@", and demanding the comma dropped those hunks into the
// header path where their bodies were mangled.
const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export const parseUnifiedDiff = (diff: string): DiffLine[] => {
  const lines: DiffLine[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  let inHunk = false;

  const meta = (text: string) => {
    lines.push({ kind: "meta", text, beforeLine: null, afterLine: null });
  };

  for (const raw of diff.split("\n")) {
    if (raw === "") {
      continue;
    }

    const hunk = HUNK_PATTERN.exec(raw);

    if (hunk) {
      beforeLine = Number(hunk[1]);
      afterLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw, beforeLine: null, afterLine: null });
      continue;
    }

    // Everything before the first hunk of a file is a header: "diff --git",
    // "index", the mode and rename lines, and the --- / +++ pair.
    if (!inHunk) {
      meta(raw);
      continue;
    }

    // "\ No newline at end of file" belongs to the hunk but numbers nothing.
    if (raw.startsWith("\\")) {
      meta(raw);
      continue;
    }

    if (raw.startsWith("+")) {
      lines.push({
        kind: "add",
        text: raw.slice(1),
        beforeLine: null,
        afterLine,
      });
      afterLine += 1;
      continue;
    }

    if (raw.startsWith("-")) {
      lines.push({
        kind: "del",
        text: raw.slice(1),
        beforeLine,
        afterLine: null,
      });
      beforeLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      lines.push({
        kind: "context",
        text: raw.slice(1),
        beforeLine,
        afterLine,
      });
      beforeLine += 1;
      afterLine += 1;
      continue;
    }

    // No marker at all, so the hunk has ended and the next file has begun.
    inHunk = false;
    meta(raw);
  }

  return lines;
};
