import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BaseRevision,
  Direction,
  Effort,
  Mission,
  MissionDetailResponse,
  ModelId
} from "@novus/contracts";
import { novus } from "../bridge";
import { Composer, type SubmitOutcome } from "../components/composer";
import {
  controller as controllerOf,
  deriveStateLine,
  laneSessions,
  laneView,
  sessionView,
  viewerIsController
} from "../components/derive";
import {
  ApprovalRow,
  ControlEventRow,
  TraceView,
  buildFeed
} from "../components/direction-trace";
import { GatedAction } from "../components/gated";
import { HumanMark } from "../components/identity";
import type { InspectorSection } from "../components/inspector";
import { DecisionRoom } from "../components/decision-room";
import { Dialog } from "../components/dialog";
import { FileView } from "../components/file-view";

/** The mark that says a tab is a file rather than the room itself. */
function FileGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 1.75H4.75a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1V5z" />
      <path d="M9 1.75V5h3.25" />
    </svg>
  );
}

import { RuntimeDock } from "../components/runtime-dock";
import { clockTime, deriveGoal, shortSha } from "../format";
import type { Project } from "./project-shell";

type BaseLoad =
  | { kind: "resolving" }
  | { kind: "resolved"; base: BaseRevision }
  | { kind: "failed"; message: string };

/** A "+" tab before its first message: no mission exists yet. The creationKey
 *  is minted when the tab opens and reused on retry, so a retried first
 *  message can never mint a second mission (D-031). */
interface Draft {
  creationKey: string;
  base: BaseLoad;
}

function offlineOr(code: string, message: string): string {
  return code === "offline" ? "Can't reach Novus. Check your connection and try again." : message;
}

/**
 * The Mission Room (D-032). Top to bottom it answers the room's questions in
 * one order: what work (the title), what is happening and what happens next
 * (the state line), who is in control and who is here (the authority row),
 * what the agent did and which direction caused it (the trace), and what
 * changed and what was verified (the inspector, one keystroke away).
 *
 * Repository, model, and revision machinery live in the inspector, never in
 * the header (DESIGN.md prohibited pattern 12).
 */
