import { PERMISSION_PROFILES } from "@novus/contracts";
import type {
  Checkpoint,
  Direction,
  MissionDetailResponse,
  MissionEvent,
  VerificationCheck
} from "@novus/contracts";
import { shortSha } from "../format";

/**
 * The feed projection for the direction thread (DESIGN.md signature element
 * 2), beside derive.ts and like it: pure functions over
 * MissionDetailResponse, no JSX, testable without rendering anything. One coherent trace per
 * direction: author → direction → the activity it produced, connected by a
 * left-edge --accent line. Lifecycle renders as states of that one thread —
 * position and line treatment — never as badges.
 *
 * Everything the feed shows is grouped: consecutive harness speech sits under
 * one harness identity, tool calls collapse into one disclosure, and technical
 * setup collapses into a single subordinate row. No event is ever rendered as
 * a lone centred fragment.
 */

export const HARNESS_NAME = "Claude Code";

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
  // The machine publishing what the project declares — commands, skills,
  // servers (D-043, D-118, D-119): the inspector's Overview is where that
  // is read. Unhandled, it fell to "unknown kind is technical activity" and,
  // arriving just after a direction, led the turn's stream as a stray run
  // called "declared" (D-203). It is the runner's bookkeeping, not the turn's.
  "workspace.declared",
  "workspace.pushed",
  "workspace.released",
  "process.started",
  "process.exited"
]);

type Tone = "neutral" | "warn" | "danger" | "ok";

export type Segment =
  | { kind: "harness"; key: string; texts: string[] }
  /** A run of tool activity, where it happened (D-203): the steps between
   *  one thing the harness said and the next, in stream order. Consecutive
   *  steps join one run; speech or a milestone ends it. */
  | { kind: "activity"; key: string; steps: ToolStep[] }
  /** The workers spawned at this point of the stream, by id — resolved
   *  against the block's `workers`, which keeps every worker's live state. */
  | { kind: "workers"; key: string; ids: string[] }
  | { kind: "checkpoint"; key: string; checkpoint: Checkpoint | null; sha: string | null }
  | { kind: "checks"; key: string; checks: VerificationCheck[] }
  | { kind: "note"; key: string; text: string; login: string | null; tone: Tone }
  | { kind: "outcome"; key: string; text: string; tone: Tone };

export interface ToolStep {
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
  ended: {
    failed: boolean;
    report: string | null;
    at: string | null;
    /** What the CLI stated the worker spent (D-202), or null: a figure shown
     *  only because the vendor reported it, never one Novus computed. */
    usage: { totalTokens: number | null; toolUses: number | null; durationMs: number | null } | null;
  } | null;
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
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number | null;
}

export interface TraceBlock {
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
  /** Every step of this direction's technical activity, flat, for counting
   *  and for tests. Its *place* in the turn is the activity segments (D-203,
   *  reversing D-108's one end-of-turn disclosure): a step renders where it
   *  happened, between the words that referred to it. */
  toolSteps: ToolStep[];
  /** The harness's own workers this turn spawned, joined by the ids the
   *  stream stated (D-107). Inside the disclosure, never beside the speech. */
  workers: WorkerView[];
  /** Whether a terminal execution event has arrived, so a worker without a
   *  stated end stops reading as `working` once the turn itself is over. */
  settled: boolean;
  /** True when the direction invoked one of the harness's own built-in
   *  commands (D-216): what comes back is a printout — the CLI's own text,
   *  newlines and underscores meant literally — not prose, so it is shown
   *  preformatted rather than read as markdown. A project command is a
   *  prompt template and its answer is prose; only the built-ins print. */
  printout: boolean;
}

