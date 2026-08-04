import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Mission, MissionDetailResponse, Organization, User } from "@novus/contracts";
import { novus } from "../bridge";
import { AddProjectDialog, type PickedRepository } from "../components/add-project-dialog";
import { HumanMark } from "../components/identity";
import { MissionTabs } from "../components/mission-tabs";
import { RunControl } from "../components/run-control";
import { TerminalToggle } from "../components/runtime-dock";
import { WorkspaceSetupDialog } from "../components/workspace-setup";
import {
  activeTab as activeTabOf,
  closeTab,
  closeTabs,
  emptyWorkingSet,
  openDraft,
  openMission,
  promoteDraft,
  readWorkingSet,
  selectTab,
  tabIsGone,
  writeWorkingSet,
  type OpenTab,
  type WorkingSet
} from "../components/working-set";
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

const mintTabId = (): string => crypto.randomUUID();

/**
 * The project-first shell (D-032): projects sidebar on the left — attention
 * lens, then repositories — and the selected project's room as the primary
 * region (≥55% of the width, DESIGN.md#layout). Below 1200px the sidebar
 * becomes an overlay; below 900px the room stands alone.
 *
 * Across the top of both sits the working set: the missions this person
 * currently has open (working-set.ts). The rail answers "what missions are
 * there"; the strip answers "which am I in right now", and they are different
 * questions with different answers — a project with nine missions and none open
 * puts nothing in the strip.
 */
