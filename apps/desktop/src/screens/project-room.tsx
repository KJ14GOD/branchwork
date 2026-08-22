import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BaseStatus,
  ApproachSummary,
  BaseRevision,
  Direction,
  DirectionContextRef,
  Effort,
  Mission,
  MissionDetailResponse,
  ModelId,
  RecordingStatus,
  Session,
  Workstream
} from "@novus/contracts";
import { novus } from "../bridge";
import { matchesChord, useKeybindings } from "../keybindings";
import {
  Composer,
  profileLabel,
  type PolicyControl,
  type SubmitOutcome
} from "../components/composer";
import {
  contestedAcrossSessions,
  controller as controllerOf,
  deriveStateLine,
  laneSessions,
  laneView,
  offerCountdownLabel,
  queuedPositionLabel,
  sessionActivity,
  sessionChangedFiles,
  sessionChecks,
  usageSoFar,
  sessionView,
  slashCommandCompletions,
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
import { ArtifactView } from "../components/artifact-view";
import { renderTranscript } from "../components/transcript";
import { WorkerInspector } from "../components/worker-inspector";
import type { InspectorSection } from "../components/inspector";
import { DecisionRoom } from "../components/decision-room";
import { Dialog } from "../components/dialog";
import { FileView } from "../components/file-view";
import { PreviewSurface } from "../components/preview-surface";
import { PREVIEW_TAB_KEY, pullIdOfKey, pullTabKey, type OpenPreviewTab } from "../components/preview";
import { PullRequestPage, pullStateWord } from "../components/pull-request";
import { ReceiptView } from "../components/receipt-view";

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

/** The mark that says a tab is a conversation rather than a file or a lane
 *  (D-083, D-087): the same sanctioned stroke style as the file glyph. */
function SessionGlyph() {
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
      <path d="M13.25 4.25v5.5a1 1 0 0 1-1 1H8l-2.75 2.5v-2.5H3.75a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1h8.5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

import { RuntimeDock } from "../components/runtime-dock";
import { clockTime, deriveGoal, elapsed, shortSha, truncateLabel, usd } from "../format";
import { MAX_DIRECTION_CONTEXT, scopesDisjoint } from "@novus/contracts";
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

/**
 * The floor under the live signal (D-149): how often an open room re-reads
 * even when nothing told it to. Long on purpose — this is the safety net for a
 * dropped stream or a missed signal, not the way the room normally learns, and
 * a busy room re-reads on every change instead.
 */
const SLOW_READ_MS = 30_000;

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
  forkAsk = 0,
  contextAsk = null,
  onForkConsumed,
  findAsk = 0,
  onFindConsumed,
  selectedMissionId,
  onInspector,
  onInspectTurnChanges,
  onSetup,
  onDetail,
  onCreated,
  terminalOpen,
  onOpenTerminal,
  openFiles,
  activeFile,
  onSelectFile,
  onCloseFile,
  activeWorkstreamId,
  onSelectLane,
  activeSessionId,
  openSessionIds,
  onSelectSession,
  onOpenSession,
  onCloseSession,
  onReorderSession,
  onReorderFile,
  decisionOpen,
  onOpenDecision,
  onDecisionOpen,
  sessionDraft,
  onSessionDraft,
  previewTab,
  onClosePreview,
  onReopenPreview,
  openPullIds,
  onOpenPull,
  onClosePull,
  openArtifactId,
  onCloseArtifact
}: {
  /** Incremented by the rail's Try-another-approach row (D-126); each tick
   *  opens the fork dialog, even after a cancel. */
  forkAsk?: number;
  /** A pinned reference asked for from the panel (D-182): nonced so every
   *  click lands once, deduped and capped here where the chips live. */
  contextAsk?: { ref: DirectionContextRef; n: number } | null;
  /** The palette's ask to open the find bar (D-178) — consumed, forkAsk's own pattern. */
  findAsk?: number;
  onFindConsumed?: () => void;
  /** Resets the ask once the dialog opened — the counter is a message, not
   *  state to keep (D-142 batch). */
  onForkConsumed: () => void;
  project: Project;
  details: Record<string, MissionDetailResponse>;
  selectedMissionId: string | null;
  /** Opening the evidence panel is the shell's job — it owns the panel and the
   *  control that shows it. The room only ever asks for a section. */
  onInspector: (section: InspectorSection | null) => void;
  /** Opens Changes narrowed to one turn's checkpoint (D-213) — the way in
   *  from a turn's own CHECKPOINT row; every other way in is mission-wide. */
  onInspectTurnChanges?: (checkpointId: string) => void;
  /** The setup dialog is the shell's too: the Run control opens the same one. */
  onSetup: () => void;
  onDetail: (detail: MissionDetailResponse) => void;
  onCreated: (mission: Mission) => void;
  /** The bottom terminal dock. Its toggle sits with the other workspace
   *  controls, so the shell owns the state and the room only renders it — the
   *  same toggle closes it, which is why the dock carries no Hide of its own. */
  terminalOpen: boolean;
  /** Raises the dock the shell owns — the / menu's open-in-terminal row needs
   *  it (D-199); the toggle itself stays the shell's. */
  onOpenTerminal?: () => void;
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
  /** Sessions explicitly opened as tabs on the working row; the lane's first
   *  is the anchor and implicitly always open (D-087). */
  openSessionIds: string[];
  onSelectSession: (sessionId: string | null) => void;
  /** Opens a session as a tab on the working row and selects it. */
  onOpenSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** Moves an open session tab to a new position — the row is the person's
   *  own order (D-088). */
  onReorderSession: (sessionId: string, targetIndex: number) => void;
  onReorderFile: (key: string, targetIndex: number) => void;
  /** Canvas modes the rail's tree drives (D-084): the Compare surface, and the
   *  new-session draft. The shell owns both, because the rows that open them
   *  live in the rail. */
  decisionOpen: boolean;
  /** Opens the decision surface — the state line's Publish action needs a
   *  way there (D-141); the surface itself stays the shell's one canvas
   *  switch, exactly as the rail row uses it. */
  onOpenDecision: () => void;
  onDecisionOpen: (open: boolean) => void;
  sessionDraft: boolean;
  onSessionDraft: (open: boolean) => void;
  /** The preview tab, at most one per mission (D-098). Selection rides
   *  `activeFile` under `PREVIEW_TAB_KEY`, so everything that selects another
   *  canvas already deselects it. The shell owns the entry, because the Run
   *  control that opens it lives in the top bar. */
  previewTab: OpenPreviewTab | null;
  onClosePreview: () => void;
  onReopenPreview: (url: string) => void;
  /** The pull request's own tab (D-100): opened by a person from the rail
   *  or the receipt, selection riding `activeFile` under `PULL_TAB_KEY`. */
  openPullIds: string[];
  onOpenPull: (pullRequestId: string) => void;
  onClosePull: (pullRequestId: string) => void;
  /** One artifact taking the canvas (D-122) — opened from the Evidence
   *  section, never a tab, closed with Esc or Back like a worker's view. */
  openArtifactId: string | null;
  onCloseArtifact: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Which approval is being answered, so its own card says so and a second
   *  click cannot send a second answer for it. */
  const [answering, setAnswering] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The worker view's own scroller, so find walks whichever canvas is
   *  showing (D-202): the inspector replaces the feed, and a find that only
   *  knew the feed's scroller found nothing there. */
  const inspectorScrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /** One of the turn's workers opened on the canvas (D-107). Room-local, like
   *  a disclosure: never a tab, never a rail row, never the working set's. */
  const [openWorker, setOpenWorker] = useState<{ blockKey: string; workerId: string } | null>(null);
  /** Set once, by View in conversation (D-168): the direction whose block the
   *  feed should scroll to and briefly mark, the next time that block is on
   *  screen. `sessionView` is a pure client-side filter over `detail`, so
   *  switching sessions never re-fetches — the target is already in `detail`
   *  the instant it is set, and the effect below finds it on the very next
   *  paint. Cleared once found; left standing (silently) if the execution
   *  never had a starting direction to point at. */
  const [scrollToBlockKey, setScrollToBlockKey] = useState<string | null>(null);
  /** The sibling chats a new-chat draft will continue from (D-173): their
   *  transcripts are projected and carried on the draft's first direction.
   *  Only meaningful while the draft surface is open; cleared when it closes. */
  const [continueFrom, setContinueFrom] = useState<string[]>([]);
  /** Pinned references the next send carries (D-182): worktree files and
   *  checks picked from the inspector, worn as chips on the composer's top
   *  edge and cleared once the direction lands. Held per conversation
   *  (D-215): a pin made in one chat is that chat's, and switching chats
   *  leaves it there. `pendingContext` below reads the current chat's. */
  const [pendingByChat, setPendingByChat] = useState<Record<string, DirectionContextRef[]>>({});
  /** A command waiting to be typed into the dock (D-199) — primed, never
   *  submitted: pressing Enter in one's own session stays one's own act. */
  const [dockPrime, setDockPrime] = useState<string | null>(null);
  // An abandoned draft carries nothing forward: the selection dies with the
  // surface it was made on (D-173, same rule as the draft's own words).
  useEffect(() => {
    if (!sessionDraft) setContinueFrom([]);
  }, [sessionDraft]);
  /** Where the reader was in the conversation when they opened a worker, so
   *  Back to chat returns them there rather than to the top. */
  const savedScrollRef = useRef<number | null>(null);
  // What the hand is holding, while it is holding it. Refs, not dataTransfer:
  // Chromium hides a drag's payload until the drop, and the live reorder
  // needs to know the dragged tab on every dragover (D-090).
  const dragSessionRef = useRef<string | null>(null);
  const dragFileRef = useRef<string | null>(null);

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

  // One read carries the whole room: state, participants, control, directions,
  // executions, evidence (ARCHITECTURE.md — MissionDetailResponse). The room
  // is *told* when to take it (D-149) rather than asking on a timer.
  //
  // Three things drive a read, and the order matters. The signal is the fast
  // path — a change arrives and the room re-reads at once. The coalescing
  // window is what keeps a busy turn from making one read per event: a signal
  // during an in-flight read is remembered and satisfied by a single read
  // after it, never a queue of them. The slow fallback is the honest floor —
  // a stream that is down or a signal that was missed costs latency, not
  // truth, because this fires regardless.
  useEffect(() => {
    if (selectedMissionId === null) return;
    let live = true;
    let reading = false;
    let missed = false;

    const read = async (): Promise<void> => {
      if (!live) return;
      if (reading) {
        missed = true;
        return;
      }
      reading = true;
      try {
        const result = await novus().missions.get(selectedMissionId, activeWorkstreamId ?? undefined);
        if (!live) return;
        if (result.ok) onDetail(result.value);
        // A remembered lane the mission no longer has: fall back to the lane
        // the mission started with rather than re-reading a 404 forever.
        else if (activeWorkstreamId !== null && result.code === "not_found") onSelectLane(null);
      } finally {
        reading = false;
      }
      if (live && missed) {
        missed = false;
        void read();
      }
    };

    void read();
    void novus().missions.watch(selectedMissionId);
    const stopListening = novus().missions.onChanged((change) => {
      if (change.missionId === selectedMissionId) void read();
    });
    const fallback = setInterval(() => void read(), SLOW_READ_MS);
    return () => {
      live = false;
      stopListening();
      clearInterval(fallback);
      void novus().missions.unwatch();
    };
  }, [selectedMissionId, activeWorkstreamId, onDetail, onSelectLane]);

  /** The attached image being read at full size (D-152), or null. Room state
   *  rather than trace state: it covers the whole surface, and the trace is
   *  one of the things it covers. */
  const [openImage, setOpenImage] = useState<{ artifactId: string; label: string; mimeType?: string } | null>(null);

  // Escape closes the image (D-152). Registered in the capture phase so it
  // answers before the room's other Escape handlers do: while a picture is
  // covering the surface, Escape means "put it back" and nothing else.
  useEffect(() => {
    if (!openImage) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpenImage(null);
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [openImage]);

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

  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 48;
    // A roomier threshold than the pin's, so the arrow never flickers at the
    // bottom edge: it appears once the reader has genuinely left the latest.
    setAwayFromLatest(
      element.scrollHeight - (element.scrollTop + element.clientHeight) > 160
    );
  };

  const jumpToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  // Find in the conversation (Cmd+F). The stream is the whole search domain —
  // not the rail, not the panel, not the composer — because "where did it say
  // that" is a question about this mission's record. Matches paint through the
  // CSS custom-highlight registry, so nothing about the feed's own DOM moves.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findRangesRef = useRef<Range[]>([]);

  const keys = useKeybindings();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesChord(event, keys.find)) {
        event.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.select(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys]);

  useEffect(() => {
    const registry = CSS.highlights;
    if (!registry) return;
    registry.delete("novus-find");
    findRangesRef.current = [];
    const needle = findQuery.trim().toLowerCase();
    if (!findOpen || needle.length === 0) {
      setFindCount(0);
      return;
    }
    // Whichever canvas is on screen: the conversation, or the worker a
    // person stepped into (D-202).
    const root = openWorker ? inspectorScrollRef.current : scrollRef.current;
    if (!root) {
      setFindCount(0);
      return;
    }
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode()) && ranges.length < 500) {
      const hay = (node.textContent ?? "").toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1 && ranges.length < 500) {
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    findRangesRef.current = ranges;
    setFindCount(ranges.length);
    setFindIndex((current) => (ranges.length === 0 ? 0 : Math.min(current, ranges.length - 1)));
    if (ranges.length > 0) registry.set("novus-find", new Highlight(...ranges));
  }, [findQuery, findOpen, detail, openWorker]);

  useEffect(() => {
    const registry = CSS.highlights;
    if (!registry) return;
    registry.delete("novus-find-current");
    const range = findRangesRef.current[findIndex];
    if (!findOpen || !range) return;
    registry.set("novus-find-current", new Highlight(range));
    (range.startContainer.parentElement ?? null)?.scrollIntoView({ block: "center" });
  }, [findIndex, findCount, findOpen]);

  const stepFind = (direction: 1 | -1) => {
    const total = findRangesRef.current.length;
    if (total === 0) return;
    setFindIndex((current) => (current + direction + total) % total);
  };

  useEffect(() => {
    if (findAsk > 0) {
      setFindOpen(true);
      setTimeout(() => findInputRef.current?.select(), 0);
      onFindConsumed?.();
    }
  }, [findAsk, onFindConsumed]);

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
    setFindIndex(0);
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
    effort,
    alongside = false,
    attachmentIds = []
  }: {
    body: string;
    model: ModelId;
    effort: Effort;
    alongside?: boolean;
    attachmentIds?: string[];
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
        effort,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {})
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
      // The chosen chats travel first (D-173): each is projected from the
      // detail already on screen — the one feed derivation, rendered to
      // markdown — and uploaded as a transcript artifact the first direction
      // then carries. A transcript that cannot be carried refuses the send in
      // words: a chat that silently started without the context it promised
      // is worse than one that asks again.
      const transcriptIds: string[] = [];
      for (const sourceId of continueFrom) {
        const source = sessions.find((session) => session.sessionId === sourceId);
        if (!source) continue; // swept away since selection; nothing to carry
        const rendered = renderTranscript(
          buildFeed(sessionView(detail, sourceId)),
          source.title ?? "untitled",
          new Date().toISOString()
        );
        const uploaded = await novus().missions.attachTranscript({
          missionId: detail.mission.missionId,
          workstreamId: detail.workstream.workstreamId,
          sourceSessionId: sourceId,
          markdown: rendered
        });
        if (!uploaded.ok) {
          return {
            ok: false,
            message: `The transcript of "${source.title ?? "untitled"}" could not be carried: ${uploaded.message}`
          };
        }
        transcriptIds.push(uploaded.value.artifactId);
      }
      const allAttachmentIds = [...transcriptIds, ...attachmentIds];
      const created = await novus().missions.direct({
        missionId: detail.mission.missionId,
        body,
        model,
        effort,
        workstreamId: detail.workstream.workstreamId,
        newSession: true,
        ...(alongside ? { alongside: true } : {}),
        ...(allAttachmentIds.length > 0 ? { attachmentIds: allAttachmentIds } : {}),
        ...(pendingContext.length > 0 ? { context: pendingContext } : {})
      });
      if (!created.ok) return { ok: false, message: offlineOr(created.code, created.message) };
      setPendingContext([]);
      onSessionDraft(false);
      // The conversation exists now: its tab joins the working row, selected,
      // and its row the rail's tree (D-087).
      onOpenSession(created.value.sessionId);
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
      ...(selectedSessionId !== null ? { sessionId: selectedSessionId } : {}),
      ...(alongside ? { alongside: true } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(pendingContext.length > 0 ? { context: pendingContext } : {})
    });
    if (!result.ok) return { ok: false, message: offlineOr(result.code, result.message) };
    setPendingContext([]);
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
  /** Where this lane's pinned base stands (D-139). GitHub lanes arrive with
   *  the answer on the detail; a local checkout is this machine's own truth,
   *  asked over the bridge on a slow cadence. */
  const [localBase, setLocalBase] = useState<BaseStatus | null>(null);
  const repoProvider = detail?.mission.repository?.provider ?? null;
  const repoId = detail?.mission.repository?.providerRepoId ?? null;
  const pinnedBaseRef = detail?.workstream?.baseRef ?? null;
  const pinnedBaseSha = detail?.workstream?.baseSha ?? null;
  useEffect(() => {
    if (repoProvider !== "local" || repoId === null || pinnedBaseRef === null || pinnedBaseSha === null) {
      setLocalBase(null);
      return;
    }
    let stopped = false;
    const check = async () => {
      const result = await novus().repos.baseStatusLocal({ localId: repoId, ref: pinnedBaseRef, sha: pinnedBaseSha });
      if (stopped) return;
      setLocalBase(
        result.ok
          ? result.value
          : { state: "unknown", aheadBy: null, checkedAt: new Date().toISOString() }
      );
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [repoProvider, repoId, pinnedBaseRef, pinnedBaseSha]);
  const baseStatus = detail?.baseStatus ?? localBase;
  // The rail's Try-another-approach asks by raising a counter; the room
  // opens the dialog and *consumes* the ask, so a stale count never replays
  // on later remounts (the ghost dialog that followed every navigation,
  // D-142 batch) — while an ask raised from a background tree still lands
  // after its tab switch, because consumption, not mounting, is the gate.
  useEffect(() => {
    if (forkAsk > 0) {
      setForking(true);
      onForkConsumed();
    }
  }, [forkAsk, onForkConsumed]);
  // A panel row's Add to chat (D-182): appended once per nonce, deduped by
  // identity (a file by its path, a check by its id), capped at the bound the
  // wire enforces anyway — the ninth click changes nothing rather than
  // surprising the send.
  useEffect(() => {
    if (contextAsk === null) return;
    const ref = contextAsk.ref;
    setPendingContext((previous) => {
      const duplicate = previous.some((held) =>
        held.kind === "file" && ref.kind === "file"
          ? held.path === ref.path
          : held.kind === "check" && ref.kind === "check"
            ? held.checkId === ref.checkId
            : false
      );
      if (duplicate || previous.length >= MAX_DIRECTION_CONTEXT) return previous;
      return [...previous, ref];
    });
  }, [contextAsk]);
  const approaches = detail?.approaches ?? [];
  /** Something to fork from: an approach only means anything beside a result
   *  that already exists, so the control is absent until the lane being read
   *  has a shared checkpoint a sibling could start at (D-079) — and absent
   *  again once the mission's work has ended (D-121), because a terminal
   *  room offers nothing the server would refuse. */
  const forkable =
    detail?.state === "completed" || detail?.state === "cancelled"
      ? undefined
      : approaches.find(
          (approach) =>
            approach.workstreamId === detail?.workstream?.workstreamId &&
            approach.forkPointSha !== null
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

  /**
   * The @-mention provider (D-185), held stable across re-reads.
   *
   * The composer debounces its file search against this object, so a provider
   * rebuilt on every render restarts that timer — and since D-149 the room
   * re-reads on every streamed event, the timer could be restarted faster than
   * it ever fires. Only the addresses it closes over actually change.
   */
  const mentionMissionId = detail?.mission.missionId ?? null;
  const mentionWorkstreamId = detail?.workstream?.workstreamId ?? null;
  const mention = useMemo(
    () =>
      mentionMissionId !== null && mentionWorkstreamId !== null
        ? {
            search: async (query: string) => {
              const found = await novus().workspace.searchFiles({
                missionId: mentionMissionId,
                workstreamId: mentionWorkstreamId,
                query
              });
              return found.ok ? found.value : [];
            },
            add: (path: string) =>
              setPendingContext((previous) =>
                previous.some((held) => held.kind === "file" && held.path === path) ||
                previous.length >= MAX_DIRECTION_CONTEXT
                  ? previous
                  : [...previous, { kind: "file", path }]
              )
          }
        : undefined,
    [mentionMissionId, mentionWorkstreamId]
  );
  /** The session being read. A remembered id the lane does not hold — another
   *  lane's, or one this poll has not caught up to yet — reads as the lane's
   *  first rather than as a broken canvas. */
  const selectedSessionId =
    activeSessionId !== null && sessions.some((session) => session.sessionId === activeSessionId)
      ? activeSessionId
      : null;
  const readingSessionId = selectedSessionId ?? firstSessionId;
  /** Which conversation the box belongs to (D-215): the chat on screen, the
   *  new-session draft surface, or the lane itself while it has no chats.
   *  Keys the composer's own scratch and the pinned references alike. */
  const chatKey = sessionDraft
    ? `${selectedMissionId}:draft`
    : `${selectedMissionId}:${readingSessionId ?? "lane"}`;
  const pendingContext = pendingByChat[chatKey] ?? [];
  const setPendingContext = (
    next: DirectionContextRef[] | ((previous: DirectionContextRef[]) => DirectionContextRef[])
  ) =>
    setPendingByChat((held) => {
      const previous = held[chatKey] ?? [];
      const value = typeof next === "function" ? next(previous) : next;
      return { ...held, [chatKey]: value };
    });
  const multiSession = sessions.length > 1;
  /** Where no conversation is selected in a lane that holds several, the
   *  canvas is the approach's own page — its brief and its conversations as
   *  links — not the first transcript (D-089). A lane with one conversation
   *  keeps landing straight in it. */
  const overviewShowing = multiSession && selectedSessionId === null;
  /** Session tabs on the working row (D-087, D-088, D-089): exactly what this
   *  person opened, in their order, from any approach — plus, so a restored
   *  selection is never invisible, the one being read. Nothing appears,
   *  vanishes, or swaps because the lane changed: only opening does. */
  const missionSessions = raw?.sessions ?? [];
  const sessionChrome = multiSession || sessionDraft || openSessionIds.length > 0;
  const openSessions = (() => {
    const ordered = openSessionIds
      .map((id) => missionSessions.find((session) => session.sessionId === id))
      .filter((session): session is NonNullable<typeof session> => session !== undefined);
    const reading = missionSessions.find(
      (session) =>
        session.sessionId === selectedSessionId && !openSessionIds.includes(session.sessionId)
    );
    return [...ordered, ...(reading ? [reading] : [])];
  })();
  const selectSessionTab = (session: { sessionId: string; workstreamId: string }) => {
    // A tab from another approach moves the room there, exactly as a file
    // tab does: the colour and the conversation never disagree (D-088).
    if (session.workstreamId !== activeLaneId) {
      onSelectLane(session.workstreamId === lanes[0]?.workstreamId ? null : session.workstreamId);
    }
    onSelectSession(session.sessionId);
    onSelectFile(null);
    onDecisionOpen(false);
    onSessionDraft(false);
  };
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

  // View in conversation's landing (D-168): once the target session's feed
  // is the one on screen, find the turn by its block key and centre it. Runs
  // on every feed change while a target stands, because the block a person
  // is jumping to may not exist until this exact render — the session switch
  // and the feed recompute are two renders, not one.
  useEffect(() => {
    if (scrollToBlockKey === null || feed === null) return;
    const container = scrollRef.current;
    if (!container) return;
    const target = container.querySelector(`[data-block-key="${scrollToBlockKey}"]`);
    if (target) {
      target.scrollIntoView({ block: "center" });
      setScrollToBlockKey(null);
    }
  }, [feed, scrollToBlockKey]);

  // Leaving the conversation puts the worker view away; it belongs to the
  // turn being read, not to the room (D-107).
  useEffect(() => {
    setOpenWorker(null);
    savedScrollRef.current = null;
  }, [selectedMissionId, readingSessionId]);

  /** The opened worker, freshly resolved from the feed each poll so the view
   *  updates while the worker is live. Null when it no longer resolves. */
  const openWorkerView = useMemo(() => {
    if (!openWorker || !feed) return null;
    const block = feed.blocks.find(
      (candidate) => candidate.kind === "trace" && candidate.key === openWorker.blockKey
    );
    if (!block || block.kind !== "trace") return null;
    const worker = block.workers.find((candidate) => candidate.id === openWorker.workerId);
    return worker ? { worker, settled: block.settled } : null;
  }, [openWorker, feed]);

  /** A live recording's machine-local state, for the preview tab's word
   *  (D-123): the one tab state that must survive a canvas switch. */
  const [recordingState, setRecordingState] = useState<RecordingStatus | null>(null);
  useEffect(() => {
    void novus()
      .artifacts.recordingStatus()
      .then((result) => {
        if (result.ok) setRecordingState(result.value);
      });
    return novus().artifacts.onRecording((status) => setRecordingState(status));
  }, []);
  const recordingLive =
    recordingState !== null && recordingState.missionId === selectedMissionId;

  /** The opened artifact's row, from the same detail the room already holds;
   *  a stale id (swept away, other lane) simply shows the conversation. */
  const openArtifactView = useMemo(() => {
    if (!openArtifactId || !detail) return null;
    return detail.artifacts.find((artifact) => artifact.artifactId === openArtifactId) ?? null;
  }, [openArtifactId, detail]);

  const openWorkerOn = (blockKey: string) => (workerId: string) => {
    savedScrollRef.current = scrollRef.current?.scrollTop ?? null;
    setOpenWorker({ blockKey, workerId });
  };
  const closeWorker = () => setOpenWorker(null);

  // Back where the reader was: the feed unmounts while a worker occupies the
  // canvas, so its scroll position is put back by hand on return.
  useEffect(() => {
    if (openWorker !== null || savedScrollRef.current === null) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = savedScrollRef.current;
    savedScrollRef.current = null;
  }, [openWorker]);

  /** The composer's foot names its whole target (D-080, D-083): the lane once
   *  more than one exists, the conversation once more than one exists, and a
   *  draft by what it is about to become. One lane, one session: nothing. */
  // The D-124 target eyebrow is retired (D-176): the selected tab and the
  // rail's washed row already name the conversation, and the box stays the
  // same box on every surface.

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
  /** Every live write turn — several at once when scoped chats run in
   *  parallel (D-097); the workspace's story stays the write side's. */
  const liveWriters = detail
    ? detail.executions.filter(
        (execution) =>
          execution.access === "write" &&
          !["completed", "stopped", "failed", "interrupted"].includes(execution.state)
      )
    : [];
  /** The chat on screen, answering alongside read-only, if it is (D-095). */
  const readTurnOnScreen =
    detail && readingSessionId !== null
      ? (detail.executions.find(
          (execution) =>
            execution.sessionId === readingSessionId &&
            execution.access === "read" &&
            !["completed", "stopped", "failed", "interrupted"].includes(execution.state)
        ) ?? null)
      : null;
  /**
   * The live turn the composer's stop square means (D-206): the conversation
   * on screen — its own read-alongside turn, or the lane's write turn when
   * this conversation is the one it runs for. Another chat's turn is never
   * stoppable from here: that case is the alongside offer's, and a square
   * that killed a different conversation would be a misfire.
   */
  const composerStop = (() => {
    if (!detail) return null;
    if (readTurnOnScreen) return { sessionId: readTurnOnScreen.sessionId };
    const writer = liveWriters[0] ?? null;
    if (!writer) return null;
    const writerSession = writer.sessionId ?? null;
    if (multiSession && writerSession !== null && writerSession !== readingSessionId) return null;
    return { sessionId: null };
  })();
  /**
   * Sending while the workspace's turn belongs to another chat asks the baton
   * holder: queue, or run alongside read-only (D-095). Not offered on the
   * running chat itself — its direction steers the running turn — not to
   * anyone without the baton, whose direction queues exactly as before, and
   * not when the target chat's scope is provably disjoint from every running
   * writer's (D-097): the server will start that turn in parallel, so there
   * is nothing to choose. The same matcher the server judges with decides
   * the prediction, so the composer cannot promise what dispatch refuses.
   */
  const targetScope = sessionDraft
    ? null
    : (sessions.find((session) => session.sessionId === readingSessionId)?.scope ?? null);
  const blockingWriter = detail
    ? liveWriters.find((writer) => {
        if (!sessionDraft && writer.sessionId === readingSessionId) return false;
        const writerScope =
          detail.sessions.find((session) => session.sessionId === writer.sessionId)?.scope ?? null;
        return (
          targetScope === null || writerScope === null || !scopesDisjoint(writerScope, targetScope)
        );
      })
    : undefined;
  const alongsideOffer =
    detail && isController && blockingWriter
      ? {
          runningTitle:
            sessions.find((session) => session.sessionId === blockingWriter.sessionId)?.title ?? null
        }
      : null;

  /** The chat whose scope is being declared, while the dialog is up (D-097). */
  const [scopeEditing, setScopeEditing] = useState<Session | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const saveScope = async (scope: string[] | null) => {
    if (!detail || !scopeEditing) return;
    setScopeBusy(true);
    setScopeError(null);
    const result = await novus().missions.setSessionScope({
      missionId: detail.mission.missionId,
      sessionId: scopeEditing.sessionId,
      scope
    });
    setScopeBusy(false);
    if (!result.ok) {
      setScopeError(offlineOr(result.code, result.message));
      return;
    }
    setScopeEditing(null);
  };
  /** The first proposal for an unscoped chat: the top-level directories its
   *  own turns have touched — derived from evidence, never guessed from
   *  words (D-097). */
  const scopeProposal =
    detail && scopeEditing
      ? [
          ...new Set(
            sessionChangedFiles(detail, scopeEditing.sessionId).map((file) =>
              file.path.includes("/") ? `${file.path.split("/")[0]}/**` : file.path
            )
          )
        ]
      : [];
  /**
   * The lane's answer policy, worn on the composer's foot (D-115). The server
   * enforces `policy.set` and the Mission Admin tier for Don't ask; what is
   * computed here only decides what the chip offers to ask for.
   */
  const viewerRole = detail?.participants.find(
    (participant) => participant.userId === detail.viewerUserId
  )?.role;
  const policyControl: PolicyControl | null =
    detail?.workstream !== null && detail?.workstream !== undefined
      ? {
          profile: detail.workstream.permissionProfile,
          maySet: detail.capabilities.includes("policy.set"),
          maySetUnsupervised: viewerRole === "mission_admin",
          onSet: async (profile, acknowledged) => {
            const result = await novus().missions.setPermissionProfile({
              missionId: detail.mission.missionId,
              workstreamId: detail.workstream!.workstreamId,
              profile,
              acknowledged
            });
            // The room's own 2s poll carries the new word back, exactly as a
            // scope change's does.
            if (!result.ok) return { ok: false, message: offlineOr(result.code, result.message) };
            return { ok: true };
          }
        }
      : null;

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
    artifactIds: string[];
  }) => {
    if (!detail) return;
    setDecisionBusy(true);
    setDecisionError(null);
    const result = await novus().approaches.decide({
      missionId: detail.mission.missionId,
      workstreamId: input.workstreamId,
      rationale: input.rationale,
      ...(input.acceptedRisks ? { acceptedRisks: input.acceptedRisks } : {}),
      ...(input.artifactIds.length > 0 ? { artifactIds: input.artifactIds } : {})
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

  // Following a moved base (D-144): a person's explicit act, on the words
  // that reported the drift. The machine merges every lane — all or none —
  // and the next poll clears the warning when the pin has moved.
  const [syncingBase, setSyncingBase] = useState(false);
  const syncBase = async () => {
    if (!detail) return;
    setSyncingBase(true);
    const result = await novus().missions.syncBase(detail.mission.missionId);
    setSyncingBase(false);
    if (!result.ok) setActionError(result.message ?? "The sync did not go through.");
    else setActionError(null);
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
  /** The preview taking the canvas (D-098): the sentinel where a file key
   *  would be, and a tab to show it for. */
  const previewSelected = activeFile === PREVIEW_TAB_KEY && previewTab !== null;
  /** The pull request's tab, showing only while one exists to show. */
  /** The requests open as tabs, in the order opened (D-207) — only those the
   *  mission still lists. */
  const pullTabs = detail
    ? openPullIds.flatMap((id) => {
        const pull = detail.pullRequests.find((entry) => entry.pullRequestId === id);
        return pull ? [pull] : [];
      })
    : [];
  const selectedPullId = pullIdOfKey(activeFile);
  const selectedPull = pullTabs.find((pull) => pull.pullRequestId === selectedPullId) ?? null;
  const pullSelected = selectedPull !== null;
  /** The decision a request page is about is the request's own, which may be
   *  a fulfilled one the mission has moved past (D-207). */
  const selectedPullDecision = selectedPull
    ? (detail?.decisions.find((entry) => entry.decisionId === selectedPull.decisionId) ?? null)
    : null;

  return (
    <div className="room" data-testid="project-room">
      <div className="room-main">
      {findOpen && (
        <div className="feed-find" data-testid="feed-find">
          <input
            ref={findInputRef}
            className="feed-find-input"
            placeholder="Find in conversation"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="feed-find-count" data-testid="feed-find-count">
            {findCount === 0 ? (findQuery.trim() === "" ? "" : "0 found") : `${findIndex + 1} of ${findCount}`}
          </span>
          <button className="feed-find-step" onClick={() => stepFind(-1)} aria-label="Previous match">
            ‹
          </button>
          <button className="feed-find-step" onClick={() => stepFind(1)} aria-label="Next match">
            ›
          </button>
          <button className="feed-find-step" onClick={closeFind} aria-label="Close find">
            ×
          </button>
        </div>
      )}
      {/* This strip is the mission's working row (D-086): the top strip holds
          one tab per mission, and this one — one level below, exactly where an
          open file appears — holds the mission's approaches as colour-dotted
          tabs, the sessions this person opened (D-087), Compare while it is
          open, and every open file, side by side. One canvas shows at a time;
          the colours tie a lane's tab to its sessions and files. A mission
          with one approach, one conversation and nothing open shows no strip
          at all. */}
      {(openFiles.length > 0 || decisionOpen || previewTab !== null || pullTabs.length > 0 || multiLane || sessionChrome) && (
        <div
          className="tabbar"
          role="tablist"
          aria-label={`Open in ${title}`}
          // While a tab is in hand, the whole row accepts the release: the
          // order was settled live during the drag, so letting go over a gap,
          // another species' tab, or the row's empty tail must end the
          // gesture where it stands rather than animating a snap-back (D-090).
          onDragOver={(event) => {
            if (dragSessionRef.current === null && dragFileRef.current === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            if (dragSessionRef.current === null && dragFileRef.current === null) return;
            event.preventDefault();
          }}
        >
          {multiLane ? (
            lanes.map((lane) => {
              // The approach tab is a page of its own (D-089): selected only
              // while its landing — the overview, or its one conversation —
              // is the canvas, not while one of its session tabs is.
              const selected =
                activeFile === null &&
                !decisionOpen &&
                !sessionDraft &&
                lane.workstreamId === activeLaneId &&
                selectedSessionId === null;
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
                    // Landing on the approach, not in a conversation: its own
                    // page decides — and switching lanes never touches the
                    // open session tabs (D-089).
                    onSelectSession(null);
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
                  {/* No identity dot (D-133): the name is the identity. */}
                  {lane.name}
                </button>
              );
            })
          ) : (
            <button
              role="tab"
              aria-selected={
                activeFile === null && !decisionOpen && !sessionDraft && selectedSessionId === null
              }
              className={
                activeFile === null && !decisionOpen && !sessionDraft && selectedSessionId === null
                  ? "tab active"
                  : "tab"
              }
              onClick={() => {
                onSelectFile(null);
                onDecisionOpen(false);
                onSessionDraft(false);
                onSelectSession(null);
              }}
              title={`Back to ${title}`}
              data-testid="room-tab"
            >
              {/* Not the goal again. The window's strip above already names
                  this mission and the rail names it a third time; the only
                  question this control answers is "what do I return to"
                  (D-061). With one lane it is the way back even beside open
                  session tabs, because every session tab closes now (D-089):
                  it lands on the mission's own page — the conversation where
                  there is one, the overview where there are several. */}
              Mission
            </button>
          )}
          {/* One tab per conversation this person opened (D-087, D-089): a
              glyph and a title, every one closable — the approach tab is the
              way back, so nothing needs to be permanent. With one session,
              nothing opened and no draft there is no session chrome at all. */}
          {sessionChrome &&
            openSessions.map((session) => {
              const selected =
                activeFile === null &&
                !decisionOpen &&
                !sessionDraft &&
                !overviewShowing &&
                session.sessionId === readingSessionId;
              // Mission-wide, because an open tab can be another approach's
              // conversation (D-088) — the raw detail holds every execution.
              // Each tab wears its chat's own word (D-094); the selected one
              // says nothing, its state being the room's state line.
              const tabActivity =
                !selected && raw !== undefined ? sessionActivity(raw, session.sessionId) : null;
              const needsYou = tabActivity?.state === "needs_you";
              const laneIndex = lanes.findIndex(
                (lane) => lane.workstreamId === session.workstreamId
              );
              const laneName = lanes[laneIndex]?.name ?? null;
              const draggable = openSessionIds.includes(session.sessionId);
              return (
                <span
                  key={session.sessionId}
                  className={selected ? "tab session-tab active" : "tab session-tab"}
                  data-testid="session-tab"
                  data-session={session.sessionId}
                  data-workstream={session.workstreamId}
                  draggable={draggable}
                  onDragStart={(event) => {
                    dragSessionRef.current = session.sessionId;
                    event.dataTransfer.setData("text/novus-session", session.sessionId);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    dragSessionRef.current = null;
                  }}
                  onDragOver={(event) => {
                    // The reorder happens *during* the drag, the way a
                    // browser's own tab strip moves: the tabs shifting are
                    // the feedback, and the release needs no precision —
                    // wherever the hand lets go, the order is already what
                    // the drag made it (D-090).
                    const dragged = dragSessionRef.current;
                    if (dragged === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dragged === session.sessionId) return;
                    const from = openSessionIds.indexOf(dragged);
                    const target = openSessionIds.indexOf(session.sessionId);
                    if (from === -1 || target === -1) return;
                    // Only once the pointer crosses this tab's midpoint in
                    // the direction of travel — unequal widths would
                    // otherwise flap the order under a still pointer.
                    const box = event.currentTarget.getBoundingClientRect();
                    const past = event.clientX - box.left > box.width / 2;
                    if (from < target ? past : !past) onReorderSession(dragged, target);
                  }}
                  onDrop={(event) => {
                    // Claimed so nothing animates back to where it was
                    // picked up; the order was settled while dragging.
                    if (dragSessionRef.current !== null) event.preventDefault();
                  }}
                >
                  <button
                    role="tab"
                    aria-selected={selected}
                    className="session-tab-open"
                    onClick={() => selectSessionTab(session)}
                    title={
                      multiLane && laneName
                        ? `${session.title ?? "New session"} — in ${laneName}`
                        : (session.title ?? "New session")
                    }
                  >
                    {/* Whose conversation this is (D-088, amended D-133):
                        the lane is in the tab's title, and choosing the tab
                        moves the room there — words and behavior, no dot. */}
                    <SessionGlyph />
                    <span
                      className={
                        session.title === null
                          ? "session-tab-name session-untitled"
                          : "session-tab-name"
                      }
                    >
                      {session.title ?? "New session"}
                    </span>
                    {/* Words, never a dot: a background conversation says
                        what it is doing (DESIGN.md#status-semantics, D-094). */}
                    {tabActivity?.label && (
                      <span
                        className={
                          needsYou ? "tone-warn session-needs" : "session-needs session-state"
                        }
                      >
                        {" "}
                        · {tabActivity.label}
                      </span>
                    )}
                  </button>
                  <button
                    className="session-tab-close"
                    onClick={() => onCloseSession(session.sessionId)}
                    aria-label={`Close ${session.title ?? "this session"}`}
                    title={`Close ${session.title ?? "this session"}`}
                    data-testid="session-tab-close"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          {/* The draft: an empty conversation being asked for. Not a session —
              nothing exists until words are typed, and leaving creates nothing
              anywhere (D-077, D-083). */}
          {sessionDraft && (
            <span className="tab session-tab active" data-testid="session-tab-draft">
              <span className="session-tab-open">
                <SessionGlyph />
                <span className="session-tab-name session-untitled">New session</span>
              </span>
            </span>
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
          {/* The preview, while it is open, is a closable sibling like
              Compare (D-098): the window onto the running app sits beside the
              conversation and the files, and closing it never stops the app. */}
          {previewTab !== null && (
            <span
              className={previewSelected ? "tab file-tab active" : "tab file-tab"}
              data-testid="preview-tab"
            >
              <button
                role="tab"
                aria-selected={previewSelected}
                className="file-tab-open"
                onClick={() => {
                  // The tab's own lane, exactly as a file tab moves the room
                  // to its worktree (D-084): the preview shows one lane's app.
                  if (previewTab.workstreamId !== activeWorkstreamId) {
                    onSelectLane(previewTab.workstreamId);
                  }
                  onSelectFile(PREVIEW_TAB_KEY);
                  onDecisionOpen(false);
                  onSessionDraft(false);
                }}
                title={`Preview — ${previewTab.url}`}
              >
                <span className="file-tab-name">Preview</span>
                {/* A live recording stays visible whatever canvas is up
                    (D-123): the tab carries the word, the session-tab way,
                    in the warn tone because it asks to be noticed. */}
                {recordingLive && <span className="session-state recording-tab-word"> · recording</span>}
              </button>
              <button
                className="file-tab-close"
                onClick={onClosePreview}
                aria-label="Close the preview"
                title="Close the preview — the app keeps running"
                data-testid="preview-tab-close"
              >
                ×
              </button>
            </span>
          )}
          {/* The pull request's own tab (D-100, the Conductor shape): opened
              only by a person, a closable sibling like Compare and Preview. */}
          {pullTabs.map((pullTab) => {
            const selected = selectedPullId === pullTab.pullRequestId;
            return (
              <span
                key={pullTab.pullRequestId}
                className={selected ? "tab file-tab active" : "tab file-tab"}
                data-testid="pull-tab"
                data-pull-number={pullTab.number}
              >
                <button
                  role="tab"
                  aria-selected={selected}
                  className="file-tab-open"
                  onClick={() => {
                    onSelectFile(pullTabKey(pullTab.pullRequestId));
                    onDecisionOpen(false);
                    onSessionDraft(false);
                  }}
                  title={`PR #${pullTab.number} — ${pullTab.title}`}
                >
                  <span className="file-tab-name">PR #{pullTab.number}</span>
                  <span className="session-needs session-state"> · {pullStateWord(pullTab)}</span>
                </button>
                <button
                  className="file-tab-close"
                  onClick={() => onClosePull(pullTab.pullRequestId)}
                  aria-label={`Close the PR #${pullTab.number} tab`}
                  title="Close the tab — the pull request stays exactly as it is"
                  data-testid="pull-tab-close"
                >
                  ×
                </button>
              </span>
            );
          })}
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
                draggable
                onDragStart={(event) => {
                  dragFileRef.current = file.key;
                  event.dataTransfer.setData("text/novus-file", file.key);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  dragFileRef.current = null;
                }}
                onDragOver={(event) => {
                  // Live, exactly as the session tabs move (D-090): files
                  // reorder among files, in the person's own order.
                  const dragged = dragFileRef.current;
                  if (dragged === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dragged === file.key) return;
                  const from = openFiles.findIndex((entry) => entry.key === dragged);
                  const target = openFiles.findIndex((entry) => entry.key === file.key);
                  if (from === -1 || target === -1) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  const past = event.clientX - box.left > box.width / 2;
                  if (from < target ? past : !past) onReorderFile(dragged, target);
                }}
                onDrop={(event) => {
                  if (dragFileRef.current !== null) event.preventDefault();
                }}
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
        {/* One slim row (D-127): the state and its action, then who controls
            it at the row's end. The goal is not restated here — the tab, the
            rail, and the direction itself already name it (D-126 kept a
            compact copy; on sight it was still a repetition). */}
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
              {stateLine.action?.kind === "forceInterrupt" && detail && (
                <GatedAction
                  capability="force_interrupt"
                  capabilities={detail.capabilities}
                  denialReason="Only the controller or a Mission Admin may declare a turn dead."
                  onClick={() =>
                    void runAction(
                      novus().missions.forceInterrupt(
                        detail.mission.missionId,
                        activeLaneId ?? undefined
                      )
                    )
                  }
                  variant="secondary"
                  testid="force-interrupt"
                >
                  Force interrupt
                </GatedAction>
              )}
              {readTurnOnScreen && detail && (
                <>
                  {/* The chat on screen is answering alongside, read-only
                      (D-095). The lane's own state line stays the write
                      turn's story; this suffix is the read turn's, with its
                      own Stop — the lane-level Stop above always means the
                      workspace's turn. */}
                  <span className="state-detail" data-testid="read-turn-note">
                    · answering read-only
                  </span>
                  <GatedAction
                    capability="execution.stop"
                    capabilities={detail.capabilities}
                    denialReason="Only participants who can stop this execution may stop it."
                    onClick={() =>
                      void runAction(
                        novus().missions.stop(
                          detail.mission.missionId,
                          activeLaneId ?? undefined,
                          readTurnOnScreen.sessionId
                        )
                      )
                    }
                    variant="text"
                    testid="stop-read-turn"
                  >
                    Stop
                  </GatedAction>
                </>
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
              {stateLine.action?.kind === "publish" && (
                <button
                  className="btn btn-secondary"
                  onClick={onOpenDecision}
                  data-testid="state-publish"
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
          <span className="state-authority">
          <span className="controller-slot" data-testid="controller">
            <span className="controller-name">
              {detail
                ? controller
                  ? isController
                    ? "You have the baton"
                    : `${controller.name ?? controller.login} has the baton`
                  : "No one holds the baton"
                : ""}
            </span>
          </span>
          {detail && !isController && (
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
          </span>
        </div>
        {/* The workspace row lives in the persistent header, not the
            scrolling feed (D-166, owner-hit): the base's standing and its
            one Sync action are exactly the kind of thing that must not
            require scrolling to the top of a long conversation to reach. */}
        {detail && feed?.setup && (
          <div
            className={feed.setup.danger ? "workspace-row danger" : "workspace-row"}
            data-testid="setup-row"
          >
            <span>{feed.setup.label}</span>
            {/* The base's standing, in words, where the base is named
                (D-139): silent while current, and silent while the answer is
                merely unknown — absence of a check is not an alarm, it is
                Overview's to state. */}
            {baseDriftWords(baseStatus) && (
              <span className="tone-warn workspace-drift" data-testid="base-drift">
                · {baseDriftWords(baseStatus)}
              </span>
            )}
            {/* Syncing is offered only for a base that moved forward: a
                rewritten or vanished base is a rethink, not a merge. */}
            {baseStatus?.state === "moved" && (
              <button
                className="btn btn-text workspace-row-action"
                onClick={() => void syncBase()}
                disabled={syncingBase}
                data-testid="base-sync"
              >
                {syncingBase ? "Syncing…" : "Sync"}
              </button>
            )}
            <button
              className="btn btn-text workspace-row-action"
              onClick={() => onInspector("overview")}
              data-testid="setup-overview"
            >
              Overview
            </button>
          </div>
        )}
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

      {scopeEditing !== null && (
        <ScopeDialog
          key={scopeEditing.sessionId}
          session={scopeEditing}
          proposal={scopeProposal}
          busy={scopeBusy}
          error={scopeError}
          onCancel={() => {
            setScopeEditing(null);
            setScopeError(null);
          }}
          onSave={(scope) => void saveScope(scope)}
        />
      )}

      {/* Persistently mounted, never remounted by which tab is selected
          (D-170, fixing the D-163 rebuild's own regression): the old native
          view survived a tab switch untouched, because the main process held
          it regardless of the React tree. The in-DOM webview that replaced
          it has no such independence — unmounting it destroys its guest
          page — so this instance stands outside the canvas switch below and
          is only ever hidden, never torn down, while its tab exists. Hidden
          means painted-but-invisible (absolute, opacity 0 — so capture keeps
          its pixels), and it hides when another tab is selected. The artifact
          look never paints here: the Preview tab is the running app's,
          always — opening an artifact steps back to the conversation
          (owner-directed, reversing D-171's hide-under). */}
      {previewTab !== null && selectedMissionId !== null && (
        <div
          className={previewSelected ? "room-canvas-slot" : "room-canvas-slot hidden"}
        >
          <PreviewSurface
            key={`${previewTab.workstreamId ?? "first"}:${previewTab.url}`}
            missionId={selectedMissionId}
            workstreamId={previewTab.workstreamId}
            url={previewTab.url}
            name={previewTab.name}
            detail={detail ?? null}
            onReopen={onReopenPreview}
          />
        </div>
      )}

      {/* The look renders only where the conversation would (owner-directed,
          the full fix): a file tab shows its file, the preview its app, the
          pull page its request — an open artifact never hijacks them. */}
      {openArtifactView && detail && activeFile === null && !decisionOpen ? (
        /* One artifact, looked at closely (D-122): a transient look over
           whatever canvas was showing — the worker-view shape, opened from
           the Evidence section only, closed with Esc or Back, never a tab. */
        <div className="feed-scroll">
          <div className="feed">
            <ArtifactView
              artifact={openArtifactView}
              detail={detail}
              onBack={onCloseArtifact}
              onViewInSession={({ sessionId, executionId, artifactId }) => {
                // Close the look-over-the-canvas first: opening the session
                // is a real navigation, not a further layer on top of one
                // (D-167, same shape as Back to chat).
                onCloseArtifact();
                // The exact turn (D-168): an agent capture lands on the turn
                // whose execution requested it; an image a person attached
                // lands on the message that carried it — the direction whose
                // attachments name this artifact. `detail` holds the lane's
                // full record, unaffected by which session is on screen, so
                // both lookups are stable across the switch below.
                const execution = executionId
                  ? detail.executions.find((entry) => entry.executionId === executionId)
                  : null;
                const attachingDirection =
                  execution === null
                    ? detail.directions.find((direction) =>
                        direction.attachments.some(
                          (attachment) => attachment.artifactId === artifactId
                        )
                      )
                    : null;
                // Unpin before the landing runs: otherwise the "stay at the
                // latest activity" effect (keyed on the very same session
                // switch) fires in the same commit and snaps back to the
                // bottom right after this centres the turn (D-168 follow-up).
                pinnedRef.current = false;
                setScrollToBlockKey(
                  execution?.startingDirectionId ?? attachingDirection?.directionId ?? null
                );
                onOpenSession(sessionId);
              }}
            />
          </div>
        </div>
      ) : activeFileEntry !== null && selectedMissionId !== null ? (
        // The pane reads the worktree the tab was opened from — the tab's own
        // lane, never whichever lane the room happens to be reading — so the
        // dot on the tab and the bytes on screen cannot disagree (D-084).
        <FileView
          key={activeFileEntry.key}
          missionId={selectedMissionId}
          workstreamId={activeFileEntry.workstreamId ?? undefined}
          path={activeFileEntry.path}
          onAddContext={() =>
            setPendingContext((previous) =>
              previous.some((held) => held.kind === "file" && held.path === activeFileEntry.path) ||
              previous.length >= MAX_DIRECTION_CONTEXT
                ? previous
                : [...previous, { kind: "file", path: activeFileEntry.path }]
            )
          }
        />
      ) : previewSelected && previewTab !== null && selectedMissionId !== null ? (
        // The pixels live in the persistently-mounted instance rendered
        // above this switch, not here (D-170): this branch's only job left
        // is to keep "what is selected" legible in the one place every other
        // canvas kind is decided, without standing up a second, competing
        // PreviewSurface every time the tab is chosen.
        null
      ) : pullSelected && detail ? (
        <div className="feed-scroll">
          <div className="feed">
            <PullRequestPage detail={detail} decision={selectedPullDecision} pull={selectedPull} />
          </div>
        </div>
      ) : detail && detail.receipt && (detail.state === "completed" || detail.state === "cancelled") ? (
        /* Terminal (D-121): the canvas is the receipt — the room, frozen —
           rendered from the snapshot stored at close, never a recomputation. */
        <div className="feed-scroll">
          <div className="feed">
            <ReceiptView detail={detail} receipt={detail.receipt} />
          </div>
        </div>
      ) : decisionOpen && detail ? (
        <div className="feed-scroll">
          <DecisionRoom
            detail={detail}
            busy={decisionBusy}
            error={decisionError}
            onRecord={(input) => void recordDecision(input)}
            onRequestRevision={(input) => void requestRevision(input)}
            onInspectPath={() => onInspector("changes")}
            onOpenPull={onOpenPull}
            onClose={() => onDecisionOpen(false)}
          />
        </div>
      ) : sessionDraft ? (
        /* An empty conversation: one quiet sentence, and the composer below is
           the ask. Nothing exists yet, so there is nothing else to show
           (D-077 one level down, D-083) — except what this chat may carry in:
           the lane's other conversations, offered as transcripts (D-173). */
        <div className="feed-scroll">
          <div className="feed">
            <div className="draft-canvas">
              <p className="draft-lead" data-testid="session-draft-lead">
                The first direction starts this session.
              </p>
              {sessions.length > 0 && (
                <div className="draft-continue" data-testid="draft-continue">
                  <p className="draft-continue-lead">Add chat transcripts</p>
                  <div className="draft-continue-pills">
                    {sessions.map((session) => {
                      const picked = continueFrom.includes(session.sessionId);
                      return (
                        <button
                          key={session.sessionId}
                          className="draft-continue-pill"
                          aria-pressed={picked}
                          title={
                            picked
                              ? `Remove the transcript of "${session.title ?? "untitled"}"`
                              : `Carry the transcript of "${session.title ?? "untitled"}" with your first message`
                          }
                          onClick={() =>
                            setContinueFrom((previous) =>
                              picked
                                ? previous.filter((id) => id !== session.sessionId)
                                : [...previous, session.sessionId]
                            )
                          }
                          data-testid={`continue-from-${session.sessionId}`}
                        >
                          <SessionGlyph />
                          <span className="draft-continue-title">{session.title ?? "untitled"}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : overviewShowing && detail ? (
        /* The approach's landing (D-089): its brief and its conversations as
           links, instead of dropping the reader into the first transcript. */
        <div className="feed-scroll">
          <div className="feed">
            <ApproachOverview
              lane={activeLane}
              summary={approaches.find((approach) => approach.workstreamId === activeLaneId)}
              sessions={sessions}
              detail={detail}
              onOpenSession={onOpenSession}
              mayScope={isController}
              onEditScope={(session) => setScopeEditing(session)}
              onContinueFrom={(sessionId) => {
                setContinueFrom([sessionId]);
                onSessionDraft(true);
              }}
            />
          </div>
        </div>
      ) : openWorkerView ? (
        /* One worker, looked at closely (D-107): the canvas, not a tab — the
           conversation stays the stable parent and Back to chat returns to
           it at the position the reader left. */
        <div className="feed-scroll" ref={inspectorScrollRef}>
          <div className="feed">
            <WorkerInspector
              worker={openWorkerView.worker}
              settled={openWorkerView.settled}
              onBack={closeWorker}
            />
          </div>
        </div>
      ) : (
      <div className="feed-holder">
      <div className="feed-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="feed" data-testid="chat">
          {isDraft ? (
            <DraftCanvas draft={draft} project={project} onRetry={() => void resolveBase()} />
          ) : detail && feed ? (
            <>
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
                    onOpenChanges={(checkpointId) =>
                      checkpointId && onInspectTurnChanges
                        ? onInspectTurnChanges(checkpointId)
                        : onInspector("changes")
                    }
                    onOpenVerification={() => onInspector("verification")}
                    onOpenWorker={openWorkerOn(block.key)}
                    onOpenImage={setOpenImage}
                    actions={block.direction ? directionActions(block.direction) : null}
                    // The queue is the lane's, not the conversation's: its one
                    // workspace takes turns (D-083), so position is computed
                    // against the lane view the session view narrows.
                    queuePosition={
                      block.direction ? queuedPositionLabel(detail, block.direction.directionId) : null
                    }
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
                  {(() => {
                    // DESIGN.md *Handoff offered*: expiry countdown as text.
                    // Re-read on every poll render; no timer of its own.
                    const countdown = offerCountdownLabel(liveOffer, Date.now());
                    return countdown ? (
                      <span className="trace-time" data-testid="offer-countdown">
                        {countdown}
                      </span>
                    ) : null;
                  })()}
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
      {/* The way back down: floats only while the reader is away from the
          latest, and one press returns them to where new words land. */}
      {awayFromLatest && (
        <button
          className="feed-jump"
          onClick={jumpToLatest}
          aria-label="Jump to the latest"
          title="Jump to the latest"
          data-testid="feed-jump"
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        </button>
      )}
      </div>
      )}

      {/* Terminal states never resume (D-121): the composer is hidden, not
          disabled — there is nothing to direct and no state it returns in.
          The preview tab also stands alone (D-164, owner-directed): a running
          app's view carries no direction box beneath it — the conversation
          tab is one click away and is where directing happens. File tabs keep
          theirs; the reversal is the preview's alone. */}
      {detail?.state !== "completed" && detail?.state !== "cancelled" && !previewSelected && (
      <Composer
        /* Keyed by conversation (D-215): a chat switch swaps the box for that
           chat's own — its words, files, and pins — rather than carrying one
           box across every conversation in the mission. */
        key={isDraft ? "draft" : chatKey}
        scratchKey={isDraft ? undefined : chatKey}
        /* A draft has no mission yet, so no server capabilities exist to read:
           creating one is an org act (PRODUCT.md#roles-and-capabilities) and
           the creator becomes its Mission Admin. */
        // A repository on someone else's Mac is fine to direct: their runner
        // picks the work up, which is the whole point of the handoff. A GitHub
        // repository is fine too — a runner fetches it into its own area and
        // works it exactly like a folder somebody added (D-025, D-032).
        capabilities={isDraft ? ["direction.submit"] : (detail?.capabilities ?? null)}
        isController={isController || isDraft}
        placeholderOverride={sessionDraft ? "What should this session do?" : undefined}
        alongsideOffer={alongsideOffer}
        policy={isDraft ? null : policyControl}
        onStop={
          !isDraft && composerStop && detail
            ? () =>
                void runAction(
                  novus().missions.stop(
                    detail.mission.missionId,
                    activeLaneId ?? undefined,
                    composerStop.sessionId ?? undefined
                  )
                )
            : null
        }
        onSubmit={submit}
        attach={
          isDraft || !detail
            ? undefined
            : ((room) => ({
                pick: async () => {
                  const picked = await novus().missions.pickImage();
                  return picked.ok
                    ? { ok: true as const, path: picked.value }
                    : { ok: false as const, message: offlineOr(picked.code, picked.message) };
                },
                upload: async (path: string) => {
                  const uploaded = await novus().missions.attachImage({
                    missionId: room.mission.missionId,
                    ...(room.workstream ? { workstreamId: room.workstream.workstreamId } : {}),
                    ...(selectedSessionId !== null ? { sessionId: selectedSessionId } : {}),
                    path
                  });
                  return uploaded.ok
                    ? { ok: true as const, attachment: uploaded.value }
                    : { ok: false as const, message: offlineOr(uploaded.code, uploaded.message) };
                },
                paste: async () => {
                  const pasted = await novus().missions.attachClipboardImage({
                    missionId: room.mission.missionId,
                    ...(room.workstream ? { workstreamId: room.workstream.workstreamId } : {}),
                    ...(selectedSessionId !== null ? { sessionId: selectedSessionId } : {})
                  });
                  return pasted.ok
                    ? { ok: true as const, attachment: pasted.value }
                    : { ok: false as const, message: offlineOr(pasted.code, pasted.message) };
                },
                pathOf: (file: File) => novus().missions.pathForDroppedFile(file)
              }))(detail)
        }
        pendingTranscripts={
          sessionDraft
            ? continueFrom.flatMap((sourceId) => {
                const source = sessions.find((session) => session.sessionId === sourceId);
                return source
                  ? [{ sessionId: sourceId, title: source.title ?? "untitled" }]
                  : [];
              })
            : undefined
        }
        onRemoveTranscript={(sessionId) =>
          setContinueFrom((previous) => previous.filter((id) => id !== sessionId))
        }
        pendingContext={pendingContext}
        onRemoveContext={(index) =>
          setPendingContext((previous) => previous.filter((_, at) => at !== index))
        }
        mention={mention}
        slashCommands={detail ? slashCommandCompletions(detail) : undefined}
        terminal={
          executionAvailable && onOpenTerminal
            ? (query) => {
                // A terminal command is the person's own session, not a turn
                // (D-199): raise the dock primed — typed, never submitted.
                setDockPrime(query.length > 0 ? `claude ${JSON.stringify(`/${query}`)}` : "claude");
                onOpenTerminal();
              }
            : undefined
        }
      />
      )}

      {/* An attached image, read at full size (D-152). It covers the room
          rather than opening anywhere: nothing navigated, so Escape or a click
          on the ground puts it back exactly where it was. */}
      {openImage && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={openImage.label}
          data-testid="image-lightbox"
          onClick={() => setOpenImage(null)}
        >
          {openImage.mimeType === "application/pdf" ||
          openImage.mimeType?.startsWith("video/") ||
          openImage.mimeType?.startsWith("audio/") ? (
            /* The document card (D-165 amended, the Codex shape the owner
               pointed at): Novus's own slim head — the file's name and its
               two actions — over the clean page or player, Chromium's
               toolbar and sidebar suppressed by the viewer's own fragment
               parameters. */
            <div
              className="lightbox-card"
              data-testid="lightbox-card"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="lightbox-card-head">
                <span className="lightbox-card-name" title={openImage.label}>
                  {openImage.label}
                </span>
                <span className="head-spacer" />
                <button
                  className="btn btn-text"
                  onClick={() => void novus().artifacts.openLocal(openImage.artifactId)}
                  title="Open with the default app"
                >
                  Open
                </button>
                <button
                  className="btn btn-text"
                  onClick={() => void novus().artifacts.revealLocal(openImage.artifactId)}
                >
                  Reveal in Finder
                </button>
                <button
                  className="icon-button"
                  onClick={() => setOpenImage(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </header>
              {openImage.mimeType === "application/pdf" ? (
                <iframe
                  className="lightbox-doc"
                  src={`novus-artifact://${openImage.artifactId}/blob#toolbar=0&navpanes=0&view=FitH`}
                  title={openImage.label}
                  data-testid="lightbox-doc"
                />
              ) : openImage.mimeType?.startsWith("video/") ? (
                <video
                  className="lightbox-media"
                  controls
                  autoPlay
                  src={`novus-artifact://${openImage.artifactId}/blob`}
                  data-testid="lightbox-video"
                />
              ) : (
                <audio
                  className="lightbox-audio"
                  controls
                  autoPlay
                  src={`novus-artifact://${openImage.artifactId}/blob`}
                  data-testid="lightbox-audio"
                />
              )}
            </div>
          ) : (
          <img
            className="lightbox-image"
            src={`novus-artifact://${openImage.artifactId}/blob`}
            alt={openImage.label}
            // A click on the picture itself is not a click on the ground.
            onClick={(event) => event.stopPropagation()}
          />
          )}
        </div>
      )}

      {/* The bottom dock. It shares the room's width and shortens the trace
          rather than replacing it; below the single-column threshold it takes
          the room (DESIGN.md#component-behavior). */}
      {terminalOpen && executionAvailable && selectedMissionId !== null && (
        <RuntimeDock
          key={activeLaneId ?? "default"}
          missionId={selectedMissionId}
          workstreamId={activeLaneId ?? undefined}
          prime={dockPrime}
          onPrimed={() => setDockPrime(null)}
        />
      )}

      </div>

    </div>
  );
}

/**
 * The approach's own page (D-089): what this lane is doing, in words, and its
 * conversations as links. An approach tab lands here when the lane holds more
 * than one conversation — a person reads the brief, then chooses a chat, and
 * clicking one opens it as a tab beside the others. Nothing opens by itself.
 */
function ApproachOverview({
  lane,
  summary,
  sessions,
  detail,
  onOpenSession,
  mayScope,
  onEditScope,
  onContinueFrom
}: {
  lane: Workstream | null;
  summary: ApproachSummary | undefined;
  sessions: Session[];
  detail: MissionDetailResponse;
  onOpenSession: (sessionId: string) => void;
  /** Whether this viewer holds the baton — declaring a scope is a grant of
   *  standing write authority, so it is the baton's act (D-097). */
  mayScope: boolean;
  onEditScope: (session: Session) => void;
  /** Opens the new-chat draft with this chat preselected as a transcript
   *  source (D-173) — the directional shortcut for "pick up where this chat
   *  is, in a fresh one". */
  onContinueFrom?: (sessionId: string) => void;
}) {
  // The lane's own facts, from the same summary Compare reads — counted, not
  // fetched. Checks appear only once something ran; zero run is the state
  // line's finding to report, not this page's. What the lane has spent so
  // far — turns, harness time, the harness's own cost figure — joins the
  // line (D-113): text in a row, never a tile, and a figure no turn reported
  // is absent rather than zero (D-071).
  const spent = usageSoFar(detail);
  const facts = [
    sessions.length === 1 ? "1 conversation" : `${sessions.length} conversations`,
    // The lane's answer policy, a fact beside the others (D-115): the word a
    // Viewer with no composer still gets to read.
    `${profileLabel(lane?.permissionProfile ?? "manual")} permissions`,
    `${summary?.filesChanged ?? 0} ${(summary?.filesChanged ?? 0) === 1 ? "file" : "files"} changed`,
    ...(summary && summary.checksRun > 0
      ? [`${summary.checksPassed}/${summary.checksRun} checks passed`]
      : []),
    ...(spent.turns > 0 ? [spent.turns === 1 ? "1 turn" : `${spent.turns} turns`] : []),
    ...(spent.durationMs !== null ? [`${elapsed(spent.durationMs)} of harness time`] : []),
    ...(spent.costUsd !== null ? [usd(spent.costUsd)] : [])
  ];
  // Files more than one of this approach's chats have changed (D-094): said
  // here, on the page that lists the chats, because the person deciding where
  // to type is the person who needs to know two conversations are on the same
  // ground. Evidence from checkpoints only — a warning, never a prediction.
  const contested = contestedAcrossSessions(detail);
  const overlap = contested[0];
  return (
    <div className="approach-overview" data-testid="approach-overview">
      <p className="overview-lead">{lane?.intent ?? "The work this mission started with."}</p>
      <p className="overview-facts">{facts.join(" · ")}</p>
      {overlap && (
        <p className="overview-overlap" data-testid="overview-overlap">
          <span className="tone-warn">
            {overlap.sessions.map((session) => session.title ?? "New session").join(" and ")} have
            both changed <span className="mono">{overlap.path}</span>
          </span>
          {contested.length > 1 && (
            <span className="quiet">
              {" "}
              · {contested.length - 1} more overlapping {contested.length === 2 ? "file" : "files"}
            </span>
          )}
        </p>
      )}
      <div className="overview-list">
        {sessions.map((session) => {
          // The chat's word, its footprint, its evidence, and — while
          // working — how fresh that claim is (D-094, D-096): everything a
          // person needs to pick a row. Checks are attributed by the
          // checkpoint they ran at, which is the only honest join: the
          // worktree they exercised holds every chat's work so far.
          const activity = sessionActivity(detail, session.sessionId);
          const files = sessionChangedFiles(detail, session.sessionId).length;
          const checks = sessionChecks(detail, session.sessionId);
          const passed = checks.filter((check) => check.outcome === "passed").length;
          const meta = [
            // What this chat owns (D-097), before what it did with it.
            ...(session.scope !== null ? [`owns ${truncateLabel(session.scope.join(", "), 40)}`] : []),
            ...(files > 0 ? [`${files} ${files === 1 ? "file" : "files"}`] : []),
            ...(checks.length > 0
              ? [`${passed}/${checks.length} checks at its checkpoints`]
              : []),
            ...(activity.state === "working" && activity.lastHeardAt
              ? [`last heard ${clockTime(activity.lastHeardAt)}`]
              : [])
          ];
          return (
            <div className="overview-row-wrap" key={session.sessionId}>
              <button
                className="overview-row"
                onClick={() => onOpenSession(session.sessionId)}
                title={`Open ${session.title ?? "this session"}`}
                data-testid="overview-session-row"
                data-session={session.sessionId}
              >
                <SessionGlyph />
                <span
                  className={
                    session.title === null ? "overview-row-name session-untitled" : "overview-row-name"
                  }
                >
                  {session.title ?? "New session"}
                </span>
                {/* Words, never a dot (DESIGN.md#status-semantics). */}
                {activity.label && (
                  <span className={activity.state === "needs_you" ? "tone-warn" : "overview-row-state"}>
                    {" "}
                    · {activity.label}
                  </span>
                )}
                {meta.length > 0 && <span className="overview-row-meta">{meta.join(" · ")}</span>}
              </button>
              {mayScope && (
                <button
                  className="btn btn-text overview-scope-button"
                  onClick={() => onEditScope(session)}
                  title={`Declare which files "${session.title ?? "this session"}" owns`}
                  data-testid="overview-scope"
                >
                  Scope
                </button>
              )}
              {onContinueFrom && (
                <button
                  className="btn btn-text overview-scope-button"
                  onClick={() => onContinueFrom(session.sessionId)}
                  title={`Start a new chat carrying the transcript of "${session.title ?? "this session"}"`}
                  data-testid="overview-continue-from"
                >
                  Continue
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Declaring a chat's file scope (D-097): the ownership proposal, shown and
 * approved before it stands. One pattern per line — the proposal is prefilled
 * from the directories the chat has already touched, which is the only
 * derivation that is not a guess — and saving it is the baton holder's
 * approval: in-scope writes stop asking, out-of-scope writes are refused,
 * and provably-disjoint chats run their turns at the same time.
 */
function ScopeDialog({
  session,
  proposal,
  busy,
  error,
  onCancel,
  onSave
}: {
  session: Session;
  /** Patterns derived from the chat's own touched files, for an unscoped
   *  chat's first proposal. */
  proposal: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (scope: string[] | null) => void;
}) {
  const [text, setText] = useState((session.scope ?? proposal).join("\n"));
  const patterns = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    <Dialog label="Scope" onClose={onCancel} testId="scope-dialog">
      <header className="dialog-head">
        <h2>Scope — {session.title ?? "New session"}</h2>
      </header>
      <div className="dialog-body">
        <p className="quiet">
          The files this chat owns, one pattern per line (<span className="mono">server/**</span>,{" "}
          <span className="mono">src/*.ts</span>). Writes inside them stop asking; writes outside
          them are refused; chats with provably separate files run at the same time. Bash still
          asks — a shell command declares its targets nowhere.
        </p>
        <textarea
          className="scope-input mono"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          aria-label="Scope patterns, one per line"
          data-testid="scope-input"
        />
        {error && (
          <p className="inline-error" role="alert" data-testid="scope-error">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-actions">
        {session.scope !== null && (
          <button
            className="btn btn-text"
            onClick={() => onSave(null)}
            disabled={busy}
            data-testid="scope-clear"
          >
            Clear scope
          </button>
        )}
        <button className="btn btn-text" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => onSave(patterns)}
          disabled={busy || patterns.length === 0}
          data-testid="scope-save"
        >
          {busy ? "Saving…" : "Set scope"}
        </button>
      </div>
    </Dialog>
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

/** Drift said plainly (D-139): only states that demand attention speak. */
function baseDriftWords(status: BaseStatus | null): string | null {
  if (!status) return null;
  switch (status.state) {
    case "moved":
      return status.aheadBy === null
        ? "base has moved since this began"
        : `base moved — ${status.aheadBy} ${status.aheadBy === 1 ? "commit" : "commits"} ahead`;
    case "rewritten":
      return "base rewritten since this began";
    case "missing":
      return "base branch is gone";
    default:
      return null;
  }
}
