export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "novus-theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

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
}

/** Resolves before first paint; keeps "system" live afterwards. */
export function initTheme(): void {
  document.documentElement.dataset.theme = resolve(themePreference());
  media().addEventListener("change", () => {
    if (themePreference() === "system") applyTheme("system");
  });
}
