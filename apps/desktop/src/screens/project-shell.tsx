import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableRepository, Mission, MissionDetailResponse, Organization, User } from "@novus/contracts";
import { novus } from "../bridge";
import { ProjectRoom } from "./project-room";

/** A repository the sidebar presents as a project (D-032 project-first IA). */
export interface Project {
  key: string;
  provider: "github" | "local";
  providerRepoId: string;
  name: string;
  /** Local repositories live on one machine; elsewhere they render dimmed. */
  onThisMachine: boolean;
  missions: Mission[];
}

interface OpenedRepo {
  provider: "github" | "local";
  providerRepoId: string;
  name: string;
}

interface LocalRepo {
  providerRepoId: string;
  name: string;
  defaultBranch: string;
  onThisMachine: boolean;
}

type GithubMenuLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; repositories: AvailableRepository[] }
  | { kind: "error"; message: string };

const keyOf = (provider: string, providerRepoId: string) => `${provider}:${providerRepoId}`;

/**
 * The project-first shell (D-032): projects sidebar on the left — attention
 * lens, then repositories — and the selected project's room as the primary
 * region. GitHub repositories are fetched only when Add project opens.
 */
export function ProjectShell({ user, org }: { user: User; org: Organization }) {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [details, setDetails] = useState<Record<string, MissionDetailResponse>>({});
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([]);
  const [opened, setOpened] = useState<OpenedRepo[]>([]);
  const [offline, setOffline] = useState(false);
  const [selection, setSelection] = useState<{ projectKey: string; missionId: string | null } | null>(null);
  const [menu, setMenu] = useState<"closed" | "root" | "github">("closed");
  const [githubMenu, setGithubMenu] = useState<GithubMenuLoad>({ kind: "idle" });
  const [addLocalError, setAddLocalError] = useState<string | null>(null);
  const footRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const [missionsResult, localResult] = await Promise.all([
      novus().missions.list(),
      novus().repos.localList()
    ]);
    if (missionsResult.ok) {
      setOffline(false);
      setMissions(missionsResult.value);
      const detailResults = await Promise.all(
        missionsResult.value.map((mission) => novus().missions.get(mission.missionId))
      );
      setDetails((prev) => {
        const next = { ...prev };
        for (const result of detailResults) {
          if (result.ok) next[result.value.mission.missionId] = result.value;
        }
        return next;
      });
    } else if (missionsResult.code === "offline") {
      setOffline(true);
    } else {
      setMissions((prev) => prev ?? []);
    }
    if (localResult.ok) setLocalRepos(localResult.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [offline, refresh]);

  const projects = useMemo(() => {
    const map = new Map<string, Project>();
    const ensure = (
      provider: "github" | "local",
      providerRepoId: string,
      name: string,
      onThisMachine: boolean
    ): Project => {
      const key = keyOf(provider, providerRepoId);
      const existing = map.get(key);
      if (existing) return existing;
      const project: Project = { key, provider, providerRepoId, name, onThisMachine, missions: [] };
      map.set(key, project);
      return project;
    };
    for (const repo of localRepos) ensure("local", repo.providerRepoId, repo.name, repo.onThisMachine);
    for (const mission of missions ?? []) {
      const repo = mission.repository;
      if (!repo) continue;
      // A local repo not in localList (list unavailable) is honestly "not here".
      ensure(repo.provider, repo.providerRepoId, repo.name, repo.provider === "github").missions.push(mission);
    }
    for (const repo of opened) ensure(repo.provider, repo.providerRepoId, repo.name, repo.provider === "github");
    for (const project of map.values()) {
      project.missions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return [...map.values()];
  }, [missions, localRepos, opened]);

  // Needs attention: the only attention state that exists today is a failed
  // mission branch (PRODUCT.md has no other realized attention states yet).
  const attention = useMemo(
    () =>
      (missions ?? []).filter(
        (mission) => details[mission.missionId]?.workstream?.branchStatus === "failed"
      ),
    [missions, details]
  );

  // Keep a project selected whenever one exists; never a dead canvas.
  useEffect(() => {
    if (projects.length === 0) {
      if (selection) setSelection(null);
      return;
    }
    const first = projects[0];
    if (first && (!selection || !projects.some((project) => project.key === selection.projectKey))) {
      setSelection({ projectKey: first.key, missionId: first.missions[0]?.missionId ?? null });
    }
  }, [projects, selection]);

  const selectedProject = selection
    ? projects.find((project) => project.key === selection.projectKey) ?? null
    : null;

  // Keyboard: ⌘T new tab in the project, ⌘1–9 switch workstream tabs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !selectedProject) return;
      if (event.key === "t") {
        event.preventDefault();
        setSelection({ projectKey: selectedProject.key, missionId: null });
      } else if (/^[1-9]$/.test(event.key)) {
        const mission = selectedProject.missions[Number(event.key) - 1];
        if (mission) {
          event.preventDefault();
          setSelection({ projectKey: selectedProject.key, missionId: mission.missionId });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedProject]);

  // The add-project menu closes on Escape and on any click outside it.
  useEffect(() => {
    if (menu === "closed") return;
    const onDown = (event: MouseEvent) => {
      if (!footRef.current?.contains(event.target as Node)) setMenu("closed");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu("closed");
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = () => {
    setAddLocalError(null);
    setMenu((current) => (current === "closed" ? "root" : "closed"));
  };

  // GitHub repositories are fetched lazily, only when the user asks (D-032).
  const openGithubMenu = async () => {
    setMenu("github");
    setGithubMenu({ kind: "loading" });
    const result = await novus().repos.available();
    if (result.ok) setGithubMenu({ kind: "loaded", repositories: result.value });
    else if (result.code === "offline") {
      setGithubMenu({ kind: "error", message: "Can't reach Novus. Check your connection." });
    } else {
      // Includes repo_unconfigured: the honest state, verbatim.
      setGithubMenu({ kind: "error", message: result.message });
    }
  };

  const openGithubProject = (repo: AvailableRepository) => {
    setOpened((prev) =>
      prev.some((candidate) => candidate.providerRepoId === repo.providerRepoId && candidate.provider === "github")
        ? prev
        : [...prev, { provider: "github", providerRepoId: repo.providerRepoId, name: repo.name }]
    );
    setSelection({ projectKey: keyOf("github", repo.providerRepoId), missionId: null });
    setMenu("closed");
  };

  const addLocalFolder = async () => {
    setAddLocalError(null);
    const result = await novus().repos.addLocal();
    if (!result.ok) {
      setAddLocalError(result.message);
      return;
    }
    if (result.value === null) {
      // The user cancelled the picker; nothing happened and nothing is wrong.
      setMenu("closed");
      return;
    }
    setMenu("closed");
    setSelection({ projectKey: keyOf("local", result.value.providerRepoId), missionId: null });
    await refresh();
  };

  const selectProject = (project: Project) => {
    setSelection({ projectKey: project.key, missionId: project.missions[0]?.missionId ?? null });
  };

  const openAttention = (mission: Mission) => {
    const repo = mission.repository;
    if (!repo) return;
    setSelection({ projectKey: keyOf(repo.provider, repo.providerRepoId), missionId: mission.missionId });
  };

  const handleSelectTab = useCallback((missionId: string | null) => {
    setSelection((prev) => (prev ? { projectKey: prev.projectKey, missionId } : prev));
  }, []);

  const handleDetail = useCallback((detail: MissionDetailResponse) => {
    setDetails((prev) => ({ ...prev, [detail.mission.missionId]: detail }));
  }, []);

  const handleCreated = useCallback((detail: MissionDetailResponse) => {
    setMissions((prev) => (prev ? [...prev, detail.mission] : [detail.mission]));
    setDetails((prev) => ({ ...prev, [detail.mission.missionId]: detail }));
    const repo = detail.mission.repository;
    if (repo) {
      setSelection({
        projectKey: keyOf(repo.provider, repo.providerRepoId),
        missionId: detail.mission.missionId
      });
    }
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="brand">Novus</span>
        <span className="spacer" />
        <span className="identity-mark" title={`${user.login} · ${org.name}`}>
          {user.login.slice(0, 2)}
        </span>
        <button className="btn btn-text" onClick={() => novus().auth.signOut()}>
          Sign out
        </button>
      </header>

      {offline && (
        <div className="notice-bar" data-testid="offline" aria-live="polite">
          <span className="status-dot warn" />
          Can&apos;t reach Novus — retrying.
        </div>
      )}

      <div className="project-shell" data-testid="project-shell">
        <aside className="sidebar" data-testid="sidebar">
          <div className="sidebar-scroll">
            {attention.length > 0 && (
              <>
                <div className="group-label">
                  Needs attention <span className="side-count">{attention.length}</span>
                </div>
                {attention.map((mission) => (
                  <button
                    key={mission.missionId}
                    className="side-row"
                    onClick={() => openAttention(mission)}
                    title={mission.goal}
                    data-testid="attention-row"
                  >
                    <span className="status-dot danger" />
                    <span className="side-name">{mission.goal}</span>
                  </button>
                ))}
              </>
            )}

            <div className="group-label">Projects</div>
            {missions === null && !offline && (
              <div data-testid="sidebar-loading">
                <div className="placeholder-block" />
                <div className="placeholder-block" />
                <div className="placeholder-block" />
              </div>
            )}
            {projects.map((project) => {
              const away = project.provider === "local" && !project.onThisMachine;
              const selected = selection?.projectKey === project.key;
              return (
                <div key={project.key} className="side-group">
                  <button
                    className={`side-row${selected ? " selected" : ""}${away ? " away" : ""}`}
                    onClick={() => selectProject(project)}
                    title={away ? "On another machine" : project.name}
                    aria-current={selected}
                    data-testid="project-row"
                  >
                    <span className="side-name">{project.name}</span>
                    {project.missions.length > 0 && (
                      <span className="side-count">{project.missions.length}</span>
                    )}
                  </button>
                  {/* An open project shows its workstreams inline: the tabs and
                      the rail name the same things (D-032). */}
                  {selected &&
                    project.missions.map((mission) => (
                      <button
                        key={mission.missionId}
                        className={`side-row side-child${
                          selection?.missionId === mission.missionId ? " selected" : ""
                        }`}
                        onClick={() =>
                          setSelection({ projectKey: project.key, missionId: mission.missionId })
                        }
                        title={mission.goal}
                        data-testid="workstream-row"
                      >
                        <span className="side-name">{mission.goal}</span>
                      </button>
                    ))}
                </div>
              );
            })}
            {missions !== null && projects.length === 0 && (
              <p className="side-empty">No projects yet.</p>
            )}
          </div>

          <div className="sidebar-foot" ref={footRef}>
            {menu !== "closed" && (
              <div className="menu" role="menu" data-testid="add-menu">
                {menu === "root" && (
                  <>
                    <button className="menu-item" role="menuitem" onClick={() => void openGithubMenu()} data-testid="menu-github">
                      From GitHub…
                    </button>
                    <button className="menu-item" role="menuitem" onClick={() => void addLocalFolder()} data-testid="menu-local">
                      Local folder…
                    </button>
                    {addLocalError && (
                      <p className="menu-note inline-error" role="alert" data-testid="add-local-error">
                        {addLocalError}
                      </p>
                    )}
                  </>
                )}
                {menu === "github" && (
                  <>
                    {githubMenu.kind === "loading" && <p className="menu-note">Loading repositories…</p>}
                    {githubMenu.kind === "error" && (
                      <p className="menu-note" data-testid="gh-error">{githubMenu.message}</p>
                    )}
                    {githubMenu.kind === "loaded" && githubMenu.repositories.length === 0 && (
                      <p className="menu-note">No repositories are available to this organization yet.</p>
                    )}
                    {githubMenu.kind === "loaded" &&
                      githubMenu.repositories.map((repo) => (
                        <button
                          key={repo.providerRepoId}
                          className="menu-item"
                          role="menuitem"
                          onClick={() => openGithubProject(repo)}
                          data-testid="gh-repo"
                        >
                          {repo.name}
                        </button>
                      ))}
                  </>
                )}
              </div>
            )}
            <button className="btn btn-text add-project" onClick={openMenu} data-testid="add-project">
              + Add project
            </button>
          </div>
        </aside>

        <section className="room-area">
          {selectedProject && selection ? (
            <ProjectRoom
              key={selectedProject.key}
              project={selectedProject}
              details={details}
              selectedMissionId={selection.missionId}
              onSelectTab={handleSelectTab}
              onDetail={handleDetail}
              onCreated={handleCreated}
            />
          ) : (
            <div className="empty room-empty" data-testid="no-projects">
              <p>No projects yet. Add one from GitHub or a local folder.</p>
              <button className="btn btn-primary" onClick={() => setMenu("root")}>
                Add project
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
