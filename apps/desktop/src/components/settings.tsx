import { useState } from "react";
import { Dialog } from "./dialog";
import { applyTheme, themePreference, THEME_CHOICES, type ThemePreference } from "../theme";

/**
 * The settings surface after first run (D-102): the theme choice the setup
 * room offers (DESIGN.md#first-run-setup), reachable for the rest of the
 * product's life from the rail's identity row or ⌘,. Same anatomy as the
 * setup row — label and one-line description left, the three-option segment
 * right — applied immediately, persisted locally.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<ThemePreference>(themePreference());

  const pick = (value: ThemePreference) => {
    applyTheme(value);
    setTheme(value);
  };

  return (
    <Dialog label="Settings" onClose={onClose} testId="settings-dialog">
      <header className="dialog-head">
        <h2>Settings</h2>
      </header>
      <div className="setup-row settings-row">
        <div>
          <div className="setup-row-label">Theme</div>
          <div className="setup-row-desc">Light, dark, or follow the system.</div>
        </div>
        <div className="segment" role="group" aria-label="Theme">
          {THEME_CHOICES.map((option) => (
            <button
              key={option.value}
              className="btn btn-secondary"
              aria-pressed={theme === option.value}
              data-testid={`theme-${option.value}`}
              onClick={() => pick(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
