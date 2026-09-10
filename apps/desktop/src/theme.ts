import { applyThemeTokens, themeById } from "./themes";

/** Light, dark, follow the system — or one of this machine's custom themes
 *  by id, `custom:thm_…` (D-254). */
export type BuiltInTheme = "light" | "dark" | "system";
export type ThemePreference = BuiltInTheme | `custom:${string}`;

const STORAGE_KEY = "novus-theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

/** The one choice set, shared by setup and Settings so the two surfaces can
 *  never drift apart. */
export const THEME_CHOICES: { value: BuiltInTheme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

/** Fires on the window whenever the resolved theme may have changed, so
 *  surfaces that copied token values out of CSS (the terminal) repaint. */
export const THEME_EVENT = "novus:theme";

export function themePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "system" || stored === "dark") return stored;
  // A custom theme that has since been removed falls back to dark, the reference.
  if (stored?.startsWith("custom:") && themeById(stored.slice("custom:".length))) return stored as ThemePreference;
  return "dark";
}

/** The custom theme a preference names, or null for the built-ins. */
export function customThemeOf(preference: ThemePreference): ReturnType<typeof themeById> {
  return preference.startsWith("custom:") ? themeById(preference.slice("custom:".length)) : null;
}

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") return media().matches ? "light" : "dark";
  if (preference.startsWith("custom:")) return customThemeOf(preference)?.base ?? "dark";
  return preference === "light" ? "light" : "dark";
}

/** Paints a preference: the base on the root, a custom theme's tokens over it. */
function paint(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(preference);
  applyThemeTokens(document.documentElement, customThemeOf(preference));
}

export function applyTheme(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  paint(preference);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Resolves before first paint; keeps "system" live afterwards. */
export function initTheme(): void {
  paint(themePreference());
  media().addEventListener("change", () => {
    if (themePreference() === "system") applyTheme("system");
  });
}
