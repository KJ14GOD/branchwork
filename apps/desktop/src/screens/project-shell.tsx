import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Effort,
  type Mission,
  type ModelId,
  type MissionDetailResponse,
  type Organization,
  type Session,
  type User,
  type Workstream
} from "@novus/contracts";
import { novus } from "../bridge";
import { AddProjectDialog, type PickedRepository } from "../components/add-project-dialog";
import { Composer } from "../components/composer";
import { Dialog } from "../components/dialog";
import { HumanMark, SignOutGlyph } from "../components/identity";
import { MissionTabs } from "../components/mission-tabs";
import { ColumnHandle, useColumnWidth } from "../components/resizable";
import { RunControl } from "../components/run-control";
import { TerminalToggle } from "../components/runtime-dock";
import { WorkspaceSetupDialog } from "../components/workspace-setup";
import { ThemeControl } from "../components/settings";
import {
  activeTab as activeTabOf,
  closeSession,
  closeTab,
  closeTabs,
  emptyWorkingSet,
  openMission,
  openMissionAt,
  promoteDraft,
  openSession,
  readWorkingSet,
  reorderSession,
  selectLane,
  selectSession,
  selectTab,
  tabIsGone,
  writeWorkingSet,
  type OpenTab,
  type WorkingSet
} from "../components/working-set";
import {
  boardColumnOf,
  laneView,
  liveRunProcess,
  sessionActivity,
  sessionNeedsYou,
  type BoardColumnId
} from "../components/derive";
import { HomeBoard } from "../components/home-board";
import { PREVIEW_TAB_KEY, PULL_TAB_KEY, type OpenPreviewTab } from "../components/preview";
import { deriveGoal, plural, truncateLabel } from "../format";
import { ProjectRoom } from "./project-room";
import { Inspector, type InspectorSection } from "../components/inspector";


/**
 * The other half of an invitation. Somebody who has been sent a token has no
 * project, no mission, and nothing to click — so this lives beside Add project
 * in the rail, which is the only place a person with an empty Novus looks.
 */
/**
 * The missions that have been filed away.
 *
 * Behind a control rather than in the rail, because that is what filing
 * something away means: it is out of the list, and taking it back out is a
 * deliberate act you go and perform (D-063). A permanent Archived section with
 * a Restore beside every row would make putting something away and getting it
 * back equally easy, and then archival is just a second list.
 */
function ArchivedDialog({
  missions,
  error,
  restoringMissionId,
  onRestore,
  onClose
}: {
  missions: Mission[];
  error: string | null;
  restoringMissionId: string | null;
  onRestore: (missionId: string) => Promise<void>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog" role="dialog" aria-label="Archived missions" data-testid="archived-dialog">
        <div className="dialog-head">
          <h2 className="dialog-title">Archived</h2>
          <p className="quiet">
            {plural(missions.length, "mission")}, kept whole. Restoring one puts it back in its project
            with every direction, checkpoint and decision exactly where it was.
          </p>
        </div>
        <div className="archived-list">
          {missions.map((mission) => (
            <div key={mission.missionId} className="archived-entry" data-testid="archived-row">
              <span className="archived-goal">{mission.goal}</span>
              <span className="archived-meta">
                {mission.repository?.name ?? "local"}
                {mission.archivedByLogin ? ` · filed by ${mission.archivedByLogin}` : ""}
              </span>
              <button
                className="btn btn-text archived-restore"
                onClick={() => void onRestore(mission.missionId)}
                disabled={restoringMissionId !== null}
                aria-busy={restoringMissionId === mission.missionId}
                data-testid="mission-restore"
              >
                {restoringMissionId === mission.missionId ? "Restoring…" : "Restore"}
              </button>
            </div>
          ))}
        </div>
        {error && (
          <p className="inline-error archived-error" role="alert" data-testid="restore-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn btn-text" onClick={onClose} data-testid="archived-close">
            Close
          </button>
        </div>
      </div>
    </>
  );
}

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

/** The rail's own switch: a pane with its left column marked. */
/**
 * Finding a mission by name, across every project (D-066).
 *
 * Deliberately missions and not code: the rail's job is getting to a room, and
 * a box there that searched file contents would be a different feature wearing
 * the same control. Files are filtered where the files are.
 */
function SearchDialog({
  missions,
  onOpen,
  onClose
}: {
  missions: { missionId: string; goal: string; project: string }[];
  onOpen: (missionId: string) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  /** Which row Enter would open. Arrow keys move it; the pointer moves it too,
   *  so the keyboard and the mouse never disagree about what is selected. */
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needle = term.trim().toLowerCase();
  const found =
    needle === ""
      ? missions
      : missions.filter(
          (mission) =>
            mission.goal.toLowerCase().includes(needle) || mission.project.toLowerCase().includes(needle)
        );
  const cursor = Math.min(active, Math.max(0, found.length - 1));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="dialog palette" role="dialog" aria-label="Find a mission" data-testid="search-dialog">
        {/* One line, no box. A field drawn as a box inside a dialog is a box
            inside a box, and the glyph already says what the line is for. */}
        <div className="palette-query">
          <SearchGlyph />
          <input
            ref={inputRef}
            className="palette-input"
            value={term}
            placeholder="Find a mission"
            onChange={(event) => {
              setTerm(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                setActive((index) => Math.min(index + 1, found.length - 1));
                event.preventDefault();
              } else if (event.key === "ArrowUp") {
                setActive((index) => Math.max(index - 1, 0));
                event.preventDefault();
              } else if (event.key === "Enter" && found[cursor]) {
                onOpen(found[cursor].missionId);
              }
            }}
            aria-label="Find a mission"
            data-testid="search-input"
          />
          <kbd className="palette-hint">esc</kbd>
        </div>

        {found.length > 0 && (
          <div className="palette-results" role="listbox" aria-label="Missions">
            <div className="palette-group">Missions</div>
            {found.map((mission, index) => (
              <button
                key={mission.missionId}
                role="option"
                aria-selected={index === cursor}
                className={index === cursor ? "palette-hit active" : "palette-hit"}
                onMouseEnter={() => setActive(index)}
                onClick={() => onOpen(mission.missionId)}
                data-testid="search-hit"
              >
                <span className="palette-name">{mission.goal}</span>
                <span className="palette-where">{mission.project}</span>
              </button>
            ))}
          </div>
        )}

        {found.length === 0 && (
          <p className="palette-empty" data-testid="search-empty">
            No mission here is called that.
          </p>
        )}
      </div>
    </>
  );
}

function HomeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.75 8 2.5l5.5 4.25v6a.75.75 0 0 1-.75.75h-9a.75.75 0 0 1-.75-.75z" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="7.25" cy="7.25" r="4.25" />
      <path d="m10.5 10.5 2.75 2.75" />
    </svg>
  );
}

