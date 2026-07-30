import { useState } from "react";

/**
 * The persistent, always-visible way to talk to the agent — the direct
 * answer to "this feels more a blackbox than a whole platform": asking a
 * question used to be reachable only by knowing `/` opens a palette first.
 * Docked at the bottom of the timeline column, the same shape a bottom-
 * pinned message editor takes in every tool researched for this that serves
 * both a chat-style and a command-driven audience (Zed's agent panel keeps
 * its palette and this pinned editor as two separate, non-competing things,
 * not one replacing the other) — `/` still opens the command palette for
 * filters, jumps, and a quick ask of its own, but it is no longer the only
 * door in.
 *
 * One control does both jobs a text field can do here: while nothing is
 * running it starts a turn (`ask`); while a turn is in flight it steers the
 * one already running (`direct`), folded in at the run's next safe boundary
 * rather than applied immediately — the same distinction the rail's old,
 * now-removed direction box used to draw with a second form.
 */
export const AskBar = ({
  busy,
  onAsk,
  onDirect,
}: {
  busy: boolean;
  onAsk: (goal: string) => void;
  onDirect: (goal: string) => void;
}) => {
  const [value, setValue] = useState("");

  const send = () => {
    const trimmed = value.trim();

    if (!trimmed) {
      return;
    }

    if (busy) {
      onDirect(trimmed);
    } else {
      onAsk(trimmed);
    }

    setValue("");
  };

  return (
    <form
      className="ask-bar"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        className="ask-bar__input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={
          busy
            ? "Steer the running turn — applied at its next safe point"
            : "Ask the agent to do something"
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
      <button className="ask-bar__submit" type="submit" disabled={value.trim() === ""}>
        {busy ? "Steer" : "Ask"}
      </button>
    </form>
  );
};
