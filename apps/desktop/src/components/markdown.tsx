import type { ReactNode } from "react";

/**
 * Markdown rendered to React elements, deliberately without producing HTML
 * (D-048).
 *
 * The safety property is the whole reason this exists rather than a dependency.
 * A README is repository content — anyone who can push can write it, and a
 * harness turn can write it without a human reading it first. Rendering that
 * through `dangerouslySetInnerHTML` would put attacker-authored markup in a
 * window that holds `window.novus`, and the content-security policy does not
 * help: the bridge is same-origin script the page is allowed to run. So nothing
 * here ever builds a markup string. Text becomes elements, and an element can
 * only ever be what this file names.
 *
 * The subset is what a project's own documentation actually uses. Anything
 * outside it renders as its own source text, which is honest — the reader sees
 * exactly what is in the file rather than a silently dropped line.
 */

/** Inline emphasis, code, and links, without a regex that can backtrack. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buffer = "";
  let index = 0;
  let piece = 0;

  const flush = (): void => {
    if (buffer !== "") {
      out.push(buffer);
      buffer = "";
    }
  };
  const push = (node: ReactNode): void => {
    flush();
    piece += 1;
    out.push(<span key={`${key}-${piece}`}>{node}</span>);
  };

  while (index < text.length) {
    const rest = text.slice(index);

    const code = /^`([^`]+)`/.exec(rest);
    if (code?.[1] !== undefined) {
      push(<code className="md-code">{code[1]}</code>);
      index += code[0].length;
      continue;
    }
    const strong = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strong?.[1] !== undefined) {
      push(<strong>{strong[1]}</strong>);
      index += strong[0].length;
      continue;
    }
    const emphasis = /^(?:\*([^*\n]+)\*|_([^_\n]+)_)/.exec(rest);
    if (emphasis) {
      push(<em>{emphasis[1] ?? emphasis[2]}</em>);
      index += emphasis[0].length;
      continue;
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link?.[1] !== undefined && link[2] !== undefined) {
      // Rendered as text carrying its destination, never as something that
      // navigates: a link in repository content is somebody else's URL, and
      // this pane is not the place to follow one.
      push(
        <span className="md-link" title={link[2]}>
          {link[1] === "" ? link[2] : link[1]}
        </span>
      );
      index += link[0].length;
      continue;
    }

    buffer += text[index];
    index += 1;
  }
  flush();
  return out;
}

interface Block {
  kind: "heading" | "paragraph" | "code" | "list" | "quote" | "rule";
  level?: number;
  language?: string;
  lines: string[];
  ordered?: boolean;
}

/** Line-at-a-time, because a document is a sequence of blocks and treating it
 *  as one string is what makes markdown parsers quadratic. */
function blocksOf(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // the closing fence, or the end of the file
      blocks.push({ kind: "code", language: fence[1] ?? "", lines: body });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2] ?? ""] });
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: "rule", lines: [] });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        body.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    const bullet = /^\s*([-*+]|\d+\.)\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1] ?? "");
      const body: string[] = [];
      while (index < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[index] ?? "")) {
        body.push((lines[index] ?? "").replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, lines: body });
      continue;
    }

    const body: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^(?:#{1,6}\s|```|\s*>|\s*(?:[-*+]|\d+\.)\s)/.test(lines[index] ?? "")
    ) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: body });
  }

  return blocks;
}

export function Markdown({ source }: { source: string }) {
  const blocks = blocksOf(source);
  return (
    <div className="md" data-testid="markdown">
      {blocks.map((block, position) => {
        const key = `b${position}`;
        switch (block.kind) {
          case "heading": {
            const level = Math.min(block.level ?? 1, 6);
            const text = inline(block.lines[0] ?? "", key);
            if (level === 1) return <h1 key={key} className="md-h1">{text}</h1>;
            if (level === 2) return <h2 key={key} className="md-h2">{text}</h2>;
            if (level === 3) return <h3 key={key} className="md-h3">{text}</h3>;
            return <h4 key={key} className="md-h4">{text}</h4>;
          }
          case "code":
            return (
              <pre key={key} className="md-pre mono" data-language={block.language}>
                {block.lines.join("\n")}
              </pre>
            );
          case "rule":
            return <hr key={key} className="md-rule" />;
          case "quote":
            return (
              <blockquote key={key} className="md-quote">
                {inline(block.lines.join(" "), key)}
              </blockquote>
            );
          case "list":
            return block.ordered ? (
              <ol key={key} className="md-list">
                {block.lines.map((item, at) => (
                  <li key={`${key}-${at}`}>{inline(item, `${key}-${at}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="md-list">
                {block.lines.map((item, at) => (
                  <li key={`${key}-${at}`}>{inline(item, `${key}-${at}`)}</li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={key} className="md-p">
                {inline(block.lines.join(" "), key)}
              </p>
            );
        }
      })}
    </div>
  );
}
