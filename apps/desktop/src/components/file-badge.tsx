import {
  siCss,
  siDocker,
  siGit,
  siGnubash,
  siGo,
  siHtml5,
  siJavascript,
  siJson,
  siMarkdown,
  siPython,
  siReact,
  siRuby,
  siRust,
  siSvelte,
  siSvg,
  siToml,
  siTypescript,
  siVuedotjs,
  siYaml,
  type SimpleIcon
} from "simple-icons";

/**
 * The mark every file row wears (D-048, restyled D-197), shared so the All
 * files panel, the composer's @-mention popover, and the pinned file chip
 * (D-182, D-185) speak one vocabulary: a file looks like itself wherever it is
 * offered.
 *
 * A language's own mark, where the sanctioned brand-icon set has one (D-029) —
 * a Python file is the Python mark in Python's blue, the way it is in every
 * tool a person has ever used, which is a fact about the file and not
 * something Novus is saying. Where no brand owns the type, a plain stroke
 * glyph carries the file's family in the terminal palette instead.
 *
 * Works from the file's name alone, mirroring how the workspace tree derives
 * an extension (workspace-tree.ts): the suffix after the last dot, except a
 * leading dot is part of the name, not an extension — `.gitignore` has none.
 */

/**
 * The family a nameless type falls back to. Not decoration and not a semantic
 * token: a file type is a *fact about a file*, the same way a foreign
 * program's colours in the terminal are facts about that program (D-048).
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

/** The types a brand owns. Only marks a person already reads as that language:
 *  an invented glyph per extension is the maintenance burden D-048 refused. */
const BRAND: Record<string, SimpleIcon> = {
  py: siPython,
  js: siJavascript, mjs: siJavascript, cjs: siJavascript,
  ts: siTypescript,
  tsx: siReact, jsx: siReact,
  rb: siRuby,
  rs: siRust,
  go: siGo,
  sh: siGnubash, bash: siGnubash, zsh: siGnubash,
  html: siHtml5,
  css: siCss, scss: siCss,
  vue: siVuedotjs,
  svelte: siSvelte,
  json: siJson,
  yaml: siYaml, yml: siYaml,
  toml: siToml,
  md: siMarkdown, mdx: siMarkdown,
  svg: siSvg
};

/** Brands whose own colour is black: unreadable on a dark room and a muddy
 *  smudge on a light one, so these wear the room's own ink instead. */
const INK = new Set(["md", "mdx", "json", "rs"]);

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

/** The brand that owns this file's type, or null where none does. Named files
 *  answer before extensions do: `.gitignore` is git's, whatever it ends in. */
function brandOf(name: string): { icon: SimpleIcon; ink: boolean } | null {
  const lower = name.toLowerCase();
  if (lower.startsWith(".git")) return { icon: siGit, ink: false };
  if (lower === "dockerfile") return { icon: siDocker, ink: false };
  const extension = extensionOf(lower);
  const icon = BRAND[extension];
  return icon ? { icon, ink: INK.has(extension) } : null;
}

/** The stroke glyphs for types no brand owns — one per family, so a row still
 *  says what kind of thing it is rather than showing a blank slot. */
const GLYPH: Record<FileFamily, string> = {
  // A page with a folded corner.
  doc: "M4 2h5l3 3v9H4zM9 2v3h3",
  plain: "M4 2h5l3 3v9H4zM9 2v3h3",
  // Structured text is braces.
  data: "M6.5 2.5C5 2.5 5 5 5 5s0 3-1.5 3C5 8 5 11 5 11s0 2.5 1.5 2.5M9.5 2.5C11 2.5 11 5 11 5s0 3 1.5 3C11 8 11 11 11 11s0 2.5-1.5 2.5",
  // Settings are the gear's simplest honest form.
  config: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4",
  // A picture in its frame.
  asset: "M2.5 3.5h11v9h-11zM2.5 10l3-3 2.5 2.5 2-2 3.5 3.5M10.5 6a.6.6 0 1 0 0-.01",
  // Code is the angle brackets it is always written in.
  code: "M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5",
  // The web's own shape.
  web: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M1.5 8h13M8 1.5c1.8 1.9 2.7 4.1 2.7 6.5S9.8 12.6 8 14.5c-1.8-1.9-2.7-4.1-2.7-6.5S6.2 3.4 8 1.5"
};

/**
 * The mark for a file, named by its path or bare name. A brand's mark wears
 * the brand's own colour, taken from the icon set rather than written here —
 * DESIGN.md's no-local-values rule is about Novus's palette, and a language's
 * colour is not Novus's to choose.
 */
export function FileBadge({ path }: { path: string }) {
  const name = path.split("/").pop() ?? path;
  const brand = brandOf(name);

  if (brand && !brand.ink) {
    return (
      <svg
        className="file-mark"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill={`#${brand.icon.hex}`}
        aria-hidden="true"
      >
        <path d={brand.icon.path} />
      </svg>
    );
  }

  if (brand) {
    return (
      <svg className="file-mark ink" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
        <path d={brand.icon.path} />
      </svg>
    );
  }

  const family = familyOfName(name);
  return (
    <svg
      className={`file-mark family-${family}`}
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPH[family]} />
    </svg>
  );
}
