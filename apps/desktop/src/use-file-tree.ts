import { useCallback, useEffect, useState } from "react";

import { bridge, type FileContent, type TreeEntry } from "./bridge.ts";

export type FileTreeState = {
  rootEntries: TreeEntry[];
  rootLoading: boolean;
  rootError: string | null;
  childrenByPath: Record<string, TreeEntry[]>;
  loadingPaths: Set<string>;
  expandedPaths: Set<string>;
  toggleDirectory: (path: string) => void;
  selectedPath: string | null;
  selectFile: (path: string) => void;
  fileContent: FileContent | null;
  fileLoading: boolean;
  fileError: string | null;
};

/**
 * "Caveman mode": browse the open repository, open a file, look at it.
 *
 * Everything here goes through `bridge().fs`, which is only present inside
 * the Electron shell — there is no fallback path for a plain browser tab,
 * the same way the terminal has none. Confinement (repository-relative
 * paths, `.git`/`.env` refused, symlinks resolved) lives host-side in
 * `electron/fs-browser.ts`; this hook trusts what comes back rather than
 * re-checking it, the same way `use-file-changes.ts` trusts the worker's
 * own projection instead of re-deriving it.
 *
 * A directory's children are fetched once, on first expand, and kept —
 * collapsing does not drop the cache, so re-expanding is instant. Nothing
 * here polls: the tree reflects the repository as of whenever a directory
 * was last opened, which is enough for a read-only viewer that is not
 * watching for external changes the way the event-driven hooks are.
 */
export const useFileTree = (repositoryPath: string | null): FileTreeState => {
  const [rootEntries, setRootEntries] = useState<TreeEntry[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, TreeEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // A cached tree from a different repository would show the wrong files
  // under the right-looking names, so every piece of state resets together
  // when the repository this tree is for changes.
  useEffect(() => {
    setRootEntries([]);
    setChildrenByPath({});
    setExpandedPaths(new Set());
    setSelectedPath(null);
    setFileContent(null);
    setFileError(null);
  }, [repositoryPath]);

  useEffect(() => {
    const host = bridge();

    if (!repositoryPath || !host) {
      return;
    }

    let cancelled = false;
    setRootLoading(true);

    void host.fs
      .list(repositoryPath, ".")
      .then((entries) => {
        if (!cancelled) {
          setRootEntries(entries);
          setRootError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRootError((error as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRootLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repositoryPath]);

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpandedPaths((current) => {
        const next = new Set(current);

        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }

        return next;
      });

      const host = bridge();

      if (!repositoryPath || !host || childrenByPath[path] || loadingPaths.has(path)) {
        return;
      }

      setLoadingPaths((current) => new Set(current).add(path));

      void host.fs
        .list(repositoryPath, path)
        .then((entries) => {
          setChildrenByPath((current) => ({ ...current, [path]: entries }));
        })
        .catch(() => {
          // Left un-cached and still collapsible, not surfaced as an error —
          // one unreadable subdirectory (permissions, a race with a delete)
          // is not worth a banner in a tree the rest of which is fine.
        })
        .finally(() => {
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        });
    },
    [repositoryPath, childrenByPath, loadingPaths],
  );

  const selectFile = useCallback(
    (path: string) => {
      const host = bridge();

      if (!repositoryPath || !host) {
        return;
      }

      setSelectedPath(path);
      setFileContent(null);
      setFileLoading(true);
      setFileError(null);

      void host.fs
        .read(repositoryPath, path)
        .then((content) => setFileContent(content))
        .catch((error: unknown) => setFileError((error as Error).message))
        .finally(() => setFileLoading(false));
    },
    [repositoryPath],
  );

  return {
    rootEntries,
    rootLoading,
    rootError,
    childrenByPath,
    loadingPaths,
    expandedPaths,
    toggleDirectory,
    selectedPath,
    selectFile,
    fileContent,
    fileLoading,
    fileError,
  };
};