export function ProjectRoom({
  project,
  details,
  selectedMissionId,
  onInspector,
  onSetup,
  onDetail,
  onCreated,
  terminalOpen,
  openFiles,
  activeFile,
  onSelectFile,
  onCloseFile,
  activeWorkstreamId,
  onSelectLane,
  activeSessionId,
  onSelectSession,
  decisionOpen,
  onDecisionOpen,
  sessionDraft,
  onSessionDraft
}: {
  project: Project;
  details: Record<string, MissionDetailResponse>;
  selectedMissionId: string | null;
  /** Opening the evidence panel is the shell's job — it owns the panel and the
   *  control that shows it. The room only ever asks for a section. */
  onInspector: (section: InspectorSection | null) => void;
  /** The setup dialog is the shell's too: the Run control opens the same one. */
  onSetup: () => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onCreated: (mission: Mission) => void;
  /** The bottom terminal dock. Its toggle sits with the other workspace
   *  controls, so the shell owns the state and the room only renders it — the
   *  same toggle closes it, which is why the dock carries no Hide of its own. */
  terminalOpen: boolean;
  /** Files the reader opened from the panel. Each is a tab beside the
   *  room's own — a path in ONE lane's worktree, wearing that lane's identity
   *  dot once the mission has competing approaches, because the same path open
   *  from two worktrees is two different files (D-048, D-084). While one is
   *  selected the room shows that file and nothing about the mission above it. */
  openFiles: { key: string; path: string; workstreamId: string | null }[];
  /** The selected tab's key, not its path: two lanes can hold one path. */
  activeFile: string | null;
  onSelectFile: (key: string | null) => void;
  onCloseFile: (key: string) => void;
  /** The approach lane this room is reading — null for the lane the mission
   *  started with. Everything lane-scoped follows it: the poll asks for it,
   *  the composer targets it, files and the terminal act in its worktree
   *  (D-080). */
  activeWorkstreamId: string | null;
  onSelectLane: (workstreamId: string | null) => void;
  /** The session this room is reading — null for the lane's first, which is
   *  the default and never carried around as an id (D-083). */
  activeSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  /** Canvas modes the rail's tree drives (D-084): the Compare surface, and the
   *  new-session draft. The shell owns both, because the rows that open them
   *  live in the rail. */
  decisionOpen: boolean;
  onDecisionOpen: (open: boolean) => void;
  sessionDraft: boolean;
  onSessionDraft: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Which approval is being answered, so its own card says so and a second
   *  click cannot send a second answer for it. */
  const [answering, setAnswering] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const isDraft = selectedMissionId === null;
  const raw = selectedMissionId === null ? undefined : details[selectedMissionId];
  /** The lane's own view: the server computed the lane-scoped facts for the
   *  lane the poll named, and this filters the mission-wide ledgers down to
   *  the same lane (D-080). The Decision Room reads the unfiltered fields,
   *  which laneView leaves untouched. */
  const detail = useMemo(() => (raw ? laneView(raw) : undefined), [raw]);
  // Agents run where the repository is. For a folder somebody added that means
  // this machine; for a GitHub repository it means the machine whose runner
  // fetched it — which is the same question and the same answer (D-025, D-032).
  const executionAvailable = project.onThisMachine;

  const resolveBase = useCallback(async () => {
    setDraft((prev) =>
      prev
        ? { ...prev, base: { kind: "resolving" } }
        : { creationKey: crypto.randomUUID(), base: { kind: "resolving" } }
    );
    const result =
      project.provider === "local"
        ? await novus().repos.baseLocal(project.providerRepoId)
        : await novus().repos.base(project.providerRepoId);
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            base: result.ok
              ? { kind: "resolved", base: result.value }
              : { kind: "failed", message: offlineOr(result.code, result.message) }
          }
        : prev
    );
  }, [project.provider, project.providerRepoId]);

  useEffect(() => {
    if (isDraft && draft === null) void resolveBase();
  }, [isDraft, draft, resolveBase]);

  // One poll carries the whole room: state, participants, control, directions,
  // executions, evidence (ARCHITECTURE.md — MissionDetailResponse).
  useEffect(() => {
    if (selectedMissionId === null) return;
    let live = true;
    const tick = async () => {
      const result = await novus().missions.get(selectedMissionId, activeWorkstreamId ?? undefined);
      if (!live) return;
      if (result.ok) {
        onDetail(result.value);
        return;
      }
      // A remembered lane the mission no longer has: fall back to the lane the
      // mission started with rather than polling a 404 forever.
      if (activeWorkstreamId !== null && result.code === "not_found") onSelectLane(null);
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selectedMissionId, activeWorkstreamId, onDetail, onSelectLane]);

  // Resizing the window must not strand the feed halfway up: a reader who was
  // at the bottom stays at the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
  };

  // Room keys (DESIGN.md#keyboard): G then C/V/A, R to request control.
  const chordRef = useRef(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (chordRef.current) {
        chordRef.current = false;
        if (key === "c") onInspector("changes");
        else if (key === "v") onInspector("verification");
        else if (key === "a") onInspector(null);
        return;
      }
      if (key === "g") {
        chordRef.current = true;
        setTimeout(() => {
          chordRef.current = false;
        }, 1200);
      } else if (key === "r" && detail?.capabilities.includes("control.request")) {
        void novus().control.request(detail.mission.missionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const submit = async ({
    body,
    model,
    effort
  }: {
    body: string;
    model: ModelId;
    effort: Effort;
  }): Promise<SubmitOutcome> => {
    setActionError(null);
    if (isDraft) {
      if (!draft || draft.base.kind !== "resolved") {
        return { ok: false, message: "The base revision is not resolved yet." };
      }
      const created = await novus().missions.create({
        goal: deriveGoal(body),
        successCriteria: body,
        provider: project.provider,
        providerRepoId: project.providerRepoId,
        baseRef: draft.base.base.ref,
        baseSha: draft.base.base.sha,
        creationKey: draft.creationKey
      });
      if (!created.ok) {
        return {
          ok: false,
          message:
            created.code === "offline"
              ? "Can't reach Novus. Nothing was created — try again when you're back online."
              : created.message
        };
      }
      const directed = await novus().missions.direct({
        missionId: created.value.mission.missionId,
        body,
        model,
        effort
      });
      setDraft(null);
      onCreated(created.value.mission);
      if (!directed.ok) {
        // The mission exists but the words never landed. Say so at the site of
        // the failure rather than swallowing what the user typed.
        setActionError(offlineOr(directed.code, directed.message));
        return { ok: false, message: offlineOr(directed.code, directed.message) };
      }
      return {
        ok: true,
        queued: !directed.value.dispatched,
        deferred: directed.value.deferred
      };
    }

    if (!detail) return { ok: false, message: "This mission is still loading." };
    if (detail.workstream === null) {
      return { ok: false, message: "This mission isn't ready to direct yet." };
    }
    // A new-session draft: these words create the session, title it, and land
    // in it, in one transaction (D-083). Nothing existed until now.
    if (sessionDraft) {
      const created = await novus().missions.direct({
        missionId: detail.mission.missionId,
        body,
        model,
        effort,
        workstreamId: detail.workstream.workstreamId,
        newSession: true
      });
      if (!created.ok) return { ok: false, message: offlineOr(created.code, created.message) };
      onSessionDraft(false);
      // The conversation exists now: its row joins the rail's tree, selected.
      onSelectSession(created.value.sessionId);
      return { ok: true, queued: !created.value.dispatched, deferred: created.value.deferred };
    }
    // Direction names the lane on screen, always (D-080): the server resolves
    // the named lane's own lease and queue, so work can never silently land on
    // the mission's first lane while an Alternative is being read. The session
    // travels the same way — absent means the lane's first (D-083).
    const result = await novus().missions.direct({
      missionId: detail.mission.missionId,
      body,
      model,
      effort,
      workstreamId: detail.workstream.workstreamId,
      ...(selectedSessionId !== null ? { sessionId: selectedSessionId } : {})
    });
    if (!result.ok) return { ok: false, message: offlineOr(result.code, result.message) };
    return { ok: true, queued: !result.value.dispatched, deferred: result.value.deferred };
  };

  /**
   * The Decision Room takes the canvas, exactly as an opened file does: a
   * comparison is read at full measure or not at all, and the composer stays
   * because deciding is not a reason to stop being able to direct (D-074).
   */
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const approaches = detail?.approaches ?? [];
  /** Something to fork from: an approach only means anything beside a result
   *  that already exists, so the control is absent until the lane being read
   *  has a shared checkpoint a sibling could start at (D-079). */
  const forkable = approaches.find(
    (approach) => approach.workstreamId === detail?.workstream?.workstreamId && approach.forkPointSha !== null
  );
  /** Every lane, in creation order; more than one only where somebody forked
   *  an approach (D-074). The first is the lane the mission started with. */
  const lanes = detail?.workstreams ?? [];
  const multiLane = lanes.length > 1;
  /** The lane this response was actually computed for — used for everything
   *  rendered, so the room is always internally consistent even in the poll
   *  between switching lanes and the next response arriving. */
  const activeLaneId = detail?.workstream?.workstreamId ?? null;
  const activeLane = lanes.find((lane) => lane.workstreamId === activeLaneId) ?? null;

  /** The lane's own conversations, in creation order (D-083). One for almost
   *  every lane; session chrome exists only past one. */
  const sessions = useMemo(() => (detail ? laneSessions(detail) : []), [detail]);
  const firstSessionId = sessions[0]?.sessionId ?? null;
  /** The session being read. A remembered id the lane does not hold — another
   *  lane's, or one this poll has not caught up to yet — reads as the lane's
   *  first rather than as a broken canvas. */
  const selectedSessionId =
    activeSessionId !== null && sessions.some((session) => session.sessionId === activeSessionId)
      ? activeSessionId
      : null;
  const readingSessionId = selectedSessionId ?? firstSessionId;
  const multiSession = sessions.length > 1;
  /** Which conversation asked, for the approval card's quiet meta line —
   *  named only while the lane holds more than one (D-083). */
  const sessionTitleOf = (executionId: string): string | null => {
    if (!detail || !multiSession) return null;
    const execution = detail.executions.find((entry) => entry.executionId === executionId);
    const session = sessions.find((entry) => entry.sessionId === execution?.sessionId);
    return session ? (session.title ?? "New session") : null;
  };

  /** The selected session's own view of the lane: the trace shows one
   *  conversation at a time, and everything else stays the lane's (D-083). */
  const sessionDetail = useMemo(
    () => (detail ? sessionView(detail, selectedSessionId) : undefined),
    [detail, selectedSessionId]
  );
  const feed = useMemo(() => (sessionDetail ? buildFeed(sessionDetail) : null), [sessionDetail]);

  /** The composer's foot names its whole target (D-080, D-083): the lane once
   *  more than one exists, the conversation once more than one exists, and a
   *  draft by what it is about to become. One lane, one session: nothing. */
  const readingSession =
    sessions.find((session) => session.sessionId === readingSessionId) ?? null;
  const sessionName = readingSession ? (readingSession.title ?? "New session") : null;
  const laneName = activeLane?.name ?? detail?.workstream?.name ?? null;
  const composerTarget = sessionDraft
    ? laneName
      ? `Directing a new session in ${laneName}`
      : null
    : multiSession && sessionName
      ? multiLane && laneName
        ? `Directing ${laneName} · "${sessionName}"`
        : `Directing "${sessionName}"`
      : multiLane && laneName
        ? `Directing ${laneName}`
        : null;

  // Auto-scroll on new activity unless the reader scrolled up. Keyed to the
  // conversation on screen: switching sessions lands at its latest activity.
  const eventCount = sessionDetail?.events.length ?? 0;
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [eventCount, selectedMissionId, readingSessionId]);
  const stateLine = detail ? deriveStateLine(detail) : null;
  const controller = detail ? controllerOf(detail) : null;
  const isController = detail ? viewerIsController(detail) : false;
  /**
   * The permission questions this mission is blocked on.
   *
   * Rendered from the server's own projection, and answered through a route
   * that checks `approval.respond` against the current lease — so a card on
   * screen is never the thing deciding who may answer (D-062).
   */
  const pendingApprovals = (detail?.approvals ?? []).filter(
    (approval) => approval.state === "pending"
  );
  const lastTraceKey =
    [...(feed?.blocks ?? [])].reverse().find((block) => block.kind !== "control")?.key ?? null;
  const liveOffer = detail?.control.liveOffer ?? null;
  const offerIsLive =
    liveOffer !== null && ["open", "accepted", "waiting_for_boundary"].includes(liveOffer.state);

  const respondToApproval = async (approvalId: string, decision: "approve" | "deny") => {
    setAnswering(approvalId);
    setApprovalError(null);
    const result = await novus().missions.respondApproval({ approvalId, decision });
    setAnswering(null);
    // A request answered by whoever holds the baton now — including someone
    // else, a moment ago — comes back refused, and the reason is the server's.
    if (!result.ok) setApprovalError(result.message);
  };

  const createApproach = async (intent: string) => {
    if (!detail?.workstream) return;
    setDecisionBusy(true);
    setDecisionError(null);
    const result = await novus().approaches.create({
      missionId: detail.mission.missionId,
      fromWorkstreamId: detail.workstream.workstreamId,
      intent,
      // The checkpoint the dialog showed is the checkpoint the fork gets, or
      // the server refuses and says where it moved — never a silent later
      // revision (D-079).
      ...(forkable?.forkPointSha ? { expectedOriginSha: forkable.forkPointSha } : {})
    });
    setDecisionBusy(false);
    setForking(false);
    if (!result.ok) setDecisionError(result.message);
    // The lane exists now: go to it. Its row is already in the rail's tree,
    // and landing in the room you just made beats a comparison over one turn
    // of nothing (D-084).
    else onSelectLane(result.value.workstream.workstreamId);
  };

  const recordDecision = async (input: {
    workstreamId: string;
    rationale: string;
    acceptedRisks: string;
  }) => {
    if (!detail) return;
    setDecisionBusy(true);
    setDecisionError(null);
    const result = await novus().approaches.decide({
      missionId: detail.mission.missionId,
      workstreamId: input.workstreamId,
      rationale: input.rationale,
      ...(input.acceptedRisks ? { acceptedRisks: input.acceptedRisks } : {})
    });
    setDecisionBusy(false);
    if (!result.ok) setDecisionError(result.message);
  };

  const requestRevision = async (input: { workstreamId: string; reason: string }) => {
    if (!detail) return;
    setDecisionBusy(true);
    setDecisionError(null);
    const result = await novus().approaches.requestRevision({
      missionId: detail.mission.missionId,
      workstreamId: input.workstreamId,
      reason: input.reason
    });
    setDecisionBusy(false);
    if (!result.ok) setDecisionError(result.message);
  };

  const runAction = async (call: Promise<{ ok: boolean; message?: string }>) => {
    const result = await call;
    if (!result.ok) setActionError(result.message ?? "That did not go through.");
    else setActionError(null);
  };

  const directionActions = (direction: Direction) => {
    if (!detail) return null;
    // Apply and Reject belong to the lease, not to authorship: the server
    // grants `direction.apply` to whoever holds the baton, including for their
    // own direction, so the interface may never hide a verb the server allows
    // (AGENTS.md rule 13, in the mirror). Cancel belongs to the author.
    const mine = direction.authorUserId === detail.viewerUserId;
    return (
      <span className="inline-actions">
        <GatedAction
          capability="direction.apply"
          capabilities={detail.capabilities}
          denialReason="Only the controller can apply direction."
          holderLogin={detail.control.holderLogin}
          onClick={() =>
            void runAction(
              novus().missions.resolveDirection({ directionId: direction.directionId, action: "apply" })
            )
          }
          variant="secondary"
          testid="apply-direction"
        >
          Apply
        </GatedAction>
        <GatedAction
          capability="direction.apply"
          capabilities={detail.capabilities}
          denialReason="Only the controller can reject direction."
          holderLogin={detail.control.holderLogin}
          onClick={() =>
            void runAction(
              novus().missions.resolveDirection({ directionId: direction.directionId, action: "reject" })
            )
          }
          variant="text"
          testid="reject-direction"
        >
          Reject
        </GatedAction>
        {mine && (
          <button
            className="btn btn-text"
            onClick={() => void runAction(novus().missions.cancelDirection(direction.directionId))}
            data-testid="cancel-direction"
          >
            Cancel
          </button>
        )}
      </span>
    );
  };

  const title = isDraft ? "New mission" : (detail?.mission.goal ?? "Loading mission");
  /** The file tab being read, resolved from its key — null when the canvas is
   *  the mission's own. */
  const activeFileEntry = openFiles.find((file) => file.key === activeFile) ?? null;

  return (
    <div className="room" data-testid="project-room">
      <div className="room-main">
      {/* This strip is the mission's working row (D-086): the top strip holds
          one tab per mission, and this one — one level below, exactly where an
          open file appears — holds the mission's approaches as colour-dotted
          tabs, Compare while it is open, and every open file, side by side.
          One canvas shows at a time; the colours tie a lane's tab to its
          files. Sessions are never tabs here — they are the rail's tree. A
          mission with one approach and nothing open shows no strip at all. */}
      {(openFiles.length > 0 || decisionOpen || multiLane) && (
        <div className="tabbar" role="tablist" aria-label={`Open in ${title}`}>
          {multiLane ? (
            lanes.map((lane, index) => {
              const selected =
                activeFile === null && !decisionOpen && lane.workstreamId === activeLaneId;
              return (
                <button
                  key={lane.workstreamId}
                  role="tab"
                  aria-selected={selected}
                  className={selected ? "tab lane-tab active" : "tab lane-tab"}
                  onClick={() => {
                    onSelectFile(null);
                    onDecisionOpen(false);
                    onSessionDraft(false);
                    if (lane.workstreamId !== activeLaneId) {
                      onSelectLane(lane.workstreamId === lanes[0]?.workstreamId ? null : lane.workstreamId);
                    }
                  }}
                  title={
                    lane.approach
                      ? `${lane.name} — isolated workspace`
                      : `${lane.name} — the work this mission started with`
                  }
                  data-testid="lane-tab"
                  data-workstream={lane.workstreamId}
                >
                  <span
                    className={index === 0 ? "lane-dot lane-dot-current" : "lane-dot lane-dot-alt"}
                    aria-hidden="true"
                  />
                  {lane.name}
                </button>
              );
            })
          ) : (
            <button
              role="tab"
              aria-selected={activeFile === null && !decisionOpen}
              className={activeFile === null && !decisionOpen ? "tab active" : "tab"}
              onClick={() => {
                onSelectFile(null);
                onDecisionOpen(false);
                onSessionDraft(false);
              }}
              title={`Back to ${title}`}
              data-testid="room-tab"
            >
              {/* Not the goal again. The window's strip above already names
                  this mission and the rail names it a third time; the only
                  question this control answers is "what do I return to"
                  (D-061). With approaches, their tabs are the way back. */}
              Mission
            </button>
          )}
          {/* Compare, while it is open, is a sibling tab rather than a swap:
              a person reads a file, comes back to the comparison, and reads
              another, without any canvas silently eating the last (D-084). */}
          {decisionOpen && (
            <span
              className={activeFile === null ? "tab file-tab active" : "tab file-tab"}
              data-testid="compare-tab"
            >
              <button
                role="tab"
                aria-selected={activeFile === null}
                className="file-tab-open"
                onClick={() => {
                  onSelectFile(null);
                  onSessionDraft(false);
                }}
                title="Compare approaches"
              >
                <span className="file-tab-name">Compare</span>
              </button>
              <button
                className="file-tab-close"
                onClick={() => {
                  onDecisionOpen(false);
                }}
                aria-label="Close the comparison"
                title="Close the comparison"
              >
                ×
              </button>
            </span>
          )}
          {openFiles.map((file) => {
            // Which lane's worktree this tab reads — its own fact, captured
            // when it was opened. The dot says so once approaches exist, and
            // choosing the tab puts the room in that lane, so the colour and
            // the content can never disagree (D-084).
            const fileLaneId = file.workstreamId ?? lanes[0]?.workstreamId ?? null;
            const laneIndex = lanes.findIndex((lane) => lane.workstreamId === fileLaneId);
            const laneName = lanes[laneIndex]?.name ?? null;
            return (
              <span
                key={file.key}
                className={file.key === activeFile ? "tab file-tab active" : "tab file-tab"}
                data-testid="file-tab"
                data-path={file.path}
                data-workstream={fileLaneId ?? undefined}
              >
                <button
                  role="tab"
                  aria-selected={file.key === activeFile}
                  className="file-tab-open"
                  onClick={() => {
                    onSelectFile(file.key);
                    if (file.workstreamId !== activeWorkstreamId) onSelectLane(file.workstreamId);
                    onSessionDraft(false);
                  }}
                  title={multiLane && laneName ? `${file.path} — in ${laneName}` : file.path}
                >
                  {multiLane && laneIndex >= 0 && (
                    <span
                      className={laneIndex === 0 ? "lane-dot lane-dot-current" : "lane-dot lane-dot-alt"}
                      aria-hidden="true"
                    />
                  )}
                  <FileGlyph />
                  <span className="file-tab-name">{file.path.split("/").pop() ?? file.path}</span>
                </button>
                <button
                  className="file-tab-close"
                  onClick={() => onCloseFile(file.key)}
                  aria-label={`Close ${file.path}`}
                  title={`Close ${file.path}`}
                  data-testid="file-tab-close"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {activeFile === null && (
      <header className="room-header">
        <h1 className="mission-title" data-testid="room-goal" title={title}>
          {title}
        </h1>

        {/* Which lane this room is, said once and quietly (D-080). Absent for
            the mission that never forked, because there is nothing to tell
            apart. */}
        {multiLane && activeLane && (
          <p className="lane-context" data-testid="lane-context">
            {activeLane.name}
            {activeLane.approach ? " · isolated workspace" : ""}
            {activeLane.approach && activeLane.originSha ? (
              <>
                {" "}· forked at <span className="mono">{shortSha(activeLane.originSha)}</span>
              </>
            ) : null}
          </p>
        )}

        <div className="state-line" role="status" aria-live="polite" data-testid="state-line">
          {stateLine ? (
            <>
              <span className="state-name">{stateLine.name}</span>
              <span className="state-detail">— {stateLine.detail}</span>
              {stateLine.suffix && <span className="state-detail">· {stateLine.suffix}</span>}
              {stateLine.action?.kind === "stop" && detail && (
                <GatedAction
                  capability="execution.stop"
                  capabilities={detail.capabilities}
                  denialReason="Only participants who can stop this execution may stop it."
                  onClick={() =>
                    // The lane travels on the wire, so a Stop pressed in an
                    // Alternative can never land on the mission's first lane
                    // (D-080, D-083).
                    void runAction(
                      novus().missions.stop(detail.mission.missionId, activeLaneId ?? undefined)
                    )
                  }
                  variant="secondary"
                  testid="stop"
                >
                  Stop
                </GatedAction>
              )}
              {(stateLine.action?.kind === "changes" || stateLine.action?.kind === "verification") && (
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    onInspector(stateLine.action?.kind === "verification" ? "verification" : "changes")
                  }
                  data-testid="state-action"
                >
                  {stateLine.action.label}
                </button>
              )}
              {stateLine.action?.kind === "setup" && (
                <button className="btn btn-secondary" onClick={onSetup} data-testid="state-setup">
                  {stateLine.action.label}
                </button>
              )}
              {/* Stop and Open preview are deliberately absent here: while a
                  run command is alive they live on the Run control, which is
                  where every run verb lives (DESIGN.md#component-behavior).
                  So is any decision button (D-084): the sentence is the state,
                  and the decision is read on Compare, one rail row away. */}
            </>
          ) : (
            <>
              <span className="state-name">Ready</span>
              <span className="state-detail">
                {isDraft ? "— the first direction creates this mission" : "— loading this mission"}
              </span>
              {isDraft && !executionAvailable && (
                <span className="state-detail">
                  · no machine has this repository checked out for Novus yet — the first direction asks one
                  to fetch it
                </span>
              )}
            </>
          )}
        </div>

        <div className="authority-row">
          {detail ? (
            <>
              {/* Deliberately reached, never pushed: absent until this lane has
                  produced something to fork from, and absent for anyone whose
                  role does not carry it (D-074). */}
              {forkable && detail.capabilities.includes("approach.create") && (
                <>
                  <button
                    className="btn btn-text"
                    onClick={() => setForking(true)}
                    data-testid="try-another-approach"
                  >
                    Try another approach
                  </button>
                  {/* One quiet sentence, only while the mission has a single
                      lane and a reviewable result — the moment the control is
                      for. Once approaches exist the rail's tree says the rest. */}
                  {approaches.length === 1 &&
                    (detail.state === "work_completed_unverified" ||
                      detail.state === "ready_for_review") && (
                      <span className="quiet approach-helper" data-testid="approach-helper">
                        Start from this shared checkpoint and compare another solution.
                      </span>
                    )}
                </>
              )}
              {/* Sessions, other approaches, Compare, and the decision have no
                  controls here (D-084): the rail's tree is the one map of the
                  mission's structure, and this row is about authority. */}
              <span className="controller-slot" data-testid="controller">
                {controller ? (
                  <>
                    <HumanMark login={controller.login} name={controller.name} />
                    <span className="controller-name">
                      {isController ? "You have the baton" : `${controller.name ?? controller.login} has the baton`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="controller-name">No one holds the baton</span>
                  </>
                )}
              </span>
              {!isController && (
                <GatedAction
                  capability="control.request"
                  capabilities={detail.capabilities}
                  denialReason="Only participants who can operate this mission may request control."
                  holderLogin={detail.control.holderLogin}
                  onClick={() => void runAction(novus().control.request(detail.mission.missionId))}
                  variant="text"
                  testid="request-control"
                >
                  Request control
                </GatedAction>
              )}
              <span className="head-spacer" />
            </>
          ) : (
            <span className="controller-name quiet">
              {isDraft ? "Nobody has joined this mission yet" : "Loading participants…"}
            </span>
          )}
        </div>
      </header>
      )}

      {actionError && (
        <p className="inline-error room-error" role="alert" data-testid="action-error">
          {actionError}
        </p>
      )}

      {forking && detail?.workstream && (
        <TryAnotherApproach
          goal={detail.mission.goal}
          fromName={detail.workstream.name}
          originSha={forkable?.forkPointSha ?? null}
          busy={decisionBusy}
          onCancel={() => setForking(false)}
          onCreate={(intent) => void createApproach(intent)}
        />
      )}

      {activeFileEntry !== null && selectedMissionId !== null ? (
        // The pane reads the worktree the tab was opened from — the tab's own
        // lane, never whichever lane the room happens to be reading — so the
        // dot on the tab and the bytes on screen cannot disagree (D-084).
        <FileView
          key={activeFileEntry.key}
          missionId={selectedMissionId}
          workstreamId={activeFileEntry.workstreamId ?? undefined}
          path={activeFileEntry.path}
        />
      ) : decisionOpen && detail ? (
        <div className="feed-scroll">
          <DecisionRoom
            detail={detail}
            busy={decisionBusy}
            error={decisionError}
            onRecord={(input) => void recordDecision(input)}
            onRequestRevision={(input) => void requestRevision(input)}
            onInspectPath={() => onInspector("changes")}
            onClose={() => onDecisionOpen(false)}
          />
        </div>
      ) : sessionDraft ? (
        /* An empty conversation: one quiet sentence, and the composer below is
           the ask. Nothing exists yet, so there is nothing else to show
           (D-077 one level down, D-083). */
        <div className="feed-scroll">
          <div className="feed">
            <div className="draft-canvas">
              <p className="draft-lead" data-testid="session-draft-lead">
                The first direction starts this session.
              </p>
            </div>
          </div>
        </div>
      ) : (
      <div className="feed-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="feed" data-testid="chat">
          {isDraft ? (
            <DraftCanvas draft={draft} project={project} onRetry={() => void resolveBase()} />
          ) : detail && feed ? (
            <>
              {feed.setup && (
                <div
                  className={feed.setup.danger ? "workspace-row danger" : "workspace-row"}
                  data-testid="setup-row"
                >
                  <span>{feed.setup.label}</span>
                  <button
                    className="btn btn-text workspace-row-action"
                    onClick={() => onInspector("overview")}
                    data-testid="setup-overview"
                  >
                    Overview
                  </button>
                </div>
              )}
              {feed.blocks.map((block) =>
                block.kind === "control" ? (
                  <ControlEventRow key={block.key} block={block} />
                ) : (
                  <TraceView
                    key={block.key}
                    block={block}
                    controllerUserId={detail.control.holderUserId}
                    controllerLogin={detail.control.holderLogin}
                    viewerIsController={isController}
                    onOpenChanges={() => onInspector("changes")}
                    onOpenVerification={() => onInspector("verification")}
                    actions={block.direction ? directionActions(block.direction) : null}
                    // The question goes in the thread that raised it, so it is
                    // attached to the last block rather than floated anywhere.
                    approvals={
                      block.key === lastTraceKey
                        ? pendingApprovals.map((approval) => (
                            <ApprovalRow
                              key={approval.approvalId}
                              approval={approval}
                              capabilities={detail.capabilities}
                              controllerLogin={detail.control.holderLogin}
                              busy={answering === approval.approvalId}
                              error={answering === null ? approvalError : null}
                              askedIn={sessionTitleOf(approval.executionId)}
                              onRespond={(decision) => void respondToApproval(approval.approvalId, decision)}
                              onRequestControl={
                                detail.capabilities.includes("control.request")
                                  ? () => void runAction(novus().control.request(detail.mission.missionId))
                                  : null
                              }
                            />
                          ))
                        : null
                    }
                  />
                )
              )}

              {detail.control.openRequests
                .filter((request) => request.state === "open")
                .map((request) => (
                  <div className="authority-card" key={request.requestId} data-testid="control-request">
                    <HumanMark login={request.requesterLogin} />
                    <span className="authority-text">
                      <strong>{request.requesterLogin}</strong> requests control
                    </span>
                    <span className="trace-time">{clockTime(request.createdAt)}</span>
                    {request.requesterUserId === detail.viewerUserId ? (
                      <button
                        className="btn btn-text"
                        onClick={() => void runAction(novus().control.withdrawRequest(detail.mission.missionId))}
                        data-testid="withdraw-request"
                      >
                        Withdraw
                      </button>
                    ) : (
                      <span className="inline-actions">
                        <GatedAction
                          capability="control.offer"
                          capabilities={detail.capabilities}
                          denialReason="Only the controller can offer control."
                          holderLogin={detail.control.holderLogin}
                          onClick={() =>
                            void runAction(
                              novus().control.offer({
                                missionId: detail.mission.missionId,
                                toUserId: request.requesterUserId
                              })
                            )
                          }
                          variant="secondary"
                          testid="offer-control"
                        >
                          Offer
                        </GatedAction>
                        <GatedAction
                          capability="control.offer"
                          capabilities={detail.capabilities}
                          denialReason="Only the controller can decline a request for control."
                          holderLogin={detail.control.holderLogin}
                          onClick={() => void runAction(novus().control.declineRequest(request.requestId))}
                          variant="text"
                          testid="decline-request"
                        >
                          Decline
                        </GatedAction>
                      </span>
                    )}
                  </div>
                ))}

              {liveOffer && offerIsLive && (
                <div className="authority-card" data-testid="handoff-offer">
                  <HumanMark login={liveOffer.fromLogin} />
                  <span className="authority-text">
                    <strong>{liveOffer.fromLogin}</strong> offers control to{" "}
                    {liveOffer.toUserId === detail.viewerUserId ? "you" : liveOffer.toLogin}
                  </span>
                  <span className="trace-time">{clockTime(liveOffer.createdAt)}</span>
                  {liveOffer.toUserId === detail.viewerUserId ? (
                    <span className="inline-actions">
                      <GatedAction
                        capability="control.accept"
                        capabilities={detail.capabilities}
                        denialReason="Only the named recipient can accept this offer."
                        onClick={() => void runAction(novus().control.acceptOffer(liveOffer.offerId))}
                        variant="secondary"
                        testid="accept-offer"
                      >
                        Accept
                      </GatedAction>
                      <button
                        className="btn btn-text"
                        onClick={() => void runAction(novus().control.declineOffer(liveOffer.offerId))}
                        data-testid="decline-offer"
                      >
                        Decline
                      </button>
                    </span>
                  ) : (
                    <GatedAction
                      capability="control.offer"
                      capabilities={detail.capabilities}
                      denialReason="Only the controller can withdraw this offer."
                      holderLogin={detail.control.holderLogin}
                      onClick={() => void runAction(novus().control.withdrawOffer(liveOffer.offerId))}
                      variant="text"
                      testid="withdraw-offer"
                    >
                      Withdraw
                    </GatedAction>
                  )}
                </div>
              )}

              {/* A mission that exists but has produced nothing says so.
                  The technical setup row is not activity, so it does not
                  suppress the sentence (DESIGN.md#transient-states). */}
              {feed.blocks.length === 0 && (
                <p className="quiet" data-testid="feed-empty">
                  Nothing has happened here yet.
                </p>
              )}
            </>
          ) : (
            <div data-testid="feed-loading">
              <div className="placeholder-block" />
              <div className="placeholder-block" />
              <div className="placeholder-block" />
            </div>
          )}
        </div>
      </div>
      )}

      <Composer
        key={selectedMissionId ?? "draft"}
        /* A draft has no mission yet, so no server capabilities exist to read:
           creating one is an org act (PRODUCT.md#roles-and-capabilities) and
           the creator becomes its Mission Admin. */
        // A repository on someone else's Mac is fine to direct: their runner
        // picks the work up, which is the whole point of the handoff. A GitHub
        // repository is fine too — a runner fetches it into its own area and
        // works it exactly like a folder somebody added (D-025, D-032).
        capabilities={isDraft ? ["direction.submit"] : (detail?.capabilities ?? null)}
        isController={isController || isDraft}
        contextNote={composerTarget}
        placeholderOverride={sessionDraft ? "What should this session do?" : undefined}
        onSubmit={submit}
      />

      {/* The bottom dock. It shares the room's width and shortens the trace
          rather than replacing it; below the single-column threshold it takes
          the room (DESIGN.md#component-behavior). */}
      {terminalOpen && executionAvailable && selectedMissionId !== null && (
        <RuntimeDock
          key={activeLaneId ?? "default"}
          missionId={selectedMissionId}
          workstreamId={activeLaneId ?? undefined}
        />
      )}

      </div>

    </div>
  );
}

/** The "+" tab before its first message: the pinned base, quietly, and one
 *  left-aligned sentence — never a form and never a marketing empty state. */
function DraftCanvas({
  draft,
  project,
  onRetry
}: {
  draft: Draft | null;
  project: Project;
  onRetry: () => void;
}) {
  if (draft === null || draft.base.kind === "resolving") {
    return <p className="quiet">Resolving the base revision…</p>;
  }
  if (draft.base.kind === "failed") {
    return (
      <p className="quiet">
        <span className="inline-error" data-testid="base-error">
          {draft.base.message}
        </span>{" "}
        <button className="btn btn-text" onClick={onRetry} data-testid="base-retry">
          Try again
        </button>
      </p>
    );
  }
  return (
    <div className="draft-canvas">
      <p className="draft-lead">The first direction creates this mission and starts Claude Code.</p>
      <p className="quiet" data-testid="draft-base">
        Pinned to {project.name} · <span className="mono">{draft.base.base.ref}</span> ·{" "}
        <span className="mono">{shortSha(draft.base.base.sha)}</span>
      </p>
    </div>
  );
}

/**
 * Starting a competing approach (D-074, D-079).
 *
 * One required field, because an approach nobody can tell apart from its
 * sibling is a retry — and PRODUCT.md has always said a retry is a
 * continuation. The dialog names the mission's goal and the exact shared
 * checkpoint the fork starts from, so nobody starts one thinking it begins
 * from now — and if no shared checkpoint exists, it blocks with the reason
 * rather than guessing a revision.
 */
function TryAnotherApproach({
  goal,
  fromName,
  originSha,
  busy,
  onCancel,
  onCreate
}: {
  goal: string;
  fromName: string;
  originSha: string | null;
  busy: boolean;
  onCancel: () => void;
  onCreate: (intent: string) => void;
}) {
  const [intent, setIntent] = useState("");
  return (
    <Dialog label="Try another approach" onClose={onCancel} testId="try-approach-dialog">
        <header className="dialog-head">
          <h2>Try another approach</h2>
          <p className="dialog-sub" data-testid="approach-goal">{goal}</p>
          {originSha ? (
            <p className="dialog-sub" data-testid="approach-origin">
              Starts from shared checkpoint <span className="mono">{shortSha(originSha)}</span>. Changes
              made only in {fromName} stay there.
            </p>
          ) : (
            <p className="dialog-sub" data-testid="approach-origin-missing">
              No shared checkpoint exists yet — {fromName} has to checkpoint a first result before an
              approach can start beside it.
            </p>
          )}
        </header>
        <div className="dialog-body">
          <label className="field">
            <span className="field-label">What should this approach try differently?</span>
            <textarea
              className="input"
              rows={3}
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
              placeholder="Describe the solution you want to compare."
              data-testid="approach-intent-input"
              autoFocus
            />
          </label>
          <p className="quiet">
            This starts an isolated workspace. {fromName} stays unchanged. The project&rsquo;s saved
            setup and the local files already approved for this repository carry over automatically.
          </p>
          <p className="quiet">
            Approaches should solve the same mission in meaningfully different ways. For unrelated
            work, create a new mission.
          </p>
        </div>
        <footer className="dialog-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={intent.trim().length === 0 || busy || originSha === null}
            onClick={() => onCreate(intent.trim())}
            data-testid="create-approach"
          >
            Start approach
          </button>
        </footer>
    </Dialog>
  );
}
