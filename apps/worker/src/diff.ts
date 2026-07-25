export type UnifiedDiff = {
  diff: string;
  additions: number;
  deletions: number;
};

type DiffOp = {
  kind: "equal" | "delete" | "insert";
  text: string;
};

const DEFAULT_CONTEXT = 3;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

// A line-level LCS is quadratic. Common prefix/suffix trimming keeps realistic
// edits far below this ceiling; anything larger degrades to a whole-file
// replacement rather than exhausting memory.
const MAX_DIFF_CELLS = 4_000_000;

type SplitText = {
  lines: string[];
  endsWithNewline: boolean;
};

const splitLines = (text: string): SplitText => {
  if (text === "") {
    return { lines: [], endsWithNewline: true };
  }

  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");

  if (endsWithNewline) {
    lines.pop();
  }

  return { lines, endsWithNewline };
};

const diffCore = (before: string[], after: string[]): DiffOp[] => {
  if (before.length === 0) {
    return after.map((text) => ({ kind: "insert" as const, text }));
  }

  if (after.length === 0) {
    return before.map((text) => ({ kind: "delete" as const, text }));
  }

  if ((before.length + 1) * (after.length + 1) > MAX_DIFF_CELLS) {
    return [
      ...before.map((text) => ({ kind: "delete" as const, text })),
      ...after.map((text) => ({ kind: "insert" as const, text })),
    ];
  }

  const width = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * width);

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      lengths[row * width + column] =
        before[row] === after[column]
          ? lengths[(row + 1) * width + column + 1]! + 1
          : Math.max(
              lengths[(row + 1) * width + column]!,
              lengths[row * width + column + 1]!,
            );
    }
  }

  const ops: DiffOp[] = [];
  let row = 0;
  let column = 0;

  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      ops.push({ kind: "equal", text: before[row]! });
      row += 1;
      column += 1;
    } else if (
      lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!
    ) {
      ops.push({ kind: "delete", text: before[row]! });
      row += 1;
    } else {
      ops.push({ kind: "insert", text: after[column]! });
      column += 1;
    }
  }

  while (row < before.length) {
    ops.push({ kind: "delete", text: before[row]! });
    row += 1;
  }

  while (column < after.length) {
    ops.push({ kind: "insert", text: after[column]! });
    column += 1;
  }

  return ops;
};

const diffLines = (before: string[], after: string[]): DiffOp[] => {
  let prefix = 0;

  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let beforeEnd = before.length;
  let afterEnd = after.length;

  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  return [
    ...before.slice(0, prefix).map((text) => ({ kind: "equal" as const, text })),
    ...diffCore(before.slice(prefix, beforeEnd), after.slice(prefix, afterEnd)),
    ...before.slice(beforeEnd).map((text) => ({ kind: "equal" as const, text })),
  ];
};

type Hunk = {
  start: number;
  end: number;
};

const collectHunks = (ops: DiffOp[], context: number): Hunk[] => {
  const hunks: Hunk[] = [];

  for (const [index, op] of ops.entries()) {
    if (op.kind === "equal") {
      continue;
    }

    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const previous = hunks.at(-1);

    if (previous && start <= previous.end) {
      previous.end = end;
      continue;
    }

    hunks.push({ start, end });
  }

  return hunks;
};

export const buildUnifiedDiff = (
  path: string,
  before: string,
  after: string,
  context = DEFAULT_CONTEXT,
): UnifiedDiff => {
  const beforeText = splitLines(before);
  const afterText = splitLines(after);
  const ops = diffLines(beforeText.lines, afterText.lines);

  const additions = ops.filter((op) => op.kind === "insert").length;
  const deletions = ops.filter((op) => op.kind === "delete").length;

  if (additions === 0 && deletions === 0) {
    return { diff: "", additions: 0, deletions: 0 };
  }

  // Line number each op occupies on its own side, so hunk headers can be
  // written without re-walking the operation list.
  const beforeNumbers: number[] = [];
  const afterNumbers: number[] = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const op of ops) {
    beforeNumbers.push(beforeLine);
    afterNumbers.push(afterLine);

    if (op.kind !== "insert") {
      beforeLine += 1;
    }

    if (op.kind !== "delete") {
      afterLine += 1;
    }
  }

  const lines = [`--- a/${path}`, `+++ b/${path}`];

  for (const hunk of collectHunks(ops, context)) {
    const slice = ops.slice(hunk.start, hunk.end);
    const beforeCount = slice.filter((op) => op.kind !== "insert").length;
    const afterCount = slice.filter((op) => op.kind !== "delete").length;
    const beforeStart =
      beforeCount === 0
        ? beforeNumbers[hunk.start]! - 1
        : beforeNumbers[hunk.start]!;
    const afterStart =
      afterCount === 0
        ? afterNumbers[hunk.start]! - 1
        : afterNumbers[hunk.start]!;

    lines.push(
      `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
    );

    for (const [offset, op] of slice.entries()) {
      const index = hunk.start + offset;

      if (op.kind === "equal") {
        lines.push(` ${op.text}`);
      } else if (op.kind === "delete") {
        lines.push(`-${op.text}`);
      } else {
        lines.push(`+${op.text}`);
      }

      const isLastBeforeLine =
        op.kind !== "insert" &&
        beforeNumbers[index] === beforeText.lines.length;
      const isLastAfterLine =
        op.kind !== "delete" && afterNumbers[index] === afterText.lines.length;

      if (
        (isLastBeforeLine && !beforeText.endsWithNewline) ||
        (isLastAfterLine && !afterText.endsWithNewline)
      ) {
        lines.push(NO_NEWLINE_MARKER);
      }
    }
  }

  return { diff: `${lines.join("\n")}\n`, additions, deletions };
};
