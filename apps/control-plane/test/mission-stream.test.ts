import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";
import { buildServer } from "../src/server.ts";
import { createMissionBus, type MissionBus } from "../src/mission-bus.ts";
import { recordEvent } from "../src/events.ts";
import { withMission } from "../src/db.ts";
import type { FastifyInstance } from "fastify";

/**
 * The room's live connection (D-149).
 *
 * These are about the two ways a push transport lies. The first is telling a
 * watcher to re-read before the row it is about is visible — the reason the
 * notification is sent by Postgres inside the writing transaction rather than
 * by an emitter beside it, and the reason a rolled-back write must say nothing
 * at all. The second is telling the wrong person: the stream must answer a
 * non-participant exactly as the mission read does, with a 404 that does not
 * confirm the mission exists.
 */

let harness: Harness;
let kartik: SignedIn;
let maya: SignedIn;
let bus: MissionBus;
let server: FastifyInstance;
let origin: string;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");

beforeAll(async () => {
  harness = await createHarness("novus_test_mission_stream");
  kartik = await harness.signIn("kartik");
  maya = await harness.signIn("maya");
  // A real listening server, not `inject`: a hijacked streaming response is
  // exactly what light-my-request cannot model, and the streaming is the
  // feature under test.
  bus = createMissionBus(harness.config.databaseUrl);
  server = buildServer(harness.db, harness.config, undefined, bus);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.addresses()[0];
  origin = `http://127.0.0.1:${address?.port}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await bus?.stop();
  await harness?.close();
});

async function missionWithLane(): Promise<{ missionId: string; workstreamId: string }> {
  const localId = randomUUID();
  const headSha = sha(localId);
  await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(kartik),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: "Hear about work without asking",
      successCriteria: "The machine is told",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  return {
    missionId: created.json().mission.missionId as string,
    workstreamId: created.json().workstream.workstreamId as string
  };
}

async function mission(): Promise<{ missionId: string; orgId: string }> {
  const localId = randomUUID();
  const headSha = sha(localId);
  await harness.app.inject({
    method: "POST",
    url: "/repositories/local",
    headers: bearer(kartik),
    payload: { localId, name: "novus/local", defaultBranch: "main", headSha }
  });
  const created = await harness.app.inject({
    method: "POST",
    url: "/missions",
    headers: bearer(kartik),
    payload: {
      goal: "Say it the moment it happens",
      successCriteria: "The room hears without asking",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  return { missionId: created.json().mission.missionId as string, orgId: kartik.orgId };
}

/** Opens the stream and collects parsed `change` frames as they arrive. */
async function openStream(
  missionId: string,
  as: SignedIn
): Promise<{
  changes: { missionId: string; seq: number; kind: string }[];
  ready: Promise<void>;
  close: () => void;
}> {
  const controller = new AbortController();
  const changes: { missionId: string; seq: number; kind: string }[] = [];
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const response = await fetch(`${origin}/missions/${missionId}/stream`, {
    headers: { authorization: `Bearer ${as.token}` },
    signal: controller.signal
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  void (async () => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith("event: ready")) markReady();
          if (frame.startsWith("event: change")) {
            const data = frame.slice(frame.indexOf("data: ") + 6);
            changes.push(JSON.parse(data));
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The abort at the end of a test surfaces here; nothing to do.
    }
  })();
  await ready;
  return { changes, ready, close: () => controller.abort() };
}

async function eventually<T>(read: () => T, predicate: (value: T) => boolean, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Enrols this machine as the lane's runner and returns its credential. */
async function enrolRunner(room: { missionId: string; workstreamId: string }): Promise<string> {
  await harness.app.inject({
    method: "POST",
    url: `/workstreams/${room.workstreamId}/branch/report`,
    headers: bearer(kartik),
    payload: { status: "created" }
  });
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${room.workstreamId}/runner`,
    headers: bearer(kartik),
    payload: { workstreamId: room.workstreamId, label: "test-machine" }
  });
  expect(enrolled.statusCode).toBe(200);
  return enrolled.json().credential as string;
}

/** Opens the runner's command stream and counts the work signals it gets. */
async function openRunnerStream(
  credential: string
): Promise<{ signals: () => number; ready: Promise<void>; close: () => void }> {
  const controller = new AbortController();
  let count = 0;
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const response = await fetch(`${origin}/runner/stream`, {
    headers: { authorization: `Runner ${credential}` },
    signal: controller.signal
  });
  expect(response.status).toBe(200);
  void (async () => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith("event: ready")) markReady();
          if (frame.startsWith("event: work")) count += 1;
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted at the end of a test.
    }
  })();
  await ready;
  return { signals: () => count, ready, close: () => controller.abort() };
}

/**
 * The runner's own wait (D-154).
 *
 * The claim is narrow on purpose: a signal means *ask for your commands*, and
 * nothing about the durable queue changes. So these check that the signal
 * arrives when work is enqueued, that it is scoped to the lane the credential
 * names, and that no credential means no stream at all.
 */
