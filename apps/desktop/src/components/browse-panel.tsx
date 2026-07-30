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
      <span className="rail__label">Files</span>
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

export const FileViewer = ({ state }: { state: FileTreeState }) => {
  if (!state.selectedPath) {
    return (
      <div className="viewer viewer--empty">
        <p className="viewer__hint">Select a file on the left to look at it.</p>
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
        <pre className="viewer__content">
          {state.fileContent.content}
          {state.fileContent.truncated ? "\n… truncated, file is larger than this viewer shows" : ""}
        </pre>
      ) : null}
    </div>
  );
};
