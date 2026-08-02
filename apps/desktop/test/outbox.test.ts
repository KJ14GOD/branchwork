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
  executionId: string;
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
