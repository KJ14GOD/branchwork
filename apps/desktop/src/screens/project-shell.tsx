import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Mission, MissionDetailResponse, Organization, User } from "@novus/contracts";
import { novus } from "../bridge";
import { AddProjectDialog, type PickedRepository } from "../components/add-project-dialog";
import { HumanMark } from "../components/identity";
import { RunControl } from "../components/run-control";
import { WorkspaceSetupDialog } from "../components/workspace-setup";
import { truncateLabel } from "../format";
import { ProjectRoom } from "./project-room";
import { Inspector, type InspectorSection } from "../components/inspector";


/**
 * The other half of an invitation. Somebody who has been sent a token has no
 * project, no mission, and nothing to click — so this lives beside Add project
 * in the rail, which is the only place a person with an empty Novus looks.
 */
function JoinDialog({ onJoined, onClose }: { onJoined: () => void; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const redeem = async () => {
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const result = await novus().invites.redeem(value);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onJoined();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog join-dialog" role="dialog" aria-label="Join a mission" data-testid="join-dialog">
        <h2 className="dialog-title">Join a mission</h2>
        <p className="quiet">
          Paste the invitation someone sent you. It works once, and it names the role you join with.
        </p>
        <input
          ref={inputRef}
          className="input"
          value={token}
          placeholder="Invitation"
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void redeem();
          }}
          aria-label="Invitation"
          data-testid="join-token"
        />
        {error && (
          <p className="inline-error" role="alert" data-testid="join-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void redeem()}
            disabled={busy || token.trim().length === 0}
            data-testid="join-submit"
          >
            Join mission
          </button>
        </div>
      </div>
    </>
  );
}

function PanelGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M10 2.75v10.5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "twisty-glyph open" : "twisty-glyph"}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

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
  const [joinOpen, setJoinOpen] = useState(false);
  /** The setup dialog is held here because two surfaces open the same one: the
   *  state line's action inside the room, and the Run control beside it. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** The docked evidence panel. Held here because its toggle lives in the top
   *  bar and because the panel outlives the workstream tab beneath it. */
  const [inspector, setInspector] = useState<InspectorSection | null>(null);
  /** Reopening returns to whatever section you were last reading. */
  const lastSection = useRef<InspectorSection>("overview");
  /** Which projects are showing their workstreams. Disclosure is the reader's
   *  choice and survives selection moving elsewhere. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
      setExpanded((prev) => new Set(prev).add(first.key));
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

  // A dialog about one workstream's workspace must not survive a move to
  // another workstream.
  useEffect(() => {
    setSetupOpen(false);
  }, [selection?.missionId]);

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

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectProject = (project: Project) => {
    setExpanded((prev) => new Set(prev).add(project.key));
    setSelection({ projectKey: project.key, missionId: project.missions[0]?.missionId ?? null });
    setRailOpen(false);
  };

  /**
   * Clicking anywhere on a project row opens it — the name is the control, not
   * just the arrow beside it. Clicking the project you are already reading
   * closes it again, so one target both reveals and hides.
   */
  const openProject = (project: Project) => {
    const showing = expanded.has(project.key) && selection?.projectKey === project.key;
    if (showing) {
      toggleExpanded(project.key);
      return;
    }
    selectProject(project);
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
      const key = keyOf(repo.provider, repo.providerRepoId);
      setSelection({ projectKey: key, missionId: mission.missionId });
      // A workstream you just created should be visible in the rail, not
      // hidden behind a project that never opened.
      setExpanded((prev) => new Set(prev).add(key));
    }
  }, []);

  const openMission = selection?.missionId ? details[selection.missionId] : undefined;

  return (
    <div className="shell-split">
      <div className="shell-column">
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
        {/* The room's workspace controls: one Run control beside the evidence
            toggle, in the corner that belongs to the mission. Not a toolbar,
            and not a second navigation (DESIGN.md#component-behavior). */}
        {openMission && (
          <RunControl detail={openMission} onSetup={() => setSetupOpen(true)} />
        )}
        <button
          className={inspector ? "icon-button active" : "icon-button"}
          onClick={() =>
            setInspector((current) => {
              if (current) {
                lastSection.current = current;
                return null;
              }
              return lastSection.current;
            })
          }
          aria-pressed={inspector !== null}
          aria-label={inspector ? "Hide the evidence panel" : "Show the evidence panel"}
          title={inspector ? "Hide details" : "Show details"}
          disabled={!selectedProject || selection?.missionId === null}
          data-testid="panel-toggle"
        >
          <PanelGlyph />
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
              const open = expanded.has(project.key);
              return (
                <div key={project.key} className="side-group">
                  <div className={`side-row side-parent${selected ? " selected" : ""}${away ? " away" : ""}`}>
                    {/* Disclosure and selection are separate acts: you can look
                        inside a project without leaving the one you are in. */}
                    <button
                      className="side-twisty"
                      onClick={() => toggleExpanded(project.key)}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`}
                      disabled={project.missions.length === 0}
                      data-testid="project-twisty"
                    >
                      <Chevron open={open} />
                    </button>
                    <button
                      className="side-open"
                      onClick={() => openProject(project)}
                      title={away ? "On another machine" : project.name}
                      aria-current={selected}
                      data-testid="project-row"
                    >
                      <span className="side-name">{project.name}</span>
                      {project.missions.length > 0 && (
                        <span className="side-count">{project.missions.length}</span>
                      )}
                    </button>
                  </div>
                  {/* An open project shows its workstreams inline: the tabs and
                      the rail name the same things (D-032). */}
                  {open &&
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
            <button
              className="btn btn-text add-project"
              onClick={() => setJoinOpen(true)}
              data-testid="join-mission"
            >
              Join with invitation
            </button>
            <div className="sidebar-identity">
              <HumanMark login={user.login} name={user.name} />
              <span className="sidebar-login">{user.login}</span>
              <button
                className="btn btn-text"
                onClick={() => novus().auth.signOut()}
                data-testid="sign-out"
              >
                Sign out
              </button>
            </div>
          </div>
        </aside>

        {joinOpen && (
          <JoinDialog
            onClose={() => setJoinOpen(false)}
            onJoined={() => {
              setJoinOpen(false);
              void refresh();
            }}
          />
        )}

        {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}

        <section className="room-area">
          {selectedProject && selection ? (
            <ProjectRoom
              key={selectedProject.key}
              project={selectedProject}
              details={details}
              selectedMissionId={selection.missionId}
              onInspector={setInspector}
              onSetup={() => setSetupOpen(true)}
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

      {setupOpen && openMission && selectedProject && (
        <WorkspaceSetupDialog
          key={openMission.mission.missionId}
          missionId={openMission.mission.missionId}
          /* A workspace is prepared where the repository is. Anywhere else the
             dialog says so rather than offering a control that cannot work
             (D-042). */
          preparableHere={selectedProject.provider === "local" && selectedProject.onThisMachine}
          onClose={() => setSetupOpen(false)}
        />
      )}
      </div>

      {/* Full height, hard against the right edge: the panel owns that corner
          of the window, including the identity and control it reports on. */}
      {inspector && openMission && (
        <Inspector
          detail={openMission}
          section={inspector}
          onSection={setInspector}
          onClose={() => setInspector(null)}
          onDetail={handleDetail}
          onRevoke={() => void novus().control.revoke(openMission.mission.missionId)}
        />
      )}
    </div>
  );
}