export interface ControlBlock {
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

/** The names out of a carried list (D-193): each entry is `{name, digest}`,
 *  and the trace says the names while the record keeps the digests. */
function namesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === "object" ? (entry as { name?: unknown }).name : entry))
    .filter((name): name is string => typeof name === "string");
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

  // The built-ins this machine announced (D-188): a direction that is one of
  // them, by name, gets its answer back as a printout (D-216).
  const builtins = new Set(detail.workspace?.globalSlashCommands ?? []);
  const invokesBuiltin = (body: string | null): boolean => {
    if (body === null || !body.startsWith("/")) return false;
    const name = body.slice(1).split(/\s/, 1)[0] ?? "";
    return builtins.has(name);
  };

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
      settled: false,
      printout: invokesBuiltin(direction?.body ?? null)
    };
    blocks.push(block);
    if (direction) traces.set(direction.directionId, block);
    open = block;
    return block;
  };

  /**
   * Every worker spawned in this feed, by the id its own children carry.
   *
   * Kept beside the blocks rather than inside one, because a worker outlives
   * the block it was spawned in: a direction applied mid-turn opens a new
   * trace block, and the subagent running across that seam goes on reporting
   * under the same spawn id. Looked up per block, its steps and its end
   * silently became the *new* block's grouped activity — the open worker's own
   * view stopped growing while the room around it moved (D-200, owner-hit).
   */
  const workersById = new Map<string, WorkerView>();

  /**
   * One step of activity, recorded flat and placed in the stream (D-203). A
   * run of consecutive steps is one segment; the next thing the harness says
   * ends the run, so speech is never fused across the actions it narrates.
   */
  const step = (block: TraceBlock, entry: ToolStep) => {
    block.toolSteps.push(entry);
    const last = block.segments[block.segments.length - 1];
    if (last?.kind === "activity") {
      last.steps.push(entry);
      return;
    }
    block.segments.push({ kind: "activity", key: `activity-${block.key}-${block.segments.length}`, steps: [entry] });
  };

  /** A spawn, placed where it happened; consecutive spawns share one row group. */
  const spawnRow = (block: TraceBlock, workerId: string) => {
    const last = block.segments[block.segments.length - 1];
    if (last?.kind === "workers") {
      last.ids.push(workerId);
      return;
    }
    block.segments.push({ kind: "workers", key: `workers-${block.key}-${block.segments.length}`, ids: [workerId] });
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
        step(open, { label: humanizeKind(event.kind), detail: event.actor.login });
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

    if (ABSORBED_KINDS.has(event.kind)) {
      // One absorbed kind keeps a single word (D-231): a direction steered
      // into the already-running turn says so on its own row's machinery
      // line — the "resumed" pattern — because words that landed mid-turn
      // without opening a turn would otherwise look ignored.
      if (event.kind === "direction.applied" && event.payload.steered === true) {
        const steered = traces.get(text(event.payload.directionId) ?? "");
        if (steered) {
          steered.machinery = steered.machinery ? `${steered.machinery} · steered` : "steered";
        }
      }
      continue;
    }

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
          const worker = workersById.get(parent);
          if (worker) worker.steps.push({ label: "said", detail: body });
          else step(block, { label: "said", detail: body, nested: true });
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
        if ((label === "Task" || label === "Agent") && own && !parent) {
          // The spawn itself. The spawn row becomes the worker's own row in
          // the Workers rollup rather than a flat step — same disclosure,
          // same facts, grouped where its children will land (D-107). The
          // CLI has named this tool both `Task` and `Agent` across versions
          // (D-205); `harness-stream.ts` matches the same pair when it
          // records the end.
          const spawned: WorkerView = {
            id: own,
            purpose: detail,
            at: event.occurredAt,
            steps: [],
            ended: null
          };
          block.workers.push(spawned);
          workersById.set(own, spawned);
          spawnRow(block, own);
          break;
        }
        if (parent) {
          const worker = workersById.get(parent);
          if (worker) {
            worker.steps.push({ label, detail });
            break;
          }
          // A parent the log never explained: grouped activity, no identity
          // claimed (D-107).
          step(block, { label, detail, nested: true });
          break;
        }
        step(block, { label, detail });
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
        step(block, {
          label: `${event.payload.decision === "denied" ? "refused" : "allowed"} by policy · ${tool}`,
          detail: summary ? `${summary} (${profileWord})` : profileWord
        });
        break;
      }
      case "harness.worker.ended": {
        const own = text(event.payload.toolUseId);
        const worker = own ? workersById.get(own) : undefined;
        // An end whose start was never recorded proves nothing and renders
        // nothing — the parser already refuses to emit one, but an old log
        // is read with the same honesty.
        if (worker) {
          const stated = event.payload.usage as
            | { totalTokens?: unknown; toolUses?: unknown; durationMs?: unknown }
            | null
            | undefined;
          const figure = (value: unknown): number | null =>
            typeof value === "number" && Number.isFinite(value) ? value : null;
          worker.ended = {
            failed: event.payload.failed === true,
            report: text(event.payload.report),
            at: event.occurredAt,
            usage: stated
              ? {
                  totalTokens: figure(stated.totalTokens),
                  toolUses: figure(stated.toolUses),
                  durationMs: figure(stated.durationMs)
                }
              : null
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
        // The paid-for speed tier is a fact about the turn (D-230): one quiet
        // word on the machinery line, only when it is not the default.
        if (base && event.payload.speed === "fast") base = `${base} · fast`;
        if (base && profileWord) base = `${base} · ${profileWord}`;
        block.machinery = base ? (readOnly ? `${base} · read-only` : base) : block.machinery;
        // What the turn was handed rides the event and reads in Extensions
        // (D-193, amended 2026-08-29 — owner-called noise): the stream no
        // longer restates the happy path. Only what could NOT be carried
        // speaks here, each drop with its reason in the warn tone, because a
        // standing enablement that no longer names real bytes is news a
        // person acts on.
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
        // The slash commands, same grammar (D-187).
        const commandsDropped = Array.isArray(event.payload.slashCommandsDropped)
          ? event.payload.slashCommandsDropped
          : [];
        for (const drop of commandsDropped) {
          const name = text((drop as { name?: unknown }).name);
          if (!name) continue;
          push(block, {
            kind: "note",
            key: `${event.eventId}-slash-command-drop-${name}`,
            text: `Slash command not carried — "${name}": ${
              text((drop as { reason?: unknown }).reason) ?? "the reason was not stated"
            }`,
            login: null,
            tone: "warn"
          });
        }
        // The machine's own skills, same grammar (D-191) — named apart from
        // the project's, because where a skill came from is the fact a reader
        // of somebody else's turn most needs.
        const globalsDropped = Array.isArray(event.payload.globalSkillsDropped)
          ? event.payload.globalSkillsDropped
          : [];
        for (const drop of globalsDropped) {
          const name = text((drop as { name?: unknown }).name);
          if (!name) continue;
          push(block, {
            kind: "note",
            key: `${event.eventId}-global-skill-drop-${name}`,
            text: `Machine skill not carried — "${name}": ${
              text((drop as { reason?: unknown }).reason) ?? "the reason was not stated"
            }`,
            login: null,
            tone: "warn"
          });
        }
        const mcpDropped = Array.isArray(event.payload.mcpServersDropped)
          ? event.payload.mcpServersDropped
          : [];
        for (const drop of mcpDropped) {
          const name = text((drop as { name?: unknown }).name);
          if (!name) continue;
          push(block, {
            kind: "note",
            key: `${event.eventId}-mcp-drop-${name}`,
            text: `MCP server not carried — "${name}": ${
              text((drop as { reason?: unknown }).reason) ?? "the reason was not stated"
            }`,
            login: null,
            tone: "warn"
          });
        }
        // The machine's own servers (D-198), named apart: whose machine a
        // tool acts as is the fact a reader most needs.
        const machineDropped = Array.isArray(event.payload.machineMcpServersDropped)
          ? event.payload.machineMcpServersDropped
          : [];
        for (const drop of machineDropped) {
          const name = text((drop as { name?: unknown }).name);
          if (!name) continue;
          push(block, {
            kind: "note",
            key: `${event.eventId}-machine-mcp-drop-${name}`,
            text: `Machine MCP server not carried — "${name}": ${
              text((drop as { reason?: unknown }).reason) ?? "the reason was not stated"
            }`,
            login: null,
            tone: "warn"
          });
        }
        // The owner's own accounts this turn carried (D-217), named apart with
        // whose they are — an account acts as its lender, and that is the fact
        // a reader most needs.
        const connectorsCarried = namesOf(event.payload.connectors).map((name) =>
          name.replace(/^claude\.ai /, "")
        );
        if (connectorsCarried.length > 0) {
          const owner = detail.runner?.ownerLogin;
          push(block, {
            kind: "note",
            key: `${event.eventId}-connectors`,
            text: `Accounts carried: ${connectorsCarried.join(", ")}${owner ? ` — ${owner}'s` : ""}`,
            login: null,
            tone: "neutral"
          });
        }
        break;
      }
      case "harness.session": {
        // Continuity is apparatus, not speech (D-193 amended): one quiet word
        // on the machinery line instead of a sentence standing in the stream.
        if (event.payload.resumed === true) {
          block.machinery = block.machinery ? `${block.machinery} · resumed` : "resumed";
        }
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
        step(block, { label: humanizeKind(event.kind), detail: event.actor.login });
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
