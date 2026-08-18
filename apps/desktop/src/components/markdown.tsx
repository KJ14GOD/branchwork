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
 * The subset is what a project's own documentation actually uses — headings,
 * lists (nested, ordered from any start, task items), tables, quotes, fences,
 * rules, and the inline set. Anything outside it renders as its own source
 * text, which is honest — the reader sees exactly what is in the file rather
 * than a silently dropped line.
 */

/** Inline emphasis, code, strikethrough, and links, without a regex that can
 *  backtrack. */
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
    const strike = /^~~([^~\n]+)~~/.exec(rest);
    if (strike?.[1] !== undefined) {
      push(<del>{strike[1]}</del>);
      index += strike[0].length;
      continue;
    }
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^")]*")?\)/.exec(rest);
    if (link?.[1] !== undefined && link[2] !== undefined) {
      // Rendered as text carrying its destination, never as something that
      // navigates: a link in repository content is somebody else's URL, and
      // this pane is not the place to follow one. A quoted title in the
      // source is tolerated and dropped — the destination is the truth shown.
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

interface ListItem {
  text: string;
  /** null: an ordinary item; true/false: a task item with its checked state. */
  done: boolean | null;
  child: ListGroup | null;
}

interface ListGroup {
  ordered: boolean;
  /** The number the source starts at, so a list continued from prose keeps it. */
  start: number;
  items: ListItem[];
}

interface Block {
  kind: "heading" | "paragraph" | "code" | "list" | "quote" | "rule" | "table";
  level?: number;
  language?: string;
  lines: string[];
  list?: ListGroup;
  header?: string[];
  rows?: string[][];
}

const LIST_LINE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

/** Contiguous list lines into a tree, depth read from indentation — two
 *  spaces (or a tab) per level, which is what hand-written READMEs use. */
function listOf(lines: string[]): ListGroup {
  const groups: ListGroup[] = [];
  for (const line of lines) {
    const match = LIST_LINE.exec(line);
    if (!match) continue;
    const depth = Math.floor((match[1] ?? "").replace(/\t/g, "  ").length / 2);
    const marker = match[2] ?? "-";
    const ordered = /\d/.test(marker);
    let text = match[3] ?? "";
    let done: boolean | null = null;
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
    if (task) {
      done = task[1] !== " ";
      text = task[2] ?? "";
    }
    while (groups.length > depth + 1) groups.pop();
    if (groups.length === depth && depth > 0) {
      // A jump of more than one level lands on the deepest list that exists.
    }
    if (groups.length <= depth) {
      const start = ordered ? Number.parseInt(marker, 10) || 1 : 1;
      const group: ListGroup = { ordered, start, items: [] };
      if (groups.length === 0) {
        groups.push(group);
      } else {
        const parent = groups[groups.length - 1];
        const holder = parent?.items[parent.items.length - 1];
        if (holder) holder.child = group;
        groups.push(group);
      }
    }
    const group = groups[groups.length - 1];
    group?.items.push({ text, done, child: null });
  }
  return groups[0] ?? { ordered: false, start: 1, items: [] };
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
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

    // Up to three leading spaces, which markdown allows and people type.
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
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

    // A pipe row followed by a divider row is a table; anything else with
    // pipes is just prose and falls through.
    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      const header = cellsOf(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(cellsOf(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "table", lines: [], header, rows });
      continue;
    }

    if (LIST_LINE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && LIST_LINE.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", lines: body, list: listOf(body) });
      continue;
    }

    const body: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^ {0,3}#{1,6}\s/.test(lines[index] ?? "") &&
      !/^(?:```|\s*>)/.test(lines[index] ?? "") &&
      !LIST_LINE.test(lines[index] ?? "")
    ) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: body });
  }

  return blocks;
}

function ListView({ group, path }: { group: ListGroup; path: string }) {
  const items = group.items.map((item, at) => (
    <li key={`${path}-${at}`}>
      {item.done !== null && (
        <span className="md-task" data-done={item.done ? "true" : "false"} aria-hidden="true" />
      )}
      {inline(item.text, `${path}-${at}`)}
      {item.child && <ListView group={item.child} path={`${path}-${at}`} />}
    </li>
  ));
  return group.ordered ? (
    <ol className="md-list" {...(group.start !== 1 ? { start: group.start } : {})}>
      {items}
    </ol>
  ) : (
    <ul className="md-list">{items}</ul>
  );
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
          case "table":
            return (
              <div key={key} className="md-table-scroll">
                <table className="md-table">
                  <thead>
                    <tr>
                      {(block.header ?? []).map((cell, at) => (
                        <th key={`${key}-h${at}`}>{inline(cell, `${key}-h${at}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, atRow) => (
                      <tr key={`${key}-r${atRow}`}>
                        {row.map((cell, at) => (
                          <td key={`${key}-r${atRow}-${at}`}>{inline(cell, `${key}-r${atRow}-${at}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list":
            return <ListView key={key} group={block.list ?? { ordered: false, start: 1, items: [] }} path={key} />;
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
