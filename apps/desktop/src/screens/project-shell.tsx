import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Mission, MissionDetailResponse, Organization, User } from "@novus/contracts";
import { novus } from "../bridge";
import { AddProjectDialog, type PickedRepository } from "../components/add-project-dialog";
import { HumanMark } from "../components/identity";
import { truncateLabel } from "../format";
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

const keyOf = (provider: string, providerRepoId: string) => `${provider}:${providerRepoId}`;

/**
 * The project-first shell (D-032): projects sidebar on the left — attention
 * lens, then repositories — and the selected project's room as the primary
 * region (≥55% of the width, DESIGN.md#layout). Below 1200px the sidebar
 * becomes an overlay; below 900px the room stands alone.
 */
export function ProjectShell({ user, org }: { user: User; org: Organization }) {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [details, setDetails] = useState<Record<string, MissionDetailResponse>>({});
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([]);
  const [opened, setOpened] = useState<OpenedRepo[]>([]);
  const [offline, setOffline] = useState(false);
  const [selection, setSelection] = useState<{ projectKey: string; missionId: string | null } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const addTriggerRef = useRef<HTMLButtonElement>(null);

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

  // Needs attention: only states the server actually reports. A mission whose
  // branch failed, or one whose own state says it is waiting on a person.
  const attention = useMemo(
    () =>
      (missions ?? []).filter((mission) => {
        const detail = details[mission.missionId];
        if (!detail) return false;
        if (detail.workstream?.branchStatus === "failed") return true;
        return (
          detail.state === "needs_direction" ||
          detail.state === "needs_approval" ||
          detail.state === "verification_failed" ||
          detail.state === "execution_interrupted"
        );
      }),
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
    ? (projects.find((project) => project.key === selection.projectKey) ?? null)
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

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    // Focus returns to what opened the dialog (DESIGN.md#keyboard).
    addTriggerRef.current?.focus();
  }, []);

  const openPicked = (picked: PickedRepository) => {
    setOpened((prev) =>
      prev.some(
        (candidate) =>
          candidate.providerRepoId === picked.providerRepoId && candidate.provider === picked.provider
      )
        ? prev
        : [...prev, picked]
    );
    setSelection({ projectKey: keyOf(picked.provider, picked.providerRepoId), missionId: null });
    setRailOpen(false);
    closeDialog();
  };

  const selectProject = (project: Project) => {
    setSelection({ projectKey: project.key, missionId: project.missions[0]?.missionId ?? null });
    setRailOpen(false);
  };

  const openAttention = (mission: Mission) => {
    const repo = mission.repository;
    if (!repo) return;
    setSelection({ projectKey: keyOf(repo.provider, repo.providerRepoId), missionId: mission.missionId });
    setRailOpen(false);
  };

  const handleSelectTab = useCallback((missionId: string | null) => {
    setSelection((prev) => (prev ? { projectKey: prev.projectKey, missionId } : prev));
  }, []);

  const handleDetail = useCallback((detail: MissionDetailResponse) => {
    setDetails((prev) => ({ ...prev, [detail.mission.missionId]: detail }));
  }, []);

  // A newly created mission joins the list and takes focus; its detail arrives
  // from the room's own poll, so nothing here has to invent one.
  const handleCreated = useCallback((mission: Mission) => {
    setMissions((prev) => (prev ? [...prev, mission] : [mission]));
    const repo = mission.repository;
    if (repo) {
      setSelection({
        projectKey: keyOf(repo.provider, repo.providerRepoId),
        missionId: mission.missionId
      });
    }
  }, []);

  return (
    <>
      <header className="topbar">
        <button
          className="btn btn-text rail-toggle"
          onClick={() => setRailOpen((open) => !open)}
          aria-expanded={railOpen}
          data-testid="rail-toggle"
        >
          Projects
        </button>
        <span className="brand">Novus</span>
        <span className="spacer" />
        <HumanMark login={user.login} name={user.name} />
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

      <div className={railOpen ? "project-shell rail-open" : "project-shell"} data-testid="project-shell">
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
                    <span className="status-dot warn" />
                    <span className="side-name">{truncateLabel(mission.goal, 24)}</span>
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
                        <span className="side-name">{truncateLabel(mission.goal, 26)}</span>
                      </button>
                    ))}
                </div>
              );
            })}
            {missions !== null && projects.length === 0 && (
              <p className="side-empty">No projects yet.</p>
            )}
          </div>

          <div className="sidebar-foot">
            <button
              ref={addTriggerRef}
              className="btn btn-text add-project"
              onClick={() => setDialogOpen(true)}
              data-testid="add-project"
            >
              + Add project
            </button>
          </div>
        </aside>

        {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}

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
              <p>No projects yet. Open one from GitHub or a folder on this Mac.</p>
              <button className="btn btn-primary" onClick={() => setDialogOpen(true)}>
                Add project
              </button>
            </div>
          )}
        </section>
      </div>

      {dialogOpen && (
        <AddProjectDialog
          user={user}
          org={org}
          onOpen={openPicked}
          onLocalAdded={refresh}
          onClose={closeDialog}
        />
      )}
    </>
  );
}
