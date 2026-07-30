import { isAbsolute, relative, resolve, sep, basename } from "node:path";
import { open, readdir, realpath } from "node:fs/promises";

/**
 * The host-side directory tree and file viewer's own filesystem access —
 * "caveman mode," in the vocabulary the person who asked for this used.
 *
 * This is a second, independent implementation of the same confinement
 * `resolveInsideRepository`/`isProtectedPath` give `apps/worker/src/tools.ts`,
 * not an import of it: the two apps do not share a package for this today,
 * and this file exists specifically because Electron's main process is a
 * second place with real filesystem access that a compromised renderer could
 * try to walk out of, the same way a model's tool call could. Confinement
 * that only exists once, in the agent's own tools, would leave this path
 * unguarded — a human browsing files is not a new capability for the agent,
 * but the IPC handler itself is new surface, so it gets the same rules:
 * repository-relative paths only, resolved through realpath so a symlink
 * cannot point out, and .git/.env* refused outright.
 */

export type TreeEntry = {
  name: string;
  /** Repository-relative, forward-slash, never the host's absolute path. */
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
};

export type FileContent =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "binary" };

// A viewer, not an editor and not the agent's own read_file — this cap exists
// only so a stray multi-gigabyte fixture in a repository cannot freeze the
// renderer painting it. Well past anything a person actually reads.
const MAX_READ_BYTES = 2_000_000;
const BINARY_SNIFF_BYTES = 8_000;

const isOutside = (root: string, target: string): boolean => {
  const pathFromRoot = relative(root, target);

  return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
};

const isProtectedPath = (repositoryRoot: string, targetPath: string): boolean => {
  const pathFromRoot = relative(repositoryRoot, targetPath);
  const segments = pathFromRoot.split(sep);
  const fileName = basename(targetPath);
  const isEnvironmentFile =
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example");

  return segments.includes(".git") || isEnvironmentFile;
};

/**
 * Resolves a repository-relative path to a real, confined, on-disk path.
 *
 * Mirrors `resolveInsideRepository` in `apps/worker/src/tools.ts` — same
 * three checks, same order: reject an absolute request outright, resolve
 * through `realpath` so a symlink cannot point outside the repository, then
 * refuse `.git` and `.env*` regardless of how the path got there.
 */
export const resolveInTree = async (
  repositoryPath: string,
  requestedPath: string,
): Promise<{ repositoryRoot: string; targetPath: string }> => {
  if (isAbsolute(requestedPath)) {
    throw new Error("The file browser only accepts repository-relative paths.");
  }

  const repositoryRoot = await realpath(repositoryPath);
  const unresolvedPath = resolve(repositoryRoot, requestedPath);

  if (isOutside(repositoryRoot, unresolvedPath)) {
    throw new Error("The file browser cannot reach paths outside the repository.");
  }

  const targetPath = await realpath(unresolvedPath);

  if (isOutside(repositoryRoot, targetPath)) {
    throw new Error("The file browser cannot reach paths outside the repository.");
  }

  if (isProtectedPath(repositoryRoot, targetPath)) {
    throw new Error("The file browser cannot open protected repository paths.");
  }

  return { repositoryRoot, targetPath };
};

const toPosixPath = (path: string): string => path.split(sep).join("/");

/**
 * One directory's immediate children — not a recursive walk. The tree
 * expands lazily from the renderer, one click at a time, the same way
 * `list_directory` hands the agent one level rather than the whole
 * repository; a monorepo's `node_modules` makes a recursive listing
 * pointless to compute and worse to render.
 */
export const listDirectory = async (
  repositoryPath: string,
  relativePath: string,
): Promise<TreeEntry[]> => {
  const { repositoryRoot, targetPath } = await resolveInTree(
    repositoryPath,
    relativePath,
  );

  const found = await readdir(targetPath, { withFileTypes: true });

  const entries = found
    .filter((entry) => !isProtectedPath(repositoryRoot, resolve(targetPath, entry.name)))
    .map((entry): TreeEntry => ({
      name: entry.name,
      path: toPosixPath(relative(repositoryRoot, resolve(targetPath, entry.name))),
      kind: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : entry.isFile()
            ? "file"
            : "other",
    }));

  // Directories first, then alphabetical within each — the ordering every
  // tree in the research (VS Code, Zed) uses, and the one thing a flat
  // `<ul>` of `readdir`'s own order gets visibly wrong.
  entries.sort((a, b) => {
    if (a.kind === "directory" && b.kind !== "directory") return -1;
    if (a.kind !== "directory" && b.kind === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
};

/** A best-effort sniff, not a MIME check: any NUL in the sample means binary. */
const looksBinary = (sample: Buffer): boolean => sample.includes(0);

export const readFileForViewer = async (
  repositoryPath: string,
  relativePath: string,
): Promise<FileContent> => {
  const { targetPath } = await resolveInTree(repositoryPath, relativePath);

  const handle = await open(targetPath, "r");

  try {
    const { size } = await handle.stat();

    const sniffLength = Math.min(size, BINARY_SNIFF_BYTES);
    const sniff = Buffer.alloc(sniffLength);
    await handle.read(sniff, 0, sniffLength, 0);

    if (looksBinary(sniff)) {
      return { kind: "binary" };
    }

    if (size > MAX_READ_BYTES) {
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      await handle.read(buffer, 0, MAX_READ_BYTES, 0);

      return { kind: "text", content: buffer.toString("utf8"), truncated: true };
    }

    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);

    return { kind: "text", content: buffer.toString("utf8"), truncated: false };
  } finally {
    await handle.close();
  }
};
