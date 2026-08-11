import {
  TERMINAL_EXECUTION_STATES,
  type Execution,
  type FileChange,
  type MissionDetailResponse,
  type Participant,
  type Session,
  type VerificationCheck,
  type WorkspaceProcess
} from "@novus/contracts";
import { clockTime, plural } from "../format";

/** Pure projections of one poll (`MissionDetailResponse`) into what the room
 *  shows. No fetching, no fabrication: everything here is derived from state
 *  the server actually sent. */

const HARNESS_NAME = "Claude Code";

/**
 * One lane's view of the mission (D-080).
 *
 * The server already computes the lane-scoped facts — control, capabilities,
 * runner, workspace, state — for the lane the room asked for; what remains
 * mission-wide in the payload are the ledgers (directions, executions,
 * checkpoints, checks, approvals, events), because the Decision Room reads
 * them across lanes. This filters those ledgers down to the response's own
 * lane, so the trace, the state line's arithmetic, and the approval cards all
 * describe one lane and never a sibling's work. A mission with one lane passes
 * through untouched.
 */
export function laneView(detail: MissionDetailResponse): MissionDetailResponse {
  const lane = detail.workstream?.workstreamId ?? null;
  if (lane === null || detail.workstreams.length <= 1) return detail;
  const laneOf = new Map(
    detail.executions.map((execution) => [execution.executionId, execution.workstreamId])
  );
  return {
    ...detail,
    directions: detail.directions.filter((direction) => direction.workstreamId === lane),
    executions: detail.executions.filter((execution) => execution.workstreamId === lane),
    checkpoints: detail.checkpoints.filter(
      (checkpoint) => laneOf.get(checkpoint.executionId) === lane
    ),
    checks: detail.checks.filter(
      (check) =>
        (check.workstreamId ??
          (check.executionId === null ? null : laneOf.get(check.executionId) ?? null) ??
          // Unattributed checks predate lane attribution and belong to the
          // lane the mission started with.
          detail.workstreams[0]?.workstreamId) === lane
    ),
    approvals: detail.approvals.filter((approval) => approval.workstreamId === lane),
    // A process without a lane predates lane-scoping; it belongs to the
    // default lane rather than to every lane at once.
    processes: detail.processes.filter(
      (process) => (process.workstreamId ?? detail.workstreams[0]?.workstreamId) === lane
    ),
    // Mission-level events (null lane) stay: a participant joining belongs to
    // every lane's story. Another lane's events do not.
    events: detail.events.filter(
      (event) => event.workstreamId === null || event.workstreamId === lane
    )
  };
}

/** The workspace's own live turn — the one *write* execution, at most one per
 *  workstream. A read turn answering alongside (D-095) holds nothing and is
 *  not the workspace's story: its liveness is its chat's own word (D-094). */
export function activeExecution(detail: MissionDetailResponse): Execution | null {
  const live = detail.executions.filter(
    (execution) =>
      execution.access === "write" && !TERMINAL_EXECUTION_STATES.includes(execution.state)
  );
  return live[live.length - 1] ?? null;
}

/**
 * The sessions of the lane this response was computed for, in creation order
 * (D-083). The payload carries every lane's sessions because the Decision Room
 * reads across lanes; the room reads its own lane's, and shows session chrome
 * only when it holds more than one.
 */
export function laneSessions(detail: MissionDetailResponse): Session[] {
  const lane = detail.workstream?.workstreamId ?? null;
  if (lane === null) return [];
  return detail.sessions
    .filter((session) => session.workstreamId === lane)
    .sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionId.localeCompare(b.sessionId)
    );
}

/** The session whose turn is live right now, if any — at most one, because the
 *  workstream's one workspace takes turns (D-083). */
export function runningSession(detail: MissionDetailResponse): Session | null {
  const live = activeExecution(detail);
  if (!live) return null;
  return laneSessions(detail).find((session) => session.sessionId === live.sessionId) ?? null;
}

