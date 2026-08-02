import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnerEvent, SequencedRunnerEvent } from "@novus/contracts";

/**
 * The runner's event outbox (ARCHITECTURE.md#runner-plane). A runner buffers
 * locally while the control plane is unreachable, delivers in order, and on
 * overflow emits a **gap marker** naming the range it dropped, so the receipt
 * states the gap instead of quietly missing it.
 *
 * The server already de-duplicates on (execution, origin sequence); what this
 * module owns is ordering, retry, the bound, and the honesty of the gap. Pure
 * Node — no Electron — so the failure paths are testable without an app.
 */

/** The control plane accepts at most this many events per report. */
const MAX_BATCH = 50;

export interface OutboxOptions {
  /** Where the buffer survives a relaunch. */
  filePath: string;
  deliver: (executionId: string, batch: SequencedRunnerEvent[]) => Promise<void>;
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
  executionId: string;
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
  private readonly deliver: (executionId: string, batch: SequencedRunnerEvent[]) => Promise<void>;
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

  /** The next sequence this execution will be given; 1 for a fresh one. */
  nextSequence(executionId: string): number {
    return (this.sequences.get(executionId) ?? 0) + 1;
  }

  /** Records one observation. The sequence is per execution and monotonic, so
   *  a replayed delivery lands exactly once on the server. */
  append(executionId: string, event: RunnerEvent): SequencedRunnerEvent {
    const originSeq = this.nextSequence(executionId);
    this.sequences.set(executionId, originSeq);
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

    const ranges = new Map<string, { from: number; to: number }>();
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
      for (let attempt = 0; attempt < this.maxAttempts && !delivered; attempt += 1) {
        try {
          await this.deliver(batch.executionId, batch.items.map(({ originSeq, event }) => ({ originSeq, event })));
          delivered = true;
        } catch (error) {
          const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
          this.onProblem(
            `Reporting failed (attempt ${attempt + 1}): ${error instanceof Error ? error.message : "unknown"}`
          );
          await this.sleep(delay);
        }
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

  /** One execution's next run of events, bounded by the report ceiling. */
  private takeBatch(): { executionId: string; items: QueuedEvent[] } | null {
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
      // record is the durable one and this file is only the tail.
      this.queue = [];
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
