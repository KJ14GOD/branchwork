/**
 * What the transcriber is told before it hears a word (D-240): the names this
 * repository and this mission actually use, so `composer.tsx` lands as
 * `composer.tsx` and not "composer dot T S X", and a person's own words —
 * their dictionary — land as they spell them.
 *
 * Pure. The sources are read by the caller (git, the mission's record, the
 * person's preferences); this module only ranks and bounds them. Bounded on
 * purpose: vendors report that a long biasing list hurts as much as none —
 * every term is a chance to hear it where it was not said — and a
 * whisper-family prompt weighs its last tokens most, so the sentence ends
 * with the rarest names.
 */

export interface VocabularySources {
  /** The person's own words, first and always. */
  dictionary: readonly string[];
  /** Paths git reports changed in the worktree — what the person is most
   *  likely talking about. */
  changed: readonly string[];
  /** The worktree's census: tracked files plus untracked ones nothing
   *  ignores, as `git ls-files` lists them. */
  files: readonly string[];
  /** The mission's own prose: the goal, chat titles, recent directions. Only
   *  what looks like a name is taken from it. */
  words: readonly string[];
}

export interface Vocabulary {
  /** Ranked, most important first: the form a keyword list takes. */
  terms: string[];
  /** One fluent sentence ending with the rarest names: the form a prompt
   *  takes. */
  prompt: string;
}

export const MAX_VOCABULARY_TERMS = 80;
export const MAX_PROMPT_CHARS = 1_400;

/** Names every direction here may say and a transcriber gets wrong. */
const HOUSE_TERMS = [
  "Novus",
  "Claude Code",
  "Codex",
  "pnpm",
  "vitest",
  "zod",
  "Electron",
  "PostgreSQL",
  "worktree",
  "GitHub",
  "TypeScript",
  "eslint",
  "tsconfig",
  "Vite"
];

/** Basenames every repository has: a transcriber knows them already, and a
 *  term slot is better spent on a name only this repository has. */
const GENERIC_BASENAMES = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "readme.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  ".gitignore",
  ".env.example",
  "license",
  "license.md",
  "main.ts",
  "main.tsx",
  "app.tsx",
  "app.ts"
]);

/**
 * Whether a token from prose reads as a name rather than a word: a file name
 * (`composer.tsx`), a path (`apps/desktop`), an identifier (`getUser`,
 * `MAX_FILES`, `mission-branch`), or a capitalised word inside a sentence.
 */
export function looksLikeName(token: string): boolean {
  if (token.length < 3 || token.length > 60) return false;
  if (/^\d+(\.\d+)*$/.test(token)) return false;
  if (/[a-z0-9][.\-_/][a-z0-9]/i.test(token)) return true;
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(token)) return true; // camelCase
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(token)) return true; // MAX_FILES, IPC
  return false;
}

const namesFromProse = (words: readonly string[]): string[] => {
  const out: string[] = [];
  for (const line of words) {
    for (const raw of line.split(/[\s,;:()[\]{}"'`<>]+/)) {
      const token = raw.replace(/^[^\w./@-]+|[^\w./@-]+$/g, "");
      if (looksLikeName(token)) out.push(token);
    }
  }
  return out;
};

const basename = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;
const depth = (path: string): number => path.split("/").filter(Boolean).length;

/** The worktree's names, shallow first: a top-level directory is said far
 *  more often than a file six levels down, and a changed file before both. */
const namesFromWorktree = (changed: readonly string[], files: readonly string[]): string[] => {
  const out: string[] = [];
  for (const path of changed) out.push(basename(path));
  // Top-level directories, not top-level files: a root README is generic,
  // while `apps` or `scripts` is how a person names a place in the tree.
  const tops = new Set<string>();
  for (const path of files) {
    const [top, ...rest] = path.split("/").filter(Boolean);
    if (top && rest.length > 0) tops.add(top);
  }
  out.push(...tops);
  const byDepth = [...files].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  for (const path of byDepth) {
    const name = basename(path);
    if (GENERIC_BASENAMES.has(name.toLowerCase())) continue;
    out.push(name);
  }
  return out;
};

export function buildVocabulary(sources: VocabularySources): Vocabulary {
  const ranked: string[] = [];
  const seen = new Set<string>();
  const take = (term: string) => {
    const clean = term.trim();
    if (clean.length === 0 || clean.length > 60) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ranked.push(clean);
  };
  // Importance order: the person's own words, then what the mission says,
  // then what the worktree is called, then the house names.
  for (const word of sources.dictionary) take(word);
  for (const name of namesFromProse(sources.words)) take(name);
  for (const name of namesFromWorktree(sources.changed, sources.files)) take(name);
  for (const name of HOUSE_TERMS) take(name);
  const terms = ranked.slice(0, MAX_VOCABULARY_TERMS);

  // The sentence reads least-important first, so the names a whisper-family
  // model weighs most — the last ones — are the person's own.
  const lead = "A software engineer is directing a coding agent. Names that may be spoken: ";
  const ordered = [...terms].reverse();
  while (ordered.length > 0 && lead.length + ordered.join(", ").length + 1 > MAX_PROMPT_CHARS) {
    ordered.shift();
  }
  const prompt = ordered.length > 0 ? `${lead}${ordered.join(", ")}.` : lead.replace(" Names that may be spoken: ", "");
  return { terms, prompt };
}
