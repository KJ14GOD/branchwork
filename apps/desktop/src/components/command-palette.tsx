import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The command palette (D-178): every act the window can take right now, one
 * keystroke away. `⌘K` opens it; typing filters; Enter runs. It wears the
 * mission search's own anatomy — the one palette system, not a second one.
 *
 * Two house rules shape it. Actions the *state* cannot offer (no selected
 * mission, nothing running) are simply absent — there is nothing to refuse.
 * Actions a *capability* gates are present and disabled with the same denial
 * words their buttons carry (AGENTS.md rule 13 in the mirror: the palette
 * may never hide a verb the server would allow, nor imply one it refuses).
 */

export interface PaletteCommand {
  id: string;
  /** One word of context — Go, Toggle, Mission — the group heading rows sit
   *  under, searchable with the label. */
  group: string;
  label: string;
  /** The key that also does it, shown at the row's end. */
  hint?: string;
  /** Present when a capability refuses this right now: the denial words the
   *  equivalent button carries. */
  disabled?: string;
  run: () => void;
}

function CommandGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.2 2.2h5.6M5.2 13.8h5.6M2.2 5.2v5.6M13.8 5.2v5.6" />
      <circle cx="3.6" cy="3.6" r="1.4" />
      <circle cx="12.4" cy="3.6" r="1.4" />
      <circle cx="3.6" cy="12.4" r="1.4" />
      <circle cx="12.4" cy="12.4" r="1.4" />
    </svg>
  );
}

export function CommandPalette({
  commands,
  onClose
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needle = query.trim().toLowerCase();
  const found = useMemo(() => {
    if (needle === "") return commands;
    const words = needle.split(/\s+/);
    return commands.filter((command) => {
      const hay = `${command.group} ${command.label}`.toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }, [commands, needle]);
  const cursor = Math.min(active, Math.max(0, found.length - 1));

  const run = (command: PaletteCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    command.run();
  };

  /** Group headings appear where the group starts, exactly as the search's
   *  "Missions" heading does. */
  const grouped: (PaletteCommand & { heads: boolean })[] = found.map((command, at) => ({
    ...command,
    heads: at === 0 || found[at - 1]?.group !== command.group
  }));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog palette" role="dialog" aria-label="Commands" data-testid="command-palette">
        <div className="palette-query">
          <CommandGlyph />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="Type a command"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                setActive((index) => Math.min(index + 1, found.length - 1));
                event.preventDefault();
              } else if (event.key === "ArrowUp") {
                setActive((index) => Math.max(index - 1, 0));
                event.preventDefault();
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(found[cursor]);
              }
            }}
            aria-label="Type a command"
            data-testid="palette-command-input"
          />
          <kbd className="palette-hint">esc</kbd>
        </div>

        {found.length > 0 ? (
          <div className="palette-results" role="listbox" aria-label="Commands">
            {grouped.map((command, index) => (
              <div key={command.id}>
                {command.heads && <div className="palette-group">{command.group}</div>}
                <button
                  role="option"
                  aria-selected={index === cursor}
                  aria-disabled={command.disabled !== undefined}
                  title={command.disabled}
                  className={
                    (index === cursor ? "palette-hit active" : "palette-hit") +
                    (command.disabled ? " refused" : "")
                  }
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(command)}
                  data-testid="palette-command"
                >
                  <span className="palette-name">
                    {command.label}
                    {command.disabled && <span className="palette-denial"> — {command.disabled}</span>}
                  </span>
                  {command.hint && <span className="palette-where mono">{command.hint}</span>}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="palette-empty" data-testid="palette-command-empty">
            No command is called that.
          </p>
        )}
      </div>
    </>
  );
}
