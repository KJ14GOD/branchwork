import { useEffect, useState } from "react";

import type { HostCapabilities } from "@novus/contracts/protocol";

import { bridge } from "../bridge.ts";

export const OpenRepository = ({
  onOpen,
  opening,
  error,
  capabilities,
}: {
  onOpen: (
    repositoryPath: string,
    allowWrites: boolean,
    allowCommands: boolean,
  ) => void;
  opening: boolean;
  error: string | null;
  /** What the host permits, or null until the worker has answered. */
  capabilities: HostCapabilities | null;
}) => {
  const [path, setPath] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowCommands, setAllowCommands] = useState(false);
  const host = bridge();

  // Seed from the host rather than defaulting to off. An operator who set
  // NOVUS_ALLOW_WRITES=1 and then saw an unchecked box had no way to tell
  // whether the variable was ignored or the control was.
  useEffect(() => {
    if (capabilities) {
      setAllowWrites(capabilities.allowWrites);
      setAllowCommands(capabilities.allowCommands);
    }
  }, [capabilities]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (path.trim()) {
      onOpen(path.trim(), allowWrites, allowCommands);
    }
  };

  const browse = async () => {
    const chosen = await host?.pickDirectory();

    if (chosen) {
      setPath(chosen);
    }
  };

  return (
    <div className="open">
      <form className="open__panel" onSubmit={submit}>
        <div className="open__label">Open a repository</div>
        <div className="open__row">
          <input
            className="open__input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/code/your-project"
            spellCheck={false}
            autoFocus
          />
          {host ? (
            <button
              className="open__browse"
              type="button"
              onClick={() => void browse()}
            >
              Browse…
            </button>
          ) : null}
        </div>
        <label className="open__toggle">
          <input
            type="checkbox"
            checked={allowWrites}
            onChange={(event) => setAllowWrites(event.target.checked)}
          />
          <span>
            Allow writes — the agent may apply patches to this repository
          </span>
        </label>
        <label className="open__toggle">
          <input
            type="checkbox"
            checked={allowCommands}
            onChange={(event) => setAllowCommands(event.target.checked)}
          />
          <span>
            Allow commands — the agent may run programs and your test suite
          </span>
        </label>
        <button className="open__submit" type="submit" disabled={opening}>
          {opening ? "Opening…" : "Open"}
        </button>
        {error ? <div className="open__error">{error}</div> : null}
      </form>
    </div>
  );
};
