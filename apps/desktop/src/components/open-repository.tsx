import { useEffect, useState } from "react";

import type { HostCapabilities } from "@novus/contracts/protocol";

import { bridge } from "../bridge.ts";
import { Modal } from "./modal.tsx";

/**
 * What the permission checkboxes start as.
 *
 * Seeded from the host rather than defaulting to off: an operator who set
 * `NOVUS_ALLOW_WRITES=1` and then saw an unchecked box had no way to tell
 * whether the variable was ignored or the control was. Off is the answer
 * until the worker has said otherwise, which is the safe direction to fail.
 */
export const seedPermissions = (
  capabilities: HostCapabilities | null,
): { allowWrites: boolean; allowCommands: boolean } => ({
  allowWrites: capabilities?.allowWrites ?? false,
  allowCommands: capabilities?.allowCommands ?? false,
});

/**
 * Opening a repository. Only that.
 *
 * This used to also be the Mission Inbox — the form, and then every
 * remembered mission appended underneath it — so one panel did creation and
 * navigation at once and grew a row taller for every mission that existed.
 * The list moved to `mission-inbox.tsx`, which is the surface for going back
 * to work; what is left here is the repository, the permissions that
 * repository will be opened under, and one Open button, which is a bounded
 * amount of form no matter what the log remembers.
 */
export const OpenRepository = ({
  onOpen,
  opening,
  error,
  capabilities,
  onClose,
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
  onClose: () => void;
}) => {
  const [path, setPath] = useState("");
  const [permissions, setPermissions] = useState(() =>
    seedPermissions(capabilities),
  );
  const host = bridge();

  // Capabilities usually arrive after the first render — the worker is asked
  // on the way in — so the seed above is re-applied when they land.
  useEffect(() => {
    if (capabilities) {
      setPermissions(seedPermissions(capabilities));
    }
  }, [capabilities]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (path.trim()) {
      onOpen(path.trim(), permissions.allowWrites, permissions.allowCommands);
    }
  };

  const browse = async () => {
    const chosen = await host?.pickDirectory();

    if (chosen) {
      setPath(chosen);
    }
  };

  return (
    <Modal
      title="Open a repository"
      subtitle="Novus runs its agent against one repository at a time, on this machine. Nothing leaves it unless you invite someone."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          {/* In the foot, not in the body: the body scrolls and an error you
              have to scroll to find is an error nobody acts on. */}
          {error ? <div className="open__error">{error}</div> : null}
          <span className="sheet__spacer" />
          <button
            className="button button--primary button--large"
            type="submit"
            disabled={opening}
          >
            {opening ? "Opening…" : "Open"}
          </button>
        </>
      }
    >
      <div className="open__field">
        <span className="eyebrow">Repository</span>
        <div className="open__row">
          <input
            className="open__input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/code/your-project"
            spellCheck={false}
            data-autofocus
          />
          {host ? (
            <button
              className="button button--large"
              type="button"
              onClick={() => void browse()}
            >
              Browse…
            </button>
          ) : null}
        </div>
      </div>

      <div className="open__field">
        <span className="eyebrow">Permissions</span>
        <div className="open__toggles">
          <label className="open__toggle">
            <input
              type="checkbox"
              checked={permissions.allowWrites}
              onChange={(event) =>
                setPermissions((current) => ({
                  ...current,
                  allowWrites: event.target.checked,
                }))
              }
            />
            <span>
              Allow writes — the agent may apply patches to this repository
            </span>
          </label>
          <label className="open__toggle">
            <input
              type="checkbox"
              checked={permissions.allowCommands}
              onChange={(event) =>
                setPermissions((current) => ({
                  ...current,
                  allowCommands: event.target.checked,
                }))
              }
            />
            <span>
              Allow commands — the agent may run programs and your test suite
            </span>
          </label>
        </div>
      </div>
    </Modal>
  );
};
