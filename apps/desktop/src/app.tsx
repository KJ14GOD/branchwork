import { useCallback, useEffect, useRef, useState } from "react";

import { SessionSummarySchema, type SessionSummary } from "@novus/contracts/protocol";
import type { ParsedInvite } from "@novus/session-client";

import { bridge, type LaunchDescriptor } from "./bridge.ts";
import { OpenRepository } from "./components/open-repository.tsx";
import { JoinEntry } from "./join/join-entry.tsx";
import { JoinedTab } from "./join/joined-tab.tsx";
import { SessionTab, type TabStatus } from "./session-tab.tsx";
import { useSession } from "./use-session.ts";
import { useTheme } from "./use-theme.ts";

const FALLBACK_ENDPOINT =
  import.meta.env.VITE_NOVUS_ENDPOINT ?? "http://127.0.0.1:4319";

const TABS_STORAGE_KEY = "novus.tabs";

type StoredTabs = { tabs: SessionSummary[]; activeId: string | null };

/**
 * The tabs this window had open last, so relaunching does not lose the
 * thread the way closing a browser tab does not lose your history.
 *
 * Each entry is only the `SessionSummary` this app fetched or created last
 * time — it names which session and repository to resume, not a session
 * still alive anywhere. The worker's in-memory registry does not survive a
 * relaunch even though its durable log does, so every stored entry is
 * re-opened with `resume` against whatever worker is running now; see the
 * hydration effect below. Read defensively here too: a stored shape from an
 * older build should be dropped, not thrown, so a schema change here never
 * blanks the window on
 * launch.
 */
const loadStoredTabs = (): StoredTabs => {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);

    if (!raw) {
      return { tabs: [], activeId: null };
    }

    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) {
      return { tabs: [], activeId: null };
    }

    const record = parsed as { tabs?: unknown; activeId?: unknown };
    const tabs = Array.isArray(record.tabs)
      ? record.tabs.flatMap((entry) => {
          const result = SessionSummarySchema.safeParse(entry);

          return result.success ? [result.data] : [];
        })
      : [];
    const storedActiveId =
      typeof record.activeId === "string" ? record.activeId : null;
    const activeId = tabs.some((tab) => tab.id === storedActiveId)
      ? storedActiveId
      : (tabs.at(-1)?.id ?? null);

    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
};

const basename = (path: string): string =>
  path.split("/").filter(Boolean).at(-1) ?? path;

const dotClass = (status: string | undefined): string => {
  if (status === "working" || status === "running" || status === "cancelling") {
    return "busy";
  }

  if (status === "paused" || status === "pausing") {
    return "paused";
  }

  if (status === "failed") {
    return "failed";
  }

  return "idle";
};

/**
 * A session this window joined rather than hosts. Held only for the life of
 * the window, deliberately: the invite token is a credential, and the rule
 * everywhere else in this app is that credentials do not outlive the window
 * — host tabs persist to localStorage, joined tabs do not.
 */
type JoinedEntry = {
  key: string;
  invite: ParsedInvite;
  label: string;
};

