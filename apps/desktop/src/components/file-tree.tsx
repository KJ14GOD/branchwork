import { useCallback, useEffect, useState } from "react";
import type { WorkspaceEntry } from "@novus/contracts";
import { novus } from "../bridge";

/**
 * The workspace's files, in the evidence panel (D-048).
 *
 * Files are not the window's subject — the mission is, and a file tree as the
 * main event is the generic-IDE shape PRODUCT.md refuses. So this lives in the
 * panel beside the work, and opening a file is a deliberate act that takes the
 * canvas for as long as the reader wants it.
 *
 * Folders disclose in place rather than navigating, because a person reading a
 * project wants to see where a file sits, not to walk a path one level at a
 * time and lose the shape.
 */

/**
 * How a row is tinted. Not decoration and not a semantic token: a file type is
 * a *fact about a file*, the same way a foreign program's colours in the
 * terminal are facts about that program, and the room says nothing by it
 * (D-048). Kept to the few families a repository actually has, because thirty
 * hues is a paint chart rather than a signal.
 */
type FileFamily = "code" | "web" | "data" | "doc" | "config" | "asset" | "plain";

const FAMILY: Record<string, FileFamily> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", rb: "code", go: "code", rs: "code", java: "code", kt: "code",
  swift: "code", c: "code", h: "code", cc: "code", cpp: "code", hpp: "code",
  sh: "code", bash: "code", zsh: "code", sql: "code", php: "code",
  html: "web", css: "web", scss: "web", vue: "web", svelte: "web",
  json: "data", yaml: "data", yml: "data", toml: "data", xml: "data",
  csv: "data", lock: "data",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc", adoc: "doc",
  env: "config", ini: "config", cfg: "config", conf: "config", properties: "config",
  png: "asset", jpg: "asset", jpeg: "asset", gif: "asset", svg: "asset",
  webp: "asset", ico: "asset", pdf: "asset", woff: "asset", woff2: "asset"
};

/** Dotfiles carry their meaning in the name rather than the extension. */
function familyOf(entry: WorkspaceEntry): FileFamily {
  if (entry.kind === "directory") return "plain";
  const name = entry.name.toLowerCase();
  if (name.startsWith(".env")) return "config";
  if (name.startsWith(".git")) return "config";
  if (name === "dockerfile" || name === "makefile" || name === "justfile") return "config";
  return FAMILY[entry.extension] ?? "plain";
}

/** The two-or-three letters a row shows where an icon would be. A glyph set
 *  per language is a maintenance burden and a licence question; the extension
 *  is already the answer and is always right. */
function badgeOf(entry: WorkspaceEntry): string {
  if (entry.kind === "directory") return "";
  if (entry.extension !== "") return entry.extension.slice(0, 4);
  const name = entry.name.replace(/^\./, "");
  return name.slice(0, 3).toLowerCase();
}

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "tree-folder open" : "tree-folder"}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function Row({
  entry,
  depth,
  expanded,
  selected,
  onOpen
}: {
  entry: WorkspaceEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onOpen: (entry: WorkspaceEntry) => void;
}) {
  const family = familyOf(entry);
  return (
    <button
      className={selected ? "tree-row selected" : "tree-row"}
      style={{ paddingLeft: `calc(var(--s-3) + ${depth} * var(--s-4))` }}
      onClick={() => onOpen(entry)}
      title={entry.path}
      data-testid="tree-row"
      data-kind={entry.kind}
      data-path={entry.path}
    >
      {entry.kind === "directory" ? (
        <FolderGlyph open={expanded} />
      ) : (
        <span className={`tree-badge family-${family}`} aria-hidden="true">
          {badgeOf(entry)}
        </span>
      )}
      <span className="tree-name">{entry.name}</span>
    </button>
  );
}

export function FileTree({
  missionId,
  workstreamId,
  openPath,
  onOpenFile
}: {
  missionId: string;
  /** The lane whose worktree is listed — the room's active approach (D-080). */
  workstreamId?: string;
  /** The file currently taking the canvas, so the tree can mark it. */
  openPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [levels, setLevels] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(
    async (path: string) => {
      const result = await novus().workspace.listFiles({
        missionId,
        ...(workstreamId ? { workstreamId } : {}),
        path: path === "" ? undefined : path
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setLevels((previous) => ({ ...previous, [path]: result.value }));
    },
    [missionId, workstreamId]
  );

  useEffect(() => {
    setLevels({});
    setExpanded(new Set());
    void load("");
  }, [load]);

  const open = (entry: WorkspaceEntry) => {
    if (entry.kind === "file") {
      onOpenFile(entry.path);
      return;
    }
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(entry.path)) next.delete(entry.path);
      else {
        next.add(entry.path);
        if (levels[entry.path] === undefined) void load(entry.path);
      }
      return next;
    });
  };

  /** Depth-first, so a disclosed folder's contents sit under it rather than in
   *  a second pane the reader has to hold in their head. */
  const rows: { entry: WorkspaceEntry; depth: number }[] = [];
  const walk = (path: string, depth: number): void => {
    for (const entry of levels[path] ?? []) {
      rows.push({ entry, depth });
      if (entry.kind === "directory" && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);

  if (error !== null) {
    return (
      <p className="inline-error" role="alert" data-testid="tree-error">
        {error}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="quiet" data-testid="tree-empty">
        Reading the workspace…
      </p>
    );
  }

  /* Filtering, not searching a repository: it narrows what is already open, so
     a folder whose name matches keeps its children and a file matches on its
     path. Anything deeper needs the worktree indexed, which is a bigger thing
     than a box above a list (D-066). */
  const needle = filter.trim().toLowerCase();
  const shown = needle === "" ? rows : rows.filter((row) => row.entry.path.toLowerCase().includes(needle));

  return (
    <>
      <div className="tree-filter">
        <input
          className="input input-inline"
          value={filter}
          placeholder="Filter files"
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter workspace files"
          data-testid="tree-filter"
        />
      </div>
      {needle !== "" && shown.length === 0 && (
        <p className="quiet" data-testid="tree-no-match">
          Nothing here matches “{filter.trim()}”.
        </p>
      )}
    <div className="tree" role="tree" aria-label="Workspace files" data-testid="file-tree">
      {shown.map(({ entry, depth }) => (
        <Row
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={expanded.has(entry.path)}
          selected={entry.path === openPath}
          onOpen={open}
        />
      ))}
    </div>
    </>
  );
}
