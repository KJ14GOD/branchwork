import { describe, expect, it } from "vitest";
import {
  buildVocabulary,
  looksLikeName,
  MAX_PROMPT_CHARS,
  MAX_VOCABULARY_TERMS
} from "../electron/dictation-vocabulary";

/**
 * The vocabulary a transcriber is told (D-240): the person's own words first,
 * then the mission's names, then the worktree's, bounded and ordered so the
 * rarest names end the prompt sentence.
 */

describe("what reads as a name", () => {
  it("takes file names, paths, identifiers, and constants", () => {
    for (const token of ["composer.tsx", "apps/desktop", "getUser", "MAX_FILES", "mission-branch", "foo_bar", "IPC"]) {
      expect(looksLikeName(token), token).toBe(true);
    }
  });
  it("leaves ordinary words and numbers alone", () => {
    for (const token of ["refactor", "the", "Composer", "12", "2.3.1", "ok"]) {
      expect(looksLikeName(token), token).toBe(false);
    }
  });
});

describe("building the vocabulary", () => {
  const sources = {
    dictionary: ["Kartik", "Novus Fleet"],
    changed: ["apps/desktop/src/components/composer.tsx"],
    files: [
      "README.md",
      "package.json",
      "apps/desktop/electron/preload.ts",
      "apps/desktop/src/components/composer.tsx",
      "packages/contracts/src/index.ts",
      "scripts/gate.sh"
    ],
    words: ["Add a mic so I can dictate into composer.tsx and preload.ts", "use ipcRenderer.send for the frames"]
  };

  it("ranks the person's words first, then the mission's names, then the worktree's", () => {
    const { terms } = buildVocabulary(sources);
    expect(terms.slice(0, 2)).toEqual(["Kartik", "Novus Fleet"]);
    const composer = terms.indexOf("composer.tsx");
    const preload = terms.indexOf("preload.ts");
    const ipc = terms.indexOf("ipcRenderer.send");
    expect(composer).toBeGreaterThan(1);
    expect(preload).toBeGreaterThan(1);
    expect(ipc).toBeGreaterThan(1);
    // Top-level names come before deep files; generic basenames never appear.
    expect(terms).toContain("apps");
    expect(terms).toContain("scripts");
    expect(terms).toContain("gate.sh");
    expect(terms).not.toContain("README.md");
    expect(terms).not.toContain("package.json");
    expect(terms).not.toContain("index.ts");
    // The house names close the list.
    expect(terms).toContain("Novus");
    expect(terms).toContain("Claude Code");
  });

  it("dedupes case-insensitively and keeps the first spelling", () => {
    const { terms } = buildVocabulary({ dictionary: ["Composer.tsx"], changed: [], files: ["src/composer.tsx"], words: [] });
    expect(terms.filter((term) => term.toLowerCase() === "composer.tsx")).toEqual(["Composer.tsx"]);
  });

  it("ends the prompt with the person's own words and stays within bounds", () => {
    const { prompt, terms } = buildVocabulary(sources);
    expect(prompt.endsWith("Kartik.")).toBe(true);
    expect(prompt.startsWith("A software engineer is directing a coding agent.")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(terms.length).toBeLessThanOrEqual(MAX_VOCABULARY_TERMS);
  });

  it("bounds a huge worktree", () => {
    const files = Array.from({ length: 5000 }, (_, at) => `src/deep/nest/file-${at}.ts`);
    const { terms, prompt } = buildVocabulary({ dictionary: [], changed: [], files, words: [] });
    expect(terms.length).toBe(MAX_VOCABULARY_TERMS);
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("says something sensible with nothing behind the box", () => {
    const { prompt, terms } = buildVocabulary({ dictionary: [], changed: [], files: [], words: [] });
    expect(terms).toContain("Novus");
    expect(prompt).toContain("Names that may be spoken:");
  });
});
