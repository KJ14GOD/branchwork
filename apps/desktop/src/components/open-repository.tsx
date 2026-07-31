import { useEffect, useState } from "react";

import type {
  HostCapabilities,
  MissionAttention,
  RememberedSession,
} from "@novus/contracts/protocol";

import { bridge } from "../bridge.ts";

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * The inbox's headings, most urgent first.
 *
 * Worded as what is being asked of the reader rather than as a status. "Needs
 * your decision" is a request; "awaiting decision" is a description of a
 * record, and a person scanning for what to do next reads straight past it.
 * The worker sorts by this same order, so a group is always contiguous.
 */
const ATTENTION_GROUPS: { attention: MissionAttention; label: string }[] = [
  { attention: "needs-decision", label: "Needs your decision" },
  { attention: "needs-approval", label: "Needs your approval" },
  { attention: "waiting-on-someone", label: "Waiting on someone" },
  { attention: "running", label: "Running" },
  { attention: "needs-direction", label: "Needs your direction" },
  { attention: "settled", label: "Recently decided" },
];

/**
 * The first screen, and the "new tab" form — one component, two contexts.
 *
 * `embedded` skips the full-page centering wrapper (the overlay supplies its
 * own) and retitles for a second tab. Do not fork this into a separate
 * "new tab" form.
 */
export const OpenRepository = ({
  onOpen,
  opening,
  error,
  capabilities,
  remembered,
  embedded = false,
}: {
  onOpen: (
    repositoryPath: string,
    allowWrites: boolean,
    allowCommands: boolean,
    resume?: string,
  ) => void;
  /** Sessions the log remembers, newest activity first. */
  remembered: RememberedSession[];
  opening: boolean;
  error: string | null;
  /** What the host permits, or null until the worker has answered. */
  capabilities: HostCapabilities | null;
  /**
   * True when this renders inside the "new tab" overlay rather than as the
   * full-window empty state.
   */
  embedded?: boolean;
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

  const panel = (
    <form
      className={embedded ? "open__panel modal" : "open__panel"}
      onSubmit={submit}
    >
      <div className="open__title">
        {embedded ? "Open another repository" : "Open a repository"}
      </div>
      <p className="open__subtitle">
        Novus runs its agent against one repository at a time, on this machine.
        Nothing leaves it unless you invite someone.
      </p>

      <div className="open__field">
        <span className="eyebrow">Repository</span>
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
        </div>
      </div>

      <button
        className="button button--primary button--large"
        type="submit"
        disabled={opening}
      >
        {opening ? "Opening…" : "Open"}
      </button>
      {error ? <div className="open__error">{error}</div> : null}

      {remembered.length > 0 ? (
        <div className="open__recent">
          {/*
            Grouped by what each mission is asking for, not by repository and
            not by recency. Recency is actively wrong here: a mission waiting
            on a decision has by definition stopped moving, so sorting by last
            activity buried exactly the rows that needed somebody.
          */}
          {ATTENTION_GROUPS.map(({ attention, label }) => {
            const group = remembered.filter(
              (entry) => entry.attention === attention,
            );

            if (group.length === 0) {
              // No empty headings. A row of zeroes is the thing this screen
              // was already criticised for.
              return null;
            }

            return (
              <div className="inbox__group" key={attention}>
                <span className="eyebrow">{label}</span>
                {group.slice(0, 6).map((entry) => (
                  <button
                    className="inbox__row"
                    key={entry.id}
                    type="button"
                    // Resumes the id, which is what brings the old timeline
                    // back — a new one would start an empty stream beside a
                    // history nobody could reach. Permissions come from the
                    // checkboxes above, not from whatever it had before.
                    onClick={() =>
                      onOpen(
                        entry.repositoryPath,
                        allowWrites,
                        allowCommands,
                        entry.id,
                      )
                    }
                    title={`${entry.repositoryPath} · last active ${entry.lastActivityAt}`}
                  >
                    <span className="inbox__goal">
                      {/* The goal leads. Five missions in one repository were
                          five identical rows when the path did. */}
                      {entry.goal ?? "Opened, nothing run yet"}
                    </span>
                    <span className="inbox__meta">
                      <span className="inbox__repo">
                        {basename(entry.repositoryPath)}
                      </span>
                      {entry.approaches > 1 ? (
                        <span>{entry.approaches} approaches</span>
                      ) : null}
                      <span
                        className={`inbox__evidence inbox__evidence--${entry.evidence}`}
                      >
                        {/* Never a tick for a mission that tested nothing. */}
                        {entry.evidence === "verified"
                          ? "Verified"
                          : entry.evidence === "failing"
                            ? "Tests failing"
                            : "Unverified"}
                      </span>
                      {entry.controller ? (
                        <span>{entry.controller} in control</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </form>
  );

  return embedded ? panel : <div className="open">{panel}</div>;
};
