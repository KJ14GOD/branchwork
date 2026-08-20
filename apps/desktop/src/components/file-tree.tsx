import { useCallback, useEffect, useState } from "react";
import type { WorkspaceEntry } from "@novus/contracts";
import { novus } from "../bridge";
import { FileBadge } from "./file-badge";

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

/** A search hit as a row. The search returns file paths; the badge and the
 *  open handler need the same shape a directory listing produces. */
function fileEntry(path: string): WorkspaceEntry {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    kind: "file",
    extension: dot <= 0 ? "" : name.slice(dot + 1).toLowerCase().slice(0, 20)
  };
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
      {entry.kind === "directory" ? <FolderGlyph open={expanded} /> : <FileBadge path={entry.name} />}
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
  /** Every file in the worktree, fetched once when the tree mounts, so each
   *  keystroke in the filter box narrows a list already in memory instead of
   *  asking the machine again — typing filters instantly. */
  const [census, setCensus] = useState<WorkspaceEntry[] | null>(null);

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

  // The filter searches the worktree itself, through the same bridge the
  // composer's mention uses (D-185): what a person can find must not depend on
  // which folders they happen to have disclosed. Fetched whole and up front
  // rather than queried per keystroke — the round trip made typing lag.
  useEffect(() => {
    let stale = false;
    void (async () => {
      const result = await novus().workspace.searchFiles({
        missionId,
        ...(workstreamId ? { workstreamId } : {}),
        query: "",
        limit: 20_000
      });
      if (!stale && result.ok) setCensus(result.value.map(fileEntry));
    })();
    return () => {
      stale = true;
    };
  }, [missionId, workstreamId]);

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

  /* With text in the box the list is search results, flat: rows already
     loaded that match, then every match the worktree search found beyond
     them. Depth is dropped because a result's parents may not be rows at
     all — indentation against absent parents reads as broken, not as a tree. */
  const needle = filter.trim().toLowerCase();
  const loadedMatches = rows.filter((row) => row.entry.path.toLowerCase().includes(needle));
  const already = new Set(loadedMatches.map((row) => row.entry.path));
  const shown: { entry: WorkspaceEntry; depth: number }[] =
    needle === ""
      ? rows
      : [
          ...loadedMatches.map((row) => ({ entry: row.entry, depth: 0 })),
          ...(census ?? [])
            .filter((entry) => entry.path.toLowerCase().includes(needle) && !already.has(entry.path))
            .slice(0, 200)
            .map((entry) => ({ entry, depth: 0 }))
        ];

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
