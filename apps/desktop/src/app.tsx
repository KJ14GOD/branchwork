import { useCallback, useEffect, useRef, useState } from "react";

import { SessionSummarySchema, type SessionSummary } from "@novus/contracts/protocol";

import { bridge } from "./bridge.ts";
import { OpenRepository } from "./components/open-repository.tsx";
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

export const App = () => {
  // Inside the Electron shell the main process owns the worker and tells us
  // where it is listening; in a browser we fall back to the default port.
  const [endpoint, setEndpoint] = useState(FALLBACK_ENDPOINT);

  useEffect(() => {
    void bridge()
      ?.workerUrl()
      .then(setEndpoint);
  }, []);

  const { capabilities, remembered, opening, error, open } = useSession(endpoint);
  const { theme, toggleTheme } = useTheme();

  const [tabs, setTabs] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabStatuses, setTabStatuses] = useState<Record<string, TabStatus>>({});
  const [newTabOpen, setNewTabOpen] = useState(false);
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
  }, [open]);

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
        // whichever tab happens to be first.
        setActiveId(next[index - 1]?.id ?? next[0]?.id ?? null);
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
    [tabs, activeId],
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
      className="titlebar__action"
      type="button"
      onClick={toggleTheme}
      title="Switch the display theme — stays on this machine"
    >
      {theme === "dark" ? "light" : "dark"}
    </button>
  );

  if (tabs.length === 0) {
    return (
      <div className="shell">
        <header className="titlebar">
          <span className="titlebar__mark">Novus</span>
          <span className="titlebar__spacer" />
          {themeToggle}
        </header>
        <OpenRepository
          onOpen={openTab}
          opening={opening}
          error={error}
          capabilities={capabilities}
          remembered={remembered}
        />
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
          <button
            className="tab tab--new"
            type="button"
            onClick={() => setNewTabOpen(true)}
            title="Open another repository in a new tab"
          >
            +
          </button>
        </div>
        <span className="titlebar__spacer" />
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

      {newTabOpen ? (
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
    </div>
  );
};
