type DiffLineKind = "meta" | "hunk" | "context" | "add" | "del";

type DiffLine = {
  kind: DiffLineKind;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};

const HUNK_PATTERN = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/;

export const parseUnifiedDiff = (diff: string): DiffLine[] => {
  const lines: DiffLine[] = [];
  let beforeLine = 0;
  let afterLine = 0;

  for (const raw of diff.split("\n")) {
    if (raw === "") {
      continue;
    }

    const hunk = HUNK_PATTERN.exec(raw);

    if (hunk) {
      beforeLine = Number(hunk[1]);
      afterLine = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw, beforeLine: null, afterLine: null });
      continue;
    }

    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("\\")) {
      lines.push({ kind: "meta", text: raw, beforeLine: null, afterLine: null });
      continue;
    }

    if (raw.startsWith("+")) {
      lines.push({
        kind: "add",
        text: raw.slice(1),
        beforeLine: null,
        afterLine: afterLine,
      });
      afterLine += 1;
      continue;
    }

    if (raw.startsWith("-")) {
      lines.push({
        kind: "del",
        text: raw.slice(1),
        beforeLine: beforeLine,
        afterLine: null,
      });
      beforeLine += 1;
      continue;
    }

    // Only a line that opens with a space is context, and only context carries
    // a leading marker worth stripping. Everything else here is a header —
    // `diff --git a/x b/x`, `index abc..def`, `new file mode` — and treating it
    // as context both ate its first character and advanced the line numbers for
    // a line that is not part of the file.
    if (!raw.startsWith(" ")) {
      lines.push({ kind: "meta", text: raw, beforeLine: null, afterLine: null });
      continue;
    }

    lines.push({
      kind: "context",
      text: raw.slice(1),
      beforeLine: beforeLine,
      afterLine: afterLine,
    });
    beforeLine += 1;
    afterLine += 1;
  }

  return lines;
};

export type PatchProposalView = {
  path: string;
  intent: string;
  status: string;
  diff: string;
  additions: number;
  deletions: number;
};

export const DiffView = ({ patch }: { patch: PatchProposalView }) => {
  const lines = parseUnifiedDiff(patch.diff);

  return (
    <div className="patch">
      <div className="patch__head">
        <span className="patch__path">{patch.path}</span>
        <span className="patch__count patch__count--add">
          +{patch.additions}
        </span>
        <span className="patch__count patch__count--del">
          −{patch.deletions}
        </span>
        <span className="patch__badge">{patch.status}</span>
      </div>
      <div className="patch__intent">{patch.intent}</div>
      <div className="diff">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`diff__line diff__line--${line.kind === "context" ? "context" : line.kind}`}
          >
            <span className="diff__num">{line.beforeLine ?? ""}</span>
            <span className="diff__num">{line.afterLine ?? ""}</span>
            <span className="diff__text">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
