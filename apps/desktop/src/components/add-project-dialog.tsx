import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableRepository, Organization, User } from "@novus/contracts";
import { agoLabel } from "../format";
import { novus } from "../bridge";

export interface PickedRepository {
  provider: "github" | "local";
  providerRepoId: string;
  name: string;
}

interface Row {
  /** Never rendered: provider ids are machinery, not labels. */
  id: string;
  provider: "github" | "local";
  /** The repository's own name — the primary line. */
  primary: string;
  /** The default branch, quietly beside the name (D-139). */
  branch: string;
  /** The group heading a github row files under; local rows have none. */
  owner: string | null;
  /** When the host last saw a push — freshest first (D-139). */
  pushedAt: string | null;
  name: string;
  available: boolean;
}

type Load<T> =
  | { kind: "loading" }
  | { kind: "loaded"; value: T }
  | { kind: "error"; code: string; message: string };

type Source = "github" | "local";

/** Who these repositories are being listed for. A personal organization is
 *  named after its owner, so it is never printed twice. */
function githubIdentity(user: User, org: Organization): string {
  const login = user.login.trim();
  const orgName = org.name.trim();
  const same = orgName.toLowerCase() === login.toLowerCase();
  return same ? `Signed in as ${login}` : `Signed in as ${login} · ${orgName}`;
}

function githubRow(repo: AvailableRepository): Row {
  const slash = repo.name.lastIndexOf("/");
  const owner = slash > 0 ? repo.name.slice(0, slash) : null;
  const bare = slash > 0 ? repo.name.slice(slash + 1) : repo.name;
  return {
    id: repo.providerRepoId,
    provider: "github",
    primary: bare,
    branch: repo.defaultBranch,
    owner,
    pushedAt: repo.pushedAt,
    name: repo.name,
    available: true
  };
}

/**
 * Add project (DESIGN.md#primitives Dialog, D-032). A real dialog with a fixed
 * header, a fixed contextual action row, and one scrollable region between
 * them: search and actions never scroll away, however many repositories exist.
 *
 * Opening a GitHub repository does not create a mission and does not survive a
 * relaunch, so the action says what it does — Open repository — instead of
 * implying a durable "Add".
 */
