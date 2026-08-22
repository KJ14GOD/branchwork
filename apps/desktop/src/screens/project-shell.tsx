import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PERMISSION_PROFILE,
  type BranchInfo,
  type DirectionContextRef,
  type Effort,
  type Mission,
  type ModelId,
  type MissionDetailResponse,
  type Organization,
  type PermissionProfile,
  type Session,
  type User,
  type Workstream
} from "@novus/contracts";
import { novus } from "../bridge";
import { AddProjectDialog, type PickedRepository } from "../components/add-project-dialog";
import { Composer, DONT_ASK_WARNING } from "../components/composer";
import { Dialog } from "../components/dialog";
import { GearGlyph, HumanMark, SignOutGlyph } from "../components/identity";
import { SettingsDialog } from "../components/settings-dialog";
import { CommandPalette, type PaletteCommand } from "../components/command-palette";
import { applyTheme } from "../theme";
import { chordLabel, matchesChord, useKeybindings } from "../keybindings";
import { MissionTabs } from "../components/mission-tabs";
import { ColumnHandle, useColumnWidth } from "../components/resizable";
import { OpenInControl } from "../components/open-in";
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
  type BoardColumnId,
  standingDecision
} from "../components/derive";
import { HomeBoard } from "../components/home-board";
import { PREVIEW_TAB_KEY, pullIdOfKey, pullTabKey, type OpenPreviewTab } from "../components/preview";
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
/** The repository, as an open folder (D-130 — a place being worked in,
 *  the shape coding harnesses made familiar): the one glyph a project row
 *  leads with — same approved stroke set as Home and Search, always beside
 *  its name (DESIGN.md#icons). */
function RepoGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"
      className="side-repo-glyph">
      <path d="M1.75 12.25V3.9a1.15 1.15 0 0 1 1.15-1.15h2.84a1.15 1.15 0 0 1 .92.46l.62.83a1.15 1.15 0 0 0 .92.46h3.9a1.15 1.15 0 0 1 1.15 1.15v1.1" />
      <path d="M1.75 12.25 3.3 8.06a1.15 1.15 0 0 1 1.08-.75h9.02a.7.7 0 0 1 .66.94l-1.2 3.26a1.15 1.15 0 0 1-1.08.74H1.75z" />
    </svg>
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
  focused,
  selectedPullId,
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
  /** Which request's tab is showing, if one is — its row is washed. */
  selectedPullId: string | null;
  onOpenPull: (pullRequestId: string) => void;
  /** Whether this lane can fork (a shared checkpoint exists, the role carries
   *  approach.create, and the mission is not terminal) — computed by the
   *  shell from the same detail the room reads (D-126). */
  forkable: boolean;
  onFork: () => void;
  /** Whether this tree's mission is the active tab (D-142): only the focused
   *  tree washes its selection and carries the singular testids — background
   *  trees are structure and navigation, never a second selection. */
  focused: boolean;
}) {
  const lanes: Workstream[] = detail.workstreams;
  const firstLaneId = lanes[0]?.workstreamId ?? null;
  const selectedLaneId = storedLaneId ?? firstLaneId;
  /** Approaches whose conversations are folded away (D-134, amended for
   *  approaches too): this window's own choice, for this session. Nothing
   *  folds because the selection moved — swapping approaches leaves every
   *  other approach's conversations exactly as they were. */
  const [foldedLanes, setFoldedLanes] = useState<Set<string>>(new Set());
  const selectedLaneSessions: Session[] = detail.sessions.filter(
    (session) => session.workstreamId === selectedLaneId
  );
  // No conversation selected no longer means "reading the first" (D-089): it
  // means the approach's own page, so no session row washes and the approach
  // row does instead.
  const storedSelection =
    storedSessionId !== null &&
    selectedLaneSessions.some((session) => session.sessionId === storedSessionId)
      ? storedSessionId
      : null;
  // The canvas lands straight in a lane's only conversation (D-089), so the
  // wash follows it there; with several, null means the approach's own page.
  const selectedSessionId =
    storedSelection ??
    (selectedLaneSessions.length === 1 ? (selectedLaneSessions[0]?.sessionId ?? null) : null);
  const showSessions = selectedLaneSessions.length > 0 || sessionDraft;

  // One wash in the rail: the deepest thing the canvas is showing. The tree
  // always renders for the active mission (D-126): Mission → Approach → Chat
  // is the structure, and hiding it for the ordinary mission hid the product.
  const washSession = focused && !decisionOpen && !sessionDraft && showSessions;
  const washApproach =
    focused && !decisionOpen && !sessionDraft && (!showSessions || selectedSessionId === null);

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
      {lanes.map((lane, laneIndex) => {
          const selected = lane.workstreamId === selectedLaneId;
          // The spine's states, computed here rather than with :has() —
          // whether a later approach hangs below (the vertical continues),
          // and whether this row sits above the open one (its vertical is
          // part of the bright path, D-133).
          const selectedIndex = lanes.findIndex(
            (candidate) => candidate.workstreamId === selectedLaneId
          );
          const more = laneIndex < lanes.length - 1;
          const beforeOpen = laneIndex < selectedIndex;
          // Every approach shows its own conversations (D-134, amended):
          // selection moves the room, never somebody's disclosure.
          const laneSessions = detail.sessions.filter(
            (session) => session.workstreamId === lane.workstreamId
          );
          const folded = foldedLanes.has(lane.workstreamId);
          const showChildren = !folded && (laneSessions.length > 0 || (selected && sessionDraft));
          const needs =
            !selected &&
            laneSessions.some((session) => sessionNeedsYou(detail, session.sessionId));
          // What an approach's row does, in the order a person wants it
          // (D-183, owner-reported twice — the second report is the one that found the real fault).
          //
          //  1. Not the lane you are reading → select it, and **unfold** it:
          //     choosing a lane is asking to see it, and a folded lane you
          //     return to would otherwise swallow the click.
          //  2. The lane you are reading, from inside one of its
          //     conversations → **go back to the approach's own page**. This
          //     was the missing one, and it left the page unreachable: the row
          //     only folded, so the way back to a lane's overview was to leave
          //     the mission entirely and come back.
          //  3. The lane you are reading, already on its own page → fold and
          //     unfold its conversations, which is all that is left to mean.
          //
          // Meaning 2 exists only where the page does: a lane with a single
          // conversation has no approach page (D-089 — it lands straight in
          // the chat), so for it the row skips to meaning 3. Without this, the
          // first click on a one-chat lane cleared invisible selection state
          // and read as a dead control — the exact fault D-183's second
          // report named, reintroduced for the single-chat case.
          const readingASession =
            focused && selectedSessionId !== null && !decisionOpen && laneSessions.length > 1;
          const activate = () => {
            if (selected && readingASession) {
              onSelectApproach(lane.workstreamId === firstLaneId ? null : lane.workstreamId);
            } else if (selected) {
              setFoldedLanes((previous) => {
                const next = new Set(previous);
                if (next.has(lane.workstreamId)) next.delete(lane.workstreamId);
                else next.add(lane.workstreamId);
                return next;
              });
            } else {
              setFoldedLanes((previous) => {
                if (!previous.has(lane.workstreamId)) return previous;
                const next = new Set(previous);
                next.delete(lane.workstreamId);
                return next;
              });
              onSelectApproach(lane.workstreamId === firstLaneId ? null : lane.workstreamId);
            }
          };
          return (
            <Fragment key={lane.workstreamId}>
              <div
                className={`side-row side-approach${selected ? " side-approach-open" : ""}${more ? " side-approach-more" : ""}${beforeOpen ? " side-approach-before-open" : ""}${selected && washApproach ? " selected" : ""}`}
                data-testid="rail-approach-row"
                data-workstream={lane.workstreamId}
                onClick={(event) => {
                  // The whole chip is the touch target (D-134, amended): a
                  // short lane name leaves most of the row outside the name
                  // button, and a tap there must not be dead.
                  if ((event.target as HTMLElement).closest("button")) return;
                  activate();
                }}
              >
                <button
                  className="side-open-mission"
                  onClick={activate}
                  aria-current={focused && selected}
                  aria-expanded={selected ? !folded : undefined}
                  title={
                    lane.approach
                      ? `${lane.name} — isolated workspace`
                      : `${lane.name} — the work this mission started with`
                  }
                >
                  {/* No identity dot here (D-128): the row carries the lane's
                      name, and the spine already says it is a child. The dot
                      keeps its work on the room's tabs, where two lanes'
                      conversations sit side by side. No branch either (D-131,
                      reversing D-126's placement): the mission branch is
                      machinery, and its home is Overview. */}
                  <span className="side-name" data-testid={focused && selected ? "lane-context" : undefined}>
                    {lane.name}
                    {lane.approach ? " · isolated workspace" : ""}
                  </span>
                  {needs && <span className="tone-warn side-needs"> · needs you</span>}
                </button>
                {/* A middle approach's vertical stops where its curve begins;
                    this element resumes the line behind the curve's sweep, so
                    the straight stroke and the arc never draw side by side
                    (D-133 smoothing — the owner's own formula). It also lets
                    the open row's top run bright while the resumption stays
                    quiet: one border cannot be two colors. */}
                {more && <span className="side-spine-below" aria-hidden="true" />}
                {/* A parent's + creates its child, exactly as the project row's
                    does for missions (D-077, D-084). Only on the approach being
                    read: a session starts where you are. */}
                {focused && selected && mayDirect && (
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
              {/* Its children, under it and nowhere else — one block, so the
                  mission-level spine has a single element to pass through
                  (D-128). Rendered only with something in it: an empty block
                  would still occupy a spine slot. */}
              {showChildren && (
                <div
                  className={[
                    "side-children",
                    more && "side-children-more",
                    // The bright path to an open approach further down runs
                    // through this block too — one continuous line, so its
                    // own segment brightens along with the row above it
                    // (D-135 fix).
                    beforeOpen && "side-children-before-open"
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {laneSessions.map((session) => {
                    const washed =
                      selected && session.sessionId === selectedSessionId && !sessionDraft;
                    // Every chat's own word on its row (D-094): needs you in
                    // the warn tone, working and queued quietly, idle as
                    // nothing at all. The washed row says nothing — its state
                    // is the room's state line.
                    const activity = washed ? null : sessionActivity(detail, session.sessionId);
                    const rowNeeds = activity?.state === "needs_you";
                    return (
                      <div
                        key={session.sessionId}
                        className={`side-row side-session${washed && washSession ? " selected" : ""}`}
                        data-testid="rail-session-row"
                        data-session={session.sessionId}
                      >
                        <button
                          className="side-open-mission"
                          onClick={() => {
                            // A row opens its conversation; from another
                            // approach it moves the room there first —
                            // D-088's guarantee, the rail's version.
                            if (!selected) {
                              onSelectApproach(
                                lane.workstreamId === firstLaneId ? null : lane.workstreamId
                              );
                            }
                            onSelectSession(session.sessionId);
                          }}
                          aria-current={focused && washed}
                          title={session.title ?? "New session"}
                        >
                          <span
                            className={
                              session.title === null ? "side-name side-untitled" : "side-name"
                            }
                          >
                            {truncateLabel(session.title ?? "New session", 24)}
                          </span>
                          {activity?.label && (
                            <span className={rowNeeds ? "tone-warn side-needs" : "side-needs side-state"}>
                              {" "}
                              · {activity.label}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                  {selected && draftRow}
                </div>
              )}
            </Fragment>
          );
        })}
      {forkable && (
        <div className="side-row side-fork">
          <button
            className="side-open-mission"
            onClick={onFork}
            data-testid={focused ? "try-another-approach" : undefined}
            title="Start from the shared checkpoint and compare another solution"
          >
            <span className="side-name side-fork-name">Try another approach</span>
          </button>
        </div>
      )}
      {/* A one-lane mission publishes without a comparison (D-140): the same
          surface, one column — record the decision, then Publish. The row
          appears once there is a checkpoint to decide on. */}
      {lanes.length === 1 && detail.approaches[0]?.checkpointSha && (
        <div
          className={`side-row side-compare${decisionOpen ? " selected" : ""}`}
          data-testid={focused ? "rail-publish" : undefined}
        >
          <button className="side-open-mission" onClick={onCompare} aria-current={decisionOpen}>
            <span className="side-name">Publish</span>
            {standingDecision(detail) !== null && (
              <span className="side-decision-note"> · decision recorded</span>
            )}
          </button>
        </div>
      )}
      {lanes.length > 1 && (
        <div
          className={`side-row side-compare${decisionOpen ? " selected" : ""}`}
          data-testid={focused ? "rail-compare" : undefined}
        >
          <button className="side-open-mission" onClick={onCompare} aria-current={decisionOpen}>
            <span className="side-name">Compare</span>
            {standingDecision(detail) !== null && (
              <span className="side-decision-note"> · decision recorded</span>
            )}
          </button>
        </div>
      )}
      {/* Every request the mission opened, oldest first (D-207): a merged one
          is the mission's history and stays listed beside the next. */}
      {detail.pullRequests.map((pull) => (
        <div
          key={pull.pullRequestId}
          className={`side-row side-compare${selectedPullId === pull.pullRequestId ? " selected" : ""}`}
          data-testid={focused ? "rail-pull" : undefined}
          data-pull-number={pull.number}
        >
          <button
            className="side-open-mission"
            onClick={() => onOpenPull(pull.pullRequestId)}
            aria-current={selectedPullId === pull.pullRequestId}
          >
            <span className="side-name">PR #{pull.number}</span>
            <span className="side-decision-note"> · {pull.state}</span>
          </button>
        </div>
      ))}
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
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The room consumes this ask and opens its find bar (the forkAsk pattern).
  const [findAsk, setFindAsk] = useState(0);
  const [joinOpen, setJoinOpen] = useState(false);
  /** The setup dialog is held here because two surfaces open the same one: the
   *  state line's action inside the room, and the Run control beside it. */
  const [setupOpen, setSetupOpen] = useState(false);
  /** The rail's Try-another-approach row asks; the room owns the dialog
   *  (D-126). A counter, so every ask opens it even after a cancel. */
  const [forkAsk, setForkAsk] = useState(0);
  /** A pinned reference asked for from the panel (D-182): the inspector's
   *  rows live here in the shell, the composer's chips live in the room, so
   *  the ask crosses as a nonced value the room consumes — the forkAsk
   *  pattern, carrying a payload. */
  const [contextAsk, setContextAsk] = useState<{ ref: DirectionContextRef; n: number } | null>(
    null
  );
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
  /** The pull requests open as tabs, per mission tab, in the order opened
   *  (D-207): a mission publishes more than once, so each request is its
   *  own tab rather than one boolean. */
  const [pullOpenByTab, setPullOpenByTab] = useState<Record<string, string[]>>({});
  /** Which projects are showing their missions. Disclosure is the reader's
   *  choice and survives selection moving elsewhere. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Missions whose tree is folded away (D-134): this window's own choice,
   *  for this session — the structure is the default, not a cage. */
  const [foldedTrees, setFoldedTrees] = useState<Set<string>>(new Set());
  /** A mission row's one action (D-134, amended — no twisty): the active
   *  mission's row has no navigation left to do, its room is the canvas,
   *  so its click folds and unfolds the tree; any other mission's opens it. */
  const activateMission = (missionId: string, projectKey: string) => {
    if (activeMissionId === missionId) {
      setFoldedTrees((previous) => {
        const next = new Set(previous);
        if (next.has(missionId)) next.delete(missionId);
        else next.add(missionId);
        return next;
      });
    } else {
      openMissionTab(projectKey, missionId);
    }
  };
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

  // The rail reports on every mission, including the ones nobody has open —
  // and it learns by being told, not by asking (D-179): one connection
  // streams an address for any participant mission that moved, and the shell
  // re-reads exactly that mission. Bursts collapse: a running turn emits many
  // events, so each mission's re-read trails its last signal by a beat. An
  // address the rail has never heard of is a new mission — the one case that
  // re-reads the list itself.
  useEffect(() => {
    void novus().missions.watchAll();
    // Two trailing debounces, because two different reads answer a signal:
    // the changed mission's own detail (per mission, so parallel missions
    // never starve each other), and the list — whose rows carry the board
    // fields (attention, working, lastActivityAt) the detail path
    // deliberately leaves null, so a detail's mission row must never replace
    // a list row.
    const detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = novus().missions.onAnyChanged((change) => {
      const pending = detailTimers.get(change.missionId);
      if (pending) clearTimeout(pending);
      detailTimers.set(
        change.missionId,
        setTimeout(() => {
          detailTimers.delete(change.missionId);
          const tab = workingSetRef.current.tabs.find(
            (entry) => entry.missionId === change.missionId
          );
          void novus()
            .missions.get(change.missionId, tab?.workstreamId ?? undefined)
            .then((result) => {
              if (!result.ok) return;
              setDetails((prev) => ({
                ...prev,
                [result.value.mission.missionId]: result.value
              }));
            });
        }, 300)
      );
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => {
        listTimer = null;
        void novus()
          .missions.list()
          .then((result) => {
            if (result.ok) {
              setOffline(false);
              setMissions(result.value);
            }
          });
      }, 300);
    });
    return () => {
      stop();
      for (const timer of detailTimers.values()) clearTimeout(timer);
      if (listTimer) clearTimeout(listTimer);
      void novus().missions.unwatchAll();
    };
  }, []);

  // The slow sweep underneath the stream (the D-149 pattern): a dropped
  // connection or a missed signal costs latency, never truth. Also the only
  // reader for what no mission event describes — local repos, checkouts, the
  // archived list.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 45_000);
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
// A notification's click brings the person back to the mission that asked
  // (D-180): the main process focused the window; this opens the tab.
  useEffect(() => {
    return novus().notifications.onOpenMission((missionId) => {
      const holder = projects.find((project) =>
        project.missions.some((mission) => mission.missionId === missionId)
      );
      if (holder) openMissionTab(holder.key, missionId);
    });
  }, [projects, openMissionTab]);

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
  // project, and the three surfaces every desktop app keys the same way
  // (D-177): ⌘B the rail, ⌘J the terminal dock, ⌘E the evidence panel
  // (DESIGN.md#keyboard). Each chord is read from the bindings registry, so
  // the settings Keyboard page's rebinding takes effect the keystroke after
  // it is recorded.
  const keys = useKeybindings();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (matchesChord(event, keys.newMission)) {
        event.preventDefault();
        newMissionHere();
      } else if (matchesChord(event, keys.palette)) {
        event.preventDefault();
        setSettingsDialogOpen(false);
        setPaletteOpen((open) => !open);
      } else if (matchesChord(event, keys.toggleRail)) {
        event.preventDefault();
        setRailHidden((hidden) => !hidden);
      } else if (matchesChord(event, keys.toggleDock)) {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      } else if (matchesChord(event, keys.togglePanel)) {
        event.preventDefault();
        if (activeMissionId === null) return;
        setInspector((current) => {
          if (current) {
            lastSection.current = current;
            return null;
          }
          return lastSection.current ?? "overview";
        });
      } else if (matchesChord(event, keys.openSettings)) {
        event.preventDefault();
        // The popover is anchored in the rail; the chord shows the rail
        // first when it was put away, so the block has somewhere to open.
        setRailHidden(false);
        setSettingsOpen((previous) => !previous);
      } else if (/^[1-9]$/.test(event.key) && !event.shiftKey && !event.altKey) {
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
  }, [currentProject, newMissionHere, openMissionTab, activeMissionId, keys]);

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
  const activeTreeShown =
    openDetail !== undefined && !(activeMissionId !== null && foldedTrees.has(activeMissionId));
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
  const openPullIds = active ? (pullOpenByTab[active.id] ?? []) : [];

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
  const openLaneView = useCallback((workstreamId: string | null, tabId?: string) => {
    const target = tabId ?? activeTabOf(workingSetRef.current)?.id;
    if (!target) return;
    setWorkingSet((previous) => selectLane(previous, target, workstreamId));
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
  const openPullTab = useCallback((pullRequestId: string, tabId?: string) => {
    const target = tabId ?? activeTabOf(workingSetRef.current)?.id;
    if (!target) return;
    setPullOpenByTab((previous) => {
      const held = previous[target] ?? [];
      return held.includes(pullRequestId) ? previous : { ...previous, [target]: [...held, pullRequestId] };
    });
    setActiveFileByTab((previous) => ({ ...previous, [target]: pullTabKey(pullRequestId) }));
    setDecisionOpen(false);
    setSessionDraft(false);
  }, []);

  const closePullTab = useCallback((pullRequestId: string) => {
    const current = activeTabOf(workingSetRef.current);
    if (!current) return;
    setPullOpenByTab((previous) => ({
      ...previous,
      [current.id]: (previous[current.id] ?? []).filter((id) => id !== pullRequestId)
    }));
    setActiveFileByTab((previous) =>
      previous[current.id] === pullTabKey(pullRequestId) ? { ...previous, [current.id]: null } : previous
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
            <button className="side-row" onClick={() => setPaletteOpen(true)} data-testid="rail-search">
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
                      <RepoGlyph />
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
                      const missionDetail = details[mission.missionId];
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
                            onClick={(event) => {
                              // The whole row is the touch target: a short
                              // goal leaves most of the chip outside the name
                              // button, and a tap there must not be dead
                              // (D-134, amended). Inner buttons handle their
                              // own clicks.
                              if ((event.target as HTMLElement).closest("button")) return;
                              activateMission(mission.missionId, project.key);
                            }}
                          >
                            <button
                              className="side-open-mission"
                              onClick={() => activateMission(mission.missionId, project.key)}
                              aria-expanded={isActive ? !foldedTrees.has(mission.missionId) : undefined}
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
                          {(() => {
                            // Every open mission grows its tree (D-142,
                            // reversing the active-only rule): the working
                            // set is what you have open, and hiding an open
                            // mission's structure made the rail lie about
                            // it. Rows in a background tree are navigation —
                            // acting on one focuses its tab first.
                            const treeTab = isActive
                              ? active
                              : (workingSet.tabs.find(
                                  (tab) => tab.missionId === mission.missionId
                                ) ?? null);
                            if (!treeTab || !missionDetail || foldedTrees.has(mission.missionId)) {
                              return null;
                            }
                            const tabId = treeTab.id;
                            const focusTab = () => {
                              if (!isActive) setWorkingSet((previous) => selectTab(previous, tabId));
                            };
                            return (
                              <MissionTree
                                detail={missionDetail}
                                focused={isActive}
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
                                onFork={() => {
                                  focusTab();
                                  setForkAsk((previous) => previous + 1);
                                }}
                                storedLaneId={treeTab.workstreamId}
                                storedSessionId={treeTab.sessionId}
                                decisionOpen={isActive && decisionOpen}
                                sessionDraft={isActive && sessionDraft}
                                mayDirect={missionDetail.capabilities.includes("direction.submit")}
                                onSelectApproach={(workstreamId) => {
                                  // The approach row lands on the approach's
                                  // own page (D-089) — never in a conversation,
                                  // and never touching the open session tabs.
                                  focusTab();
                                  openLaneView(workstreamId, tabId);
                                  setWorkingSet((previous) => selectSession(previous, tabId, null));
                                  setDecisionOpen(false);
                                  setSessionDraft(false);
                                  setRailOpen(false);
                                }}
                                onSelectSession={(sessionId) => {
                                  // A row opens its session as a tab on the
                                  // working row (D-087, D-089): every row, the
                                  // lane's first included — opening is always
                                  // this person's own act.
                                  focusTab();
                                  setWorkingSet((previous) => openSession(previous, tabId, sessionId));
                                  setActiveFileByTab((previous) => ({ ...previous, [tabId]: null }));
                                  setDecisionOpen(false);
                                  setSessionDraft(false);
                                  setRailOpen(false);
                                }}
                                onCompare={() => {
                                  focusTab();
                                  setActiveFileByTab((previous) => ({ ...previous, [tabId]: null }));
                                  setSessionDraft(false);
                                  setDecisionOpen(true);
                                  setRailOpen(false);
                                }}
                                onNewSession={() => {
                                  focusTab();
                                  setActiveFileByTab((previous) => ({ ...previous, [tabId]: null }));
                                  setDecisionOpen(false);
                                  setSessionDraft(true);
                                  setRailOpen(false);
                                }}
                                selectedPullId={isActive ? pullIdOfKey(activeFile) : null}
                                onOpenPull={(pullRequestId) => {
                                  focusTab();
                                  openPullTab(pullRequestId, tabId);
                                  setRailOpen(false);
                                }}
                              />
                            );
                          })()}
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
              {/* The gear beside them (D-174): the full settings dialog —
                  several pages, the shape every peer app carries — where the
                  account corner already is. */}
              <button
                className="icon-button"
                onClick={() => setSettingsDialogOpen(true)}
                aria-label="Settings"
                title="Settings"
                data-testid="open-settings"
              >
                <GearGlyph />
              </button>
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

        {paletteOpen && (
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            commands={(() => {
              const commands: PaletteCommand[] = [];
              commands.push({
                id: "home",
                group: "Go",
                label: "Home — the board",
                run: () => setWorkingSet((previous) => ({ ...previous, activeId: null }))
              });
              // Every mission across every project (D-184 — the separate
              // search dialog merged in here, the Conductor shape): the label
              // carries the project so typing either finds it, and the
              // current project's first nine keep their ⌘n.
              for (const project of projects) {
                project.missions.forEach((mission, at) => {
                  const here = currentProject !== null && project.key === currentProject.key;
                  commands.push({
                    id: `mission-${mission.missionId}`,
                    group: "Missions",
                    label: `${mission.goal.slice(0, 60)} · ${project.name}`,
                    hint: here && at < 9 ? `⌘${at + 1}` : undefined,
                    run: () => openMissionTab(project.key, mission.missionId)
                  });
                });
              }
              if (archived && archived.length > 0) {
                commands.push({
                  id: "archived",
                  group: "Go",
                  label: `Archived missions (${archived.length})`,
                  run: () => setArchivedOpen(true)
                });
              }
              commands.push({
                id: "rail",
                group: "Toggle",
                label: railHidden ? "Show the projects rail" : "Hide the projects rail",
                hint: chordLabel(keys.toggleRail),
                run: () => setRailHidden((hidden) => !hidden)
              });
              commands.push({
                id: "terminal",
                group: "Toggle",
                label: terminalOpen ? "Hide the terminal dock" : "Show the terminal dock",
                hint: chordLabel(keys.toggleDock),
                run: () => setTerminalOpen((open) => !open)
              });
              if (activeMissionId !== null) {
                commands.push({
                  id: "panel",
                  group: "Toggle",
                  label: inspector ? "Hide the evidence panel" : "Show the evidence panel",
                  hint: chordLabel(keys.togglePanel),
                  run: () =>
                    setInspector((current) => {
                      if (current) {
                        lastSection.current = current;
                        return null;
                      }
                      return lastSection.current ?? "overview";
                    })
                });
                const sections: { key: InspectorSection; label: string; hint?: string }[] = [
                  { key: "changes", label: "Open Changes", hint: "G C" },
                  { key: "verification", label: "Open Verification", hint: "G V" },
                  { key: "files", label: "Open All files", hint: "G A" },
                  { key: "overview", label: "Open Overview" },
                  { key: "evidence", label: "Open Evidence" }
                ];
                for (const section of sections) {
                  commands.push({
                    id: `section-${section.key}`,
                    group: "Panel",
                    label: section.label,
                    hint: section.hint,
                    run: () => setInspector(section.key)
                  });
                }
              }
              if (currentProject) {
                commands.push({
                  id: "new-mission",
                  group: "Mission",
                  label: `Start a mission in ${currentProject.name}`,
                  hint: chordLabel(keys.newMission),
                  run: () => newMissionHere()
                });
              }
              if (activeMissionId !== null) {
                commands.push({
                  id: "find",
                  group: "Mission",
                  label: "Find in the conversation",
                  hint: chordLabel(keys.find),
                  run: () => setFindAsk((ask) => ask + 1)
                });
                const detail = openDetail;
                if (detail && detail.control.holderUserId !== detail.viewerUserId) {
                  const may = detail.capabilities.includes("control.request");
                  commands.push({
                    id: "request-control",
                    group: "Mission",
                    label: "Request control",
                    hint: "R",
                    disabled: may
                      ? undefined
                      : "Only participants who can operate this mission may request control.",
                    run: () => void novus().control.request(detail.mission.missionId)
                  });
                }
              }
              commands.push({
                id: "settings",
                group: "Novus",
                label: "Open Settings",
                run: () => setSettingsDialogOpen(true)
              });
              for (const theme of ["light", "dark", "system"] as const) {
                commands.push({
                  id: `theme-${theme}`,
                  group: "Novus",
                  label: `Theme: ${theme.charAt(0).toUpperCase()}${theme.slice(1)}`,
                  run: () => applyTheme(theme)
                });
              }
              return commands;
            })()}
          />
        )}
        {settingsDialogOpen && (
          <SettingsDialog
            user={user}
            onClose={() => setSettingsDialogOpen(false)}
            onSignOut={() => {
              setSettingsDialogOpen(false);
              void novus().auth.signOut();
            }}
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

        <section className="room-area" data-testid="room-area">
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
              previewOpen={previewTab !== null}
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
          {/* The same corner, the same rule: one icon, one menu, never a
              second navigation (D-159). It names the lane on screen, so a
              mission with competing approaches opens the one being read. */}
          <OpenInControl
            missionId={activeMissionId}
            workstreamId={openDetail?.workstream?.workstreamId ?? null}
            availableHere={currentProject?.onThisMachine === true}
            disabled={activeMissionId === null || !openDetail?.workstream}
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
              contextAsk={contextAsk}
              findAsk={findAsk}
              onFindConsumed={() => setFindAsk(0)}
              onForkConsumed={() => setForkAsk(0)}
              onOpenDecision={() => {
                setSessionDraft(false);
                setDecisionOpen(true);
                setRailOpen(false);
              }}
              project={currentProject}
              details={details}
              selectedMissionId={active.missionId}
              onInspector={setInspector}
              onSetup={() => setSetupOpen(true)}
              onDetail={handleDetail}
              onCreated={handleCreated}
              terminalOpen={terminalOpen}
              onOpenTerminal={() => setTerminalOpen(true)}
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
              openPullIds={openPullIds}
              onOpenPull={(pullRequestId) => openPullTab(pullRequestId)}
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
          onAddContext={(ref) => setContextAsk((prev) => ({ ref, n: (prev?.n ?? 0) + 1 }))}
          onOpenArtifact={(artifactId) => {
            // The artifact look belongs to the conversation canvas alone
            // (D-165 amended twice, owner-hit: it was hijacking every canvas
            // — files, preview, all of them — until dismissed). Opening one
            // IS a navigation to the conversation: whatever tab was selected
            // steps back, and Compare closes, so the look never contends
            // with another canvas anywhere.
            setActiveFileByTab((previous) =>
              previous[active.id] === null ? previous : { ...previous, [active.id]: null }
            );
            setDecisionOpen(false);
            setOpenArtifact({ tabId: active.id, artifactId });
          }}
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
  /** The branch this mission starts from (D-139): null is the default branch,
   *  exactly as before the chip existed. Reset when the project changes —
   *  a branch belongs to one repository. */
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [basePicking, setBasePicking] = useState(false);
  const [baseFilter, setBaseFilter] = useState("");
  const [branches, setBranches] = useState<
    { kind: "idle" | "loading" } | { kind: "loaded"; value: BranchInfo[] } | { kind: "error"; message: string }
  >({ kind: "idle" });
  /** The answer policy the first turn will run under (D-201). Held here rather
   *  than set on a lane, because the lane does not exist until Enter: the
   *  choice is applied the moment it does, before the turn is dispatched. */
  const [profile, setProfile] = useState<PermissionProfile>(DEFAULT_PERMISSION_PROFILE);

  useEffect(() => {
    setBaseRef(null);
    setBasePicking(false);
    setBranches({ kind: "idle" });
  }, [target.key]);
  const openBasePicker = async () => {
    setBasePicking((open) => !open);
    setBaseFilter("");
    if (branches.kind === "loaded") return;
    setBranches({ kind: "loading" });
    const result = await novus().repos.branches({
      provider: target.provider,
      providerRepoId: target.providerRepoId
    });
    setBranches(
      result.ok ? { kind: "loaded", value: result.value } : { kind: "error", message: result.message }
    );
  };
  const create = async ({
    body,
    model,
    effort,
    attachmentPaths
  }: {
    body: string;
    model: ModelId;
    effort: Effort;
    attachmentPaths?: string[];
  }): Promise<{ ok: boolean; message?: string }> => {
    // The chosen ref is resolved again at this moment (D-139): the pin is the
    // branch's tip when Enter was pressed, not when the menu was opened.
    const base =
      target.provider === "local"
        ? await novus().repos.baseLocal(target.providerRepoId, baseRef ?? undefined)
        : await novus().repos.base(target.providerRepoId, baseRef ?? undefined);
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
    const missionId = created.value.mission.missionId;
    const workstreamId = created.value.workstream.workstreamId;

    // Both of these happen *before* the first direction, and that order is the
    // whole point (D-201): a profile is pinned at dispatch (D-115), and an
    // attachment has to exist before the turn that reads it is sent. The
    // creator is this mission's Mission Admin, so both are theirs to set.
    if (profile !== DEFAULT_PERMISSION_PROFILE) {
      const set = await novus().missions.setPermissionProfile({
        missionId,
        workstreamId,
        profile,
        acknowledged: profile === "dont_ask" ? DONT_ASK_WARNING : null
      });
      // The mission exists either way. A refused profile is said out loud
      // rather than swallowed, and nothing is started under a policy the
      // person did not get: they land in the room and choose again.
      if (!set.ok) {
        onCreated(created.value.mission);
        return { ok: false, message: set.message };
      }
    }

    const attachmentIds: string[] = [];
    let refused: string | null = null;
    for (const path of attachmentPaths ?? []) {
      const uploaded = await novus().missions.attachImage({ missionId, workstreamId, path });
      if (uploaded.ok) attachmentIds.push(uploaded.value.artifactId);
      else refused = uploaded.message;
    }
    // One file that could not be prepared does not cost the person their
    // words: the turn goes with what did upload, and the room says what
    // did not.
    if (refused !== null && attachmentIds.length === 0 && (attachmentPaths?.length ?? 0) > 0) {
      onCreated(created.value.mission);
      return { ok: false, message: refused };
    }

    // The words are the first direction; whether they run now or queue is the
    // server's decision, reported in the room this opens into.
    await novus().missions.direct({
      missionId,
      body,
      model,
      effort,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {})
    });
    onCreated(created.value.mission);
    return refused === null ? { ok: true } : { ok: true, message: refused };
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
        {/* Where the mission starts from (D-139): the default branch unless a
            person says otherwise, chosen here because base is a birth decision
            of the mission — the room never changes what code it is about. */}
        <span className="chip-wrap ask-base-wrap">
          <button
            className="chip-button ask-base"
            onClick={() => void openBasePicker()}
            aria-haspopup="menu"
            aria-expanded={basePicking}
            data-testid="ask-base"
          >
            Base · <span className="mono">{baseRef ?? "default"}</span>
            <Chevron open={basePicking} />
          </button>
          {basePicking && (
            <div className="chip-menu ask-base-menu" role="menu" data-testid="ask-base-menu">
              <input
                className="input base-filter"
                placeholder="Filter branches"
                value={baseFilter}
                onChange={(event) => setBaseFilter(event.target.value)}
                aria-label="Filter branches"
                data-testid="base-filter"
                autoFocus
              />
              {branches.kind === "loading" && <p className="chip-menu-note">Reading branches…</p>}
              {branches.kind === "error" && <p className="chip-menu-note">{branches.message}</p>}
              {branches.kind === "loaded" &&
                branches.value
                  .filter((branch) => branch.name.toLowerCase().includes(baseFilter.trim().toLowerCase()))
                  .slice(0, 40)
                  .map((branch) => (
                    <button
                      key={branch.name}
                      className="chip-menu-row base-row-choice"
                      role="menuitem"
                      title={branch.sha}
                      onClick={() => {
                        setBaseRef(branch.isDefault ? null : branch.name);
                        setBasePicking(false);
                      }}
                      data-testid="base-branch-row"
                    >
                      <span className="mono base-branch-name">{branch.name}</span>
                      {branch.isDefault && <span className="base-branch-default">default</span>}
                    </button>
                  ))}
              {branches.kind === "loaded" &&
                branches.value.filter((branch) =>
                  branch.name.toLowerCase().includes(baseFilter.trim().toLowerCase())
                ).length === 0 && <p className="chip-menu-note">No branch matches.</p>}
              <p className="chip-menu-note base-note">
                The mission pins this branch at its current commit. Its pull request will target it.
              </p>
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
          /* No mission exists to upload to yet, so the composer holds what is
             picked and `create` uploads it the instant one does (D-201).
             Clipboard paste is deliberately absent: its bytes have no path to
             hold, and a temporary file to invent one is a later slice. */
          attach={{
            pick: async () => {
              const picked = await novus().missions.pickImage();
              return picked.ok
                ? { ok: true as const, path: picked.value }
                : { ok: false as const, message: picked.message };
            },
            pathOf: (file: File) => novus().missions.pathForDroppedFile(file)
          }}
          /* The creator is this mission's Mission Admin, so every profile is
             theirs to choose — including the one that needs the warning
             acknowledged, which the chip's own dialog collects (D-115). */
          policy={{
            profile,
            maySet: true,
            maySetUnsupervised: true,
            onSet: async (chosen) => {
              setProfile(chosen);
              return { ok: true };
            }
          }}
        />
      </div>
    </Dialog>
  );
}
