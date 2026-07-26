import { useState } from "react";

import { bridge } from "../bridge.ts";

export const OpenRepository = ({
  onOpen,
  opening,
  error,
}: {
  onOpen: (repositoryPath: string, allowWrites: boolean) => void;
  opening: boolean;
  error: string | null;
}) => {
  const [path, setPath] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const host = bridge();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (path.trim()) {
      onOpen(path.trim(), allowWrites);
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
        <button className="open__submit" type="submit" disabled={opening}>
          {opening ? "Opening…" : "Open"}
        </button>
        {error ? <div className="open__error">{error}</div> : null}
      </form>
    </div>
  );
};
