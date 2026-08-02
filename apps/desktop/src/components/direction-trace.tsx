import type {
  Checkpoint,
  Direction,
  MissionDetailResponse,
  MissionEvent,
  VerificationCheck
} from "@novus/contracts";
import { clockTime, plural, shortSha } from "../format";
import { Baton, HarnessMark, HumanMark } from "./identity";

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

/** Events that carry no meaning of their own once the trace exists. */
const ABSORBED_KINDS = new Set([
  "direction.submitted",
  "direction.queued",
  "direction.applied",
  "execution.starting"
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
  segments: Segment[];
  /** Who rejected, superseded, or cancelled it, when someone did. */
  resolvedBy: string | null;
  /** All of this direction's technical activity, in ONE disclosure — not one
   *  per gap between harness messages. */
  toolSteps: ToolStep[];
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
      segments: [],
      resolvedBy: null,
      toolSteps: []
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
    if (event.kind.startsWith("control.") || event.kind.startsWith("handoff.")) {
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
        if (body) push(block, { kind: "harness", key: event.eventId, texts: [body] });
        break;
      }
      case "harness.tool":
        block.toolSteps.push({
          label: text(event.payload.tool) ?? "tool",
          detail: text(event.payload.detail)
        });
        break;
      case "execution.started":
      case "execution.running": {
        const model = text(event.payload.model);
        const effort = text(event.payload.effort);
        block.machinery = model ? (effort ? `${model} · effort ${effort}` : model) : block.machinery;
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
        push(block, { kind: "outcome", key: event.eventId, text: "Turn completed", tone: "neutral" });
        break;
      case "execution.stopped":
        push(block, {
          kind: "outcome",
          key: event.eventId,
          text: `Stopped${event.actor.login ? ` by ${event.actor.login}` : ""}`,
          tone: "warn"
        });
        break;
      case "execution.failed":
        push(block, {
          kind: "outcome",
          key: event.eventId,
          text: `Failed — ${text(event.payload.reason) ?? text(event.payload.error) ?? "no reason reported"}`,
          tone: "danger"
        });
        break;
      case "execution.interrupted":
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
          text: `${event.actor.login ?? "The controller"} applied this direction`,
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
          <li key={index} data-testid="tool-line">
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
  const counts = checkpoint
    ? `${plural(checkpoint.filesChanged, "file")} changed · +${checkpoint.additions} −${checkpoint.deletions}`
    : "checkpoint recorded";
  return (
    <div className="milestone" data-testid="checkpoint-line">
      <span className="milestone-label">Checkpoint</span>
      <span className="milestone-body">
        {counts}
        {segment.sha && <span className="mono milestone-sha"> {shortSha(segment.sha)}</span>}
        {checkpoint?.withheldSecrets ? ` · ${plural(checkpoint.withheldSecrets, "secret")} withheld` : ""}
        {checkpoint?.uncommitted ? " · uncommitted" : ""}
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
          <span className="status-dot neutral" />
          {segment.text}
        </div>
      );
  }
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
  actions
}: {
  block: TraceBlock;
  controllerUserId: string | null;
  controllerLogin: string | null;
  viewerIsController: boolean;
  onOpenChanges: () => void;
  onOpenVerification: () => void;
  /** Apply / Reject / Cancel for a direction still awaiting judgment. */
  actions?: React.ReactNode;
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
            <Baton holderUserId={block.authorUserId} />
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
          <span className="status-dot warn" />
          <span>Queued — applies at the next safe point</span>
          {actions}
        </div>
      )}
      {waiting && !ownedByController && (
        <div className="trace-waiting-row" data-testid="direction-waiting">
          <span className="status-dot warn" />
          <span>
            {viewerIsController
              ? "Waiting for you — apply or reject it here"
              : controllerLogin
                ? `Waiting for ${controllerLogin} to apply this direction`
                : "Waiting — no one holds the baton"}
          </span>
          {actions}
        </div>
      )}
      {settled && direction && (
        <div className="trace-waiting-row" data-testid="direction-settled">
          <span className="status-dot neutral" />
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

      {block.machinery && <div className="trace-machinery">{block.machinery}</div>}

      {speech.map((segment) => (
        <SegmentView
          key={segment.key}
          segment={segment}
          onOpenChanges={onOpenChanges}
          onOpenVerification={onOpenVerification}
        />
      ))}

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
    </article>
  );
}

export function ControlEventRow({ block }: { block: ControlBlock }) {
  return (
    <div className="control-event" data-testid="control-event">
      {block.login && <HumanMark login={block.login} />}
      {block.baton && <Baton holderUserId={block.key} />}
      <span>{block.text}</span>
      <span className="trace-time">{clockTime(block.at)}</span>
    </div>
  );
}
