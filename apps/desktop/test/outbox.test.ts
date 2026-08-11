import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent, SequencedRunnerEvent } from "@novus/contracts";
import { EventOutbox } from "../electron/outbox";

/**
 * The outbox is what stands between a working agent and a control plane that
 * is briefly unreachable. What matters is that events arrive in order, arrive
 * once, survive a relaunch, and that a loss is stated rather than hidden.
 */

let root: string;

const text = (value: string): RunnerEvent => ({ kind: "harness.text", payload: { text: value } });

interface Delivery {
  executionId: string | null;
  batch: SequencedRunnerEvent[];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "novus-outbox-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ordering and sequencing", () => {
  it("numbers each execution from one and delivers in order", async () => {
    const delivered: Delivery[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      deliver: async (executionId, batch) => {
        delivered.push({ executionId, batch });
      }
    });

    outbox.append("exe_a", text("one"));
    outbox.append("exe_a", text("two"));
    outbox.append("exe_b", text("other lane"));
    outbox.append("exe_a", text("three"));
    await outbox.flush();

    expect(delivered.map((delivery) => delivery.executionId)).toEqual(["exe_a", "exe_b", "exe_a"]);
    expect(delivered[0]?.batch.map((item) => item.originSeq)).toEqual([1, 2]);
    expect(delivered[1]?.batch.map((item) => item.originSeq)).toEqual([1]);
    expect(delivered[2]?.batch.map((item) => item.originSeq)).toEqual([3]);
    expect(outbox.pending).toBe(0);
  });

  it("splits a long run into batches the control plane will accept", async () => {
    const sizes: number[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      deliver: async (_executionId, batch) => {
        sizes.push(batch.length);
      }
    });
    for (let index = 0; index < 120; index += 1) outbox.append("exe_a", text(`line ${index}`));
    await outbox.flush();
    expect(sizes).toEqual([50, 50, 20]);
  });
});

describe("retry and parking", () => {
  it("backs off and eventually delivers the same batch once", async () => {
    const waits: number[] = [];
    let attempts = 0;
    const delivered: SequencedRunnerEvent[][] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      baseDelayMs: 250,
      maxDelayMs: 8000,
      sleep: async (ms) => {
        waits.push(ms);
      },
      deliver: async (_executionId, batch) => {
        attempts += 1;
        if (attempts <= 3) throw new Error("control plane unreachable");
        delivered.push(batch);
      }
    });

    outbox.append("exe_a", text("survives a partition"));
    await outbox.flush();

    expect(waits).toEqual([250, 500, 1000]);
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.map((item) => item.originSeq)).toEqual([1]);
    expect(outbox.pending).toBe(0);
  });

  it("caps the delay rather than backing off forever", async () => {
    const waits: number[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      maxAttempts: 8,
      sleep: async (ms) => {
        waits.push(ms);
      },
      deliver: async () => {
        throw new Error("still down");
      }
    });
    outbox.append("exe_a", text("held"));
    await outbox.flush();
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("parks with the events kept, instead of spinning, and resumes on the next flush", async () => {
    const problems: string[] = [];
    let reachable = false;
    const delivered: SequencedRunnerEvent[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      maxAttempts: 2,
      sleep: async () => undefined,
      onProblem: (message) => problems.push(message),
      deliver: async (_executionId, batch) => {
        if (!reachable) throw new Error("offline");
        delivered.push(...batch);
      }
    });

    outbox.append("exe_a", text("first"));
    outbox.append("exe_a", text("second"));
    await outbox.flush();
    expect(outbox.pending).toBe(2);
    expect(problems.some((message) => message.includes("Parked"))).toBe(true);

    reachable = true;
    await outbox.flush();
    expect(delivered.map((item) => item.originSeq)).toEqual([1, 2]);
    expect(outbox.pending).toBe(0);
  });

  it("replaces a permanently refused batch with a gap marker, never silence (D-110)", async () => {
    const problems: string[] = [];
    const delivered: Delivery[] = [];
    let refuseData = true;
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      maxAttempts: 2,
      sleep: async () => undefined,
      onProblem: (message) => problems.push(message),
      deliver: async (executionId, batch) => {
        // The server refuses the data batch outright; the marker that
        // replaces it is accepted, so the record states the loss.
        if (refuseData && batch.some((item) => item.event.kind !== "runner.gap")) return "refused";
        delivered.push({ executionId, batch });
      }
    });

    outbox.append("exe_a", text("first"));
    outbox.append("exe_a", text("second"));
    await outbox.flush();
    refuseData = false;

    expect(delivered).toHaveLength(1);
    const marker = delivered[0].batch[0];
    expect(marker.event.kind).toBe("runner.gap");
    expect(marker.event.payload).toEqual({ droppedFrom: 1, droppedTo: 2 });
    expect(outbox.pending).toBe(0);
    expect(problems.some((message) => message.includes("refused 2 buffered events"))).toBe(true);
  });

  it("gives up on a refused gap marker instead of looping forever", async () => {
    const problems: string[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      maxAttempts: 1,
      sleep: async () => undefined,
      onProblem: (message) => problems.push(message),
      deliver: async () => "refused"
    });
    outbox.append("exe_a", text("doomed"));
    await outbox.flush();
    // The data batch became a marker; the refused marker was given up. Empty
    // queue, bounded work, and both losses said out loud.
    expect(outbox.pending).toBe(0);
    expect(problems.some((message) => message.includes("refused a gap marker"))).toBe(true);
  });
});

