/**
 * The tinted extension badge every file row wears (D-048), shared so the All
 * files panel and the composer's @-mention popover (D-185) speak one
 * vocabulary: a file looks like itself everywhere it is offered.
 *
 * Works from the file's name alone, mirroring how the workspace tree derives
 * an extension (workspace-tree.ts): the suffix after the last dot, except a
 * leading dot is part of the name, not an extension — `.gitignore` has none.
 */

/**
 * How a badge is tinted. Not decoration and not a semantic token: a file type
 * is a *fact about a file*, the same way a foreign program's colours in the
 * terminal are facts about that program, and the room says nothing by it
 * (D-048). Kept to the few families a repository actually has, because thirty
 * hues is a paint chart rather than a signal.
 */
export type FileFamily = "code" | "web" | "data" | "doc" | "config" | "asset" | "plain";

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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase().slice(0, 20);
}

/** Dotfiles carry their meaning in the name rather than the extension. */
export function familyOfName(name: string): FileFamily {
  const lower = name.toLowerCase();
  if (lower.startsWith(".env")) return "config";
  if (lower.startsWith(".git")) return "config";
  if (lower === "dockerfile" || lower === "makefile" || lower === "justfile") return "config";
  return FAMILY[extensionOf(lower)] ?? "plain";
}

/** The two-to-four letters a row shows where an icon would be. A glyph set
 *  per language is a maintenance burden and a licence question; the extension
 *  is already the answer and is always right. */
export function badgeOfName(name: string): string {
  const extension = extensionOf(name);
  if (extension !== "") return extension.slice(0, 4);
  return name.replace(/^\./, "").slice(0, 3).toLowerCase();
}

/** The badge for a file, named by its path or bare name. */
export function FileBadge({ path }: { path: string }) {
  const name = path.split("/").pop() ?? path;
  return (
    <span className={`tree-badge family-${familyOfName(name)}`} aria-hidden="true">
      {badgeOfName(name)}
    </span>
  );
}
