import { useEffect, useRef, useState } from "react";
import { focusQuietly } from "./dialog";
import {
  applyTheme,
  themePreference,
  THEME_CHOICES,
  THEME_EVENT,
  type ThemePreference
} from "../theme";

/** The resolved theme as the document root wears it, kept live so the
 *  trigger's glyph can follow System wherever the OS takes it. */
function useResolvedTheme(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark"
  );
  useEffect(() => {
    const read = () =>
      setResolved(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    window.addEventListener(THEME_EVENT, read);
    return () => window.removeEventListener(THEME_EVENT, read);
  }, []);
  return resolved;
}

function SunGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1" />
    </svg>
  );
}

function MoonGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.25 9.6a5.6 5.6 0 0 1-6.85-6.85A5.6 5.6 0 1 0 13.25 9.6Z" />
    </svg>
  );
}

function DisplayGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.25" />
      <path d="M6 13.75h4M8 11.25v2.5" />
    </svg>
  );
}

const CHOICE_GLYPHS: Record<ThemePreference, () => React.ReactElement> = {
  light: SunGlyph,
  dark: MoonGlyph,
  system: DisplayGlyph
};

/**
 * The theme control at the rail's foot (D-103, reversing D-102's dialog on
 * the owner's direction): the trigger wears the *resolved* theme — a
 * crescent while the product is dark, a sun while it is light, System
 * following whichever it resolves to — and opens a small block anchored
 * right there, not a page: the setup room's three-option segment and
 * nothing else. Click outside or Esc puts it away.
 */
export function ThemeControl({
  open,
  onToggle,
  onClose
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const [theme, setTheme] = useState<ThemePreference>(themePreference());
  const resolved = useResolvedTheme();
  const anchor = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // Dismissing the popover is not keyboard navigation (D-106).
      focusQuietly(document.activeElement);
      onClose();
    };
    document.addEventListener("mousedown", onPress);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const pick = (value: ThemePreference) => {
    applyTheme(value);
    setTheme(value);
  };

  return (
    <div className="theme-anchor" ref={anchor}>
      <button
        className="icon-button"
        onClick={onToggle}
        aria-label={`Theme: ${theme}`}
        aria-expanded={open}
        title="Theme (⌘,)"
        data-resolved={resolved}
        data-testid="open-theme"
      >
        {resolved === "dark" ? <MoonGlyph /> : <SunGlyph />}
      </button>
      {open && (
        <div className="theme-popover" role="group" aria-label="Theme" data-testid="theme-popover">
          {THEME_CHOICES.map((option) => {
            const Glyph = CHOICE_GLYPHS[option.value];
            return (
              <button
                key={option.value}
                className={theme === option.value ? "icon-button active" : "icon-button"}
                aria-pressed={theme === option.value}
                aria-label={option.label}
                title={option.label}
                data-testid={`theme-${option.value}`}
                onClick={() => pick(option.value)}
              >
                <Glyph />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