function SidebarGlyph() {
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
      <path d="M6.25 2.75v10.5" />
    </svg>
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
/**
 * The active mission's structure, nested where its project is (D-084): one row
 * per approach, the selected approach's sessions one level deeper, Compare at
 * the mission level once there are two approaches to compare. Rows are
 * navigation — this tree is what the room's lane and session tabs used to be —
 * and it renders nothing at all for the ordinary mission of one approach and
 * one conversation.
 */
function MissionTree({
  detail,
  storedLaneId,
  storedSessionId,
  decisionOpen,
  sessionDraft,
  mayDirect,
  onSelectApproach,
  onSelectSession,
  onCompare,
  onNewSession,
  pullSelected,
  onOpenPull,
  forkable,
  onFork
}: {
  detail: MissionDetailResponse;
  storedLaneId: string | null;
  storedSessionId: string | null;
  decisionOpen: boolean;
  sessionDraft: boolean;
  mayDirect: boolean;
  onSelectApproach: (workstreamId: string | null) => void;
  onSelectSession: (sessionId: string) => void;
  onCompare: () => void;
  onNewSession: () => void;
  /** The pull request's rail row (D-100): present once one exists, opening
   *  its tab on the working row. */
  pullSelected: boolean;
  onOpenPull: () => void;
  /** Whether this lane can fork (a shared checkpoint exists, the role carries
   *  approach.create, and the mission is not terminal) — computed by the
   *  shell from the same detail the room reads (D-126). */
  forkable: boolean;
  onFork: () => void;
}) {
  const lanes: Workstream[] = detail.workstreams;
  const firstLaneId = lanes[0]?.workstreamId ?? null;
  const selectedLaneId = storedLaneId ?? firstLaneId;
  const laneSessions: Session[] = detail.sessions.filter(
    (session) => session.workstreamId === selectedLaneId
  );
  // No conversation selected no longer means "reading the first" (D-089): it
  // means the approach's own page, so no session row washes and the approach
  // row does instead.
  const storedSelection =
    storedSessionId !== null && laneSessions.some((session) => session.sessionId === storedSessionId)
      ? storedSessionId
      : null;
  // The canvas lands straight in a lane's only conversation (D-089), so the
  // wash follows it there; with several, null means the approach's own page.
  const selectedSessionId =
    storedSelection ?? (laneSessions.length === 1 ? (laneSessions[0]?.sessionId ?? null) : null);
  const showSessions = laneSessions.length > 0 || sessionDraft;

  // One wash in the rail: the deepest thing the canvas is showing. The tree
  // always renders for the active mission (D-126): Mission → Approach → Chat
  // is the structure, and hiding it for the ordinary mission hid the product.
  const washSession = !decisionOpen && !sessionDraft && showSessions;
  const washApproach =
    !decisionOpen && !sessionDraft && (!showSessions || selectedSessionId === null);

  // The selected approach's conversations — rendered directly beneath its own
  // row, never after the last approach, or the first lane's sessions read as
  // the last lane's children (found by eye in live use, 2026-08-08).
  const sessionRows = showSessions
    ? laneSessions.map((session) => {
        const selected = session.sessionId === selectedSessionId && !sessionDraft;
        // Every chat's own word on its row (D-094): needs you in the warn
        // tone, working and queued quietly, idle as nothing at all. The
        // selected row says nothing — its state is the room's state line.
        const activity = selected ? null : sessionActivity(detail, session.sessionId);
        const needs = activity?.state === "needs_you";
        return (
          <div
            key={session.sessionId}
            className={`side-row side-session${selected && washSession ? " selected" : ""}`}
            data-testid="rail-session-row"
            data-session={session.sessionId}
          >
            <button
              className="side-open-mission"
              onClick={() => onSelectSession(session.sessionId)}
              aria-current={selected}
              title={session.title ?? "New session"}
            >
              <span className={session.title === null ? "side-name side-untitled" : "side-name"}>
                {truncateLabel(session.title ?? "New session", 24)}
              </span>
              {activity?.label && (
                <span className={needs ? "tone-warn side-needs" : "side-needs side-state"}>
                  {" "}
                  · {activity.label}
                </span>
              )}
            </button>
          </div>
        );
      })
    : null;
  /* The conversation being asked for: nothing exists yet, and leaving creates
     nothing — the row only mirrors the canvas (D-077, D-083). */
  const draftRow = sessionDraft ? (
    <div className="side-row side-session selected" data-testid="rail-session-draft">
      <span className="side-open-mission">
        <span className="side-name side-untitled">New session</span>
      </span>
    </div>
  ) : null;

  return (
    <div className="side-tree" data-testid="mission-tree">
      {lanes.map((lane, index) => {
          const selected = lane.workstreamId === selectedLaneId;
          const needs =
            !selected &&
            detail.sessions
              .filter((session) => session.workstreamId === lane.workstreamId)
              .some((session) => sessionNeedsYou(detail, session.sessionId));
          return (
            <Fragment key={lane.workstreamId}>
              <div
                className={`side-row side-approach${selected && washApproach ? " selected" : ""}`}
                data-testid="rail-approach-row"
                data-workstream={lane.workstreamId}
              >
                <button
                  className="side-open-mission"
                  onClick={() => onSelectApproach(lane.workstreamId === firstLaneId ? null : lane.workstreamId)}
                  aria-current={selected}
                  title={
                    lane.approach
                      ? `${lane.name} — isolated workspace`
                      : `${lane.name} — the work this mission started with`
                  }
                >
                  <span
                    className={index === 0 ? "lane-dot lane-dot-current" : "lane-dot lane-dot-alt"}
                    aria-hidden="true"
                  />
                  <span className="side-name" data-testid={selected ? "lane-context" : undefined}>
                    {lane.name}
                    {lane.approach ? " · isolated workspace" : ""}
                  </span>
                  {needs && <span className="tone-warn side-needs"> · needs you</span>}
                </button>
                {/* A parent's + creates its child, exactly as the project row's
                    does for missions (D-077, D-084). Only on the approach being
                    read: a session starts where you are. */}
                {selected && mayDirect && (
                  <button
                    className="side-new-mission"
                    onClick={(event) => {
                      event.stopPropagation();
                      onNewSession();
                    }}
                    aria-label={`New session in ${lane.name}`}
                    title={`New session in ${lane.name}`}
                    data-testid="rail-new-session"
                  >
                    +
                  </button>
                )}
              </div>
              {/* The branch this approach's work lands on (D-126): machinery,
                  quiet and mono, beneath the approach it belongs to. */}
              {selected && (
                <div className="side-branch" data-testid="rail-branch" title={lane.missionBranch}>
                  {lane.missionBranch}
                </div>
              )}
              {/* Its children, under it and nowhere else. */}
              {selected && sessionRows}
              {selected && draftRow}
            </Fragment>
          );
        })}
      {forkable && (
        <div className="side-row side-fork">
          <button
            className="side-open-mission"
            onClick={onFork}
            data-testid="try-another-approach"
            title="Start from the shared checkpoint and compare another solution"
          >
            <span className="side-name side-fork-name">Try another approach</span>
          </button>
        </div>
      )}
      {lanes.length > 1 && (
        <div
          className={`side-row side-compare${decisionOpen ? " selected" : ""}`}
          data-testid="rail-compare"
        >
          <button className="side-open-mission" onClick={onCompare} aria-current={decisionOpen}>
            <span className="side-name">Compare</span>
            {detail.decisions.some((decision) => decision.supersededAt === null) && (
              <span className="side-decision-note"> · decision recorded</span>
            )}
          </button>
        </div>
      )}
      {detail.pullRequest && (
        <div
          className={`side-row side-compare${pullSelected ? " selected" : ""}`}
          data-testid="rail-pull"
        >
          <button className="side-open-mission" onClick={onOpenPull} aria-current={pullSelected}>
            <span className="side-name">PR #{detail.pullRequest.number}</span>
            <span className="side-decision-note"> · {detail.pullRequest.state}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** One open file tab: a path in one lane's worktree. The lane is stored as
 *  the tab's own fact, so the pane reads the worktree it was opened from even
 *  while the room is switching lanes underneath it (D-084). */
export interface OpenFileTab {
  key: string;
  path: string;
  /** Null means the lane the mission started with, exactly as everywhere. */
  workstreamId: string | null;
}

const fileTabKey = (workstreamId: string | null, path: string): string =>
  `${workstreamId ?? "first"}:${path}`;

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
  /** The same set, readable from inside `refresh` without remaking it: the
   *  rail's slow poll fetches each open mission for the lane its tab is
   *  reading, so the room and the background refresh never disagree about
   *  which lane a mission's cached detail describes (D-080). */
  const workingSetRef = useRef(workingSet);
  workingSetRef.current = workingSet;
  /** Restoration reads the store and asks the server about every mission in it
   *  before anything is allowed to open a room, or a relaunch would open a
   *  first mission over the ones the person actually left open. */
  const [restored, setRestored] = useState(false);
  /** Which project the rail is showing, for the case where nothing is open. */
  const [railProject, setRailProject] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  /** Hidden by choice, at any width — distinct from `railOpen`, which is the
   *  narrow-window overlay. */
  const [railHidden, setRailHidden] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Both side columns are draggable and remember where they were put (D-065).
  const [railWidth, setRailWidth] = useColumnWidth("novus-rail-width", 240, 180, 420);
  const [panelWidth, setPanelWidth] = useColumnWidth("novus-panel-width", 380, 320, 760);
  /** Why filing one away was refused — most often because it is still working. */
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [restoringMissionId, setRestoringMissionId] = useState<string | null>(null);
  /** The Archived view: read on demand, because it is not the rail's job. */
  const [archived, setArchived] = useState<Mission[] | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  /** The setup dialog is held here because two surfaces open the same one: the
   *  state line's action inside the room, and the Run control beside it. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** The rail's Try-another-approach row asks; the room owns the dialog
   *  (D-126). A counter, so every ask opens it even after a cancel. */
  const [forkAsk, setForkAsk] = useState(0);
  /** The docked evidence panel. Held here because its toggle lives in the top
   *  bar and because the panel outlives the mission selected beside it. */
  const [inspector, setInspector] = useState<InspectorSection | null>(null);
  /** One artifact taking the active tab's canvas (D-122) — the worker-view
   *  shape: opened from the Evidence section, closed with Esc or Back. */
  const [openArtifact, setOpenArtifact] = useState<{ tabId: string; artifactId: string } | null>(
    null
  );
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
  /** A file open over one room's canvas — from one lane's worktree, which is
   *  part of its identity: the same path open from two approaches is two tabs,
   *  each wearing its lane's dot (D-084). `key` is lane + path. */
  const [filesByTab, setFilesByTab] = useState<Record<string, OpenFileTab[]>>({});
  const [activeFileByTab, setActiveFileByTab] = useState<Record<string, string | null>>({});
  /** The preview tab per open mission (D-098): at most one, ephemeral exactly
   *  like the file tabs above — the app it shows is a process, not view
   *  state, and reopening a mission reopens its trace. Selection rides
   *  `activeFileByTab` under `PREVIEW_TAB_KEY`, so everything that selects
   *  another canvas already deselects the preview. */
  const [previewByTab, setPreviewByTab] = useState<Record<string, OpenPreviewTab | null>>({});
  /** The pull request's own tab (D-100): opened by a person, per mission,
   *  ephemeral like the file tabs. Content derives from the detail's own
   *  pullRequest; this only remembers that the tab was opened. */
  const [pullOpenByTab, setPullOpenByTab] = useState<Record<string, boolean>>({});
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
        missionsResult.value.map((mission) => {
          const tab = workingSetRef.current.tabs.find((entry) => entry.missionId === mission.missionId);
          return novus().missions.get(mission.missionId, tab?.workstreamId ?? undefined);
        })
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

  // Needs attention: only states the server actually reports. The state read
  // is the mission list's own, which the server projects over **every lane**
  // with attention first (PRODUCT.md#the-mission-state-model) — so a closed
  // mission whose background Alternative is waiting on an approval surfaces
  // here, not only in its own room. Any lane's failed branch counts too, from
  // the detail where one has been read; a detail is no longer required for the
  // state part, so the lens works from the list alone after a reconnect.
  const readingMissionId = activeTabOf(workingSet)?.missionId ?? null;
  const attention = useMemo(
    () =>
      (missions ?? []).filter((mission) => {
        // The mission being read never queues in the lens beside its own rail
        // row (D-126): its state is on screen, and a lens exists for what is
        // NOT being looked at.
        if (mission.missionId === readingMissionId) return false;
        if (
          mission.primaryState === "needs_direction" ||
          mission.primaryState === "needs_approval" ||
          mission.primaryState === "verification_failed" ||
          mission.primaryState === "execution_interrupted"
        ) {
          return true;
        }
        const detail = details[mission.missionId];
        if (!detail) return false;
        return (detail.workstreams.length > 0 ? detail.workstreams : [detail.workstream]).some(
          (lane) => lane?.branchStatus === "failed"
        );
      }),
    [missions, details, readingMissionId]
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

  /** Canvas modes of the active room, driven from the rail's tree (D-084):
   *  Compare opens from its row, a new-session draft from the selected
   *  approach row's `+`. Both are about the room on screen, so any change of
   *  what that room is — tab, lane, or session — quietly ends them. */
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [sessionDraft, setSessionDraft] = useState(false);
  /** A Decided card's click lands on Compare (D-120): the reset below would
   *  otherwise clear the canvas the moment the tab changed, so the intent
   *  rides a ref the reset consumes exactly once. */
  const pendingCompareMission = useRef<string | null>(null);
  useEffect(() => {
    const wantCompare =
      pendingCompareMission.current !== null &&
      active?.missionId === pendingCompareMission.current;
    pendingCompareMission.current = null;
    setDecisionOpen(wantCompare);
    setSessionDraft(false);
  }, [active?.id, active?.missionId, active?.workstreamId, active?.sessionId]);

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

  /**
   * Starting a mission is a question, not a place (D-077): a small dialog asks
   * what Claude should do, Enter with words creates and starts the mission, and
   * Enter with nothing — or Esc, or a click outside — does nothing at all. The
   * permanent "New mission" row this replaces sat in the rail dressed as a
   * mission, and the draft tab it opened sat in the strip dressed as one too.
   */
  const [newMissionIn, setNewMissionIn] = useState<Project | null>(null);
  const openNewMission = useCallback((project: Project) => {
    setNewMissionIn(project);
    setRailProject(project.key);
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
      setPullOpenByTab((previous) => {
        if (!(tab.id in previous)) return previous;
        const next = { ...previous };
        delete next[tab.id];
        return next;
      });
      // The preview tab goes with its mission tab. If the one native view is
      // this tab's, it is asked down too — the process it showed keeps
      // running (D-098). Another mission's view is left alone.
      setPreviewByTab((previous) => {
        const entry = previous[tab.id];
        if (entry === undefined) return previous;
        const next = { ...previous };
        delete next[tab.id];
        void (async () => {
          const status = await novus().workspace.preview.status();
          if (status.ok && status.value !== null && entry !== null && status.value.url === entry.url) {
            await novus().workspace.preview.close();
          }
        })();
        return next;
      });
    },
    [forgetTabFiles]
  );

  /** Whichever repository the person is in: the room they are reading, or the
   *  project the rail is showing when nothing is open. */
  const newMissionHere = useCallback(() => {
    if (currentProject) {
      openNewMission(currentProject);
      return;
    }
    // No repository to create in yet, so the honest next step is choosing one.
    setDialogOpen(true);
  }, [currentProject, openNewMission]);

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
    else setRailProject(first.key);
  }, [restored, projects, railProject, workingSet.tabs.length, openMissionTab]);

  // Keyboard: ⌘T a new mission in the repository you are in, ⌘, Settings —
  // the platform's own chord for it — ⌘1–9 the rail's missions for that
  // project (DESIGN.md#keyboard).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "t") {
        event.preventDefault();
        newMissionHere();
      } else if (event.key === ",") {
        event.preventDefault();
        // The popover is anchored in the rail; the chord shows the rail
        // first when it was put away, so the block has somewhere to open.
        setRailHidden(false);
        setSettingsOpen((previous) => !previous);
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
    const key = keyOf(picked.provider, picked.providerRepoId);
    setRailProject(key);
    setExpanded((prev) => new Set(prev).add(key));
    closeDialog();
    setNewMissionIn({
      key,
      name: picked.name,
      provider: picked.provider,
      providerRepoId: picked.providerRepoId,
      missions: [],
      onThisMachine: true
    });
  };

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * A project row is a disclosure and nothing more (D-077): click opens the
   * list, click again closes it, and the room never moves. Landing somewhere
   * is what clicking a *mission* does — a row that navigated on its first
   * press and toggled on its second was two behaviours behind one target.
   */
  const openProject = (project: Project) => {
    setRailProject(project.key);
    toggleExpanded(project.key);
  };

  const openAttention = (mission: Mission) => {
    const repo = mission.repository;
    if (!repo) return;
    openBoardMission(mission, boardColumnOf(mission));
  };

  /** A board card's one action (D-120): open the mission AT the thing that is
   *  asking — the attention's lane and chat, the running lane's chat, or (for
   *  a decided mission with siblings) the Compare surface. Navigation only:
   *  nothing starts, stops, or changes state from a card. */
  const openBoardMission = (mission: Mission, column: BoardColumnId) => {
    const repo = mission.repository;
    const projectKey = repo
      ? keyOf(repo.provider, repo.providerRepoId)
      : (projects.find((project) =>
          project.missions.some((candidate) => candidate.missionId === mission.missionId)
        )?.key ?? null);
    if (!projectKey) return;
    const place = mission.attention ?? mission.working;
    setWorkingSet((previous) =>
      openMissionAt(previous, mission.missionId, projectKey, mintTabId, {
        workstreamId: place?.workstreamId ?? undefined,
        sessionId: place?.sessionId ?? undefined
      })
    );
    if (column === "decided" && mission.workstreamCount > 1) {
      pendingCompareMission.current = mission.missionId;
    }
    setRailProject(projectKey);
    setExpanded((previous) => new Set(previous).add(projectKey));
    setRailOpen(false);
  };


  const handleDetail = useCallback((detail: MissionDetailResponse) => {
    setDetails((prev) => ({ ...prev, [detail.mission.missionId]: detail }));
  }, []);

  // A newly created mission joins the list, and the draft the person typed into
  // becomes that mission's tab in place — not a second tab beside it.
  const handleCreated = useCallback((mission: Mission) => {
    // Deduplicated by id: the 5-second poll can deliver the new mission before
    // this append lands, and the two copies then coexist until the next poll
    // replaces the list wholesale — a flicker in the rail, and two cards for
    // one mission on the Home board, which is where it was finally seen
    // (found by e2e/home.spec.ts's first screenshot, D-120).
    setMissions((prev) => {
      if (!prev) return [mission];
      if (prev.some((existing) => existing.missionId === mission.missionId)) return prev;
      return [...prev, mission];
    });
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
  // The tree always renders for the active mission (D-126): Mission →
  // Approach → Chat is the structure, and hiding it for the ordinary mission
  // hid the product.
  const activeTreeShown = openDetail !== undefined;
  /** The tree is shown but the canvas is the mission's own landing (D-089) —
   *  no conversation selected, nothing else covering it. In a one-lane
   *  mission no approach row exists to carry the wash, so the mission's own
   *  row keeps it; with several lanes the approach row takes it instead. */
  // The approach row exists for every active mission now, so it carries the
  // landing wash; the mission row washes only before its detail arrives.
  const activeLandingWashed = false;

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
    if (restoringMissionId !== null) return;
    setArchiveError(null);
    setRestoringMissionId(missionId);
    try {
      const result = await novus().missions.restore(missionId);
      if (!result.ok) {
        setArchiveError(result.message);
        return;
      }
      await refresh();
    } finally {
      setRestoringMissionId(null);
    }
  };
  const openFiles = active ? (filesByTab[active.id] ?? []) : [];
  const activeFile = active ? (activeFileByTab[active.id] ?? null) : null;
  const previewTab = active ? (previewByTab[active.id] ?? null) : null;
  const pullTabOpen = active ? (pullOpenByTab[active.id] ?? false) : false;

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

  /** Switches which approach the active mission's tab is reading, in place
   *  (D-080, restored by D-086): the top strip holds missions, and the lane is
   *  the tab's own state — the approach tabs live in the room's strip. */
  const openLaneView = useCallback((workstreamId: string | null) => {
    const current = activeTabOf(workingSetRef.current);
    if (!current) return;
    setWorkingSet((previous) => selectLane(previous, current.id, workstreamId));
  }, []);

  /**
   * Opens the preview as a tab on the room's working row (D-098). The address
   * is the one the Run control showed — a URL a live process reported — and
   * the lane is captured as the tab's own fact, exactly like a file tab's.
   * The main process validates it all again; this only reserves the place.
   */
  const openPreviewTab = useCallback(
    (url: string) => {
      const current = activeTabOf(workingSetRef.current);
      if (!current) return;
      const detail = current.missionId !== null ? details[current.missionId] : undefined;
      const name = detail ? (liveRunProcess(laneView(detail))?.name ?? "app") : "app";
      setPreviewByTab((previous) => ({
        ...previous,
        [current.id]: { url, workstreamId: current.workstreamId, name }
      }));
      setActiveFileByTab((previous) => ({ ...previous, [current.id]: PREVIEW_TAB_KEY }));
      setDecisionOpen(false);
      setSessionDraft(false);
    },
    [details]
  );

  const closePreviewTab = useCallback(() => {
    const current = activeTabOf(workingSetRef.current);
    if (!current) return;
    setPreviewByTab((previous) => ({ ...previous, [current.id]: null }));
    setActiveFileByTab((previous) =>
      previous[current.id] === PREVIEW_TAB_KEY ? { ...previous, [current.id]: null } : previous
    );
    // Closing the tab discards the view, never the process (D-098).
    void novus().workspace.preview.close();
  }, []);

  /** A stopped app serving again: the tab's record follows the new address. */
  const reopenPreview = useCallback((url: string) => {
    const current = activeTabOf(workingSetRef.current);
    if (!current) return;
    setPreviewByTab((previous) => {
      const entry = previous[current.id];
      return entry ? { ...previous, [current.id]: { ...entry, url } } : previous;
    });
  }, []);

  /** Opens the pull request's own tab and selects it (D-100). */
  const openPullTab = useCallback(() => {
    const current = activeTabOf(workingSetRef.current);
    if (!current) return;
    setPullOpenByTab((previous) => ({ ...previous, [current.id]: true }));
    setActiveFileByTab((previous) => ({ ...previous, [current.id]: PULL_TAB_KEY }));
    setDecisionOpen(false);
    setSessionDraft(false);
  }, []);

  const closePullTab = useCallback(() => {
    const current = activeTabOf(workingSetRef.current);
    if (!current) return;
    setPullOpenByTab((previous) => ({ ...previous, [current.id]: false }));
    setActiveFileByTab((previous) =>
      previous[current.id] === PULL_TAB_KEY ? { ...previous, [current.id]: null } : previous
    );
  }, []);

  return (
    <div className="shell-split">
      <div className="shell-column">

      {offline && (
        <div className="notice-bar" data-testid="offline" aria-live="polite">
          Can&apos;t reach Novus — retrying.
        </div>
      )}

      <div className={railOpen ? "project-shell rail-open" : "project-shell"} data-testid="project-shell">
        {!railHidden && (
        <aside className="sidebar" data-testid="sidebar" style={{ width: railWidth }}>
          {/* At the rail's own right edge, clear of the window's buttons:
              the switch belongs to the column it moves, and the column now
              runs the full height of the window (D-068). */}
          <div className="sidebar-top">
            <button
              className="icon-button active"
              onClick={() => setRailHidden(true)}
              aria-pressed
              aria-label="Hide the projects rail"
              title="Hide projects"
              data-testid="rail-toggle"
            >
              <SidebarGlyph />
            </button>
          </div>
          {/* Fixed above the scroll, and only these two. Everything else in
              this column is a list; these are the two ways out of one (D-066). */}
          <div className="sidebar-fixed">
            <button
              className={activeMissionId === null && active === null ? "side-row selected" : "side-row"}
              // Home is a glance, not a purge (D-120): the board shows with
              // every open tab kept in the strip, so checking what needs you
              // never costs the working set. Before the board this wiped the
              // tabs, which made Home and "close everything" one control.
              onClick={() => setWorkingSet((previous) => ({ ...previous, activeId: null }))}
              data-testid="rail-home"
            >
              <HomeGlyph />
              <span className="side-name">Home</span>
            </button>
            <button className="side-row" onClick={() => setSearchOpen(true)} data-testid="rail-search">
              <SearchGlyph />
              <span className="side-name">Search</span>
            </button>
          </div>
          <div className="sidebar-scroll">
            {attention.length > 0 && (
              <>
                <div className="group-label">
                  Needs attention <span className="side-count">{attention.length}</span>
                </div>
                {attention.map((mission) => {
                  // Where the attention actually is (D-093): the lane, named
                  // only while the mission holds more than one, and the exact
                  // conversation whose turn is blocked, when it has a title.
                  // A one-lane mission whose one conversation is untitled has
                  // nothing further to name, and the row stays one line.
                  const where = [
                    mission.workstreamCount > 1 ? mission.attention?.workstreamName : null,
                    mission.attention?.sessionTitle
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(" · ");
                  return (
                    <button
                      key={mission.missionId}
                      className="side-row attention-row"
                      onClick={() => openAttention(mission)}
                      title={mission.goal}
                      data-testid="attention-row"
                    >
                      <span className="side-name">{truncateLabel(mission.goal, 24)}</span>
                      {where && (
                        <span className="attention-where" data-testid="attention-where">
                          {truncateLabel(where, 28)}
                        </span>
                      )}
                    </button>
                  );
                })}
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
                  {/* Never washed as selected: selection is the mission's, and
                      greying the heading with it read as the whole project
                      being pressed (D-077). */}
                  <div className={`side-row side-parent${away ? " away" : ""}`}>
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
                        openNewMission(project);
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
                    project.missions.map((mission) => {
                      const isActive = activeMissionId === mission.missionId;
                      const missionDetail = isActive ? details[mission.missionId] : undefined;
                      return (
                        <Fragment key={mission.missionId}>
                          <div
                            className={`side-row side-child${
                              // When the tree renders, the wash moves to the
                              // deepest row the canvas is showing (D-084 —
                              // one selection per rail); on the mission's own
                              // landing that deepest row is this one (D-089).
                              isActive && (!activeTreeShown || activeLandingWashed)
                                ? " selected"
                                : ""
                            }${isActive ? " active-mission" : ""}`}
                            data-testid="mission-row"
                          >
                            <button
                              className="side-open-mission"
                              onClick={() => openMissionTab(project.key, mission.missionId)}
                              title={mission.goal}
                            >
                              <span className="side-name">{truncateLabel(mission.goal, 26)}</span>
                              {/* A count, for every mission whose tree is not
                                  the disclosed one (D-084). */}
                              {mission.workstreamCount > 1 && (
                                <span className="side-approaches" data-testid="mission-approaches-count">
                                  {mission.workstreamCount} approaches
                                </span>
                              )}
                            </button>
                            {/* Who is in this mission, on its own row (D-126):
                                the participants' marks, the controller ringed —
                                presence where the mission is named, the aggregate
                                list still Overview's (D-066). */}
                            {isActive && missionDetail && missionDetail.participants.length > 0 && (
                              <span className="presence-cluster" data-testid="rail-presence">
                                {missionDetail.participants.slice(0, 4).map((participant) => (
                                  <span
                                    key={participant.userId}
                                    className={
                                      participant.login === missionDetail.control.holderLogin
                                        ? "presence-mark presence-controller"
                                        : "presence-mark"
                                    }
                                    title={
                                      participant.login === missionDetail.control.holderLogin
                                        ? `${participant.login} has the baton`
                                        : participant.login
                                    }
                                  >
                                    <HumanMark login={participant.login} name={participant.name} />
                                  </span>
                                ))}
                              </span>
                            )}
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
                          {/* The active mission's structure, nested where its
                              project is (D-084). Only the active one: a rail
                              showing every mission's tree is the tab soup
                              relocated. */}
                          {isActive && missionDetail && active && (
                            <MissionTree
                              detail={missionDetail}
                              forkable={
                                missionDetail.state !== "completed" &&
                                missionDetail.state !== "cancelled" &&
                                missionDetail.capabilities.includes("approach.create") &&
                                missionDetail.approaches.some(
                                  (approach) =>
                                    approach.workstreamId === missionDetail.workstream?.workstreamId &&
                                    approach.forkPointSha !== null
                                )
                              }
                              onFork={() => setForkAsk((previous) => previous + 1)}
                              storedLaneId={active.workstreamId}
                              storedSessionId={active.sessionId}
                              decisionOpen={decisionOpen}
                              sessionDraft={sessionDraft}
                              mayDirect={missionDetail.capabilities.includes("direction.submit")}
                              onSelectApproach={(workstreamId) => {
                                // The approach row lands on the approach's
                                // own page (D-089) — never in a conversation,
                                // and never touching the open session tabs.
                                openLaneView(workstreamId);
                                setWorkingSet((previous) =>
                                  selectSession(previous, active.id, null)
                                );
                                setDecisionOpen(false);
                                setSessionDraft(false);
                                setRailOpen(false);
                              }}
                              onSelectSession={(sessionId) => {
                                // A row opens its session as a tab on the
                                // working row (D-087, D-089): every row, the
                                // lane's first included — opening is always
                                // this person's own act.
                                setWorkingSet((previous) =>
                                  openSession(previous, active.id, sessionId)
                                );
                                setActiveFileByTab((previous) => ({ ...previous, [active.id]: null }));
                                setDecisionOpen(false);
                                setSessionDraft(false);
                                setRailOpen(false);
                              }}
                              onCompare={() => {
                                setActiveFileByTab((previous) => ({ ...previous, [active.id]: null }));
                                setSessionDraft(false);
                                setDecisionOpen(true);
                                setRailOpen(false);
                              }}
                              onNewSession={() => {
                                setActiveFileByTab((previous) => ({ ...previous, [active.id]: null }));
                                setDecisionOpen(false);
                                setSessionDraft(true);
                                setRailOpen(false);
                              }}
                              pullSelected={activeFile === PULL_TAB_KEY}
                              onOpenPull={() => {
                                openPullTab();
                                setRailOpen(false);
                              }}
                            />
                          )}
                        </Fragment>
                      );
                    })}

                </div>
              );
            })}
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
            {/* Archived missions are put away, not parked in the rail. A row
                that listed them with Restore beside each one would make filing
                something away and taking it back out equally easy, which is
                not what filing away means — you go and look (D-063). */}
            {archived !== null && archived.length > 0 && (
              <button
                className="btn btn-text add-project"
                onClick={() => setArchivedOpen(true)}
                data-testid="open-archived"
              >
                Archived <span className="side-count">{archived.length}</span>
              </button>
            )}
            <div className="sidebar-identity">
              <HumanMark login={user.login} name={user.name} />
              <span className="sidebar-login">{user.login}</span>
              {/* Where desktop apps keep it: the account corner of the rail.
                  A block opens right here — never a page — and the glyph is
                  the resolved theme itself (D-103). */}
              <ThemeControl
                open={settingsOpen}
                onToggle={() => setSettingsOpen((previous) => !previous)}
                onClose={() => setSettingsOpen(false)}
              />
              {/* Beside the theme block, and shaped like it: the account
                  corner is icons, and a door with an arrow out of it says
                  leaving as plainly as the word did (D-105). */}
              <button
                className="icon-button"
                onClick={() => novus().auth.signOut()}
                aria-label="Sign out"
                title="Sign out"
                data-testid="sign-out"
              >
                <SignOutGlyph />
              </button>
            </div>
          </div>
        </aside>
        )}

        {!railHidden && (
        <ColumnHandle
          edge="right"
          width={railWidth}
          onWidth={setRailWidth}
          reset={240}
          label="Resize the projects rail"
        />
        )}

        {newMissionIn && (
          <NewMissionDialog
            project={newMissionIn}
            projects={projects}
            onClose={() => setNewMissionIn(null)}
            onCreated={(mission) => {
              setNewMissionIn(null);
              handleCreated(mission);
            }}
          />
        )}

        {joinOpen && (
          <JoinDialog
            onClose={() => setJoinOpen(false)}
            onJoined={() => {
              setJoinOpen(false);
              void refresh();
            }}
          />
        )}

        {searchOpen && (
          <SearchDialog
            missions={projects.flatMap((project) =>
              project.missions.map((mission) => ({
                missionId: mission.missionId,
                goal: mission.goal,
                project: project.name
              }))
            )}
            onOpen={(missionId) => {
              const owner = projects.find((project) =>
                project.missions.some((mission) => mission.missionId === missionId)
              );
              if (owner) openMissionTab(owner.key, missionId);
              setSearchOpen(false);
            }}
            onClose={() => setSearchOpen(false)}
          />
        )}

        {archivedOpen && (
          <ArchivedDialog
            missions={archived ?? []}
            error={archiveError}
            restoringMissionId={restoringMissionId}
            onRestore={restoreMission}
            onClose={() => {
              setArchivedOpen(false);
              setArchiveError(null);
            }}
          />
        )}

        {railOpen && <div className="rail-scrim" onClick={() => setRailOpen(false)} />}

        <section className="room-area">
        <header className={railHidden ? "topbar topbar-alone" : "topbar"}>
          {/* Visible only while the rail is away — hidden by choice at any
              width, or collapsed to an overlay below 1200px, where this is the
              way in (CSS decides which case is showing). Two switches for one
              thing would be one too many, so the rail's own copy owns the wide
              case and this one owns the narrow (D-084: the tree made the rail
              load-bearing, and an overlay nothing could open was a dead end). */}
          <button
            className="icon-button rail-toggle"
            onClick={() => {
              if (window.matchMedia("(max-width: 1200px)").matches) {
                setRailOpen((previous) => !previous);
              } else {
                setRailHidden(false);
              }
            }}
            aria-pressed={false}
            aria-label="Show the projects rail"
            title="Show projects"
            data-testid="rail-toggle"
          >
            <SidebarGlyph />
          </button>
          {/* The open missions live in the window's own top row rather than in a
              band beneath it. The row was mostly empty and the tabs sat under it,
              so the window had two chrome edges where it needed one (D-066). */}
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
          <span className="spacer" />
          {/* The room's workspace controls: one Run control beside the evidence
              toggle, in the corner that belongs to the mission. Not a toolbar,
              and not a second navigation (DESIGN.md#component-behavior). */}
          {/* Run never leaves the corner. A draft has nothing to run yet, so
              the control disables rather than unmounting — a control that
              vanishes when you switch tabs reads as a layout bug, and the
              house rule is disabled-with-reason, never hidden (DESIGN.md). */}
          {openDetail && openDetail.workstream ? (
            <RunControl
              detail={laneView(openDetail)}
              onSetup={() => setSetupOpen(true)}
              onOpenPreview={openPreviewTab}
            />
          ) : (
            <button
              className="btn btn-secondary run-trigger"
              disabled
              title="Available once this mission exists and has a workspace"
              data-testid="run-control-disabled"
            >
              Run
            </button>
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
          {active && currentProject ? (
            <ProjectRoom
              key={active.id}
              forkAsk={forkAsk}
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
              onSelectFile={(key) =>
                setActiveFileByTab((previous) => ({ ...previous, [active.id]: key }))
              }
              onCloseFile={(key) => {
                setFilesByTab((previous) => ({
                  ...previous,
                  [active.id]: (previous[active.id] ?? []).filter((entry) => entry.key !== key)
                }));
                setActiveFileByTab((previous) =>
                  previous[active.id] === key ? { ...previous, [active.id]: null } : previous
                );
              }}
              activeWorkstreamId={active.workstreamId}
              onSelectLane={openLaneView}
              activeSessionId={active.sessionId}
              openSessionIds={active.openSessionIds}
              onSelectSession={(sessionId) =>
                setWorkingSet((previous) => selectSession(previous, active.id, sessionId))
              }
              onOpenSession={(sessionId) =>
                setWorkingSet((previous) => openSession(previous, active.id, sessionId))
              }
              onCloseSession={(sessionId) =>
                setWorkingSet((previous) => closeSession(previous, active.id, sessionId))
              }
              onReorderSession={(sessionId, targetIndex) =>
                setWorkingSet((previous) => reorderSession(previous, active.id, sessionId, targetIndex))
              }
              onReorderFile={(key, targetIndex) =>
                setFilesByTab((previous) => {
                  const current = previous[active.id] ?? [];
                  const from = current.findIndex((entry) => entry.key === key);
                  if (from === -1 || from === targetIndex) return previous;
                  if (targetIndex < 0 || targetIndex >= current.length) return previous;
                  const next = [...current];
                  const [moved] = next.splice(from, 1);
                  next.splice(targetIndex, 0, moved!);
                  return { ...previous, [active.id]: next };
                })
              }
              decisionOpen={decisionOpen}
              onDecisionOpen={setDecisionOpen}
              sessionDraft={sessionDraft}
              onSessionDraft={setSessionDraft}
              previewTab={previewTab}
              onClosePreview={closePreviewTab}
              onReopenPreview={reopenPreview}
              pullTabOpen={pullTabOpen}
              onOpenPull={openPullTab}
              onClosePull={closePullTab}
              openArtifactId={openArtifact?.tabId === active.id ? openArtifact.artifactId : null}
              onCloseArtifact={() => setOpenArtifact(null)}
            />
          ) : (missions?.length ?? 0) > 0 ? (
            // Home (D-120): every active mission, grouped by what it needs.
            // Rendered only once a mission exists at all — a board over
            // nothing is prohibited pattern 11 — and the card's click is its
            // one action: open at the thing that is asking.
            <HomeBoard
              missions={missions ?? []}
              now={Date.now()}
              onOpen={openBoardMission}
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
                onClick={() => openNewMission(currentProject)}
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
          key={`${openDetail.mission.missionId}:${openDetail.workstream?.workstreamId ?? "default"}`}
          missionId={openDetail.mission.missionId}
          workstreamId={openDetail.workstream?.workstreamId}
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
        <ColumnHandle
          edge="left"
          width={panelWidth}
          onWidth={setPanelWidth}
          reset={420}
          label="Resize the evidence panel"
        />
      )}
      {inspector && openDetail && active && (
        <Inspector
          width={panelWidth}
          detail={laneView(openDetail)}
          section={inspector}
          onSection={setInspector}
          hostedHere={currentProject?.onThisMachine === true}
          openPath={openFiles.find((entry) => entry.key === activeFile)?.path ?? null}
          onOpenFile={(path) => {
            // The lane is captured at the moment of opening: this tab is that
            // worktree's copy of the file, whatever the room reads later. The
            // same path opened from a sibling approach is a second tab.
            const lane = active.workstreamId;
            const key = fileTabKey(lane, path);
            setFilesByTab((previous) => {
              const current = previous[active.id] ?? [];
              return current.some((entry) => entry.key === key)
                ? previous
                : { ...previous, [active.id]: [...current, { key, path, workstreamId: lane }] };
            });
            setActiveFileByTab((previous) => ({ ...previous, [active.id]: key }));
          }}
          onOpenArtifact={(artifactId) => setOpenArtifact({ tabId: active.id, artifactId })}
          onClose={() => setInspector(null)}
          onDetail={handleDetail}
          onRevoke={() => void novus().control.revoke(openDetail.mission.missionId)}
        />
      )}
    </div>
  );
}

/**
 * Starting a mission, the way Conductor starts work (D-077): the project's
 * name across the top, one large prompt area that *is* the body, and the real
 * composer's own foot — model chip, effort chip, and the send control as the
 * Create action. Enter with words creates the mission and your words become
 * its first direction; Enter with nothing, Esc, or a click outside closes it
 * and nothing happens anywhere.
 */
function NewMissionDialog({
  project,
  projects,
  onClose,
  onCreated
}: {
  project: Project;
  /** Every project, so the ask is not stuck where it was opened: the header
   *  is a picker, exactly as Conductor's is. */
  projects: Project[];
  onClose: () => void;
  onCreated: (mission: Mission) => void;
}) {
  const [target, setTarget] = useState(project);
  const [picking, setPicking] = useState(false);
  const create = async ({
    body,
    model,
    effort
  }: {
    body: string;
    model: ModelId;
    effort: Effort;
  }): Promise<{ ok: boolean; message?: string }> => {
    const base =
      target.provider === "local"
        ? await novus().repos.baseLocal(target.providerRepoId)
        : await novus().repos.base(target.providerRepoId);
    if (!base.ok) return { ok: false, message: base.message };
    const created = await novus().missions.create({
      goal: deriveGoal(body),
      successCriteria: body,
      provider: target.provider,
      providerRepoId: target.providerRepoId,
      baseRef: base.value.ref,
      baseSha: base.value.sha,
      creationKey: crypto.randomUUID()
    });
    if (!created.ok) return { ok: false, message: created.message };
    // The words are the first direction; whether they run now or queue is the
    // server's decision, reported in the room this opens into.
    await novus().missions.direct({
      missionId: created.value.mission.missionId,
      body,
      model,
      effort
    });
    onCreated(created.value.mission);
    return { ok: true };
  };

  return (
    <Dialog label={`New mission in ${target.name}`} onClose={onClose} testId="new-mission-dialog">
      <header className="dialog-head ask-head">
        {/* The header is a picker, not a label: with five projects open, where
            the mission lands is part of the ask (D-078). Reuses the composer's
            own chip menu, so one menu style exists in the product. */}
        <span className="chip-wrap">
          <button
            className="chip-button ask-project"
            onClick={() => setPicking((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={picking}
            data-testid="ask-project"
          >
            {target.name}
            <Chevron open={picking} />
          </button>
          {picking && (
            <div className="chip-menu ask-project-menu" role="menu" data-testid="ask-project-menu">
              {projects.map((candidate) => {
                const away = candidate.provider === "local" && !candidate.onThisMachine;
                return (
                  <button
                    key={candidate.key}
                    className="chip-menu-row"
                    role="menuitem"
                    disabled={away}
                    title={away ? "On another machine" : candidate.name}
                    onClick={() => {
                      setTarget(candidate);
                      setPicking(false);
                    }}
                  >
                    {candidate.name}
                  </button>
                );
              })}
            </div>
          )}
        </span>
      </header>
      <div className="dialog-body ask-body">
        <Composer
          capabilities={["direction.submit"]}
          isController
          placeholderOverride="What should Claude Code work on?"
          onEmptySubmit={onClose}
          onSubmit={create}
        />
      </div>
    </Dialog>
  );
}
