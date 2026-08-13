import { PERMISSION_PROFILES } from "@novus/contracts";
import type {
  ApprovalRequest,
  Checkpoint,
  Direction,
  MissionDetailResponse,
  MissionEvent,
  VerificationCheck
} from "@novus/contracts";
import { clockTime, compactCount, elapsed, plural, shortSha, usd } from "../format";
import { HarnessMark, HumanMark } from "./identity";

/**
 * The direction thread (DESIGN.md signature element 2). One coherent trace per
 * direction: author → direction → the activity it produced, connected by a
 * left-edge --accent line. Lifecycle renders as states of that one thread —
 * position and line treatment — never as badges.
 *
 * Everything the feed shows is grouped: consecutive harness speech sits under
 * one harness identity, tool calls collapse into one disclosure, and technical
 * setup collapses into a single subordinate row. No event is ever rendered as
 * a lone centred fragment.
 */

const HARNESS_NAME = "Claude Code";

/** Events that describe getting ready, not doing the work. They collapse into
 *  one subordinate row above the first trace. */
const SETUP_KINDS = new Set([
  "mission.created",
  "workstream.created",
  "workstream.branch_created",
  "runner.registered"
]);

/** Events that carry no meaning of their own once the trace exists. The last
 *  two said "requested {login}" and "reached" as catch-all rows in the
 *  disclosure — protocol bookkeeping the direction row and the approval card
 *  already say better, removed on the owner's sight of the clutter (D-108). */
const ABSORBED_KINDS = new Set([
  "direction.submitted",
  "direction.queued",
  "direction.applied",
  "execution.starting",
  "execution.requested",
  "boundary.reached",
  // The turn's pulse (D-114): liveness for the stall watch, not a moment in
  // the room.
  "execution.heartbeat"
]);

/**
 * The workspace runtime's own events. A run command is not an execution and no
 * direction caused it, so nothing here hangs off a direction thread — and a
 * thread with no author, no words, and one disclosure is exactly the lone
 * fragment signature element 2 exists to prevent. The room reports these live
 * in the state line and on the Run control; the record keeps them in history.
 */
const WORKSPACE_RUNTIME_KINDS = new Set([
  "workspace.command_requested",
  "workspace.stop_requested",
  "workspace.readiness",
  "process.started",
  "process.exited"
]);

type Tone = "neutral" | "warn" | "danger" | "ok";

type Segment =
  | { kind: "harness"; key: string; texts: string[] }
  | { kind: "checkpoint"; key: string; checkpoint: Checkpoint | null; sha: string | null }
  | { kind: "checks"; key: string; checks: VerificationCheck[] }
  | { kind: "note"; key: string; text: string; login: string | null; tone: Tone }
  | { kind: "outcome"; key: string; text: string; tone: Tone };

interface ToolStep {
  label: string;
  detail: string | null;
  /** Produced by one of the harness's **own** subagents rather than by the
   *  harness itself, but not joinable to a recorded spawn — old logs, or a
   *  parent id the stream never explained. It stays what it always was:
   *  indented grouped activity, no identity claimed (D-107). */
  nested?: boolean;
}

/**
 * One of the harness's own workers, joined entirely from what the stream
 * stated (D-107): the Task call's own id and description, its children's
 * tagged activity, and the Task result's own outcome flag and report. A
 * worker has no branch, checkpoint, controller, workstream, or cost — the
 * CLI states usage per turn only, and Novus does not compute figures the
 * vendor did not report.
 */
export interface WorkerView {
  /** The spawning Task call's own id. */
  id: string;
  /** The Task call's description — the only identity the harness stated. */
  purpose: string | null;
  /** When the spawn appeared on the stream. */
  at: string | null;
  /** What the worker said and did, in stream order. */
  steps: ToolStep[];
  /** The Task result, when it arrived. Null is "not stated", never "fine". */
  ended: { failed: boolean; report: string | null; at: string | null } | null;
}

/**
 * A worker's state, in a word — or in nothing. `working` only while the
 * parent turn is itself live: once the turn has settled without the Task
 * result arriving, the worker's end was never stated, and an unstated end is
 * not a state (D-094's rule — evidence, never prediction).
 */
export function workerState(worker: WorkerView, turnSettled: boolean): "working" | "done" | "failed" | null {
  if (worker.ended) return worker.ended.failed ? "failed" : "done";
  return turnSettled ? null : "working";
}

/** The files a worker's own tool activity named — its footprint as stated,
 *  never the checkpoint's (a worker has no checkpoint, D-071). */
export function workerFiles(worker: WorkerView): string[] {
  const files = new Set<string>();
  for (const step of worker.steps) {
    if ((step.label === "Write" || step.label === "Edit" || step.label === "NotebookEdit") && step.detail) {
      files.add(step.detail);
    }
  }
  return [...files];
}

/** What the harness said this turn cost, summed over the turns of one trace. */
interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number | null;
}

