import {
  TERMINAL_EXECUTION_STATES,
  type Execution,
  type FileChange,
  type MissionDetailResponse,
  type Participant,
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
          (check.executionId === null ? null : laneOf.get(check.executionId) ?? null)) === lane
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

/** The one execution that is still live, if any. At most one per workstream
 *  (PRODUCT.md#domain-model). */
export function activeExecution(detail: MissionDetailResponse): Execution | null {
  const live = detail.executions.filter(
    (execution) => !TERMINAL_EXECUTION_STATES.includes(execution.state)
  );
  return live[live.length - 1] ?? null;
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

export type StateTone = "neutral" | "active" | "warn" | "danger" | "ok";

export interface StateLineAction {
  label: string;
  /** What the action does; the room wires it to a real call or an inspector
   *  section. Never rendered without a real destination. */
  kind: "stop" | "changes" | "verification" | "setup" | "preview" | "stopRun" | "decision";
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

  const base = primaryStateLine(detail, files.length, checks);

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
    return since ? `no progress reported since ${clockTime(since)}` : "no progress reported for a while";
  }
  if (detail.runner === null) return "no machine has connected to run this workstream yet";
  return null;
}

/** The last thing the running execution reported, for the stalled suffix to
 *  name a time rather than a vague duration. */
function lastProgressAt(detail: MissionDetailResponse): string | null {
  const live = [...detail.executions]
    .reverse()
    .find((execution) => execution.state === "running" || execution.state === "starting");
  if (!live) return null;
  const events = detail.events.filter((event) => event.executionId === live.executionId);
  return events[events.length - 1]?.occurredAt ?? live.createdAt;
}

function handoffSuffix(detail: MissionDetailResponse): string | null {
  const offer = detail.control.liveOffer;
  if (!detail.overlays.includes("handoff_waiting_for_boundary") || !offer) return null;
  return `Handing control to ${offer.toLogin} at the next safe point`;
}

function primaryStateLine(
  detail: MissionDetailResponse,
  fileCount: number,
  checks: { total: number; passed: number; failed: number }
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
        detail: "preparing the mission worktree",
        working: true
      };
    case "agent_running":
      return {
        tone: "active",
        name: "Running",
        detail: `${HARNESS_NAME} is working`,
        suffix: null,
        action: { label: "Stop", kind: "stop" },
        working: true
      };
    case "agent_stopping":
      return {
        tone: "active",
        name: "Stopping",
        detail: `${HARNESS_NAME} was asked to stop`,
        suffix: null,
        // No action: the one that belongs here has been taken.
        action: null,
        working: true
      };
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
          ? `${HARNESS_NAME} asks to ${asking.displayName.toLowerCase()}`
          : `${HARNESS_NAME} is waiting for a decision it cannot make itself`
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
      // nothing has been published (D-075). It never says "done".
      const decision = detail.decisions.find((entry) => entry.supersededAt === null);
      const chosen = detail.approaches.find(
        (approach) => approach.workstreamId === decision?.workstreamId
      );
      return {
        ...quiet,
        tone: "neutral",
        name: "Decision recorded",
        detail: decision
          ? `${decision.decidedByLogin} chose ${chosen?.name ?? "this approach"} — not published yet`
          : "a result was chosen — not published yet",
        action: { label: "Open the decision", kind: "decision" }
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