/** Whether this session's turn is waiting on a person — the fact behind the
 *  "· needs you" words on the rail tree's rows (D-083, D-084). */
export function sessionNeedsYou(detail: MissionDetailResponse, sessionId: string): boolean {
  return detail.executions.some(
    (execution) =>
      execution.sessionId === sessionId &&
      (execution.state === "needs_approval" || execution.state === "needs_direction")
  );
}

/**
 * What one conversation is doing right now, in a word (D-094). The lane's
 * chats share one workspace, so a person choosing where to type needs each
 * row to answer "and what is this one doing?" without being opened. Four
 * states, precedence in the order a person must act on them:
 *
 *  - `needs_you` — its turn is blocked on a person (approval or direction).
 *  - `working` — its turn is live. `lastHeardAt` is the turn's latest
 *    reported moment, so a row can say how fresh "working" is.
 *  - `queued` — it has direction waiting for the workspace, with the count.
 *  - `idle` — nothing to say; rows render no suffix at all, because ten
 *    quiet chats each announcing "idle" is apparatus (DESIGN.md).
 *
 * The label is the row's words — "needs you", "working", "queued · 2" —
 * always words, never a dot (DESIGN.md#status-semantics).
 */
export interface SessionActivity {
  state: "needs_you" | "working" | "queued" | "idle";
  label: string | null;
  lastHeardAt: string | null;
}

export function sessionActivity(
  detail: MissionDetailResponse,
  sessionId: string
): SessionActivity {
  if (sessionNeedsYou(detail, sessionId)) {
    return { state: "needs_you", label: "needs you", lastHeardAt: null };
  }
  const live = detail.executions.find(
    (execution) =>
      execution.sessionId === sessionId && !TERMINAL_EXECUTION_STATES.includes(execution.state)
  );
  if (live) {
    const heard = detail.events
      .filter((event) => event.executionId === live.executionId)
      .map((event) => event.occurredAt)
      .sort()
      .at(-1);
    return { state: "working", label: "working", lastHeardAt: heard ?? live.createdAt };
  }
  const waiting = detail.directions.filter(
    (direction) =>
      direction.sessionId === sessionId &&
      (direction.state === "submitted" || direction.state === "queued")
  ).length;
  if (waiting > 0) {
    return {
      state: "queued",
      label: waiting === 1 ? "queued" : `queued · ${waiting}`,
      lastHeardAt: null
    };
  }
  return { state: "idle", label: null, lastHeardAt: null };
}

/**
 * The files one conversation's turns have changed, latest checkpoint winning
 * per path — the chat's own footprint in the shared worktree (D-094). Derived
 * entirely from checkpoints, which are git's account, so a chat is credited
 * only with what its turns actually committed.
 */