interface TraceBlock {
  kind: "trace";
  key: string;
  direction: Direction | null;
  authorLogin: string | null;
  authorUserId: string | null;
  body: string | null;
  at: string | null;
  /** Harness machinery for this turn: subordinate, never in the header. */
  machinery: string | null;
  /** What the harness reported this turn cost, when it reported anything. */
  usage: UsageTotals | null;
  segments: Segment[];
  /** Who rejected, superseded, or cancelled it, when someone did. */
  resolvedBy: string | null;
  /** All of this direction's technical activity, in ONE disclosure — not one
   *  per gap between harness messages. */
  toolSteps: ToolStep[];
  /** The harness's own workers this turn spawned, joined by the ids the
   *  stream stated (D-107). Inside the disclosure, never beside the speech. */
  workers: WorkerView[];
  /** Whether a terminal execution event has arrived, so a worker without a
   *  stated end stops reading as `working` once the turn itself is over. */
  settled: boolean;
}

interface ControlBlock {
  kind: "control";
  key: string;
  text: string;
  login: string | null;
  baton: boolean;
  at: string;
}

export type FeedBlock = TraceBlock | ControlBlock;

export interface Feed {
  setup: { label: string; danger: boolean; at: string } | null;
  blocks: FeedBlock[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Turns `control.request_withdrawn` into "request withdrawn" so an event kind
 *  never reaches the canvas as a raw identifier. */
function humanizeKind(kind: string): string {
  const tail = kind.includes(".") ? kind.slice(kind.indexOf(".") + 1) : kind;
  return tail.replace(/_/g, " ");
}

interface ControlLine {
  text: string;
  /** Whose mark leads the row; null renders the row without one. */
  login: string | null;
  /** The completed transfer carries the baton to its new holder. */
  baton: boolean;
}

/**
 * Control events are the most important moments in the product, so they are
 * read from their payloads and named. An event the renderer cannot attribute
 * returns null and folds into the trace's technical row — a system actor is
 * never rendered as "Someone".
 */
function controlLine(event: MissionEvent): ControlLine | null {
  const actor = event.actor.kind === "user" ? event.actor.login : null;
  const from = text(event.payload.fromLogin);
  const to = text(event.payload.toLogin) ?? text(event.payload.holderLogin);
  const requester = text(event.payload.requesterLogin);
  const plain = (value: string, login: string | null): ControlLine => ({
    text: value,
    login,
    baton: false
  });

  switch (event.kind) {
    case "control.transferred":
    case "handoff.completed": {
      if (from && to) return { text: `${from} handed the baton to ${to}`, login: to, baton: true };
      if (to) return { text: `${to} has the baton`, login: to, baton: true };
      return null;
    }
    case "control.request_fulfilled": {
      const who = requester ?? to ?? actor;
      return who ? plain(`${who}'s request for control was granted`, who) : null;
    }
    case "control.requested":
    case "control.request": {
      const who = requester ?? actor;
      return who ? plain(`${who} asked for control`, who) : null;
    }
    case "control.request_withdrawn": {
      const who = requester ?? actor;
      return who ? plain(`${who} withdrew the request for control`, who) : null;
    }
    case "control.request_declined": {
      if (!actor) return null;
      return plain(
        requester ? `${actor} declined ${requester}'s request for control` : `${actor} declined the request for control`,
        actor
      );
    }
    case "control.revoked": {
      if (!actor) return null;
      return plain(from ? `${actor} revoked control from ${from}` : `${actor} revoked control`, actor);
    }
    case "policy.changed": {
      // The lane's answer policy moved (D-115): a room-level act with a name
      // on it, exactly like the baton moving. The dangerous word carries its
      // meaning in the sentence, because "Don't ask" alone undersells it.
      if (!actor) return null;
      const word = text(event.payload.to);
      const label = PERMISSION_PROFILES.find((option) => option.id === word)?.label ?? word;
      if (!label) return null;
      return plain(
        word === "dont_ask"
          ? `${actor} set permissions to ${label} — every act the harness asks about is approved by policy, on the record`
          : `${actor} set permissions to ${label}`,
        actor
      );
    }
    case "control.released": {
      const who = from ?? actor;
      return who ? plain(`${who} released control`, who) : null;
    }
    case "control.offered":
    case "handoff.offered": {
      const who = from ?? actor;
      if (!who) return null;
      return plain(to ? `${who} offered control to ${to}` : `${who} offered control`, who);
    }
    case "control.offer_withdrawn": {
      const who = from ?? actor;
      return who ? plain(`${who} withdrew the offer of control`, who) : null;
    }
    case "control.offer_accepted":
    case "handoff.accepted": {
      const who = to ?? actor;
      return who ? plain(`${who} accepted control`, who) : null;
    }
    case "control.offer_declined":
    case "handoff.declined": {
      const who = to ?? actor;
      return who ? plain(`${who} declined the offer of control`, who) : null;
    }
    case "control.offer_expired": {
      if (from && to) return plain(`${from}'s offer of control to ${to} expired unanswered`, from);
      return plain("The offer of control expired unanswered", from);
    }
    // Bookkeeping the lease emits alongside the moments above. Subordinate:
    // it belongs in the technical row, not in the stream.
    case "control.granted":
    case "control.requests_superseded":
    case "control.request_superseded":
      return null;
    default:
      return actor ? plain(`${actor} — ${humanizeKind(event.kind)}`, actor) : null;
  }
}

/**
 * Groups one poll's events into traces. Events are grouped under the direction
 * that caused them (`event.cause.directionId`); uncaused activity falls to the
 * open trace, and uncaused activity with no open trace gets an unattributed
 * one — so nothing is ever orphaned into the canvas.
 */
export function buildFeed(detail: MissionDetailResponse): Feed {
  const events = [...detail.events].sort((a, b) => a.seq - b.seq);
  const directions = new Map(detail.directions.map((direction) => [direction.directionId, direction]));
  const blocks: FeedBlock[] = [];
  const traces = new Map<string, TraceBlock>();
  let open: TraceBlock | null = null;
  let setupAt: string | null = null;
  let sawSetup = false;

  // Typed evidence, consumed in the order the events reference it: the numbers
  // in the trace come from the checkpoint and check records, never from a
  // loosely-typed event payload.
  const checkpointQueue = new Map<string, Checkpoint[]>();
  for (const checkpoint of [...detail.checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const queue = checkpointQueue.get(checkpoint.executionId) ?? [];
    queue.push(checkpoint);
    checkpointQueue.set(checkpoint.executionId, queue);
  }
  // A participant-run check has no execution: it belongs to the ledger, not to
  // any one direction's trace. Only harness-observed checks hang off a turn.
  const checkQueue = new Map<string, VerificationCheck[]>();
  for (const check of [...detail.checks].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    if (check.executionId === null) continue;
    const queue = checkQueue.get(check.executionId) ?? [];
    queue.push(check);
    checkQueue.set(check.executionId, queue);
  }

  const newTrace = (direction: Direction | null, event: MissionEvent | null): TraceBlock => {
    const block: TraceBlock = {
      kind: "trace",
      key: direction?.directionId ?? `trace-${event?.eventId ?? blocks.length}`,
      direction,
      authorLogin: direction?.authorLogin ?? event?.actor.login ?? null,
      authorUserId: direction?.authorUserId ?? null,
      body: direction?.body ?? null,
      at: direction?.submittedAt ?? event?.occurredAt ?? null,
      machinery: null,
      usage: null,
      segments: [],
      resolvedBy: null,
      toolSteps: [],
      workers: [],
      settled: false
    };
    blocks.push(block);
    if (direction) traces.set(direction.directionId, block);
    open = block;
    return block;
  };

  const push = (block: TraceBlock, segment: Segment) => {
    const last = block.segments[block.segments.length - 1];
    if (segment.kind === "harness" && last?.kind === "harness") {
      last.texts.push(...segment.texts);
      return;
    }
    if (segment.kind === "checks" && last?.kind === "checks") {
      last.checks.push(...segment.checks);
      return;
    }
    block.segments.push(segment);
  };

  for (const event of events) {
    if (SETUP_KINDS.has(event.kind)) {
      sawSetup = true;
      setupAt = setupAt ?? event.occurredAt;
      continue;
    }
    if (event.kind === "workstream.branch_failed") {
      sawSetup = true;
      setupAt = setupAt ?? event.occurredAt;
      continue;
    }
    if (WORKSPACE_RUNTIME_KINDS.has(event.kind)) continue;
    if (
      event.kind.startsWith("control.") ||
      event.kind.startsWith("handoff.") ||
      event.kind === "policy.changed"
    ) {
      const line = controlLine(event);
      if (line) {
        blocks.push({
          kind: "control",
          key: event.eventId,
          text: line.text,
          login: line.login,
          baton: line.baton,
          at: event.occurredAt
        });
      } else if (open) {
        // Lease bookkeeping is technical activity, not a moment in the room.
        open.toolSteps.push({ label: humanizeKind(event.kind), detail: event.actor.login });
      }
      continue;
    }

    const directionId = event.cause.directionId;
    let block: TraceBlock;
    if (directionId) {
      block = traces.get(directionId) ?? newTrace(directions.get(directionId) ?? null, event);
      open = block;
    } else {
      block = open ?? newTrace(null, event);
    }

    if (ABSORBED_KINDS.has(event.kind)) continue;

    switch (event.kind) {
      case "harness.text": {
        const body = text(event.payload.text);
        if (!body) break;
        const parent = text(event.payload.parentToolUseId);
        if (parent) {
          // One of the harness's own subagents. It is activity, not the answer
          // the room is waiting for, so it never takes the speech position —
          // and the reply that leads stays the harness's own (D-065). Joined
          // to its worker when the spawn id was recorded (D-107); grouped
          // activity as before when it was not.
          const worker = block.workers.find((candidate) => candidate.id === parent);
          if (worker) worker.steps.push({ label: "said", detail: body });
          else block.toolSteps.push({ label: "said", detail: body, nested: true });
          break;
        }
        push(block, { kind: "harness", key: event.eventId, texts: [body] });
        break;
      }
      case "harness.tool": {
        const label = text(event.payload.tool) ?? "tool";
        const detail = text(event.payload.detail);
        const parent = text(event.payload.parentToolUseId);
        const own = text(event.payload.toolUseId);
        if (label === "Task" && own && !parent) {
          // The spawn itself. The Task row becomes the worker's own row in
          // the Workers rollup rather than a flat step — same disclosure,
          // same facts, grouped where its children will land (D-107).
          block.workers.push({ id: own, purpose: detail, at: event.occurredAt, steps: [], ended: null });
          break;
        }
        if (parent) {
          const worker = block.workers.find((candidate) => candidate.id === parent);
          if (worker) {
            worker.steps.push({ label, detail });
            break;
          }
          // A parent the log never explained: grouped activity, no identity
          // claimed (D-107).
          block.toolSteps.push({ label, detail, nested: true });
          break;
        }
        block.toolSteps.push({ label, detail });
        break;
      }
      case "approval.policy": {
        // A profile-decided answer (D-115): apparatus, never a question — the
        // act was answered by a person's standing policy the moment it was
        // asked, and this row is the receipt's view of that. It never takes
        // the card position, because nothing waited.
        const tool = text(event.payload.toolName) ?? "a tool";
        const summary = text(event.payload.summary);
        const profileWord =
          PERMISSION_PROFILES.find((option) => option.id === text(event.payload.profile))?.label ??
          text(event.payload.profile) ??
          "policy";
        block.toolSteps.push({
          label: `${event.payload.decision === "denied" ? "refused" : "allowed"} by policy · ${tool}`,
          detail: summary ? `${summary} (${profileWord})` : profileWord
        });
        break;
      }
      case "harness.worker.ended": {
        const own = text(event.payload.toolUseId);
        const worker = own ? block.workers.find((candidate) => candidate.id === own) : undefined;
        // An end whose start was never recorded proves nothing and renders
        // nothing — the parser already refuses to emit one, but an old log
        // is read with the same honesty.
        if (worker) {
          worker.ended = {
            failed: event.payload.failed === true,
            report: text(event.payload.report),
            at: event.occurredAt
          };
        }
        break;
      }
      case "harness.usage": {
        const totals = block.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null, durationMs: null };
        const add = (current: number | null, value: unknown): number | null => {
          const parsed = typeof value === "number" && Number.isFinite(value) ? value : null;
          if (parsed === null) return current;
          return (current ?? 0) + parsed;
        };
        block.usage = {
          inputTokens: add(totals.inputTokens, event.payload.inputTokens) ?? 0,
          outputTokens: add(totals.outputTokens, event.payload.outputTokens) ?? 0,
          costUsd: add(totals.costUsd, event.payload.costUsd),
          durationMs: add(totals.durationMs, event.payload.durationMs)
        };
        break;
      }
      case "execution.started":
      case "execution.running": {
        const model = text(event.payload.model);
        const effort = text(event.payload.effort);
        // A read-alongside turn says so on its machinery line (D-095): the
        // trace reads normally, and the one word explains why this turn could
        // only ever answer — never change the worktree.
        const readOnly =
          event.executionId !== null &&
          detail.executions.find((execution) => execution.executionId === event.executionId)
            ?.access === "read";
        // And a turn that ran under a standing answer policy says which
        // (D-115) — on the apparatus line, because what supervision a turn
        // had is a fact about the turn. Manual is the default and says
        // nothing, exactly as an ordinary write turn's access says nothing.
        const profile = text(event.payload.permissionProfile);
        const profileWord =
          profile && profile !== "manual"
            ? (PERMISSION_PROFILES.find((option) => option.id === profile)?.label ?? profile)
            : null;
        let base = model ? (effort ? `${model} · effort ${effort}` : model) : null;
        if (base && profileWord) base = `${base} · ${profileWord}`;
        block.machinery = base ? (readOnly ? `${base} · read-only` : base) : block.machinery;
        // What the turn was handed (D-118): the enabled skills it actually
        // carries, stated as apparatus — and any it could not carry, each with
        // the reason, in the warn tone, because a standing enablement that no
        // longer names real bytes is news a person acts on. Nothing carried
        // and nothing dropped says nothing, like every default.
        const carried = Array.isArray(event.payload.skills)
          ? event.payload.skills.filter((name): name is string => typeof name === "string")
          : [];
        if (carried.length > 0) {
          push(block, {
            kind: "note",
            key: `${event.eventId}-skills`,
            text: `Project skills carried: ${carried.join(", ")}`,
            login: null,
            tone: "neutral"
          });
        }
        const droppedSkills = Array.isArray(event.payload.skillsDropped)
          ? event.payload.skillsDropped
          : [];
        for (const drop of droppedSkills) {
          const name = text((drop as { name?: unknown }).name);
          if (!name) continue;
          push(block, {
            kind: "note",
            key: `${event.eventId}-skill-drop-${name}`,
            text: `Project skill not carried — "${name}": ${
              text((drop as { reason?: unknown }).reason) ?? "the reason was not stated"
            }`,
            login: null,
            tone: "warn"
          });
        }
        break;
      }
      case "harness.session": {
        const resumed = event.payload.resumed === true;
        if (!resumed) break;
        push(block, {
          kind: "note",
          key: event.eventId,
          text: `${HARNESS_NAME} resumed its earlier session`,
          login: null,
          tone: "neutral"
        });
        break;
      }
      case "workspace.checkpoint": {
        const queue = event.executionId ? checkpointQueue.get(event.executionId) : undefined;
        const checkpoint = queue?.shift() ?? null;
        push(block, {
          kind: "checkpoint",
          key: event.eventId,
          checkpoint,
          sha: checkpoint?.sha ?? text(event.payload.sha)
        });
        break;
      }
      case "verification.observed": {
        const queue = event.executionId ? checkQueue.get(event.executionId) : undefined;
        const check = queue?.shift();
        if (check) push(block, { kind: "checks", key: event.eventId, checks: [check] });
        break;
      }
      case "execution.completed":
        block.settled = true;
        push(block, { kind: "outcome", key: event.eventId, text: "Turn completed", tone: "neutral" });
        break;
      case "execution.stopped":
        block.settled = true;
        push(block, {
          kind: "outcome",
          key: event.eventId,
          text: `Stopped${event.actor.login ? ` by ${event.actor.login}` : ""}`,
          tone: "warn"
        });
        break;
      case "execution.failed":
        block.settled = true;
        push(block, {
          kind: "outcome",
          key: event.eventId,
          text: `Failed — ${text(event.payload.reason) ?? text(event.payload.error) ?? "no reason reported"}`,
          tone: "danger"
        });
        break;
      case "execution.interrupted":
        block.settled = true;
        push(block, {
          kind: "outcome",
          key: event.eventId,
          text: `Interrupted — ${text(event.payload.reason) ?? "the execution ended before it finished"}`,
          tone: "warn"
        });
        break;
      case "runner.gap":
        push(block, {
          kind: "note",
          key: event.eventId,
          text: "Some events never arrived — the runner reconnected and backfilled",
          login: null,
          tone: "warn"
        });
        break;
      case "direction.authorized":
        push(block, {
          kind: "note",
          key: event.eventId,
          // Authorized, not applied. Applied is written only when the runner
          // acknowledges it; saying "applied" here would claim the harness has
          // work it may never have been given (PRODUCT.md#direction).
          text: `${event.actor.login ?? "The controller"} approved this direction`,
          login: event.actor.login,
          tone: "neutral"
        });
        break;
      case "direction.rejected":
      case "direction.superseded":
      case "direction.cancelled":
        // The lifecycle is the thread's own state, rendered once as line
        // treatment — this event only supplies who settled it.
        block.resolvedBy = event.actor.login;
        break;
      default:
        // Anything the renderer does not know by name is technical activity,
        // never a mystery fragment in the middle of the room.
        block.toolSteps.push({ label: humanizeKind(event.kind), detail: event.actor.login });
    }
  }

  // Directions that have produced nothing yet (queued, waiting for the
  // controller) belong at the end: position is the lifecycle.
  for (const direction of [...detail.directions].sort((a, b) => a.ordinal - b.ordinal)) {
    if (traces.has(direction.directionId)) continue;
    newTrace(direction, null);
  }

  const workstream = detail.workstream;
  const failed = workstream?.branchStatus === "failed";
  const setup =
    sawSetup && workstream
      ? {
          label: failed
            ? `Branch creation failed · ${workstream.baseRef} @ ${shortSha(workstream.baseSha)}`
            : `Workspace ready · ${workstream.baseRef} @ ${shortSha(workstream.baseSha)}`,
          danger: failed,
          at: setupAt ?? workstream.baseSha
        }
      : null;

  return { setup, blocks };
}

/** One disclosure per trace: every tool call and every unnamed event the
 *  direction produced, counted honestly and out of the way. */
/**
 * The turn's workers as their own quiet rows on the trace (D-108, reversing
 * D-107's placement inside the disclosure on the owner's sight of it): the
 * way a terminal shows subagents — one line each, the purpose, the last
 * thing it did, its state in a word — and Enter or a click steps in. They
 * take the milestone anatomy, like CHECKPOINT, because that is what they
 * are: something the turn produced, worth one glance.
 */
function WorkerRows({
  workers,
  settled,
  onOpenWorker
}: {
  workers: WorkerView[];
  settled: boolean;
  onOpenWorker?: (workerId: string) => void;
}) {
  return (
    <div className="worker-rows" data-testid="worker-rollup">
      {workers.map((worker, index) => {
        const state = workerState(worker, settled);
        const last = worker.steps[worker.steps.length - 1] ?? null;
        const doing = last
          ? last.label === "said"
            ? (last.detail ?? "")
            : [last.label, last.detail].filter(Boolean).join(" ")
          : null;
        return (
          <button
            key={worker.id}
            className="milestone worker-line"
            data-testid="worker-row"
            onClick={() => onOpenWorker?.(worker.id)}
          >
            <span className="milestone-label">{index === 0 ? "workers" : ""}</span>
            <span className="worker-purpose">{worker.purpose ?? "Worker"}</span>
            {doing && <span className="worker-last mono">{doing}</span>}
            {state && (
              <span
                className={state === "failed" ? "worker-state tone-danger" : "worker-state"}
                data-testid="worker-state"
              >
                {state}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TechnicalActivity({ steps }: { steps: ToolStep[] }) {
  return (
    <details className="disclosure" data-testid="technical-activity">
      <summary>
        <Chevron />
        Technical activity
        <span className="disclosure-count">{plural(steps.length, "step")}</span>
      </summary>
      <ul className="tool-list">
        {steps.map((step, index) => (
          <li
            key={index}
            data-testid="tool-line"
            className={step.nested ? "tool-line-nested" : undefined}
            // Indent is the grouping, as it is everywhere else in the trace: a
            // worker's step sits under the turn that spawned it.
            data-worker={step.nested ? "true" : undefined}
          >
            <span className="mono tool-name">{step.label}</span>
            {step.detail && <span className="tool-detail">{step.detail}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Chevron() {
  return (
    <svg
      className="disclosure-chevron"
      viewBox="0 0 16 16"
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

function CheckpointRow({ segment, onOpenChanges }: { segment: Segment & { kind: "checkpoint" }; onOpenChanges: () => void }) {
  const checkpoint = segment.checkpoint;
  return (
    <div className="milestone" data-testid="checkpoint-line">
      <span className="milestone-label">Checkpoint</span>
      <span className="milestone-body">
        {checkpoint ? (
          <>
            {plural(checkpoint.filesChanged, "file")} changed{" "}
            {/* The sign says which way; the colour agrees with it. Same two
                tokens the diff itself uses, so one change reads the same in
                the trace and in the panel (D-065). */}
            <span className="change-counts mono">
              <span className="count-add">+{checkpoint.additions}</span>
              <span className="count-del">−{checkpoint.deletions}</span>
            </span>
          </>
        ) : (
          "checkpoint recorded"
        )}
        {segment.sha && <span className="mono milestone-sha"> {shortSha(segment.sha)}</span>}
        {checkpoint?.withheldSecrets ? ` · ${plural(checkpoint.withheldSecrets, "secret")} withheld` : ""}
        {/* A scoped turn's shell side-effects, or a parallel sibling's work in
            flight: named, never committed by this turn (D-097). */}
        {checkpoint && checkpoint.driftPaths.length > 0 ? (
          <span className="tone-warn" data-testid="checkpoint-drift">
            {` · ${plural(checkpoint.driftPaths.length, "file")} outside its scope, uncommitted`}
          </span>
        ) : checkpoint?.uncommitted ? (
          " · uncommitted"
        ) : (
          ""
        )}
      </span>
      {checkpoint && checkpoint.filesChanged > 0 && (
        <button className="btn btn-text milestone-action" onClick={onOpenChanges} data-testid="trace-open-changes">
          Changes
        </button>
      )}
    </div>
  );
}

function ChecksRow({
  segment,
  onOpenVerification
}: {
  segment: Segment & { kind: "checks" };
  onOpenVerification: () => void;
}) {
  const passed = segment.checks.filter((check) => check.outcome === "passed").length;
  const failed = segment.checks.filter(
    (check) => check.outcome === "failed" || check.outcome === "errored"
  ).length;
  return (
    <div className="milestone" data-testid="verification-line">
      <span className="milestone-label">Verification</span>
      <span className="milestone-body">
        {failed > 0 ? `${failed} failed, ${passed} passed` : `${plural(passed, "check")} passed`}
      </span>
      <button className="btn btn-text milestone-action" onClick={onOpenVerification} data-testid="trace-open-verification">
        Verification
      </button>
    </div>
  );
}

function SegmentView({
  segment,
  onOpenChanges,
  onOpenVerification
}: {
  segment: Segment;
  onOpenChanges: () => void;
  onOpenVerification: () => void;
}) {
  switch (segment.kind) {
    case "harness":
      return (
        <div className="harness-turn" data-testid="msg-agent">
          <span className="harness-identity">
            <HarnessMark />
            <span className="harness-name">{HARNESS_NAME}</span>
          </span>
          <div className="harness-body">
            {segment.texts.map((paragraph, index) => (
              <p key={index} className="prose">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      );
    case "checkpoint":
      return <CheckpointRow segment={segment} onOpenChanges={onOpenChanges} />;
    case "checks":
      return <ChecksRow segment={segment} onOpenVerification={onOpenVerification} />;
    case "note":
      return (
        <div className={`trace-note tone-${segment.tone}`} data-testid="trace-note">
          {segment.login && <HumanMark login={segment.login} />}
          <span>{segment.text}</span>
        </div>
      );
    case "outcome":
      return (
        <div className={`trace-outcome tone-${segment.tone}`} data-testid="trace-outcome">
          {segment.text}
        </div>
      );
  }
}

/**
 * What the turn cost, stated beside the model that ran it — apparatus, at the
 * meta step, never a tile and never a chart (DESIGN.md prohibited pattern 16).
 *
 * A figure the harness did not report is left out rather than shown as zero:
 * every number here is the harness's own claim, and inventing a zero would be
 * Novus asserting something nobody told it.
 */
function usageLine(usage: UsageTotals | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    parts.push(`${compactCount(usage.inputTokens)} in`, `${compactCount(usage.outputTokens)} out`);
  }
  if (usage.costUsd !== null) parts.push(usd(usage.costUsd));
  if (usage.durationMs !== null) parts.push(elapsed(usage.durationMs));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Line treatment carries the direction's lifecycle: live threads keep the
 *  accent line, settled or waiting ones fall back to the neutral edge. */
function traceStateClass(direction: Direction | null): string {
  if (!direction) return "trace";
  switch (direction.state) {
    case "submitted":
    case "queued":
      return "trace trace-waiting";
    case "rejected":
    case "superseded":
    case "cancelled":
      return "trace trace-settled";
    case "applied":
      return "trace";
  }
}

export function TraceView({
  block,
  controllerUserId,
  controllerLogin,
  viewerIsController,
  onOpenChanges,
  onOpenVerification,
  onOpenWorker,
  actions,
  approvals,
  queuePosition
}: {
  block: TraceBlock;
  controllerUserId: string | null;
  controllerLogin: string | null;
  viewerIsController: boolean;
  onOpenChanges: () => void;
  onOpenVerification: () => void;
  /** Opens one worker's own view on the canvas (D-107). */
  onOpenWorker?: (workerId: string) => void;
  /** Apply / Reject / Cancel for a direction still awaiting judgment. */
  actions?: React.ReactNode;
  /** Permission questions this execution is blocked on, if any. */
  approvals?: React.ReactNode;
  /** "2 of 3" while several directions wait in this lane's queue; null when
   *  the waiting row would be numbering a queue of one (DESIGN.md *Direction
   *  queued*). */
  queuePosition?: string | null;
}) {
  const direction = block.direction;
  const waiting = direction?.state === "submitted" || direction?.state === "queued";
  const ownedByController =
    direction !== null && controllerUserId !== null && direction.authorUserId === controllerUserId;
  const settled =
    direction?.state === "rejected" ||
    direction?.state === "superseded" ||
    direction?.state === "cancelled";
  // Reading order inside a trace: what the harness said, then how it did it,
  // then what it produced, then how it ended.
  const speech = block.segments.filter(
    (segment) => segment.kind === "harness" || segment.kind === "note"
  );
  const evidence = block.segments.filter(
    (segment) => segment.kind === "checkpoint" || segment.kind === "checks"
  );
  const outcomes = block.segments.filter((segment) => segment.kind === "outcome");

  return (
    <article className={traceStateClass(direction)} data-testid="direction-trace" data-direction-state={direction?.state ?? "none"}>
      {block.body !== null && (
        <header className="trace-head">
          {block.authorLogin && <HumanMark login={block.authorLogin} />}
          <span className="trace-author">{block.authorLogin ?? "Unattributed"}</span>
          {block.authorUserId && block.authorUserId === controllerUserId && (
            <span className="trace-controller">holds the baton</span>
          )}
          {block.at && <span className="trace-time">{clockTime(block.at)}</span>}
        </header>
      )}

      {block.body !== null && (
        <p className="trace-body prose" data-testid="msg-user">
          {block.body}
        </p>
      )}

      {/* The controller's own direction applies at the next receptive point
          without further action (PRODUCT.md#direction), so it is never
          presented to them as something to approve. */}
      {waiting && ownedByController && (
        <div className="trace-waiting-row" data-testid="direction-queued">
          <span>Queued — applies at the next safe point</span>
          {queuePosition && (
            <span className="queue-position" data-testid="queue-position">
              {queuePosition} in the queue
            </span>
          )}
          {actions}
        </div>
      )}
      {waiting && !ownedByController && (
        <div className="trace-waiting-row" data-testid="direction-waiting">
          <span>
            {viewerIsController
              ? "Waiting for you — apply or reject it here"
              : controllerLogin
                ? `Waiting for ${controllerLogin} to apply this direction`
                : "Waiting — no one holds the baton"}
          </span>
          {queuePosition && (
            <span className="queue-position" data-testid="queue-position">
              {queuePosition} in the queue
            </span>
          )}
          {actions}
        </div>
      )}
      {settled && direction && (
        <div className="trace-waiting-row" data-testid="direction-settled">
          <span>
            {direction.state === "rejected" &&
              (block.resolvedBy ? `Rejected by ${block.resolvedBy}` : "Rejected")}
            {direction.state === "superseded" && "Superseded by a later direction"}
            {direction.state === "cancelled" &&
              (block.resolvedBy ? `Cancelled by ${block.resolvedBy}` : "Cancelled by its author")}
            {direction.resolutionReason ? ` — ${direction.resolutionReason}` : ""}
          </span>
        </div>
      )}

      {(block.machinery || block.usage) && (
        <div className="trace-machinery" data-testid="trace-machinery">
          {[block.machinery, usageLine(block.usage)].filter(Boolean).join(" · ")}
        </div>
      )}

      {speech.map((segment) => (
        <SegmentView
          key={segment.key}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

      {/* Workers on the trace itself, one quiet line each — the CLI's shape,
          graphically (D-108). The disclosure below stays the harness's own
          steps. */}
      {block.workers.length > 0 && (
        <WorkerRows workers={block.workers} settled={block.settled} onOpenWorker={onOpenWorker} />
      )}

      {block.toolSteps.length > 0 && <TechnicalActivity steps={block.toolSteps} />}

      {evidence.map((segment) => (
        <SegmentView
          key={segment.key}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

      {outcomes.map((segment) => (
        <SegmentView
          key={segment.key}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

      {/* Last, because it is where the harness stopped: everything above is
          what it did, and this is what it is waiting on (D-062). */}
      {approvals}
    </article>
  );
}

/**
 * A permission the harness is asking for, in the thread where it asked.
 *
 * Not a dialog and not a notification centre: the question belongs beside the
 * work that raised it, because "may I run this" is only answerable by someone
 * reading what came before it (DESIGN.md#state-presentation).
 *
 * Only the lease holder may answer, and that is the server's decision — this
 * renders what the server said about the viewer's capabilities and nothing it
 * inferred locally. Everyone else is told who can, which is the honest answer
 * to "why is this waiting" and the thing a room full of people needs to know.
 */
export function ApprovalRow({
  approval,
  capabilities,
  controllerLogin,
  busy,
  error,
  askedIn,
  onRespond,
  onRequestControl
}: {
  approval: ApprovalRequest;
  capabilities: MissionDetailResponse["capabilities"];
  controllerLogin: string | null;
  busy: boolean;
  error: string | null;
  /** The session the question came from, named only while the lane holds more
   *  than one conversation — the question blocks the lane's one workspace, so
   *  the card renders whichever session is selected, attributed (D-083). */
  askedIn?: string | null;
  onRespond: (decision: "approve" | "deny") => void;
  onRequestControl: (() => void) | null;
}) {
  const mayAnswer = capabilities.includes("approval.respond");
  return (
    <div className="approval" data-testid="approval" data-approval-id={approval.approvalId}>
      <div className="approval-ask">
        <span className="approval-tool mono" data-testid="approval-tool">
          {approval.displayName}
        </span>
        <span className="approval-summary" data-testid="approval-summary">
          {approval.summary}
        </span>
        {askedIn && (
          <span className="approval-asked" data-testid="approval-asked-in">
            asked in &quot;{askedIn}&quot;
          </span>
        )}
      </div>
      {mayAnswer ? (
        <div className="approval-actions">
          <button
            className="btn btn-primary"
            onClick={() => onRespond("approve")}
            disabled={busy}
            data-testid="approval-approve"
          >
            Approve once
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => onRespond("deny")}
            disabled={busy}
            data-testid="approval-deny"
          >
            Deny
          </button>
          {/* Said plainly, because "Approve" on its own reads like a policy. */}
          <span className="approval-note">This one act only — nothing is remembered.</span>
        </div>
      ) : (
        <div className="approval-actions" data-testid="approval-denied-to-viewer">
          <span className="approval-note">
            {controllerLogin
              ? `${controllerLogin} holds the baton and can answer this.`
              : "Nobody holds the baton, so nobody can answer this yet."}
          </span>
          {onRequestControl && (
            <button className="btn btn-text" onClick={onRequestControl} data-testid="approval-request-control">
              Request control
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert" data-testid="approval-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function ControlEventRow({ block }: { block: ControlBlock }) {
  return (
    <div className="control-event" data-testid="control-event">
      {block.login && <HumanMark login={block.login} />}
      <span>{block.text}</span>
      <span className="trace-time">{clockTime(block.at)}</span>
    </div>
  );
}
