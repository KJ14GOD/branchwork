import { useState } from "react";

import { parseInvite, type ParsedInvite } from "@novus/session-client";

/**
 * Where the default worker lives when an invite names a session but no
 * endpoint. Invites minted by a host whose worker moved off the standard
 * port carry an explicit ?endpoint=, so this only decides the plain case.
 */
const DEFAULT_WORKER_ENDPOINT =
  import.meta.env.VITE_NOVUS_ENDPOINT ?? "http://127.0.0.1:4319";

/**
 * The join half of the delineation: paste an invite, join its session.
 *
 * Opening a repository is hosting and stays where it always was; this is the
 * other thing a Novus window can do, and it deliberately asks for exactly
 * one input — the link the host copied out of the Invite panel. Everything
 * the link means (which transport, which session, which credential) is
 * decided by `parseInvite`, shared with the browser guest, so a link that
 * would be refused there is refused here with the same reason before
 * anything is contacted.
 */
export const JoinEntry = ({
  onJoin,
  prefill = null,
  embedded = false,
}: {
  onJoin: (invite: ParsedInvite) => void;
  /** From a `--join=<link>` launch, so the field starts filled in. */
  prefill?: string | null;
  /** True inside the overlay; false as the full-window empty state. */
  embedded?: boolean;
}) => {
  const [link, setLink] = useState(prefill ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    const checked = parseInvite(link, DEFAULT_WORKER_ENDPOINT);

    if (checked.kind === "refused") {
      setRefusal(checked.reason);

      return;
    }

    setRefusal(null);
    onJoin(checked.invite);
  };

  const panel = (
    <form
      className={embedded ? "open__panel modal" : "open__panel"}
      onSubmit={submit}
    >
      <div className="open__title">Join a mission</div>
      <p className="open__subtitle">
        Paste an invite from a Novus host. You join their live session with the
        role the invite carries — their repository and credentials stay on
        their machine.
      </p>

      <div className="open__field">
        <span className="eyebrow">Invite link</span>
        <input
          className="open__input"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="http://127.0.0.1:5274/?session=…&token=…"
          spellCheck={false}
          autoFocus
        />
      </div>

      <button
        className="button button--primary button--large"
        type="submit"
        disabled={!link.trim()}
      >
        Join
      </button>
      {refusal ? <div className="open__error">{refusal}</div> : null}

      <p className="open__subtitle">
        What works today: joining a host on this machine, or a relay invite
        (wss:// off this machine, ws:// only here). There is no hosted relay
        yet, so a teammate on another machine needs one stood up behind TLS
        first.
      </p>
    </form>
  );

  return embedded ? panel : <div className="open">{panel}</div>;
};
