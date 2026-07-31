import { useEffect, useMemo, useRef, useState } from "react";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

export const CommandOverlay = ({
  commands,
  onAsk,
  onClose,
}: {
  commands: Command[];
  // Free text that matches no command is a question for the agent.
  onAsk: ((goal: string) => void) | null;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return commands;
    }

    const filtered = commands.filter((command) =>
      command.label.toLowerCase().includes(needle),
    );

    if (onAsk) {
      // The ask leads: anything the user types is more likely a question than
      // a command they half-remembered.
      return [
        {
          id: "ask",
          label: `Ask — ${query.trim()}`,
          hint: "Enter",
          run: () => onAsk(query.trim()),
        },
        ...filtered,
      ];
    }

    return filtered;
  }, [commands, onAsk, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => Math.min(value + 1, matches.length - 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(value - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      matches[active]?.run();
      onClose();
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="palette" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={onAsk ? "Ask the agent, or run a command" : "Run a command"}
          spellCheck={false}
        />
        {matches.length === 0 ? (
          <div className="palette__empty">No matching command.</div>
        ) : (
          <ul className="palette__list">
            {matches.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  className={`palette__item${index === active ? " palette__item--active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    command.run();
                    onClose();
                  }}
                >
                  <span>{command.label}</span>
                  {command.hint ? (
                    <span className="palette__hint">{command.hint}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
