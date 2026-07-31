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
 *
 * This is the reconciliation of the two copies that used to exist. They were
 * fixed in different directions — the host learned to pass headers through, the
 * guest learned to track the hunk — and hunk state is the stronger of the two,
 * because it subsumes the header fix and additionally gets a removed line whose
 * text happens to begin with `--` right. Patch diffs parse exactly as they did
 * on both sides: the worker always writes ---, +++ and an @@ header, so the
 * first hunk opens before any line the two implementations disagreed about.
 */

import {
  highlightLine,
  INITIAL_STATE,
  languageForPath,
  type HighlightState,
  type LanguageId,
  type Token,
} from "./highlight.ts";

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

export type HighlightedDiffLine = DiffLine & { tokens: readonly Token[] };

/** `+++ b/src/greet.js` and `diff --git a/x b/y` both name the file below. */
const PLUS_HEADER = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/;
const GIT_HEADER = /^diff --git a\/.+? b\/(.+)$/;

const pathFromHeader = (text: string): string | null => {
  const plus = PLUS_HEADER.exec(text);

  if (plus && plus[1] !== "/dev/null") {
    return plus[1] ?? null;
  }

  return GIT_HEADER.exec(text)?.[1] ?? null;
};

/**
 * Tokenize a parsed diff for display.
 *
 * TWO STATES, NOT ONE. A hunk interleaves two versions of the same region:
 * `-` and context lines are the file *before*, `+` and context lines are the
 * file *after*. Tokenizing them as a single stream lets a block comment opened
 * on a removed line "close" on an added one, which then miscolours the rest of
 * the hunk. Each side therefore carries its own `HighlightState`, and context
 * lines — which belong to both — advance both.
 *
 * `fallbackPath` is the single-file case (a patch card knows its own path).
 * A `git diff` covering several files names each one in its headers, so the
 * language is re-read as those go past; a hunk header resets both states,
 * because a hunk is a fresh window into the file with no guarantee that
 * whatever was open at the end of the last hunk is still open here.
 */
export const highlightDiffLines = (
  lines: readonly DiffLine[],
  fallbackPath: string | null,
): HighlightedDiffLine[] => {
  let language: LanguageId | null = fallbackPath
    ? languageForPath(fallbackPath)
    : null;
  let before: HighlightState = INITIAL_STATE;
  let after: HighlightState = INITIAL_STATE;

  return lines.map((line) => {
    if (line.kind === "meta") {
      const path = pathFromHeader(line.text);

      if (path !== null) {
        language = languageForPath(path);
      }

      return { ...line, tokens: [] };
    }

    if (line.kind === "hunk") {
      before = INITIAL_STATE;
      after = INITIAL_STATE;

      return { ...line, tokens: [] };
    }

    if (language === null) {
      return { ...line, tokens: [] };
    }

    if (line.kind === "del") {
      const result = highlightLine(line.text, language, before);
      before = result.state;

      return { ...line, tokens: result.tokens };
    }

    if (line.kind === "add") {
      const result = highlightLine(line.text, language, after);
      after = result.state;

      return { ...line, tokens: result.tokens };
    }

    // Context: belongs to both sides, so it advances both. Tokenized once —
    // the two states are equal here in every case that is not already broken.
    const result = highlightLine(line.text, language, after);
    before = highlightLine(line.text, language, before).state;
    after = result.state;

    return { ...line, tokens: result.tokens };
  });
};
