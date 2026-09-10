import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listThemes, parseThemeFile, removeTheme, saveTheme, themeById, themeFileOf, THEME_TOKENS } from "../src/themes";

/** A theme file is read strictly and kept on this machine (D-254). */
describe("custom themes (D-254)", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key)
    };
  });
  afterEach(() => {
    storage.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("reads a theme file, and refuses in words what is not one", () => {
    const good = parseThemeFile(JSON.stringify({ novusTheme: 1, name: " Ink ", base: "dark", tokens: { "--bg": "#000000", "--accent": "rgb(200, 200, 255)" } }));
    expect(good).toEqual({ ok: true, theme: { novusTheme: 1, name: "Ink", base: "dark", tokens: { "--bg": "#000000", "--accent": "rgb(200, 200, 255)" } } });
    expect(parseThemeFile("not json")).toEqual({ ok: false, reason: "That file is not JSON." });
    expect(parseThemeFile(JSON.stringify({ name: "x" }))).toMatchObject({ ok: false });
    expect(parseThemeFile(JSON.stringify({ novusTheme: 1, name: "", base: "dark", tokens: { "--bg": "#000" } }))).toEqual({ ok: false, reason: "The theme has no name." });
    expect(parseThemeFile(JSON.stringify({ novusTheme: 1, name: "x", base: "blue", tokens: { "--bg": "#000" } }))).toMatchObject({ ok: false });
    expect(parseThemeFile(JSON.stringify({ novusTheme: 1, name: "x", base: "dark", tokens: { "--s-4": "40px" } }))).toEqual({
      ok: false,
      reason: "Not a theme token: --s-4. A theme sets colours only."
    });
    expect(parseThemeFile(JSON.stringify({ novusTheme: 1, name: "x", base: "dark", tokens: { "--bg": "url(x); color: red" } }))).toEqual({
      ok: false,
      reason: "--bg is not a colour value."
    });
    expect(parseThemeFile(JSON.stringify({ novusTheme: 1, name: "x", base: "dark", tokens: {} }))).toEqual({ ok: false, reason: "The theme sets no tokens." });
  });

  it("keeps themes by name, replaces a re-import, removes, and round-trips the file", () => {
    let n = 0;
    const mint = () => `thm_${(n += 1)}`;
    const ink = saveTheme({ novusTheme: 1, name: "Ink", base: "dark", tokens: { "--bg": "#000000" } }, mint);
    const paper = saveTheme({ novusTheme: 1, name: "Paper", base: "light", tokens: { "--bg": "#fffff0" } }, mint);
    expect(listThemes().map((theme) => theme.name)).toEqual(["Ink", "Paper"]);
    const again = saveTheme({ novusTheme: 1, name: "Ink", base: "dark", tokens: { "--bg": "#111111" } }, mint);
    expect(again.id).toBe(ink.id);
    expect(themeById(ink.id)?.tokens["--bg"]).toBe("#111111");
    expect(JSON.parse(themeFileOf(paper))).toEqual({ novusTheme: 1, name: "Paper", base: "light", tokens: { "--bg": "#fffff0" } });
    removeTheme(paper.id);
    expect(listThemes().map((theme) => theme.name)).toEqual(["Ink"]);
    expect(THEME_TOKENS).toContain("--accent");
    expect(THEME_TOKENS).not.toContain("--s-4");
  });
});