describe("the runner command stream", () => {
  it("signals the lane when a command is enqueued for it", async () => {
    const room = await missionWithLane();
    const credential = await enrolRunner(room);
    const stream = await openRunnerStream(credential);
    try {
      const directed = await harness.app.inject({
        method: "POST",
        url: `/missions/${room.missionId}/direction`,
        headers: bearer(kartik),
        payload: { body: "Do the thing", workstreamId: room.workstreamId }
      });
      expect(directed.statusCode).toBe(200);
      const seen = await eventually(
        () => stream.signals(),
        (count) => count > 0
      );
      expect(seen).toBeGreaterThan(0);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("does not signal one lane about another lane's work", async () => {
    const mine = await missionWithLane();
    const other = await missionWithLane();
    const credential = await enrolRunner(mine);
    await enrolRunner(other);
    const stream = await openRunnerStream(credential);
    try {
      const directed = await harness.app.inject({
        method: "POST",
        url: `/missions/${other.missionId}/direction`,
        headers: bearer(kartik),
        payload: { body: "Work for somebody else", workstreamId: other.workstreamId }
      });
      expect(directed.statusCode).toBe(200);
      // Longer than delivery ever needs, then insist on silence.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(stream.signals()).toBe(0);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("is refused without a runner credential, and to a user session", async () => {
    const anonymous = await fetch(`${origin}/runner/stream`);
    expect(anonymous.status).toBe(401);
    // A user session is not a runner: the schemes are deliberately distinct.
    const asPerson = await fetch(`${origin}/runner/stream`, {
      headers: { authorization: `Bearer ${kartik.token}` }
    });
    expect(asPerson.status).toBe(401);
  }, 30_000);
});

describe("the mission stream", () => {
  it("tells an open room that the mission moved, naming the sequence", async () => {
    const { missionId, orgId } = await mission();
    const stream = await openStream(missionId, kartik);
    try {
      await withMission(harness.db, missionId, async (client) => {
        await recordEvent(client, {
          orgId,
          missionId,
          kind: "mission.note",
          actorKind: "system",
          actorId: "system",
          payload: { note: "something happened" }
        });
      });
      const changes = await eventually(
        () => stream.changes,
        (seen) => seen.some((change) => change.kind === "mission.note")
      );
      const change = changes.find((candidate) => candidate.kind === "mission.note");
      expect(change).toBeDefined();
      expect(change?.missionId).toBe(missionId);
      expect(change?.seq).toBeGreaterThan(0);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("says nothing about a write that rolled back", async () => {
    const { missionId, orgId } = await mission();
    const stream = await openStream(missionId, kartik);
    try {
      await expect(
        withMission(harness.db, missionId, async (client) => {
          await recordEvent(client, {
            orgId,
            missionId,
            kind: "mission.rolled-back",
            actorKind: "system",
            actorId: "system",
            payload: {}
          });
          throw new Error("deliberate rollback");
        })
      ).rejects.toThrow("deliberate rollback");
      // A notification that outran its transaction is the failure this
      // guards: give it longer than delivery needs, then insist on silence.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(stream.changes.some((change) => change.kind === "mission.rolled-back")).toBe(false);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("is refused to someone who is not in the mission, without confirming it exists", async () => {
    const { missionId } = await mission();
    const response = await fetch(`${origin}/missions/${missionId}/stream`, {
      headers: { authorization: `Bearer ${maya.token}` }
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  }, 30_000);

  it("is refused without a session", async () => {
    const { missionId } = await mission();
    const response = await fetch(`${origin}/missions/${missionId}/stream`);
    expect(response.status).toBe(401);
  }, 30_000);

  it("carries one mission's events to that mission's watcher only", async () => {
    const first = await mission();
    const second = await mission();
    const stream = await openStream(first.missionId, kartik);
    try {
      await withMission(harness.db, second.missionId, async (client) => {
        await recordEvent(client, {
          orgId: second.orgId,
          missionId: second.missionId,
          kind: "mission.elsewhere",
          actorKind: "system",
          actorId: "system",
          payload: {}
        });
      });
      await withMission(harness.db, first.missionId, async (client) => {
        await recordEvent(client, {
          orgId: first.orgId,
          missionId: first.missionId,
          kind: "mission.here",
          actorKind: "system",
          actorId: "system",
          payload: {}
        });
      });
      await eventually(
        () => stream.changes,
        (seen) => seen.some((change) => change.kind === "mission.here")
      );
      expect(stream.changes.some((change) => change.kind === "mission.elsewhere")).toBe(false);
      expect(stream.changes.every((change) => change.missionId === first.missionId)).toBe(true);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("keeps the watcher present while it is open, without a read", async () => {
    const { missionId } = await mission();
    // A participant who has never read the mission is offline by definition
    // (D-091). The connection alone must be enough to change that, or a room
    // that re-reads on change would report its own watcher away between
    // quiet moments.
    await harness.db.query(
      "update participants set last_seen_at = null where mission_id = $1 and user_id = $2",
      [missionId, kartik.userId]
    );
    const stream = await openStream(missionId, kartik);
    try {
      const settled = await (async () => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const row = await harness.db.query(
            "select last_seen_at from participants where mission_id = $1 and user_id = $2",
            [missionId, kartik.userId]
          );
          const value = (row.rows[0]?.last_seen_at as Date | null) ?? null;
          if (value !== null) return value;
          if (Date.now() > deadline) return null;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
      expect(settled).not.toBeNull();
    } finally {
      stream.close();
    }
  }, 30_000);

  it("drops its subscription when the watcher goes away", async () => {
    const { missionId } = await mission();
    const before = bus.size;
    const stream = await openStream(missionId, kartik);
    expect(bus.size).toBe(before + 1);
    stream.close();
    const settled = await eventually(
      () => bus.size,
      (size) => size === before
    );
    expect(settled).toBe(before);
  }, 30_000);
});

/** Opens the all-missions stream (D-179) and collects its change frames. */
async function openAllStream(as: SignedIn): Promise<{
  changes: { missionId: string; seq: number; kind: string }[];
  close: () => void;
}> {
  const controller = new AbortController();
  const changes: { missionId: string; seq: number; kind: string }[] = [];
  let markReady = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const response = await fetch(`${origin}/streams/missions`, {
    headers: { authorization: `Bearer ${as.token}` },
    signal: controller.signal
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  void (async () => {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith("event: ready")) markReady();
          if (frame.startsWith("event: change")) {
            changes.push(JSON.parse(frame.slice(frame.indexOf("data: ") + 6)));
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted at the end of a test.
    }
  })();
  await ready;
  return { changes, close: () => controller.abort() };
}

/**
 * The all-missions stream (D-179).
 *
 * The rail's live signal. Two ways this transport could lie beyond the
 * per-mission stream's: carrying more than one mission is only right if it
 * carries ALL the watcher's missions on the one connection — half a rail
 * updating live and half on the sweep would be worse than either — and
 * carrying anything about a mission the watcher does not participate in
 * would leak that it exists, because here the address IS the payload.
 */
describe("the all-missions stream", () => {
  it("carries every participant mission's changes on one connection", async () => {
    const first = await mission();
    const second = await mission();
    const stream = await openAllStream(kartik);
    try {
      for (const { missionId, orgId } of [first, second]) {
        await withMission(harness.db, missionId, async (client) => {
          await recordEvent(client, {
            orgId,
            missionId,
            kind: "mission.note",
            actorKind: "system",
            actorId: "system",
            payload: { note: "moved" }
          });
        });
      }
      const changes = await eventually(
        () => stream.changes,
        (seen) =>
          seen.some((change) => change.missionId === first.missionId) &&
          seen.some((change) => change.missionId === second.missionId)
      );
      expect(changes.some((change) => change.missionId === first.missionId)).toBe(true);
      expect(changes.some((change) => change.missionId === second.missionId)).toBe(true);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("streams a mission created after the connection opened, from its first event", async () => {
    const stream = await openAllStream(kartik);
    try {
      const late = await mission();
      await withMission(harness.db, late.missionId, async (client) => {
        await recordEvent(client, {
          orgId: late.orgId,
          missionId: late.missionId,
          kind: "mission.note",
          actorKind: "system",
          actorId: "system",
          payload: { note: "born mid-stream" }
        });
      });
      const changes = await eventually(
        () => stream.changes,
        (seen) => seen.some((change) => change.missionId === late.missionId)
      );
      expect(changes.some((change) => change.missionId === late.missionId)).toBe(true);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("says nothing about a mission the watcher does not participate in", async () => {
    // Maya's stream, kartik's mission: same organization, no participation —
    // an address for it would leak that it exists.
    const theirs = await mission();
    const stream = await openAllStream(maya);
    try {
      await withMission(harness.db, theirs.missionId, async (client) => {
        await recordEvent(client, {
          orgId: theirs.orgId,
          missionId: theirs.missionId,
          kind: "mission.note",
          actorKind: "system",
          actorId: "system",
          payload: { note: "not yours to hear" }
        });
      });
      // Give the notification time to have arrived if it was going to.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(stream.changes.some((change) => change.missionId === theirs.missionId)).toBe(false);
    } finally {
      stream.close();
    }
  }, 30_000);

  it("is refused without a session", async () => {
    const response = await fetch(`${origin}/streams/missions`);
    expect(response.status).toBe(401);
  });

  it("drops every subscription when the watcher goes away", async () => {
    await mission();
    const before = bus.size;
    const stream = await openAllStream(kartik);
    expect(bus.size).toBeGreaterThan(before);
    stream.close();
    const settled = await eventually(
      () => bus.size,
      (size) => size === before
    );
    expect(settled).toBe(before);
  }, 30_000);
});