export function ProjectShell({ user, org }: { user: User; org: Organization }) {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [details, setDetails] = useState<Record<string, MissionDetailResponse>>({});
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([]);
  /** Which repositories this machine actually holds a checkout for — a folder
   *  somebody picked or one the runner fetched, which are the same thing once
   *  it is here (D-025, D-032). */
  const [checkedOutHere, setCheckedOutHere] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<OpenedRepo[]>([]);
  const [offline, setOffline] = useState(false);
  /** The missions this person has open, and which one they are reading. */
  const [workingSet, setWorkingSet] = useState<WorkingSet>(emptyWorkingSet);
  /** Restoration reads the store and asks the server about every mission in it
   *  before anything is allowed to open a room, or a relaunch would open a
   *  first mission over the ones the person actually left open. */
  const [restored, setRestored] = useState(false);
  /** Which project the rail is showing, for the case where nothing is open. */
  const [railProject, setRailProject] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  /** Why filing one away was refused — most often because it is still working. */
  const [archiveError, setArchiveError] = useState<string | null>(null);
  /** The Archived view: read on demand, because it is not the rail's job. */
  const [archived, setArchived] = useState<Mission[] | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  /** The setup dialog is held here because two surfaces open the same one: the
   *  state line's action inside the room, and the Run control beside it. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** The docked evidence panel. Held here because its toggle lives in the top
   *  bar and because the panel outlives the mission selected beside it. */
  const [inspector, setInspector] = useState<InspectorSection | null>(null);
  /** The bottom terminal dock, closed by default. Held here for the same
   *  reason: its toggle sits with the other workspace controls. */
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Reopening returns to whatever section you were last reading. */
  const lastSection = useRef<InspectorSection>("overview");
  /**
   * Files opened from the panel, and which one is showing (D-048), **per open
   * mission**. Switching missions must put back exactly the files that mission
   * had open, because a room you return to should be the room you left.
   *
   * The rule for closing: a mission tab's file view is *local view state*, so
   * closing the tab discards it. Nothing is lost that the machine does not
   * still hold — the files are on disk and the panel lists them — and the
   * alternative, remembering which files a closed room had open forever, is a
   * store that only ever grows and that nobody asked for. Reopening a mission
   * therefore opens its trace, which is what the room is for.
   */
  const [filesByTab, setFilesByTab] = useState<Record<string, string[]>>({});
  const [activeFileByTab, setActiveFileByTab] = useState<Record<string, string | null>>({});
  /** Which projects are showing their missions. Disclosure is the reader's
   *  choice and survives selection moving elsewhere. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const addTriggerRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const [missionsResult, archivedResult, localResult, checkoutResult] = await Promise.all([
      novus().missions.list(),
      novus().missions.list("archived"),
      novus().repos.localList(),
      novus().repos.checkedOutHere()
    ]);
    if (archivedResult.ok) setArchived(archivedResult.value);
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
    if (checkoutResult.ok) setCheckedOutHere(new Set(checkoutResult.value));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [offline, refresh]);

  // The rail reports on every mission, including the ones nobody has open. A
  // mission whose tab was closed goes on running, and the attention lens is
  // where that is visible — so the list and its states are re-read on a slow
  // timer rather than once at mount.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

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
    const here = (providerRepoId: string): boolean => checkedOutHere.has(providerRepoId);
    for (const repo of localRepos) ensure("local", repo.providerRepoId, repo.name, repo.onThisMachine);
    for (const mission of missions ?? []) {
      const repo = mission.repository;
      if (!repo) continue;
      // Whether the work can happen *here* is one question with one answer:
      // does this machine hold the checkout? A GitHub repository the runner has
      // not fetched yet honestly does not, and says so.
      ensure(repo.provider, repo.providerRepoId, repo.name, here(repo.providerRepoId)).missions.push(mission);
    }
    for (const repo of opened) ensure(repo.provider, repo.providerRepoId, repo.name, here(repo.providerRepoId));
    for (const project of map.values()) {
      project.missions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return [...map.values()];
  }, [missions, localRepos, opened, checkedOutHere]);

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

  const storageKey = `novus-open-missions:${user.userId}`;

  // Relaunch: the missions that were open come back, and the one that was
  // showing comes back selected. A mission that has since been deleted, or one
  // this person may no longer see, is dropped from local tab state — quietly,
  // because a tab that cannot open is not an error a person did anything to
  // cause, and never by failing to render the shell.
  useEffect(() => {
    let live = true;
    const stored = readWorkingSet(storageKey, mintTabId);
    if (stored.tabs.length === 0) {
      setRestored(true);
      return;
    }
    void (async () => {
      const verdicts = await Promise.all(
        stored.tabs.map(async (tab) => {
          if (tab.missionId === null) return { id: tab.id, gone: false };
          const result = await novus().missions.get(tab.missionId);
          return { id: tab.id, gone: !result.ok && tabIsGone(result.code) };
        })
      );
      if (!live) return;
      const survivors = closeTabs(
        stored,
        verdicts.filter((verdict) => verdict.gone).map((verdict) => verdict.id)
      );
      setWorkingSet(survivors);
      // The rail comes back agreeing with the window: the projects whose rooms
      // are open are disclosed, and the one being read is the one selected.
      setExpanded((previous) => {
        const next = new Set(previous);
        for (const tab of survivors.tabs) next.add(tab.projectKey);
        return next;
      });
      const showing = activeTabOf(survivors);
      if (showing) setRailProject(showing.projectKey);
      setRestored(true);
    })();
    return () => {
      live = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!restored) return;
    writeWorkingSet(storageKey, workingSet);
  }, [restored, storageKey, workingSet]);

  const active = activeTabOf(workingSet);
  const currentProjectKey = active?.projectKey ?? railProject;
  const currentProject = currentProjectKey
    ? (projects.find((project) => project.key === currentProjectKey) ?? null)
    : null;
  const activeMissionId = active?.missionId ?? null;

  const forgetTabFiles = useCallback((tabId: string) => {
    setFilesByTab((previous) => {
      if (!(tabId in previous)) return previous;
      const next = { ...previous };
      delete next[tabId];
      return next;
    });
    setActiveFileByTab((previous) => {
      if (!(tabId in previous)) return previous;
      const next = { ...previous };
      delete next[tabId];
      return next;
    });
  }, []);

  const openMissionTab = useCallback((projectKey: string, missionId: string) => {
    setWorkingSet((previous) => openMission(previous, missionId, projectKey, mintTabId));
    setRailProject(projectKey);
    setExpanded((previous) => new Set(previous).add(projectKey));
    setRailOpen(false);
  }, []);

  const openDraftTab = useCallback((projectKey: string) => {
    setWorkingSet((previous) => openDraft(previous, projectKey, mintTabId));
    setRailProject(projectKey);
    setRailOpen(false);
  }, []);

  /** Closing removes the room from the working set and nothing else: the
   *  mission keeps running, keeps its history, and keeps its place in the rail
   *  (working-set.ts). An unsent draft has nowhere else to be, so closing it
   *  discards that draft — and only that draft. */
  const closeMissionTab = useCallback(
    (tab: OpenTab) => {
      setWorkingSet((previous) => closeTab(previous, tab.id));
      forgetTabFiles(tab.id);
    },
    [forgetTabFiles]
  );

  /** Whichever repository the person is in: the room they are reading, or the
   *  project the rail is showing when nothing is open. */
  const newMissionHere = useCallback(() => {
    if (currentProjectKey) {
      openDraftTab(currentProjectKey);
      return;
    }
    // No repository to create in yet, so the honest next step is choosing one.
    setDialogOpen(true);
  }, [currentProjectKey, openDraftTab]);

  // Keep somewhere to be whenever a project exists; never a dead canvas.
  useEffect(() => {
    if (!restored) return;
    if (projects.length === 0) {
      if (railProject !== null) setRailProject(null);
      return;
    }
    if (railProject !== null && !projects.some((project) => project.key === railProject)) {
      setRailProject(projects[0]?.key ?? null);
      return;
    }
    if (workingSet.tabs.length > 0 || railProject !== null) return;
    const first = projects[0];
    if (!first) return;
    const firstMission = first.missions[0];
    if (firstMission) openMissionTab(first.key, firstMission.missionId);
    else openDraftTab(first.key);
  }, [restored, projects, railProject, workingSet.tabs.length, openMissionTab, openDraftTab]);

  // Keyboard: ⌘T a new mission in the repository you are in, ⌘1–9 the rail's
  // missions for that project (DESIGN.md#keyboard).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "t") {
        event.preventDefault();
        newMissionHere();
      } else if (/^[1-9]$/.test(event.key)) {
        if (!currentProject) return;
        const mission = currentProject.missions[Number(event.key) - 1];
        if (mission) {
          event.preventDefault();
          openMissionTab(currentProject.key, mission.missionId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentProject, newMissionHere, openMissionTab]);

  // A dialog about one mission's workspace must not survive a move to
  // another mission.
  useEffect(() => {
    setSetupOpen(false);
  }, [active?.id]);

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
    openDraftTab(keyOf(picked.provider, picked.providerRepoId));
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
    setRailProject(project.key);
    setRailOpen(false);
    // Opening a project lands you in it: the room you last had open there, its
    // first mission, or — for a project with none — a draft.
    const alreadyOpen = workingSet.tabs.find((tab) => tab.projectKey === project.key);
    if (alreadyOpen) {
      setWorkingSet((previous) => selectTab(previous, alreadyOpen.id));
      return;
    }
    const firstMission = project.missions[0];
    if (firstMission) openMissionTab(project.key, firstMission.missionId);
    else openDraftTab(project.key);
  };

  /**
   * Clicking anywhere on a project row opens it — the name is the control, not
   * just the arrow beside it. Clicking the project you are already reading
   * closes it again, so one target both reveals and hides.
   */
  const openProject = (project: Project) => {
    const showing = expanded.has(project.key) && currentProjectKey === project.key;
    if (showing) {
      toggleExpanded(project.key);
      return;
    }
    selectProject(project);
  };

  const openAttention = (mission: Mission) => {
    const repo = mission.repository;
    if (!repo) return;
    openMissionTab(keyOf(repo.provider, repo.providerRepoId), mission.missionId);
  };


  const handleDetail = useCallback((detail: MissionDetailResponse) => {
    setDetails((prev) => ({ ...prev, [detail.mission.missionId]: detail }));
  }, []);

  // A newly created mission joins the list, and the draft the person typed into
  // becomes that mission's tab in place — not a second tab beside it.
  const handleCreated = useCallback((mission: Mission) => {
    setMissions((prev) => (prev ? [...prev, mission] : [mission]));
    const repo = mission.repository;
    if (!repo) return;
    const key = keyOf(repo.provider, repo.providerRepoId);
    setWorkingSet((previous) => {
      const current = activeTabOf(previous);
      if (current && current.missionId === null && current.projectKey === key) {
        return promoteDraft(previous, current.id, mission.missionId);
      }
      return openMission(previous, mission.missionId, key, mintTabId);
    });
    setRailProject(key);
    // A mission you just created should be visible in the rail, not
    // hidden behind a project that never opened.
    setExpanded((prev) => new Set(prev).add(key));
  }, []);

  const openDetail = activeMissionId ? details[activeMissionId] : undefined;

  /** What the server said this viewer may do in that mission. Absent until its
   *  detail has been read, which is the honest answer to "may I" — so the
   *  control is not offered rather than being offered and refused. */
  const capabilitiesFor = (missionId: string): readonly string[] =>
    details[missionId]?.capabilities ?? [];

  /**
   * Files a mission away (D-063). Not deletion, and not a tab close: the tab is
   * closed too, because a room whose mission has left the list is a room the
   * rail no longer offers a way back to — but that is a consequence, not the act.
   */
  const archiveMission = async (mission: Mission) => {
    setArchiveError(null);
    const result = await novus().missions.archive(mission.missionId);
    if (!result.ok) {
      setArchiveError(result.message);
      return;
    }
    setWorkingSet((previous) => {
      const tab = previous.tabs.find((entry) => entry.missionId === mission.missionId);
      return tab ? closeTab(previous, tab.id) : previous;
    });
    await refresh();
  };

  const restoreMission = async (missionId: string) => {
    setArchiveError(null);
    const result = await novus().missions.restore(missionId);
    if (!result.ok) {
      setArchiveError(result.message);
      return;
    }
    await refresh();
  };
  const openFiles = active ? (filesByTab[active.id] ?? []) : [];
  const activeFile = active ? (activeFileByTab[active.id] ?? null) : null;

  const labelOf = useCallback(
    (tab: OpenTab): string => {
      if (tab.missionId === null) return "New mission";
      const mission = (missions ?? []).find((candidate) => candidate.missionId === tab.missionId);
      return mission?.goal ?? "Mission";
    },
    [missions]
  );

  const projectNameOf = useCallback(
    (tab: OpenTab): string =>
      projects.find((project) => project.key === tab.projectKey)?.name ?? tab.projectKey,
    [projects]
  );

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
        {openDetail && openDetail.workstream && (
          <RunControl detail={openDetail} onSetup={() => setSetupOpen(true)} />
        )}
        {/* Beside Run and the evidence toggle, never a second navigation. It
            stays visible and disabled when the workspace is on someone else's
            machine, saying why in words (D-042). */}
        <TerminalToggle
          open={terminalOpen}
          onToggle={() => setTerminalOpen((open) => !open)}
          availableHere={currentProject?.onThisMachine === true}
          disabled={activeMissionId === null}
        />
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
          disabled={activeMissionId === null}
          data-testid="panel-toggle"
        >
          <PanelGlyph />
        </button>
      </header>

      {offline && (
        <div className="notice-bar" data-testid="offline" aria-live="polite">
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
              const selected = currentProjectKey === project.key;
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
                    {/* Quiet until you are on the row or on the control itself,
                        because a rail is nouns and counts. The click is stopped
                        here deliberately: the row around it opens a project and
                        closes the one already showing, and starting a mission is
                        neither of those. */}
                    <button
                      className="side-new-mission"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDraftTab(project.key);
                      }}
                      aria-label={`New mission in ${project.name}`}
                      title={`New mission in ${project.name}`}
                      data-testid="repo-new-mission"
                    >
                      +
                    </button>
                  </div>
                  {/* An open project discloses its missions inline, and this is
                      the only place every mission is listed (D-055). The strip
                      above carries the ones that are open, which is a different
                      list and usually a much shorter one. */}
                  {open &&
                    project.missions.map((mission) => (
                      <div
                        key={mission.missionId}
                        className={`side-row side-child${
                          activeMissionId === mission.missionId ? " selected" : ""
                        }`}
                        data-testid="mission-row"
                      >
                        <button
                          className="side-open-mission"
                          onClick={() => openMissionTab(project.key, mission.missionId)}
                          title={mission.goal}
                        >
                          <span className="side-name">{truncateLabel(mission.goal, 26)}</span>
                        </button>
                        {/* One quiet control, revealed on hover or focus. A
                            permanent icon on every row would put a destructive-
                            looking mark beside work nobody is filing away, and
                            most rows are never filed away (D-063). */}
                        {capabilitiesFor(mission.missionId).includes("mission.archive") && (
                          <button
                            className="side-row-archive"
                            onClick={() => void archiveMission(mission)}
                            aria-label={`Archive ${mission.goal}`}
                            title={`Archive ${mission.goal}`}
                            data-testid="mission-archive"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    ))}
                  {open && (
                    <button
                      className={`side-row side-child side-new${
                        selected && activeMissionId === null && active !== null ? " selected" : ""
                      }`}
                      onClick={() => openDraftTab(project.key)}
                      title="New mission (⌘T)"
                      data-testid="new-mission"
                    >
                      <span className="side-name">New mission</span>
                    </button>
                  )}
                </div>
              );
            })}
            {/* Archived: not a place things go to be forgotten, so it says how
                many there are and opens on asking. Everything in it is intact
                and one control away from coming back (D-063). */}
            {archived !== null && archived.length > 0 && (
              <div className="side-group" data-testid="archived-group">
                <div className="side-head">ARCHIVED</div>
                {archived.map((mission) => (
                  <div key={mission.missionId} className="side-row side-child" data-testid="archived-row">
                    <span className="side-name">{truncateLabel(mission.goal, 26)}</span>
                    <button
                      className="side-row-archive"
                      onClick={() => void restoreMission(mission.missionId)}
                      aria-label={`Restore ${mission.goal}`}
                      title={`Restore ${mission.goal}`}
                      data-testid="mission-restore"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
            {archiveError && (
              <p className="inline-error" role="alert" data-testid="archive-error">
                {archiveError}
              </p>
            )}
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
          {/* The working set sits above the *room*, not above the window: the
              rail is its own full-height column and nothing overlaps it. Absent
              while nothing is open. */}
          {workingSet.tabs.length > 0 && (
            <MissionTabs
              tabs={workingSet.tabs}
              activeId={workingSet.activeId}
              labelOf={labelOf}
              projectOf={projectNameOf}
              onSelect={(tab) => setWorkingSet((previous) => selectTab(previous, tab.id))}
              onClose={closeMissionTab}
              onNew={newMissionHere}
            />
          )}
          {active && currentProject ? (
            <ProjectRoom
              key={active.id}
              project={currentProject}
              details={details}
              selectedMissionId={active.missionId}
              onInspector={setInspector}
              onSetup={() => setSetupOpen(true)}
              onDetail={handleDetail}
              onCreated={handleCreated}
              terminalOpen={terminalOpen}
              openFiles={openFiles}
              activeFile={activeFile}
              onSelectFile={(path) =>
                setActiveFileByTab((previous) => ({ ...previous, [active.id]: path }))
              }
              onCloseFile={(path) => {
                setFilesByTab((previous) => ({
                  ...previous,
                  [active.id]: (previous[active.id] ?? []).filter((entry) => entry !== path)
                }));
                setActiveFileByTab((previous) =>
                  previous[active.id] === path ? { ...previous, [active.id]: null } : previous
                );
              }}
            />
          ) : currentProject ? (
            // Nothing open in this project. The rail lists what there is; this
            // says how to start one, without asking anybody to find a control
            // by hovering.
            <div className="empty room-empty" data-testid="no-mission-open">
              <p>
                {currentProject.missions.length === 0
                  ? "No missions yet. Start one when you have work worth doing together."
                  : `Nothing open in ${currentProject.name}. Choose a mission in the rail, or start one.`}
              </p>
              <button
                className="btn btn-primary"
                onClick={() => openDraftTab(currentProject.key)}
                data-testid="empty-new-mission"
              >
                New mission
              </button>
            </div>
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

      {setupOpen && openDetail && currentProject && (
        <WorkspaceSetupDialog
          key={openDetail.mission.missionId}
          missionId={openDetail.mission.missionId}
          /* A workspace is prepared where the repository is. Anywhere else the
             dialog says so rather than offering a control that cannot work
             (D-042). */
          preparableHere={currentProject.onThisMachine}
          onClose={() => setSetupOpen(false)}
        />
      )}
      </div>

      {/* Full height, hard against the right edge: the panel owns that corner
          of the window, including the identity and control it reports on. */}
      {inspector && openDetail && active && (
        <Inspector
          detail={openDetail}
          section={inspector}
          onSection={setInspector}
          hostedHere={currentProject?.onThisMachine === true}
          openPath={activeFile}
          onOpenFile={(path) => {
            setFilesByTab((previous) => {
              const current = previous[active.id] ?? [];
              return current.includes(path)
                ? previous
                : { ...previous, [active.id]: [...current, path] };
            });
            setActiveFileByTab((previous) => ({ ...previous, [active.id]: path }));
          }}
          onClose={() => setInspector(null)}
          onDetail={handleDetail}
          onRevoke={() => void novus().control.revoke(openDetail.mission.missionId)}
        />
      )}
    </div>
  );
}
