export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "novus-theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

/** The one choice set, shared by setup and Settings so the two surfaces can
 *  never drift apart. */
export const THEME_CHOICES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" }
];

/** Fires on the window whenever the resolved theme may have changed, so
 *  surfaces that copied token values out of CSS (the terminal) repaint. */
export const THEME_EVENT = "novus:theme";

export function themePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "system" || stored === "dark" ? stored : "dark";
}

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") return media().matches ? "light" : "dark";
  return preference;
}

export function applyTheme(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  document.documentElement.dataset.theme = resolve(preference);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Resolves before first paint; keeps "system" live afterwards. */
export function initTheme(): void {
  document.documentElement.dataset.theme = resolve(themePreference());
  media().addEventListener("change", () => {
    if (themePreference() === "system") applyTheme("system");
  });
}
