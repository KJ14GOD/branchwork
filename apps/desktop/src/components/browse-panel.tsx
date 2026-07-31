import { useMemo } from "react";

import {
  CodeLine,
  HIGHLIGHT_LINE_LIMIT,
  highlightLines,
  languageForPath,
  shouldHighlight,
  type Token,
} from "@novus/ui";

import type { TreeEntry } from "../bridge.ts";
import type { FileTreeState } from "../use-file-tree.ts";

const basename = (path: string): string => path.split("/").at(-1) ?? path;

/**
 * One row of the tree, recursing into its own children when expanded.
 *
 * No file-type icons, deliberately — VS Code ships its Explorer icon-less by
 * default for the same reason this does: a chevron, indentation, and a
 * monospace name is enough to read as a tree, and every mark beyond that on
 * a strictly monochrome palette would have to be conveyed by shape alone,
 * which reads as noise rather than information. Directory-vs-file is the one
 * distinction that earns a glyph (the chevron itself); nothing else does.
 */
const TreeRow = ({
  entry,
  depth,
  state,
}: {
  entry: TreeEntry;
  depth: number;
  state: FileTreeState;
}) => {
  const isDirectory = entry.kind === "directory";
  const expanded = isDirectory && state.expandedPaths.has(entry.path);
  const selected = state.selectedPath === entry.path;
  const loading = isDirectory && state.loadingPaths.has(entry.path);
  const children = state.childrenByPath[entry.path];

  return (
    <>
      <button
        type="button"
        className={`tree__row${selected ? " tree__row--selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() =>
          isDirectory ? state.toggleDirectory(entry.path) : state.selectFile(entry.path)
        }
        title={entry.path}
      >
        <span className="tree__chevron">{isDirectory ? (expanded ? "▾" : "▸") : ""}</span>
        <span className="tree__name">{entry.name}</span>
        {loading ? <span className="tree__loading">…</span> : null}
      </button>
      {isDirectory && expanded && children
        ? children.map((child) => (
            <TreeRow key={child.path} entry={child} depth={depth + 1} state={state} />
          ))
        : null}
    </>
  );
};

export const FileTree = ({ state }: { state: FileTreeState }) => (
  <aside className="tree">
    <div className="tree__head">
      <span className="eyebrow">Files</span>
    </div>
    {state.rootError ? (
      <div className="files__empty files__empty--error">{state.rootError}</div>
    ) : state.rootLoading && state.rootEntries.length === 0 ? (
      <div className="files__empty">Reading…</div>
    ) : state.rootEntries.length === 0 ? (
      <div className="files__empty">Empty repository</div>
    ) : (
      <div className="tree__body">
        {state.rootEntries.map((entry) => (
          <TreeRow key={entry.path} entry={entry} depth={0} state={state} />
        ))}
      </div>
    )}
  </aside>
);

type ViewerBody =
  | { mode: "plain"; text: string; reason: string | null }
  | { mode: "code"; lines: string[]; tokens: Token[][] };

/**
 * The file's content, tokenized once per file.
 *
 * Synchronous rather than scheduled, and that is a measurement rather than a
 * shrug: `HIGHLIGHT_LINE_LIMIT` in `packages/ui/src/code-view.tsx` carries the
 * numbers this repository's own files produce — about 1-2ms per thousand lines,
 * so the cap costs ~8ms worst case, well inside one frame. Past the cap, or
 * for a format with no grammar, the file renders as a single `<pre>` text node
 * exactly as it did before highlighting existed, and the viewer says which of
 * the two it did rather than silently showing grey text.
 */
const useViewerBody = (path: string | null, content: string): ViewerBody =>
  useMemo(() => {
    const language = path === null ? null : languageForPath(path);

    if (language === null) {
      return { mode: "plain", text: content, reason: null };
    }

    const lines = content.split("\n");

    if (!shouldHighlight(content, lines.length)) {
      return {
        mode: "plain",
        text: content,
        reason: `Shown without highlighting — ${lines.length.toLocaleString()} lines is past the ${HIGHLIGHT_LINE_LIMIT.toLocaleString()}-line limit this viewer paints.`,
      };
    }

    return { mode: "code", lines, tokens: highlightLines(lines, language) };
  }, [path, content]);

const FileBody = ({
  path,
  content,
  truncated,
}: {
  path: string;
  content: string;
  truncated: boolean;
}) => {
  const body = useViewerBody(path, content);
  const tail = truncated
    ? "\n… truncated, file is larger than this viewer shows"
    : "";

  if (body.mode === "plain") {
    return (
      <>
        {body.reason ? <div className="viewer__note">{body.reason}</div> : null}
        <pre className="viewer__content">
          {body.text}
          {tail}
        </pre>
      </>
    );
  }

  return (
    <pre className="viewer__content viewer__content--code">
      {body.lines.map((line, index) => (
        <span className="code__line" key={index}>
          <span className="code__num">{index + 1}</span>
          <span className="code__text">
            <CodeLine text={line} tokens={body.tokens[index] ?? []} />
          </span>
        </span>
      ))}
      {truncated ? <span className="viewer__note">{tail.trim()}</span> : null}
    </pre>
  );
};

export const FileViewer = ({ state }: { state: FileTreeState }) => {
  if (!state.selectedPath) {
    return (
      <div className="viewer viewer--empty">
        <div className="empty">
          <p className="empty__title">Nothing open</p>
          <p className="empty__hint">
            Pick a file on the left to read it. This is a viewer — nothing here
            edits the repository.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer__head">
        <span className="viewer__path" title={state.selectedPath}>
          {basename(state.selectedPath)}
        </span>
        <span className="viewer__dir">{state.selectedPath}</span>
      </div>
      {state.fileError ? (
        <div className="files__empty files__empty--error">{state.fileError}</div>
      ) : state.fileLoading ? (
        <div className="files__empty">Reading…</div>
      ) : state.fileContent?.kind === "binary" ? (
        <div className="files__empty">Binary file — not shown.</div>
      ) : state.fileContent?.kind === "text" ? (
        <FileBody
          path={state.selectedPath}
          content={state.fileContent.content}
          truncated={state.fileContent.truncated}
        />
      ) : null}
    </div>
  );
};