export function AddProjectDialog({
  user,
  org,
  onOpen,
  onLocalAdded,
  onClose
}: {
  user: User;
  org: Organization;
  onOpen: (picked: PickedRepository) => void;
  onLocalAdded: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>("github");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [github, setGithub] = useState<Load<AvailableRepository[]>>({ kind: "loading" });
  const [local, setLocal] = useState<Load<Row[]>>({ kind: "loading" });
  const [localNote, setLocalNote] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadGithub = useCallback(async () => {
    setGithub({ kind: "loading" });
    const result = await novus().repos.available();
    setGithub(
      result.ok
        ? { kind: "loaded", value: result.value }
        : { kind: "error", code: result.code, message: result.message }
    );
  }, []);

  const loadLocal = useCallback(async () => {
    setLocal({ kind: "loading" });
    const result = await novus().repos.localList();
    setLocal(
      result.ok
        ? {
            kind: "loaded",
            value: result.value.map((repo) => ({
              id: repo.providerRepoId,
              provider: "local" as const,
              primary: repo.name,
              branch: repo.onThisMachine ? repo.defaultBranch : "on another machine",
              owner: null,
              pushedAt: null,
              name: repo.name,
              available: repo.onThisMachine
            }))
          }
        : { kind: "error", code: result.code, message: result.message }
    );
  }, []);

  useEffect(() => {
    void loadGithub();
    void loadLocal();
  }, [loadGithub, loadLocal]);

  // The search field takes focus the moment the dialog opens.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Esc closes and focus is trapped (DESIGN.md#keyboard: every dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const rows = useMemo<Row[]>(() => {
    const all =
      source === "github"
        ? github.kind === "loaded"
          ? github.value.map(githubRow)
          : []
        : local.kind === "loaded"
          ? local.value
          : [];
    // Freshest first, grouped by owner (D-139): owners ordered by their most
    // recently pushed repository, repositories within an owner the same way.
    const at = (row: Row) => (row.pushedAt ? Date.parse(row.pushedAt) : 0);
    const freshestOfOwner = new Map<string, number>();
    for (const row of all) {
      const key = row.owner ?? "";
      freshestOfOwner.set(key, Math.max(freshestOfOwner.get(key) ?? 0, at(row)));
    }
    const sorted = [...all].sort((a, b) => {
      const ownerA = a.owner ?? "";
      const ownerB = b.owner ?? "";
      if (ownerA !== ownerB) {
        const byFresh = (freshestOfOwner.get(ownerB) ?? 0) - (freshestOfOwner.get(ownerA) ?? 0);
        return byFresh !== 0 ? byFresh : ownerA.localeCompare(ownerB);
      }
      const byTime = at(b) - at(a);
      return byTime !== 0 ? byTime : a.primary.localeCompare(b.primary);
    });
    const needle = query.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((row) => row.name.toLowerCase().includes(needle));
  }, [source, github, local, query]);

  useEffect(() => {
    setActive(0);
  }, [source, query]);

  // The focused result is always in view, whatever moved the selection.
  useEffect(() => {
    const row = rows[active];
    if (!row) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"]`)?.scrollIntoView({
      block: "nearest"
    });
  }, [active, rows]);

  const open = (row: Row | undefined) => {
    if (!row || !row.available) return;
    onOpen({ provider: row.provider, providerRepoId: row.id, name: row.name });
  };

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const page = 8;
    const last = rows.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((current) => Math.min(current + 1, last));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(Math.max(last, 0));
        break;
      case "PageDown":
        event.preventDefault();
        setActive((current) => Math.min(current + page, last));
        break;
      case "PageUp":
        event.preventDefault();
        setActive((current) => Math.max(current - page, 0));
        break;
      case "Enter":
        event.preventDefault();
        open(rows[active]);
        break;
      default:
        break;
    }
  };

  const chooseFolder = async () => {
    setLocalNote(null);
    setPicking(true);
    const result = await novus().repos.addLocal();
    setPicking(false);
    if (!result.ok) {
      setLocalNote(result.message);
      return;
    }
    if (result.value === null) {
      // Cancelling the picker is not an error; nothing happened.
      setLocalNote("No folder chosen.");
      return;
    }
    await onLocalAdded();
    onOpen({ provider: "local", providerRepoId: result.value.providerRepoId, name: result.value.name });
  };

  const load = source === "github" ? github : local;
  const activeRow = rows[active];

  return (
    <>
      <div className="scrim" onClick={onClose} data-testid="dialog-scrim" />
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        ref={panelRef}
        data-testid="add-project-dialog"
      >
        <div className="dialog-head">
          <h2 id="add-project-title" className="dialog-title">
            Add project
          </h2>
          <div className="segment" role="tablist" aria-label="Repository source">
            {(["github", "local"] as const).map((option) => (
              <button
                key={option}
                role="tab"
                aria-selected={source === option}
                className={source === option ? "segment-tab active" : "segment-tab"}
                onClick={() => setSource(option)}
                data-testid={`source-${option}`}
              >
                {option === "github" ? "GitHub" : "On this Mac"}
              </button>
            ))}
          </div>
          <p className="dialog-context" data-testid="dialog-context">
            {source === "github" ? githubIdentity(user, org) : "Folders you have opened on this Mac"}
          </p>
          <input
            ref={searchRef}
            className="input dialog-search"
            placeholder="Search repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search repositories"
            aria-controls="add-project-results"
            aria-activedescendant={activeRow ? `repo-${activeRow.id}` : undefined}
            data-testid="repo-search"
          />
        </div>

        <div className="dialog-results" id="add-project-results" role="listbox" ref={listRef} aria-label="Repositories">
          {load.kind === "loading" && (
            <div data-testid="repo-loading">
              <div className="placeholder-block" />
              <div className="placeholder-block" />
              <div className="placeholder-block" />
            </div>
          )}
          {load.kind === "error" && (
            <div className="dialog-state" data-testid="repo-error">
              <p className="dialog-state-title">
                {load.code === "offline"
                  ? "Can't reach Novus"
                  : load.code === "repo_unconfigured"
                    ? "GitHub App not installed"
                    : load.code === "forbidden" || load.code === "repo_forbidden"
                      ? "Not enough repository permission"
                      : "Repositories are unavailable"}
              </p>
              <p className="dialog-state-body">{load.message}</p>
              <button
                className="btn btn-secondary"
                onClick={() => void (source === "github" ? loadGithub() : loadLocal())}
                data-testid="repo-retry"
              >
                Try again
              </button>
            </div>
          )}
          {load.kind === "loaded" && rows.length === 0 && (
            <div className="dialog-state" data-testid="repo-empty">
              <p className="dialog-state-title">
                {query.trim()
                  ? "No repositories match that search"
                  : source === "github"
                    ? "No repositories are available to this organization yet"
                    : "No folders opened on this Mac yet"}
              </p>
              {!query.trim() && source === "local" && (
                <p className="dialog-state-body">Choose a folder to work in a repository on this machine.</p>
              )}
            </div>
          )}
          {load.kind === "loaded" &&
            rows.map((row, index) => (
              <Fragment key={`${row.provider}:${row.id}`}>
                {row.owner !== null && (index === 0 || rows[index - 1]?.owner !== row.owner) && (
                  <div className="repo-owner" aria-hidden="true">
                    {row.owner}
                  </div>
                )}
                <div
                  id={`repo-${row.id}`}
                  data-row-id={row.id}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={!row.available}
                  className={`repo-row${index === active ? " active" : ""}${row.available ? "" : " away"}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setActive(index);
                  }}
                  onClick={() => open(row)}
                  data-testid="repo-row"
                >
                  <span className="repo-row-primary">{row.primary}</span>
                  <span className="repo-row-branch">{row.branch}</span>
                  {index === active ? (
                    <span className="repo-row-open">Open ↵</span>
                  ) : (
                    row.pushedAt && <span className="repo-row-time">{agoLabel(row.pushedAt, Date.now())}</span>
                  )}
                </div>
              </Fragment>
            ))}
        </div>

        <div className="dialog-actions">
          <span className="dialog-keys" aria-hidden="true">
            <span className="dialog-key">↑↓</span> navigate <span className="dialog-key">↵</span> open{" "}
            <span className="dialog-key">esc</span> close
          </span>
          {source === "local" && (
            <button
              className="btn btn-secondary"
              onClick={() => void chooseFolder()}
              disabled={picking}
              data-testid="choose-folder"
            >
              Choose folder…
            </button>
          )}
          {localNote && source === "local" && (
            <span className="dialog-note" role="status" data-testid="local-note">
              {localNote}
            </span>
          )}
          <span className="dialog-spacer" />
          <button className="btn btn-text" onClick={onClose} data-testid="dialog-cancel">
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => open(activeRow)}
            disabled={!activeRow?.available}
            data-testid="open-repository"
          >
            Open repository
          </button>
        </div>
      </div>
    </>
  );
}