describe("overflow", () => {
  it("drops the oldest and states the gap it created", async () => {
    const delivered: SequencedRunnerEvent[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      maxEvents: 10,
      deliver: async (_executionId, batch) => {
        delivered.push(...batch);
      }
    });
    for (let index = 1; index <= 20; index += 1) outbox.append("exe_a", text(`line ${index}`));
    expect(outbox.pending).toBeLessThanOrEqual(10);
    await outbox.flush();

    const first = delivered[0];
    expect(first?.event.kind).toBe("runner.gap");
    if (first?.event.kind !== "runner.gap") throw new Error("expected a gap marker");
    // The marker takes the place of the first event it replaced, and absorbs
    // an earlier marker rather than multiplying markers.
    expect(first.event.payload.droppedFrom).toBe(1);
    expect(first.originSeq).toBe(1);
    expect(first.event.payload.droppedTo).toBeGreaterThan(1);
    expect(delivered.filter((item) => item.event.kind === "runner.gap").length).toBe(1);

    const last = delivered[delivered.length - 1];
    expect(last?.originSeq).toBe(20);
    // Everything after the gap is contiguous: no silent holes.
    const tail = delivered.slice(1).map((item) => item.originSeq);
    expect(tail).toEqual([...tail].sort((left, right) => left - right));
    expect(first.event.payload.droppedTo).toBe((tail[0] ?? 0) - 1);
  });
});

describe("the workspace's own stream", () => {
  /**
   * A setup, run, or verification report belongs to the workstream and not to
   * any turn — it can happen before a turn has ever existed — so it is reported
   * with a null execution and numbered in its own namespace. The server
   * de-duplicates on whichever of the two a report belongs to, which only works
   * if the two counters never share a number by accident and a replay repeats
   * the numbers it already used.
   */
  const readiness = (): RunnerEvent => ({
    kind: "workspace.readiness",
    payload: { readiness: "ready", portRangeStart: 3100, portRangeEnd: 3109, setupError: null }
  });

  it("numbers workspace events apart from an execution's and reports them with no execution", async () => {
    const delivered: Delivery[] = [];
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      deliver: async (executionId, batch) => {
        delivered.push({ executionId, batch });
      }
    });

    outbox.append("exe_a", text("a turn spoke"));
    outbox.append(null, readiness());
    outbox.append("exe_a", text("the turn spoke again"));
    outbox.append(null, readiness());
    await outbox.flush();

    expect(delivered.map((delivery) => delivery.executionId)).toEqual(["exe_a", null, "exe_a", null]);
    // Both streams start at one, because they are indexed apart.
    expect(delivered[0]?.batch[0]?.originSeq).toBe(1);
    expect(delivered[1]?.batch[0]?.originSeq).toBe(1);
    expect(delivered[2]?.batch[0]?.originSeq).toBe(2);
    expect(delivered[3]?.batch[0]?.originSeq).toBe(2);
  });

  it("replays a workspace batch with the same numbers, so the server can drop the duplicate", async () => {
    // A control plane that de-duplicates the way the real one does.
    const accepted = new Map<string, number>();
    let landed = 0;
    let firstAttempt = true;
    const outbox = new EventOutbox({
      filePath: join(root, "outbox.json"),
      autoDeliver: false,
      sleep: async () => undefined,
      deliver: async (executionId, batch) => {
        const stream = executionId ?? "wst_scoped";
        for (const item of batch) {
          const key = `${stream}:${item.originSeq}`;
          if (accepted.has(key)) continue; // the duplicate the index exists for
          accepted.set(key, item.originSeq);
          landed += 1;
        }
        if (firstAttempt) {
          // Delivered, then the acknowledgement was lost: the runner retries the
          // identical batch.
          firstAttempt = false;
          throw new Error("the acknowledgement never arrived");
        }
      }
    });

    outbox.append(null, readiness());
    outbox.append(null, readiness());
    await outbox.flush();

    expect(landed).toBe(2);
    expect([...accepted.keys()]).toEqual(["wst_scoped:1", "wst_scoped:2"]);
  });

  it("keeps the workspace sequence across a relaunch", () => {
    const filePath = join(root, "outbox.json");
    const first = new EventOutbox({
      filePath,
      autoDeliver: false,
      deliver: async () => {
        throw new Error("never called");
      }
    });
    first.append(null, readiness());
    first.append("exe_a", text("a turn"));

    const relaunched = new EventOutbox({
      filePath,
      autoDeliver: false,
      deliver: async () => undefined
    });
    expect(relaunched.nextSequence(null)).toBe(2);
    expect(relaunched.nextSequence("exe_a")).toBe(2);
  });
});

describe("durability", () => {
  it("resumes an undelivered buffer after a relaunch, keeping its sequences", async () => {
    const filePath = join(root, "outbox.json");
    const first = new EventOutbox({
      filePath,
      autoDeliver: false,
      deliver: async () => {
        throw new Error("never called");
      }
    });
    first.append("exe_a", text("before the crash"));
    first.append("exe_a", text("also before"));
    expect(first.pending).toBe(2);

    const delivered: SequencedRunnerEvent[] = [];
    const relaunched = new EventOutbox({
      filePath,
      autoDeliver: false,
      deliver: async (_executionId, batch) => {
        delivered.push(...batch);
      }
    });
    expect(relaunched.nextSequence("exe_a")).toBe(3);
    await relaunched.flush();
    expect(delivered.map((item) => item.originSeq)).toEqual([1, 2]);
  });
});