export const App = () => {
  // Hosting or joining, from the main process. Hosting is the default and
  // the only mode a browser (no bridge) can be in; null for the frame or two
  // before Electron answers, during which nothing worker-shaped runs — a
  // join window hydrating host tabs against a worker it does not have would
  // fail every resume and then persist the empty result over the stored one.
  const [launch, setLaunch] = useState<LaunchDescriptor | null>(() =>
    bridge() ? null : { mode: "host", invite: null },
  );

  useEffect(() => {
    void bridge()
      ?.launch()
      .then(setLaunch);
  }, []);

  const hosting = launch?.mode === "host";

  // Inside the Electron shell the main process owns the worker and tells us
  // where it is listening; in a browser we fall back to the default port. A
  // joining window is told null — it has no worker — and keeps the fallback,
  // which nothing in join mode ever contacts.
  const [endpoint, setEndpoint] = useState(FALLBACK_ENDPOINT);

  useEffect(() => {
    void bridge()
      ?.workerUrl()
      .then((url) => {
        if (url !== null) {
          setEndpoint(url);
        }
      });
  }, []);

  const { capabilities, remembered, opening, error, open } = useSession(
    endpoint,
    hosting,
  );
  const { theme, toggleTheme } = useTheme();

  const [tabs, setTabs] = useState<SessionSummary[]>([]);
  const [joined, setJoined] = useState<JoinedEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabStatuses, setTabStatuses] = useState<Record<string, TabStatus>>({});
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const hydrated = useRef(false);

  // Hydrated once, from what this window had open last — but a relaunch
  // starts a fresh worker with an empty in-memory session registry, even
  // though the durable event log survives it. A stored SessionSummary
  // trusted directly looked alive (its SSE stream reads straight from the
  // store, registry or not) while every other route — turns, files, compare
  // — 404'd against a session the fresh worker had never heard of. Each
  // stored tab is resumed for real instead, the same way the Open screen's
  // "Carry on with" list already resumes a single session; a tab that fails
  // to resume (the repository moved, a different NOVUS_DB) is dropped
  // rather than kept around looking live while being dead.
  //
  // hydrated.current is set only when an *uncancelled* attempt actually
  // finishes — not synchronously at the top of the effect. Setting it early
  // was tried and is wrong: StrictMode double-invokes this effect (mount,
  // cleanup, mount again), the cleanup cancels the first attempt before its
  // awaits resolve, and if the guard is already permanently true by then, the
  // second invocation never starts a fresh attempt either — the cancelled
  // first one is all that ever ran, its result is discarded, and the
  // persistence effect below then commits that discarded empty result to
  // localStorage, deleting every stored tab on the very first launch. This
  // effect is also keyed on `open`, which is bound to `endpoint` and changes
  // identity once `bridge().workerUrl()` resolves — hydration's first run is
  // always against `FALLBACK_ENDPOINT` before that happens, so a permanent
  // guard set before completion would also strand hydration on the wrong
  // endpoint forever whenever the real one differs. Leaving the guard
  // unset until a real completion means both the StrictMode-cancelled pass
  // and the fallback-endpoint pass simply get superseded by the next
  // invocation, the way a cancelled fetch normally would.
  useEffect(() => {
    // Not until this window knows it is hosting: a joining window has no
    // worker to resume against, and must never reach the persistence effect
    // below with a discarded-empty result to write over the host's tabs.
    if (!hosting) {
      return;
    }

    if (hydrated.current) {
      return;
    }

    const stored = loadStoredTabs();

    if (stored.tabs.length === 0) {
      hydrated.current = true;
      return;
    }

    let cancelled = false;

    void (async () => {
      const resumed: SessionSummary[] = [];

      for (const tab of stored.tabs) {
        // Checked before each resume, not only after the loop finishes: a
        // StrictMode-cancelled pass still has an event loop that keeps
        // running until it awaits something, and without this it issued a
        // real POST /sessions with resume for every stored tab before
        // finally discarding the result — a stale attempt that resumed
        // nothing productive still cost every tab a spurious extra
        // session.created on every launch that double-invokes this effect.
        if (cancelled) {
          break;
        }

        const summary = await open(
          tab.repositoryPath,
          tab.allowWrites,
          tab.allowCommands,
          tab.id,
        );

        if (summary) {
          resumed.push(summary);
        }
      }

      if (cancelled) {
        // A StrictMode-synthetic unmount, or endpoint changed mid-flight —
        // either way this attempt's result is stale, and hydrated.current
        // stays false so whichever invocation actually survives tries again.
        return;
      }

      setTabs(resumed);
      setActiveId(
        resumed.some((tab) => tab.id === stored.activeId)
          ? stored.activeId
          : (resumed.at(-1)?.id ?? null),
      );
      hydrated.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [open, hosting]);

  // Persisted after every change, once hydration has actually run — guarded,
  // or the empty initial state this component renders with for one tick
  // would immediately overwrite what hydration was about to restore.
  useEffect(() => {
    if (!hydrated.current) {
      return;
    }

    try {
      localStorage.setItem(
        TABS_STORAGE_KEY,
        JSON.stringify({ tabs, activeId } satisfies StoredTabs),
      );
    } catch {
      // Non-fatal — tabs just will not survive the next launch.
    }
  }, [tabs, activeId]);

  const openTab = useCallback(
    async (
      repositoryPath: string,
      allowWrites: boolean,
      allowCommands: boolean,
      resume?: string,
    ) => {
      const summary = await open(repositoryPath, allowWrites, allowCommands, resume);

      if (!summary) {
        return;
      }

      setTabs((current) => {
        if (current.some((tab) => tab.id === summary.id)) {
          return current.map((tab) => (tab.id === summary.id ? summary : tab));
        }

        return [...current, summary];
      });
      setActiveId(summary.id);
      setNewTabOpen(false);
    },
    [open],
  );

  // Joining is what opening an invite means — no worker involved, so unlike
  // openTab there is nothing to await: the tab exists immediately and its
  // own connection state says how contacting the host is going.
  const openJoined = useCallback((invite: ParsedInvite) => {
    const entry: JoinedEntry = {
      key: crypto.randomUUID(),
      invite,
      label: invite.kind === "relay" ? "relay" : "joining…",
    };

    setJoined((current) => [...current, entry]);
    setActiveId(entry.key);
    setJoinOpen(false);
  }, []);

  const labelJoined = useCallback((key: string, label: string) => {
    setJoined((current) =>
      current.map((entry) =>
        entry.key === key && entry.label !== label ? { ...entry, label } : entry,
      ),
    );
  }, []);

  const closeJoined = useCallback(
    (key: string) => {
      const index = joined.findIndex((entry) => entry.key === key);

      if (index === -1) {
        return;
      }

      const next = joined.filter((entry) => entry.key !== key);

      setJoined(next);

      if (activeId === key) {
        setActiveId(
          next[index - 1]?.key ?? next[0]?.key ?? tabs.at(-1)?.id ?? null,
        );
      }

      setTabStatuses((current) => {
        if (!(key in current)) {
          return current;
        }

        const nextStatuses = { ...current };
        delete nextStatuses[key];
        return nextStatuses;
      });
    },
    [joined, activeId, tabs],
  );

  // Reads tabs/activeId from the closure rather than setTabs's own updater
  // form, deliberately: calling setActiveId from inside setTabs's updater
  // typechecked and worked, but updaters are supposed to be pure, and
  // StrictMode double-invokes them specifically to catch this — harmless
  // here only because the computed value happened to be identical both
  // times. Reading closure state means closeTab is recreated whenever tabs
  // or activeId change, same cost openTab already pays for depending on
  // open.
  const closeTab = useCallback(
    (id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id);

      if (index === -1) {
        return;
      }

      const next = tabs.filter((tab) => tab.id !== id);

      setTabs(next);

      if (activeId === id) {
        // The tab to its left, falling back to the one that took its place —
        // closing the active tab should land on a neighbour, not jump to
        // whichever tab happens to be first. Joined tabs are the neighbour
        // of last resort.
        setActiveId(
          next[index - 1]?.id ?? next[0]?.id ?? joined.at(-1)?.key ?? null,
        );
      }

      setTabStatuses((current) => {
        if (!(id in current)) {
          return current;
        }

        const nextStatuses = { ...current };
        delete nextStatuses[id];
        return nextStatuses;
      });
    },
    [tabs, activeId, joined],
  );

  const reportStatus = useCallback((id: string, status: TabStatus) => {
    setTabStatuses((current) => {
      const existing = current[id];

      if (
        existing &&
        existing.runStatus === status.runStatus &&
        existing.additions === status.additions &&
        existing.deletions === status.deletions
      ) {
        return current;
      }

      return { ...current, [id]: status };
    });
  }, []);

  const themeToggle = (
    <button
      className="icon-button"
      type="button"
      onClick={toggleTheme}
      title="Switch the display theme — stays on this machine"
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );

  // A quiet secondary action, not a mode: hosting stays the default and the
  // Open screen stays about repositories. Joining is one click for the
  // person who was actually handed an invite.
  const joinButton = (
    <button
      className="icon-button"
      type="button"
      onClick={() => setJoinOpen(true)}
      title="Join another host's mission with an invite link"
    >
      Join
    </button>
  );

  const joinOverlay = joinOpen ? (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setJoinOpen(false);
        }
      }}
    >
      <JoinEntry embedded onJoin={openJoined} prefill={launch?.invite ?? null} />
    </div>
  ) : null;

  if (launch === null) {
    // One frame or two while Electron answers which kind of window this is.
    // Rendering the hosting UI here instead was wrong twice over: it flashes
    // controls a join window must not have, and its effects start talking to
    // a worker that may belong to a different Novus.
    return (
      <div className="shell">
        <header className="titlebar">
          <span className="titlebar__mark">Novus</span>
          <span className="titlebar__spacer" />
        </header>
      </div>
    );
  }

  if (tabs.length === 0 && joined.length === 0) {
    return (
      <div className="shell">
        <header className="titlebar">
          <span className="titlebar__mark">Novus</span>
          <span className="titlebar__spacer" />
          {hosting ? joinButton : null}
          {themeToggle}
        </header>
        {hosting ? (
          <OpenRepository
            onOpen={openTab}
            opening={opening}
            error={error}
            capabilities={capabilities}
            remembered={remembered}
          />
        ) : (
          // A join launch: no worker exists here, so there is no repository
          // to open and no history to carry on with — the one thing this
          // window does is join, and the launch may already carry the link.
          <JoinEntry onJoin={openJoined} prefill={launch.invite} />
        )}
        {joinOverlay}
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="titlebar__mark">Novus</span>
        <div className="tabstrip">
          {tabs.map((tab) => {
            const tabStatus = tabStatuses[tab.id];
            const hasDiff =
              tabStatus !== undefined &&
              (tabStatus.additions > 0 || tabStatus.deletions > 0);

            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                className={`tab${tab.id === activeId ? " tab--active" : ""}`}
                onClick={() => setActiveId(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveId(tab.id);
                  }
                }}
                title={tab.repositoryPath}
              >
                <span className={`tab__dot tab__dot--${dotClass(tabStatus?.runStatus)}`} />
                <span className="tab__label">{basename(tab.repositoryPath)}</span>
                {hasDiff ? (
                  <span className="tab__diffstat">
                    <span className="stat__add">+{tabStatus.additions}</span>
                    <span className="stat__del">−{tabStatus.deletions}</span>
                  </span>
                ) : null}
                <button
                  className="tab__close"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                  title="Close this tab"
                >
                  ×
                </button>
              </div>
            );
          })}
          {joined.map((entry) => {
            const entryStatus = tabStatuses[entry.key];

            return (
              <div
                key={entry.key}
                role="button"
                tabIndex={0}
                className={`tab${entry.key === activeId ? " tab--active" : ""}`}
                onClick={() => setActiveId(entry.key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveId(entry.key);
                  }
                }}
                title="A mission this window joined — it lives on another host"
              >
                <span
                  className={`tab__dot tab__dot--${dotClass(entryStatus?.runStatus)}`}
                />
                <span className="tab__label">⇅ {entry.label}</span>
                <button
                  className="tab__close"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeJoined(entry.key);
                  }}
                  title="Leave this mission"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            className="tab tab--new"
            type="button"
            onClick={() =>
              hosting ? setNewTabOpen(true) : setJoinOpen(true)
            }
            title={
              hosting
                ? "Open another repository in a new tab"
                : "Join another mission"
            }
          >
            +
          </button>
        </div>
        <span className="titlebar__spacer" />
        {hosting ? joinButton : null}
        {themeToggle}
      </header>

      {tabs.map((tab) => (
        <SessionTab
          key={tab.id}
          session={tab}
          endpoint={endpoint}
          active={tab.id === activeId}
          theme={theme}
          onStatus={(status) => reportStatus(tab.id, status)}
          onCloseTab={() => closeTab(tab.id)}
        />
      ))}

      {joined.map((entry) => (
        <JoinedTab
          key={entry.key}
          invite={entry.invite}
          active={entry.key === activeId}
          onStatus={(status) => reportStatus(entry.key, status)}
          onLabel={(label) => labelJoined(entry.key, label)}
        />
      ))}

      {newTabOpen && hosting ? (
        <div
          className="overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setNewTabOpen(false);
            }
          }}
        >
          <OpenRepository
            embedded
            onOpen={openTab}
            opening={opening}
            error={error}
            capabilities={capabilities}
            remembered={remembered}
          />
        </div>
      ) : null}

      {joinOverlay}
    </div>
  );
};
