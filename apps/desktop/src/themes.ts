/**
 * Custom themes (D-254): a theme is a name, a base — dark or light, whose
 * tokens it starts from — and overrides for some of the colour tokens. It
 * is one JSON file a person can write, import, export and share, the way
 * VS Code's and Cursor's are, and it never touches spacing, type, radii or
 * motion: those are the product's own and the reason a theme still reads
 * as Novus. Everything here is machine-local (localStorage); the main
 * process only opens and saves the file on request.
 */

/** The tokens a theme may set — exactly the colour tokens the light theme
 *  overrides in tokens.css, so a theme can go anywhere light went. */
export const THEME_TOKENS = [
  "--bg",
  "--surface-1",
  "--surface-2",
  "--edge",
  "--edge-strong",
  "--edge-selected",
  "--edge-hover",
  "--text-1",
  "--text-2",
  "--text-3",
  "--accent",
  "--accent-pressed",
  "--ok",
  "--warn",
  "--danger",
  "--lane-current",
  "--lane-alt",
  "--diff-add",
  "--diff-del",
  "--hover",
  "--selected",
  "--pressed",
  "--term-bg",
  "--term-fg",
  "--term-cursor",
  "--term-cursor-text",
  "--term-selection",
  "--term-black",
  "--term-red",
  "--term-green",
  "--term-yellow",
  "--term-blue",
  "--term-magenta",
  "--term-cyan",
  "--term-white",
  "--term-bright-black",
  "--term-bright-red",
  "--term-bright-green",
  "--term-bright-yellow",
  "--term-bright-blue",
  "--term-bright-magenta",
  "--term-bright-cyan",
  "--term-bright-white"
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface CustomTheme {
  id: string;
  name: string;
  base: "dark" | "light";
  tokens: Partial<Record<ThemeToken, string>>;
}

/** The file's shape: what import reads and export writes. */
export interface ThemeFile {
  novusTheme: 1;
  name: string;
  base: "dark" | "light";
  tokens: Partial<Record<ThemeToken, string>>;
}

const STORAGE_KEY = "novus-themes";
const TOKEN_SET = new Set<string>(THEME_TOKENS);
/** A colour value as CSS takes it; nothing that could close a declaration. */
const VALUE = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/;

/** Reads a theme file's text; the reason is in words when it is refused. */
export function parseThemeFile(text: string): { ok: true; theme: ThemeFile } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file is not JSON." };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "That file is not a theme." };
  const record = raw as Record<string, unknown>;
  if (record.novusTheme !== 1) return { ok: false, reason: "That file is not a Novus theme (no \"novusTheme\": 1)." };
  const name = typeof record.name === "string" ? record.name.trim().slice(0, 60) : "";
  if (name.length === 0) return { ok: false, reason: "The theme has no name." };
  const base = record.base === "light" ? "light" : record.base === "dark" ? "dark" : null;
  if (base === null) return { ok: false, reason: 'The theme\'s base must be "dark" or "light".' };
  if (!record.tokens || typeof record.tokens !== "object") return { ok: false, reason: "The theme sets no tokens." };
  const tokens: Partial<Record<ThemeToken, string>> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(record.tokens as Record<string, unknown>)) {
    if (!TOKEN_SET.has(key)) {
      unknown.push(key);
      continue;
    }
    if (typeof value !== "string" || !VALUE.test(value)) return { ok: false, reason: `${key} is not a colour value.` };
    tokens[key as ThemeToken] = value.trim();
  }
  if (unknown.length > 0) return { ok: false, reason: `Not a theme token: ${unknown.slice(0, 3).join(", ")}. A theme sets colours only.` };
  if (Object.keys(tokens).length === 0) return { ok: false, reason: "The theme sets no tokens." };
  return { ok: true, theme: { novusTheme: 1, name, base, tokens } };
}

function load(): Record<string, CustomTheme> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, CustomTheme> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const read = parseThemeFile(JSON.stringify({ novusTheme: 1, ...(value as object) }));
      if (read.ok) out[id] = { id, name: read.theme.name, base: read.theme.base, tokens: read.theme.tokens };
    }
    return out;
  } catch {
    return {};
  }
}

function save(map: Record<string, CustomTheme>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* a browser that refuses storage keeps the built-in themes only */
  }
}

/** Every custom theme on this machine, by name. */
export function listThemes(): CustomTheme[] {
  return Object.values(load()).sort((a, b) => a.name.localeCompare(b.name));
}

export function themeById(id: string): CustomTheme | null {
  return load()[id] ?? null;
}

/** Keeps a theme; a second import of the same name replaces the first. */
export function saveTheme(file: ThemeFile, mint: () => string = () => `thm_${Math.random().toString(36).slice(2, 10)}`): CustomTheme {
  const map = load();
  const existing = Object.values(map).find((theme) => theme.name === file.name);
  const id = existing?.id ?? mint();
  map[id] = { id, name: file.name, base: file.base, tokens: file.tokens };
  save(map);
  return map[id]!;
}

export function removeTheme(id: string): void {
  const map = load();
  if (!(id in map)) return;
  delete map[id];
  save(map);
}

/** The theme as a file, for export. */
export function themeFileOf(theme: CustomTheme): string {
  const file: ThemeFile = { novusTheme: 1, name: theme.name, base: theme.base, tokens: theme.tokens };
  return JSON.stringify(file, null, 2) + "\n";
}

/** Lays a theme's tokens over the base on the root, or clears them. */
export function applyThemeTokens(root: HTMLElement, theme: CustomTheme | null): void {
  for (const token of THEME_TOKENS) root.style.removeProperty(token);
  if (!theme) return;
  for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(token, value);
}

/** The tokens the current stylesheet resolves to, as a starting file for
 *  someone who wants to change a few. */
export function currentThemeFile(root: HTMLElement, name: string, base: "dark" | "light"): string {
  const computed = getComputedStyle(root);
  const tokens: Partial<Record<ThemeToken, string>> = {};
  for (const token of THEME_TOKENS) {
    const value = computed.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  return themeFileOf({ id: "current", name, base, tokens });
}
