import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnerEvent, SequencedRunnerEvent } from "@novus/contracts";

/**
 * The runner's event outbox (ARCHITECTURE.md#runner-plane). A runner buffers
 * locally while the control plane is unreachable, delivers in order, and on
 * overflow emits a **gap marker** naming the range it dropped, so the receipt
 * states the gap instead of quietly missing it.
 *
 * The server de-duplicates on (whatever the report belongs to, origin
 * sequence); what this module owns is ordering, retry, the bound, and the
 * honesty of the gap. Pure Node — no Electron — so the failure paths are
 * testable without an app.
 *
 * Two sequence namespaces, because there are two things a report can belong to.
 * A turn's events belong to their execution and are numbered per execution. A
 * workspace's events — setup, a run command, a check somebody asked for —
 * belong to no turn at all and can happen before a turn has ever existed, so
 * they are numbered per workstream and reported with a null execution. Sharing
 * one counter would either collide with an unrelated report or fail to
 * de-duplicate a replay, which is the whole reason the server indexes them
 * apart.
 */

/** The control plane accepts at most this many events per report. */
const MAX_BATCH = 50;

/** The sequence namespace for events that belong to the workstream rather than
 *  to any execution. Every execution id begins with `exe_`, so this can never
 *  collide with one. */
const WORKSTREAM_SEQUENCE = "workstream";

export interface OutboxOptions {
  /** Where the buffer survives a relaunch. */
  filePath: string;
  /** Resolving with `"refused"` means the server rejected the batch and will
   *  never change its mind — the outbox records a gap where it stood instead
   *  of retrying forever or (worse) dropping it silently. Throwing means a
   *  transport problem, which retries. */
  deliver: (executionId: string | null, batch: SequencedRunnerEvent[]) => Promise<void | "refused">;
  /** Bound on buffered events before the oldest are dropped with a marker. */
  maxEvents?: number;
  /** Retries per batch before the outbox parks rather than spinning forever. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether appending kicks delivery, or only `flush()` does. */
  autoDeliver?: boolean;
  onProblem?: (message: string) => void;
}

interface QueuedEvent {
  /** Null for a workspace-scoped report (D-041's setup, run, and check
   *  commands are not part of any turn). */
  executionId: string | null;
  originSeq: number;
  event: RunnerEvent;
}

interface PersistedOutbox {
  queue: QueuedEvent[];
  sequences: Record<string, number>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class EventOutbox {
  private queue: QueuedEvent[] = [];
  private readonly sequences = new Map<string, number>();
  private pumping: Promise<void> | null = null;
  private parked = false;

  private readonly filePath: string;
  private readonly deliver: (executionId: string | null, batch: SequencedRunnerEvent[]) => Promise<void | "refused">;
  private readonly maxEvents: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly autoDeliver: boolean;
  private readonly onProblem: (message: string) => void;

  constructor(options: OutboxOptions) {
    this.filePath = options.filePath;
    this.deliver = options.deliver;
    this.maxEvents = options.maxEvents ?? 2000;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.sleep = options.sleep ?? defaultSleep;
    this.autoDeliver = options.autoDeliver ?? true;
    this.onProblem = options.onProblem ?? (() => undefined);
    this.restore();
  }

  /** Events waiting to be delivered. */
  get pending(): number {
    return this.queue.length;
  }

  /** The next sequence this stream will be given; 1 for a fresh one. Null asks
   *  for the workstream's own stream rather than an execution's. */
  nextSequence(executionId: string | null): number {
    return (this.sequences.get(executionId ?? WORKSTREAM_SEQUENCE) ?? 0) + 1;
  }

  /** Records one observation. The sequence is monotonic within its own stream —
   *  per execution for a turn, per workstream for the workspace — so a replayed
   *  delivery lands exactly once on the server. */
  append(executionId: string | null, event: RunnerEvent): SequencedRunnerEvent {
    const originSeq = this.nextSequence(executionId);
    this.sequences.set(executionId ?? WORKSTREAM_SEQUENCE, originSeq);
    this.queue.push({ executionId, originSeq, event });
    this.trim();
    this.persist();
    if (this.autoDeliver) void this.pump();
    return { originSeq, event };
  }

  /** Delivers everything buffered, un-parking a stalled outbox first. Used at
   *  shutdown: a room must not lose the last thing that happened. */
  async flush(): Promise<void> {
    this.parked = false;
    await this.pump();
  }

  // --- Bounding ------------------------------------------------------------

  /**
   * Drops the oldest events past the bound and replaces them with a marker
   * that names the range. The marker takes the sequence of the first event it
   * replaces, so it lands where the loss happened rather than at the end. An
   * older marker caught by a second overflow is absorbed, never multiplied.
   */
  private trim(): void {
    if (this.queue.length <= this.maxEvents) return;
    // Reclaim headroom rather than one event at a time, or every subsequent
    // append would drop the marker it just wrote.
    const overflow = this.queue.length - this.maxEvents;
    const count = Math.min(this.queue.length - 1, overflow + Math.ceil(this.maxEvents / 10));
    const dropped = this.queue.splice(0, count);

    const ranges = new Map<string | null, { from: number; to: number }>();
    for (const item of dropped) {
      const payload = item.event.kind === "runner.gap" ? item.event.payload : null;
      const from = payload ? Math.min(payload.droppedFrom, item.originSeq) : item.originSeq;
      const to = payload ? Math.max(payload.droppedTo, item.originSeq) : item.originSeq;
      const range = ranges.get(item.executionId);
      if (!range) ranges.set(item.executionId, { from, to });
      else {
        range.from = Math.min(range.from, from);
        range.to = Math.max(range.to, to);
      }
    }

    const markers: QueuedEvent[] = [...ranges.entries()].map(([executionId, range]) => ({
      executionId,
      originSeq: range.from,
      event: { kind: "runner.gap", payload: { droppedFrom: range.from, droppedTo: range.to } }
    }));
    this.queue.unshift(...markers);
    this.onProblem(`Dropped ${dropped.length} buffered events; the gap is recorded.`);
  }

  // --- Delivery ------------------------------------------------------------

  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const running = this.drain().finally(() => {
      this.pumping = null;
    });
    this.pumping = running;
    return running;
  }

