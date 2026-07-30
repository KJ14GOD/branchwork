import { useState } from "react";

import type { InviteResponse } from "@novus/contracts/protocol";

import type { InviteRole } from "../use-session.ts";

// Same default the relay and the guest itself use, overridable the same way
// the worker endpoint is: a build-time env var, not a runtime lookup, since
// the desktop has no way to ask the guest what port it came up on.
const GUEST_PORT = import.meta.env.VITE_NOVUS_GUEST_PORT ?? "5274";

/**
 * Mints a token for a new participant and shows the link to hand them.
 *
 * The token is returned exactly once by the worker and never stored — so the
 * only copy that will ever exist is the one on screen here, which is why this
 * stays open with a "shown once" notice rather than closing itself.
 */
export const InvitePanel = ({
  onInvite,
  onClose,
}: {
  onInvite: (name: string, role: InviteRole) => Promise<InviteResponse | null>;
  onClose: () => void;
}) => {
  const [name, setName] = useState("");
  const [role, setRole] = useState<InviteRole>("editor");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const link = minted
    ? `http://127.0.0.1:${GUEST_PORT}/?session=${encodeURIComponent(minted.participant.sessionId)}&token=${encodeURIComponent(minted.token)}`
    : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!name.trim() || sending) {
      return;
    }

    setSending(true);
    setError(null);

    const result = await onInvite(name.trim(), role);

    setSending(false);

    if (result) {
      setMinted(result);
    } else {
      setError("Could not create the invite. See the message below the timeline.");
    }
  };

  const copy = () => {
    if (!link) {
      return;
    }

    void navigator.clipboard.writeText(link);
    setCopied(true);
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
      <form className="open__panel modal" onSubmit={(event) => void submit(event)}>
        <div className="open__title">Invite a teammate</div>

        {minted && link ? (
          <>
            <div className="open__row">
              <input
                className="open__input"
                value={link}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <button className="open__browse" type="button" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="open__label">
              {minted.participant.name} · {minted.participant.role} — this
              token will not be shown again
            </div>
            <button className="open__submit" type="button" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <input
              className="open__input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Teammate's name"
              spellCheck={false}
              autoFocus
            />
            <select
              className="open__input"
              value={role}
              onChange={(event) => setRole(event.target.value as InviteRole)}
            >
              <option value="editor">editor — can approve and steer</option>
              <option value="reviewer">reviewer — can approve only</option>
              <option value="viewer">viewer — read-only</option>
            </select>
            <button
              className="open__submit"
              type="submit"
              disabled={sending || !name.trim()}
            >
              {sending ? "Inviting…" : "Create invite"}
            </button>
            {error ? <div className="open__error">{error}</div> : null}
          </>
        )}
      </form>
    </div>
  );
};
