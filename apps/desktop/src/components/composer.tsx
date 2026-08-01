import { useEffect, useRef, useState } from "react";

import {
  TURN_MODELS,
  type TurnModelId,
  type TurnModelState,
} from "../use-turn-model.ts";

/**
 * The primary way you talk to this product.
 *
 * Was `ask-bar.tsx`: a one-line textarea and a button, docked on a bar with a
 * rule above it. Direct feedback was that it "feels empty" and needs to
 * actually hold things. It now does, and the shape is the one Cursor, Zed's
 * agent panel and Claude's own composer converge on — a single bordered field
 * with a real minimum height and a toolbar *inside* it, so controls have
 * somewhere to live that is not a second toolbar somewhere else.
 *
 * What it holds, all of it real state rather than decoration:
 *   - a model picker for the next turn (see use-turn-model.ts for the seam),
 *   - what pressing Enter is about to do, which changes mid-run,
 *   - the send action, labelled with the verb it is about to perform.
 *
 * One control still does both jobs a text field can do here, decided by
 * `busy`: idle it calls `ask()` and starts a turn; mid-run it calls
 * `direct()` and steers the one already running, folded in at the run's next
 * safe boundary. The placeholder and the button say which.
 */
export const Composer = ({
  busy,
  model,
  onAsk,
  onDirect,
}: {
  busy: boolean;
  model: TurnModelState;
  onAsk: (goal: string, choice?: { modelId: string | null } | null) => void;
  onDirect: (goal: string) => void;
}) => {
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Mounted only while open, so a closed picker costs nothing per render and
  // adds no listeners.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const send = () => {
    const trimmed = value.trim();

    if (!trimmed) {
      return;
    }

    if (busy) {
      // Direction carries no model: it folds into a turn that is already
      // running on a model the run has committed to, so offering a choice
      // here would be a control that cannot be honoured.
      onDirect(trimmed);
    } else {
      // null for "Auto" — the worker routes when no model is named, and the
      // pick wins outright when one is.
      onAsk(trimmed, model.option);
    }

    setValue("");
  };

  const choose = (id: TurnModelId) => {
    model.select(id);
    setMenuOpen(false);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="composer__field">
        {/*
          The auto-grow wrapper. `data-value` feeds the CSS ::after replica
          that sizes the row — see .composer__grow in styles.css. This is why
          there is no ref, no scrollHeight read, and no height write here: a
          measure-and-set implementation forces a synchronous layout on every
          keystroke, and performance was explicitly called out.
        */}
        <div className="composer__grow" data-value={value}>
          <textarea
            className="composer__input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              busy
                ? "Steer the running turn — folded in at its next safe point"
                : "Ask the agent to do something in this repository"
            }
            rows={1}
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
        </div>

        <div className="composer__toolbar">
          <div className="composer__model-wrap" ref={menuRef}>
            <button
              className="composer__model"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              title="Which model should handle the next turn"
            >
              <span className="composer__model-name">{model.option.label}</span>
              <span className="composer__model-caret" aria-hidden="true">
                ▾
              </span>
            </button>

            {menuOpen ? (
              <div className="composer__menu" role="menu">
                {TURN_MODELS.map((option) => (
                  <button
                    key={option.id}
                    className={`composer__model-option${
                      option.id === model.selected
                        ? " composer__model-option--active"
                        : ""
                    }`}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.id === model.selected}
                    onClick={() => choose(option.id)}
                  >
                    <span className="composer__model-label">{option.label}</span>
                    <span className="composer__model-note">{option.note}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <span className="composer__spacer" />

          <span className="kbd-hint">
            <kbd>⏎</kbd> {busy ? "Steer" : "Send"}
            <kbd>⇧⏎</kbd> Newline
          </span>

          <button
            className="composer__send"
            type="submit"
            disabled={value.trim() === ""}
          >
            {busy ? "Steer" : "Ask"}
          </button>
        </div>
      </div>
    </form>
  );
};
