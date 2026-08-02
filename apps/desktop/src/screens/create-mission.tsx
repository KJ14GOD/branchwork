import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableRepository, BaseRevision, Mission, Workstream } from "@novus/contracts";
import { novus } from "../bridge";

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

type RepoLoad =
  | { kind: "loading" }
  | { kind: "loaded"; repositories: AvailableRepository[] }
  | { kind: "unavailable"; message: string }
  | { kind: "offline" };

type BaseLoad =
  | { kind: "resolving" }
  | { kind: "resolved"; base: BaseRevision }
  | { kind: "failed"; message: string };

/**
 * The mission-creation flow: pick a repository, see the exact base revision
 * the mission branch will start from, then state the goal. One dialog, two
 * steps. The creationKey is minted once when the flow opens and reused on
 * retry, so a retried submission can never mint a second mission (D-031).
 */
export function CreateMissionDialog({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (mission: Mission, workstream: Workstream) => void;
}) {
  const [creationKey] = useState(() => crypto.randomUUID());
  const [repos, setRepos] = useState<RepoLoad>({ kind: "loading" });
  const [repo, setRepo] = useState<AvailableRepository | null>(null);
  const [base, setBase] = useState<BaseLoad>({ kind: "resolving" });
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const goalRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // DESIGN.md dialog contract: focus moves in on open, Tab is trapped, and
  // focus is restored to the opener on close (Reviewer E).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"
        ) ?? []
      );
    const first = focusables()[0];
    first?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const head = items[0] as HTMLElement;
      const tail = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (event.shiftKey && (active === head || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (active === tail || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        head.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      opener?.focus();
    };
  }, []);

  const loadRepos = useCallback(async () => {
    setRepos({ kind: "loading" });
    const result = await novus().repos.available();
    if (result.ok) setRepos({ kind: "loaded", repositories: result.value });
    else if (result.code === "repo_unconfigured") setRepos({ kind: "unavailable", message: result.message });
    else if (result.code === "offline") setRepos({ kind: "offline" });
    else setRepos({ kind: "unavailable", message: result.message });
  }, []);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickRepo = async (candidate: AvailableRepository) => {
    setRepo(candidate);
    setBase({ kind: "resolving" });
    setError(null);
    const result = await novus().repos.base(candidate.providerRepoId);
    if (result.ok) {
      setBase({ kind: "resolved", base: result.value });
      goalRef.current?.focus();
      return;
    }
    setBase({
      kind: "failed",
      message:
        result.code === "offline"
          ? "Can't reach Novus. Check your connection and try again."
          : result.message
    });
  };

  const submit = async () => {
    if (!repo || base.kind !== "resolved") return;
    setSaving(true);
    setError(null);
    const result = await novus().missions.create({
      goal,
      successCriteria: criteria,
      providerRepoId: repo.providerRepoId,
      baseRef: base.base.ref,
      baseSha: base.base.sha,
      creationKey
    });
    setSaving(false);
    if (result.ok) {
      onCreated(result.value.mission, result.value.workstream);
      return;
    }
    setError(
      result.code === "offline"
        ? "Can't reach Novus. Your mission wasn't created — try again when you're back online."
        : result.message
    );
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label="New mission" data-testid="create-dialog">
        <h2>New mission</h2>

        {repo === null && (
          <>
            <div className="field">
              <span className="field-label">Repository</span>
              {repos.kind === "loading" && (
                <div data-testid="repos-loading">
                  <div className="placeholder-block" />
                  <div className="placeholder-block" />
                  <div className="placeholder-block" />
                </div>
              )}
              {repos.kind === "unavailable" && (
                <p className="dialog-note" data-testid="repos-unavailable">
                  {repos.message}
                </p>
              )}
              {repos.kind === "offline" && (
                <div data-testid="repos-offline">
                  <p className="dialog-note">Can&apos;t reach Novus. Check your connection.</p>
                  <button className="btn btn-text" onClick={loadRepos}>
                    Try again
                  </button>
                </div>
              )}
              {repos.kind === "loaded" && repos.repositories.length === 0 && (
                <p className="dialog-note" data-testid="repos-empty">
                  No repositories are available to this organization yet.
                </p>
              )}
              {repos.kind === "loaded" &&
                repos.repositories.map((candidate) => (
                  <button
                    key={candidate.providerRepoId}
                    className="row"
                    onClick={() => pickRepo(candidate)}
                    data-testid="repo-row"
                  >
                    <span>{candidate.name}</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="row-meta mono">{candidate.defaultBranch}</span>
                  </button>
                ))}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-text" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}

        {repo !== null && (
          <>
            <div className="repo-block">
              <span className="repo-label">Repository</span>
              <span className="repo-value" data-testid="chosen-repo">{repo.name}</span>
              <span className="repo-label">Base</span>
              {base.kind === "resolving" && <span className="repo-value dialog-note">Resolving…</span>}
              {base.kind === "failed" && (
                <span className="repo-value">
                  <span className="inline-error" data-testid="base-error">{base.message}</span>{" "}
                  <button className="btn btn-text" onClick={() => pickRepo(repo)}>
                    Try again
                  </button>
                </span>
              )}
              {base.kind === "resolved" && (
                <span className="repo-value mono" data-testid="base-revision" title={base.base.sha}>
                  {base.base.ref} · {shortSha(base.base.sha)}
                </span>
              )}
            </div>
            <div className="field">
              <label className="field-label" htmlFor="mission-goal">Goal</label>
              <input
                id="mission-goal"
                ref={goalRef}
                className="input"
                placeholder="What should this mission accomplish?"
                value={goal}
                maxLength={500}
                onChange={(e) => setGoal(e.target.value)}
                data-testid="goal-input"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="mission-criteria">Success criteria</label>
              <textarea
                id="mission-criteria"
                className="textarea"
                placeholder="How will the team know it's done?"
                value={criteria}
                maxLength={5000}
                onChange={(e) => setCriteria(e.target.value)}
                data-testid="criteria-input"
              />
            </div>
            {error && (
              <div className="inline-error" role="alert" data-testid="create-error">
                {error}
              </div>
            )}
            <div className="dialog-actions">
              <button
                className="btn btn-text"
                onClick={() => {
                  setRepo(null);
                  setError(null);
                }}
                data-testid="back-to-repos"
              >
                Back
              </button>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn btn-text" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={submit}
                disabled={
                  saving ||
                  base.kind !== "resolved" ||
                  goal.trim().length === 0 ||
                  criteria.trim().length === 0
                }
                data-testid="create-submit"
              >
                Create mission
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
