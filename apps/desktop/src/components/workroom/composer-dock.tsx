import { useState } from "react";

import type { Workstream } from "../../workstreams.ts";

/**
 * One focused interaction surface, anchored to the work.
 *
 * The composer it replaces was a bordered panel roughly a fifth of the window
 * tall whether or not anybody was typing, so an empty mission was mostly an
 * empty box. This is compact at rest and grows with what you write.
 *
 * It also names its target. In a room with more than one agent, "send" has to
 * answer *to whom* before it is a safe thing to press — direction has an
 * author and a recipient, and a composer that hid the recipient would be
 * asking somebody to steer blind.
 */
export const ComposerDock = ({
  workstreams,
  target,
  onTarget,
  busy,
  placeholder = "Give direction…",
  primary = true,
  onSend,
}: {
  workstreams: readonly Workstream[];
  target: string | null;
  onTarget: (runId: string) => void;
  busy: boolean;
  placeholder?: string;
  /**
   * Whether Send is *this screen's* dominant action.
   *
   * True on the Workroom itself, where directing the work is the thing a person
   * is there to do. False while a focused surface is open over the work — the
   * Decision Room's own Record decision is the dominant action then, and two
   * inverted buttons on one screen destroys the mechanism that makes either of
   * them mean anything. The composer stays fully usable either way: reaching a
   * decision must not cost the ability to say something.
   */
  primary?: boolean;
  onSend: (text: string) => void;
}) => {
  const [text, setText] = useState("");
  const ready = text.trim().length > 0;
  const addressee = workstreams.find((stream) => stream.runId === target);

  const send = (event: React.FormEvent) => {
    event.preventDefault();

    if (ready) {
      onSend(text.trim());
      setText("");
    }
  };

  return (
    <form className="dock" onSubmit={send}>
      <div className="dock__row">
        {/*
          Only when there is a choice to make. One workstream means one
          recipient, and a selector with a single option is a control that
          teaches people to ignore selectors.
        */}
        {workstreams.length > 1 ? (
          <label className="dock__target">
            <span className="visually-hidden">Send direction to</span>
            <select
              className="dock__select"
              value={target ?? ""}
              onChange={(event) => onTarget(event.target.value)}
              style={
                addressee
                  ? { ["--ws" as string]: `var(${addressee.signal})` }
                  : undefined
              }
            >
              {workstreams.map((stream) => (
                <option key={stream.runId} value={stream.runId}>
                  {stream.name} · {stream.assignment}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <textarea
          className="dock__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          // Grows with the writing rather than reserving the space in advance.
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          aria-label={placeholder}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(event);
            }
          }}
        />

        <button
          className={primary ? "button button--primary dock__send" : "button dock__send"}
          type="submit"
          disabled={!ready || busy}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>

      {/*
        The shortcut is a hint under the field rather than a row of keycaps
        competing with the send button for the same attention.
      */}
      <span className="dock__hint">
        <kbd>↵</kbd> to send · <kbd>⇧↵</kbd> for a new line
      </span>
    </form>
  );
};