export function sessionChangedFiles(
  detail: MissionDetailResponse,
  sessionId: string
): FileChange[] {
  const executionIds = new Set(
    detail.executions
      .filter((execution) => execution.sessionId === sessionId)
      .map((execution) => execution.executionId)
  );
  const byPath = new Map<string, FileChange>();
  const ordered = [...detail.checkpoints]
    .filter((checkpoint) => executionIds.has(checkpoint.executionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const checkpoint of ordered) {
    for (const file of checkpoint.files) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The chat whose checkpoint a check ran against (D-096). Honest attribution
 * only: a check proves a **revision**, and the worktree at that revision
 * holds every chat's work so far — so a check is never "chat A's tests",
 * it is "a check run at chat A's checkpoint". That checkpoint belongs to
 * one turn, the turn to one conversation, and the join is exactly that:
 * check → checkpointSha → checkpoint → execution → session. Null for a
 * check with no recorded revision, or one whose revision no checkpoint of
 * this payload claims.
 */
export function sessionOfCheck(
  detail: MissionDetailResponse,
  check: VerificationCheck
): Session | null {
  if (check.checkpointSha === null) return null;
  const checkpoint = detail.checkpoints.find((candidate) => candidate.sha === check.checkpointSha);
  if (!checkpoint) return null;
  const execution = detail.executions.find(
    (candidate) => candidate.executionId === checkpoint.executionId
  );
  if (!execution) return null;
  return (
    detail.sessions.find((session) => session.sessionId === execution.sessionId) ?? null
  );
}

/** The checks run at one conversation's checkpoints (D-096), ledger order. */
export function sessionChecks(
  detail: MissionDetailResponse,
  sessionId: string
): VerificationCheck[] {
  return detail.checks.filter(
    (check) => sessionOfCheck(detail, check)?.sessionId === sessionId
  );
}

/**
 * Files more than one of the lane's conversations have changed (D-094) — the
 * overlap warning's facts. Evidence-based only: it reads what checkpoints
 * recorded, never predicts what a direction might touch, so it can warn
 * honestly and cannot cry wolf. Paths in checkpoint order per session;
 * result sorted by path, each with the sessions that touched it in lane
 * order.
 */
export function contestedAcrossSessions(
  detail: MissionDetailResponse
): { path: string; sessions: Session[] }[] {
  const sessions = laneSessions(detail);
  if (sessions.length < 2) return [];
  const touched = new Map<string, Session[]>();
  for (const session of sessions) {
    for (const file of sessionChangedFiles(detail, session.sessionId)) {
      const list = touched.get(file.path) ?? [];
      list.push(session);
      touched.set(file.path, list);
    }
  }
  return [...touched.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([path, list]) => ({ path, sessions: list }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One session's view of the lane (D-083).
 *
 * Applied after laneView: the conversation — its directions, its executions,
 * their checkpoints, and their events — narrows to one session, so a canvas
 * never shows a sibling's transcript. Approvals, checks, and processes stay
 * the lane's: the question blocks the lane's one workspace and the evidence
 * is that shared workspace's, whichever conversation asked. Null means the
 * lane's first session; a lane still carrying one session passes through
 * untouched, exactly as before.
 */
export function sessionView(
  detail: MissionDetailResponse,
  sessionId: string | null
): MissionDetailResponse {
  const sessions = laneSessions(detail);
  if (sessionId === null && sessions.length <= 1) return detail;
  const target = sessionId ?? sessions[0]?.sessionId ?? null;
  if (target === null) return detail;
  const sessionOf = new Map(
    detail.executions.map((execution) => [execution.executionId, execution.sessionId])
  );
  const directionSession = new Map(
    detail.directions.map((direction) => [direction.directionId, direction.sessionId])
  );
  const executions = detail.executions.filter((execution) => execution.sessionId === target);
  const executionIds = new Set(executions.map((execution) => execution.executionId));
  return {
    ...detail,
    directions: detail.directions.filter((direction) => direction.sessionId === target),
    executions,
    checkpoints: detail.checkpoints.filter((checkpoint) => executionIds.has(checkpoint.executionId)),
    // An event belongs to the conversation that caused it — through its
    // execution or through its direction. Mission- and lane-level moments
    // (control changing hands, a participant joining) name neither, and they
    // belong to every session's story, so they stay.
    events: detail.events.filter((event) => {
      if (event.executionId === null && event.cause.directionId === null) return true;
      if (event.executionId !== null && sessionOf.get(event.executionId) === target) return true;
      return (
        event.cause.directionId !== null && directionSession.get(event.cause.directionId) === target
      );
    })
  };
}


export function controller(detail: MissionDetailResponse): Participant | null {
  return detail.participants.find((participant) => participant.isController) ?? null;
}

export function viewerIsController(detail: MissionDetailResponse): boolean {
  return detail.control.holderUserId === detail.viewerUserId;
}

/**
 * Every file the mission has changed, latest checkpoint wins per path. A file
 * touched three times is one row, not three.
 */
export function changedFiles(detail: MissionDetailResponse): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const ordered = [...detail.checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const checkpoint of ordered) {
    for (const file of checkpoint.files) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A run command the project declared that is alive right now — the reason the
 * room can say "App running" at all, and the process the Run control collapses
 * to (PRODUCT.md *App running*).
 */
export function liveRunProcess(detail: MissionDetailResponse): WorkspaceProcess | null {
  return (
    detail.processes.find(
      (process) => process.kind === "run" && (process.state === "running" || process.state === "starting")
    ) ?? null
  );
}

/**
 * Counts for the state line and the ledger's summary. A stale check proved an
 * earlier revision, so it is history and never counted as passing or failing
 * evidence for what is there now (PRODUCT.md *Verification stale*, D-037) —
 * `total` still reports everything observed, because hiding it would be its
 * own dishonesty.
 */
export function checkTallies(detail: MissionDetailResponse): {
  total: number;
  passed: number;
  failed: number;
  stale: number;
} {
  let passed = 0;
  let failed = 0;
  let stale = 0;
  for (const check of detail.checks) {
    if (check.stale) {
      stale += 1;
      continue;
    }
    if (check.outcome === "passed") passed += 1;
    if (check.outcome === "failed" || check.outcome === "errored") failed += 1;
  }
  return { total: detail.checks.length, passed, failed, stale };
}

/** Direction that is still waiting for the controller's judgment. */
export function pendingDirections(detail: MissionDetailResponse) {
  return detail.directions.filter(
    (direction) => direction.state === "submitted" || direction.state === "queued"
  );
}

/**
 * Where a waiting direction stands in its lane's queue — "2 of 3" — stated in
 * words on the thread's waiting row (DESIGN.md *Direction queued*: the thread
 * shows queued position and its author). Named only while more than one
 * direction waits: a queue of one is not a queue, and a number there would be
 * apparatus saying nothing. Computed against the lane view, because the lane's
 * one workspace is what the queue is for — sessions share it (D-083).
 */
export function queuedPositionLabel(
  detail: MissionDetailResponse,
  directionId: string
): string | null {
  const waiting = [...pendingDirections(detail)].sort((a, b) => a.ordinal - b.ordinal);
  if (waiting.length <= 1) return null;
  const index = waiting.findIndex((direction) => direction.directionId === directionId);
  if (index === -1) return null;
  return `${index + 1} of ${waiting.length}`;
}

export type StateTone = "neutral" | "active" | "warn" | "danger" | "ok";

export interface StateLineAction {
  label: string;
  /** What the action does; the room wires it to a real call or an inspector
   *  section. Never rendered without a real destination. */
  kind: "stop" | "forceInterrupt" | "changes" | "verification" | "setup" | "preview" | "stopRun";
}

export interface StateLineView {
  tone: StateTone;
  /** The state name — emphasized by weight, never by color (D-028). */
  name: string;
  /** The rest of the sentence. */
  detail: string;
  /** Overlay text appended to the line, e.g. a handoff waiting for a boundary. */
  suffix: string | null;
  action: StateLineAction | null;
  /** Working indicator: the one element in the product that may loop. */
  working: boolean;
}

/**
 * The state line (DESIGN.md signature element 5): current state, then next
 * action. State names key verbatim to PRODUCT.md#the-mission-state-model — the
 * renderer never invents one, and it never claims an action the bridge cannot
 * perform.
 */
export function deriveStateLine(detail: MissionDetailResponse): StateLineView {
  const overlays = new Set(detail.overlays);
  const files = changedFiles(detail);
  const checks = checkTallies(detail);
  const holder = detail.control.holderLogin;

  // Runner offline invalidates every claim about what the agent is doing, so
  // it replaces the line rather than decorating it (DESIGN.md#state-presentation).
  if (overlays.has("runner_offline")) {
    const lastSeen = detail.runner?.lastSeenAt;
    return {
      tone: "danger",
      name: "Runner offline",
      detail: lastSeen
        ? `last event received at ${clockTime(lastSeen)}`
        : "no events have been received from this machine",
      suffix: handoffSuffix(detail),
      action: null,
      working: false
    };
  }

  // Once the lane holds more than one conversation, the sentence names the
  // one the harness is working in — the state itself stays the lane's, and a
  // session still writing its title is simply not named (D-083).
  const workingTitle =
    laneSessions(detail).length > 1 ? (runningSession(detail)?.title ?? null) : null;

  const base = primaryStateLine(detail, files.length, checks, workingTitle);

  // A queued direction that only the controller can apply is the room's real
  // state while nothing else is happening.
  const waiting = pendingDirections(detail).filter(
    (direction) => direction.authorUserId !== detail.control.holderUserId
  );
  const idle =
    detail.state === "ready_for_instruction" ||
    detail.state === "needs_direction" ||
    detail.state === "paused" ||
    detail.state === "new_mission";
  if (overlays.has("direction_queued") && waiting.length > 0 && idle && holder) {
    return {
      tone: "warn",
      name: `Waiting for ${holder}`,
      detail: `${plural(waiting.length, "direction")} ${waiting.length === 1 ? "is" : "are"} queued`,
      suffix: suffixFor(detail),
      action: null,
      working: false
    };
  }

  const running = liveRunProcess(detail);
  if (running && !base.working) {
    return {
      tone: "active",
      name: "App running",
      detail: running.port === null ? running.name : `${running.name} on :${running.port}`,
      suffix: suffixFor(detail),
      action: running.previewUrl
        ? { label: "Open preview", kind: "preview" }
        : { label: "Stop", kind: "stopRun" },
      working: false
    };
  }

  if (overlays.has("verification_stale") && !base.working) {
    return {
      tone: "warn",
      name: "Verification stale",
      detail: "the workspace moved past what was checked",
      suffix: suffixFor(detail),
      action: { label: "Re-run verification", kind: "verification" },
      working: false
    };
  }

  return { ...base, suffix: suffixFor(detail) };
}

/** Overlay text appended to the line. Whether a runner exists at all belongs
 *  here, not in the composer: direction is always submittable, but nothing
 *  runs until some machine has this workstream. */
function suffixFor(detail: MissionDetailResponse): string | null {
  const handoff = handoffSuffix(detail);
  if (handoff) return handoff;
  // A question with nobody to answer it. First, because it is the only thing
  // in the room that a person can fix and nobody else can: the harness is
  // blocked, the lease lapsed, and claiming it is what unblocks the work
  // (PRODUCT.md#control).
  if (detail.state === "needs_approval" && detail.control.holderLogin === null) {
    return "no one holds the baton — claim it to answer";
  }
  // Nothing has been heard from the harness for a while. Said as the fact it
  // is — no progress reported — because the turn has not been stopped, nobody
  // has lost authority, and a long tool call looks exactly like this from here
  // (PRODUCT.md, *Execution stalled*).
  if (detail.overlays.includes("execution_stalled")) {
    const since = lastProgressAt(detail);
    const base = since
      ? `no progress reported since ${clockTime(since)}`
      : "no progress reported for a while";
    // The pulse tells a long quiet tool call from a dead machine (D-114): a
    // fresh heartbeat means the process is there and saying nothing — which a
    // twenty-minute test run legitimately looks like — while no pulse means
    // nobody is home and Stop is the right instinct.
    return heartbeatFresh(detail) ? `${base} — the process is alive` : base;
  }
  if (detail.runner === null) return "no machine has connected to run this yet";
  // A backlog behind a working turn (D-112). The idle case already states the
  // queue as the whole line ("Waiting for {holder} — …"); while the harness
  // is busy the count rode on nothing, so the controller's own queued work
  // was invisible at line level. Quiet, counts as text (DESIGN.md#status-
  // semantics), and only while something is actually consuming the queue's
  // place.
  if (
    detail.overlays.includes("direction_queued") &&
    (detail.state === "agent_running" ||
      detail.state === "agent_starting" ||
      detail.state === "agent_stopping" ||
      detail.state === "needs_approval")
  ) {
    const waiting = pendingDirections(detail).length;
    if (waiting > 0) return `${plural(waiting, "direction")} queued`;
  }
  return null;
}

/** The last thing the running execution reported, for the stalled suffix to
 *  name a time rather than a vague duration. Heartbeats are excluded on both
 *  sides of the wire (D-114): a pulse is liveness, never progress. */
function lastProgressAt(detail: MissionDetailResponse): string | null {
  const live = [...detail.executions]
    .reverse()
    .find((execution) => execution.state === "running" || execution.state === "starting");
  if (!live) return null;
  const events = detail.events.filter(
    (event) => event.executionId === live.executionId && event.kind !== "execution.heartbeat"
  );
  return events[events.length - 1]?.occurredAt ?? live.createdAt;
}

/** Whether the running turn's process has stated its pulse recently (D-114):
 *  within two beats, so one dropped report does not read as a death. */
function heartbeatFresh(detail: MissionDetailResponse): boolean {
  const live = [...detail.executions]
    .reverse()
    .find((execution) => execution.state === "running" || execution.state === "starting");
  if (!live) return false;
  const pulse = detail.events
    .filter(
      (event) => event.executionId === live.executionId && event.kind === "execution.heartbeat"
    )
    .at(-1);
  if (!pulse) return false;
  return Date.now() - Date.parse(pulse.occurredAt) < 8 * 60_000;
}

/**
 * What this lane has asked of the harness so far, added up (D-113): every
 * turn, and the time and cost the harness itself reported for them. Claims
 * carried as claims (D-071): a figure no turn reported stays null — never a
 * zero standing in for "not stated" — and a lane that has run nothing sums
 * to nothing. Renderer arithmetic over the executions the room already
 * holds; no new fetch.
 */
export function usageSoFar(detail: MissionDetailResponse): {
  turns: number;
  costUsd: number | null;
  durationMs: number | null;
} {
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  for (const execution of detail.executions) {
    const cost = execution.usage.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) costUsd = (costUsd ?? 0) + cost;
    const spent = execution.usage.durationMs;
    if (typeof spent === "number" && Number.isFinite(spent)) durationMs = (durationMs ?? 0) + spent;
  }
  return { turns: detail.executions.length, costUsd, durationMs };
}

function handoffSuffix(detail: MissionDetailResponse): string | null {
  const offer = detail.control.liveOffer;
  if (!detail.overlays.includes("handoff_waiting_for_boundary") || !offer) return null;
  return `Handing control to ${offer.toLogin} at the next safe point`;
}

/**
 * The open offer's expiry, as DESIGN.md's *Handoff offered* countdown text.
 * Words, not a clock face: minutes while minutes remain, seconds under the
 * last minute — the render cadence is the room's own poll, so a seconds
 * figure is a rough count-down, not a ticking one. Only an `open` offer
 * counts down; once accepted the grant is durable and waits for the boundary
 * however long that takes (PRODUCT.md#control). Null once past expiry: the
 * sweep is about to say "expired" in the feed, and a row reading "expires in
 * 0s" forever would be the lie this label exists to avoid.
 */
export function offerCountdownLabel(
  offer: { state: string; expiresAt: string },
  now: number
): string | null {
  if (offer.state !== "open") return null;
  const remaining = Date.parse(offer.expiresAt) - now;
  if (remaining <= 0) return null;
  if (remaining >= 60_000) return `expires in ${Math.ceil(remaining / 60_000)}m`;
  return `expires in ${Math.ceil(remaining / 1_000)}s`;
}

function primaryStateLine(
  detail: MissionDetailResponse,
  fileCount: number,
  checks: { total: number; passed: number; failed: number },
  /** The working session's title, only while the lane holds more than one
   *  conversation — the detail sentence names it then (D-083). */
  workingTitle: string | null = null
): StateLineView {
  const quiet = { suffix: null, action: null, working: false };
  switch (detail.state) {
    case "new_mission":
      return { ...quiet, tone: "neutral", name: "New mission", detail: "set up the workspace to begin" };
    case "workspace_needs_setup":
      return {
        tone: "warn",
        name: "Workspace needs setup",
        detail: "configure it before running the project",
        suffix: null,
        action: { label: "Set up workspace", kind: "setup" },
        working: false
      };
    case "provisioning_workspace":
      return {
        ...quiet,
        tone: "active",
        name: "Setting up workspace",
        detail: "the project's setup command is running",
        working: true
      };
    case "workspace_failed":
      return {
        tone: "danger",
        name: "Workspace setup failed",
        detail: workspaceError(detail),
        suffix: null,
        action: { label: "Set up workspace", kind: "setup" },
        working: false
      };
    case "ready_for_instruction":
      return {
        ...quiet,
        tone: "neutral",
        name: "Ready",
        detail: `tell ${HARNESS_NAME} what to change`
      };
    case "agent_starting":
      return {
        ...quiet,
        tone: "active",
        name: "Starting",
        detail: workingTitle
          ? `preparing the mission worktree for "${workingTitle}"`
          : "preparing the mission worktree",
        working: true
      };
    case "agent_running":
      return {
        tone: "active",
        name: "Running",
        detail: workingTitle
          ? `${HARNESS_NAME} is working in "${workingTitle}"`
          : `${HARNESS_NAME} is working`,
        suffix: null,
        action: { label: "Stop", kind: "stop" },
        working: true
      };
    case "agent_stopping": {
      // A stop that goes unanswered stops being "in flight" and becomes a
      // dead end a person needs a way out of (D-111): once the stop is a
      // minute old — or the machine has gone quiet — the line offers the
      // escalation. The server enforces the same grace again; this only
      // decides when the offer is honest to show.
      const stopping = detail.executions.find((execution) => execution.state === "stopping");
      const asked = stopping
        ? detail.events
            .filter(
              (event) =>
                event.executionId === stopping.executionId &&
                event.kind === "execution.stop_requested"
            )
            .at(-1)
        : undefined;
      const unanswered =
        asked !== undefined && Date.now() - Date.parse(asked.occurredAt) >= 60_000;
      const runnerGone = detail.runner === null || detail.runner.online === false;
      const forceable =
        detail.capabilities.includes("force_interrupt") && (unanswered || runnerGone);
      return {
        tone: "active",
        name: "Stopping",
        detail: workingTitle
          ? `${HARNESS_NAME} was asked to stop in "${workingTitle}"`
          : `${HARNESS_NAME} was asked to stop`,
        suffix: unanswered ? "the stop has gone unanswered" : null,
        // No action while the stop still has a claim to work: the one that
        // belongs here has been taken. The escalation appears only when
        // waiting longer is not a plan.
        action: forceable ? { label: "Force interrupt", kind: "forceInterrupt" } : null,
        working: true
      };
    }
    case "needs_direction":
      return {
        ...quiet,
        tone: "warn",
        name: "Needs direction",
        detail: `${HARNESS_NAME} is waiting at a safe boundary`
      };
    case "needs_approval": {
      // DESIGN.md#state-presentation asks for "{Harness} asks to {action}", so
      // the state line names the act rather than the category — a person
      // deciding needs to know what is being asked, not that something is.
      const asking = detail.approvals.find((approval) => approval.state === "pending");
      return {
        ...quiet,
        tone: "warn",
        name: "Needs approval",
        // Names the act and stops. What is being asked for is on the card, in
        // the thread, next to the work that raised it — saying it twice makes
        // the line long and the card redundant.
        detail: asking
          ? `${HARNESS_NAME} asks to ${asking.displayName.toLowerCase()}${
              workingTitle ? ` in "${workingTitle}"` : ""
            }`
          : `${HARNESS_NAME} is waiting${
              workingTitle ? ` in "${workingTitle}"` : ""
            } for a decision it cannot make itself`
      };
    }
    case "paused":
      return { ...quiet, tone: "warn", name: "Paused", detail: "the execution is held at a safe boundary" };
    case "work_completed_unverified":
      return {
        tone: "warn",
        name: "Work finished",
        detail:
          checks.total === 0
            ? `${plural(fileCount, "file")} changed, nothing verified`
            : `${plural(fileCount, "file")} changed, ${plural(checks.total, "check")} observed`,
        suffix: null,
        action: { label: "Review changes", kind: "changes" },
        working: false
      };
    case "ready_for_review":
      return {
        tone: "ok",
        name: "Ready for review",
        detail: `${plural(checks.passed, "check")} passed`,
        suffix: null,
        action: { label: "Open changes", kind: "changes" },
        working: false
      };
    case "decision_recorded": {
      // Two facts, and the line refuses to collapse them: somebody chose, and
      // what has happened to publication (D-075, D-099). It never says "done".
      const decision = detail.decisions.find((entry) => entry.supersededAt === null);
      const chosen = detail.approaches.find(
        (approach) => approach.workstreamId === decision?.workstreamId
      );
      const who = decision
        ? `${decision.decidedByLogin} chose ${chosen?.name ?? "this approach"}`
        : "a result was chosen";
      // A resolved pull request is how publication ended, and the sentence
      // names it rather than going back to "not published yet" — which would
      // be a lie the moment a merge happened (D-099).
      const resolved =
        detail.pullRequest &&
        (detail.pullRequest.state === "merged" || detail.pullRequest.state === "closed")
          ? detail.pullRequest
          : null;
      return {
        ...quiet,
        tone: "neutral",
        name: "Decision recorded",
        detail: resolved
          ? resolved.state === "merged"
            ? `${who} — published as PR #${resolved.number}, merged${resolved.mergedBy ? ` by ${resolved.mergedBy}` : ""} on GitHub`
            : `${who} — PR #${resolved.number} was closed on GitHub without merging`
          : `${who} — not published yet`
        // No button: the sentence is the state, and the decision is read on
        // Compare, one rail row away (D-084).
      };
    }
    case "pull_request_open": {
      // The tracked request is the mission's story now (D-099). The sentence
      // says what stands and where resolution happens; it never offers a
      // merge, because no verb for one exists.
      const pr = detail.pullRequest;
      const openThreads = pr?.reviewThreads.filter((thread) => thread.state === "open").length ?? 0;
      return {
        ...quiet,
        tone: "neutral",
        name: pr?.state === "ready" ? "Pull request ready" : "Pull request open",
        detail: pr
          ? `PR #${pr.number} ${pr.state === "draft" ? "is a draft" : "awaits review"}${
              openThreads > 0 ? ` · ${plural(openThreads, "open comment")}` : ""
            }${pr.mergeable === "conflict" ? " · conflicts with its base" : ""} — merging happens on GitHub`
          : "a pull request is being tracked"
      };
    }
    case "verification_failed":
      return {
        tone: "danger",
        name: "Verification failed",
        detail: `${checks.failed} of ${plural(checks.total, "check")} failed`,
        suffix: null,
        action: { label: "Review failures", kind: "verification" },
        working: false
      };
    case "execution_interrupted":
      return {
        ...quiet,
        tone: "warn",
        name: "Interrupted",
        detail: interruptionReason(detail)
      };
  }
}

function workspaceError(detail: MissionDetailResponse): string {
  return detail.workspace?.setupError ?? "the setup command did not finish";
}

function interruptionReason(detail: MissionDetailResponse): string {
  for (let i = detail.events.length - 1; i >= 0; i -= 1) {
    const event = detail.events[i];
    if (event?.kind !== "execution.interrupted") continue;
    const reason = event.payload.reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return "the execution ended before it finished";
}