  private async drain(): Promise<void> {
    while (!this.parked && this.queue.length > 0) {
      const batch = this.takeBatch();
      if (!batch) return;
      let delivered = false;
      let refused = false;
      for (let attempt = 0; attempt < this.maxAttempts && !delivered && !refused; attempt += 1) {
        try {
          const answer = await this.deliver(
            batch.executionId,
            batch.items.map(({ originSeq, event }) => ({ originSeq, event }))
          );
          if (answer === "refused") refused = true;
          else delivered = true;
        } catch (error) {
          const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
          this.onProblem(
            `Reporting failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : "unknown"}`
          );
          await this.sleep(delay);
        }
      }
      if (refused) {
        // The server said no and will keep saying no. The batch cannot wedge
        // the queue and must not vanish silently: a gap marker takes its
        // place, exactly as an overflow leaves one, so the record says events
        // were lost here instead of quietly missing them. A refused *marker*
        // is the one thing given up on outright — replacing it with itself
        // would loop forever.
        const only = batch.items[0];
        if (batch.items.length === 1 && only && only.event.kind === "runner.gap") {
          this.onProblem("The control plane refused a gap marker; giving it up.");
        } else {
          const first = batch.items[0]?.originSeq ?? 1;
          const last = batch.items[batch.items.length - 1]?.originSeq ?? first;
          this.queue.unshift({
            executionId: batch.executionId,
            originSeq: first,
            event: { kind: "runner.gap", payload: { droppedFrom: first, droppedTo: last } }
          });
          this.onProblem(
            `The control plane refused ${batch.items.length} buffered events; the gap is recorded.`
          );
        }
        this.persist();
        continue;
      }
      if (!delivered) {
        // Park instead of spinning: the control plane is down, and a hot loop
        // would burn the machine while helping nobody.
        this.queue.unshift(...batch.items);
        this.parked = true;
        this.persist();
        this.onProblem("Parked the outbox; buffered events are kept until the next attempt.");
        return;
      }
      this.persist();
    }
  }

  /** One stream's next run of events, bounded by the report ceiling. */
  private takeBatch(): { executionId: string | null; items: QueuedEvent[] } | null {
    const first = this.queue[0];
    if (!first) return null;
    let count = 0;
    while (
      count < this.queue.length &&
      count < MAX_BATCH &&
      this.queue[count]?.executionId === first.executionId
    ) {
      count += 1;
    }
    return { executionId: first.executionId, items: this.queue.splice(0, count) };
  }

  // --- Durability ----------------------------------------------------------

  private restore(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedOutbox;
      if (Array.isArray(parsed.queue)) this.queue = parsed.queue;
      for (const [executionId, seq] of Object.entries(parsed.sequences ?? {})) {
        if (typeof seq === "number") this.sequences.set(executionId, seq);
      }
    } catch {
      // A corrupt buffer is not worth crashing the app over; the server's
      // record is the durable one and this file is only the tail. But the
      // loss is said out loud, because a tail that held a terminal event is a
      // room reading Running for a turn that ended.
      this.queue = [];
      this.onProblem("The persisted outbox could not be read; its buffered tail is lost.");
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const state: PersistedOutbox = {
        queue: this.queue,
        sequences: Object.fromEntries(this.sequences)
      };
      writeFileSync(this.filePath, JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      this.onProblem(`Could not persist the outbox: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}
