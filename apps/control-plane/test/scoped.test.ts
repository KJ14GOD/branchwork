import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { ReportableRunnerEvent } from "@novus/contracts";
import { FakeRepositoryProvider } from "../src/repo-provider.ts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Chat file scopes and parallel writers (D-097).
 *
 * The rules under test at the control plane: a scope is the baton holder's
 * grant and nobody else's; two chats whose scopes are provably disjoint run
 * write turns in the one worktree at the same time; any unscoped party —
 * target or runner — means exclusivity exactly as before scopes existed;
 * overlap defers with the overlap named; and a lane holding two writers
 * transfers the baton only when the last of them is done. The runner-side
 * halves (in-scope writes auto-allowed, out-of-scope denied, scoped
 * checkpoints, drift) are proven in the desktop suites.
 */

let harness: Harness;
let kartik: SignedIn;

const sha = (value: string) => createHash("sha1").update(value).digest("hex");
const runnerAuth = (credential: string) => ({ authorization: `Runner ${credential}` });

interface Lane {
  missionId: string;
  workstreamId: string;
  credential: string;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_scoped", new FakeRepositoryProvider());
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

async function mission(): Promise<Lane> {
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
      goal: "Own files, run together",
      successCriteria: "Disjoint chats never wait on each other",
      provider: "local",
      providerRepoId: localId,
      baseRef: "main",
      baseSha: headSha,
      creationKey: randomUUID()
    }
  });
  expect(created.statusCode).toBe(201);
  const workstreamId = created.json().workstream.workstreamId as string;
  await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/branch/report`,
    headers: bearer(kartik),
    payload: { status: "created" }
  });
  const enrolled = await harness.app.inject({
    method: "POST",
    url: `/workstreams/${workstreamId}/runner`,
    headers: bearer(kartik),
    payload: { workstreamId, label: "kartik-macbook" }
  });
  expect(enrolled.statusCode).toBe(200);
  return {
    missionId: created.json().mission.missionId as string,
    workstreamId,
    credential: enrolled.json().credential as string
  };
}

async function direct(
  lane: Lane,
  body: string,
  options: { as?: SignedIn; sessionId?: string; newSession?: boolean } = {}
) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/direction`,
    headers: bearer(options.as ?? kartik),
    payload: {
      body,
      model: "claude-fable-5",
      effort: "high",
      workstreamId: lane.workstreamId,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.newSession ? { newSession: true } : {})
    }
  });
}

async function setScope(
  lane: Lane,
  sessionId: string,
  scope: string[] | null,
  as: SignedIn = kartik
) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/sessions/${sessionId}/scope`,
    headers: bearer(as),
    payload: { scope }
  });
}

async function report(credential: string, executionId: string, events: ReportableRunnerEvent[]) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runner/events",
    headers: runnerAuth(credential),
    payload: { executionId, events }
  });
  expect(response.statusCode).toBe(200);
}

const live = (originSeq: number): ReportableRunnerEvent[] => [
  { originSeq, event: { kind: "execution.starting", payload: {} } },
  {
    originSeq: originSeq + 1,
    event: {
      kind: "execution.running",
      payload: { harness: "claude-code", model: "claude-fable-5", effort: "high" }
    }
  }
];

const boundary = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: { kind: "boundary.reached", payload: { reason: "turn complete" } }
});

const completed = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: { kind: "execution.completed", payload: {} }
});

interface ExecutionRow {
  exe_id: string;
  session_id: string;
  state: string;
  access: string;
}

async function executionsOf(lane: Lane): Promise<ExecutionRow[]> {
  const rows = await harness.db.query(
    "select exe_id, session_id, state, access from executions where wst_id = $1 order by created_at",
    [lane.workstreamId]
  );
  return rows.rows as ExecutionRow[];
}

/** A lane with two idle titled chats, A having finished one real turn. */
async function twoChats(): Promise<{ lane: Lane; chatA: string; chatB: string }> {
  const lane = await mission();
  const first = await direct(lane, "Build the server half");
  expect(first.statusCode).toBe(200);
  const chatA = first.json().direction.sessionId as string;
  const [turnA] = await executionsOf(lane);
  await report(lane.credential, turnA!.exe_id, [...live(1), completed(3)]);

  const second = await direct(lane, "Build the desktop half", { newSession: true });
  expect(second.statusCode).toBe(200);
  const chatB = second.json().direction.sessionId as string;
  const turnB = (await executionsOf(lane)).find((row) => row.session_id === chatB);
  await report(lane.credential, turnB!.exe_id, [...live(1), completed(3)]);
  return { lane, chatA, chatB };
}

describe("declaring a scope", () => {
  it("is the baton holder's act, event-recorded; anyone else is refused in words", async () => {
    const { lane, chatA } = await twoChats();
    const set = await setScope(lane, chatA, ["server/**"]);
    expect(set.statusCode).toBe(200);
    const stored = await harness.db.query(
      "select scope from workstream_sessions where csn_id = $1",
      [chatA]
    );
    expect(stored.rows[0].scope).toEqual(["server/**"]);
    const events = await harness.db.query(
      "select kind from events where mission_id = $1 and kind = 'session.scoped'",
      [lane.missionId]
    );
    expect(events.rowCount).toBe(1);

    const maya = await harness.signIn("maya-scoped");
    const invitation = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "contributor" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token: invitation.json().token }
    });
    const refused = await setScope(lane, chatA, ["apps/**"], maya);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("not_controller");
  });

  it("refuses a pattern that leaves the repository", async () => {
    const { lane, chatA } = await twoChats();
    const escape = await setScope(lane, chatA, ["../outside/**"]);
    expect(escape.statusCode).toBe(422);
  });
});

describe("parallel writers", () => {
  it("two provably disjoint scoped chats hold two live write turns at once", async () => {
    const { lane, chatA, chatB } = await twoChats();
    await setScope(lane, chatA, ["server/**"]);
    await setScope(lane, chatB, ["apps/desktop/**"]);

    const startA = await direct(lane, "Work the server files", { sessionId: chatA });
    expect(startA.json().dispatched).toBe(true);
    const startB = await direct(lane, "Work the desktop files", { sessionId: chatB });
    expect(startB.json().dispatched).toBe(true);
    expect(startB.json().deferred).toBeNull();

    const liveWrites = (await executionsOf(lane)).filter(
      (row) => row.access === "write" && !["completed", "stopped"].includes(row.state)
    );
    expect(liveWrites).toHaveLength(2);
    expect(new Set(liveWrites.map((row) => row.session_id))).toEqual(new Set([chatA, chatB]));
  });

  it("overlap defers, with the overlap named — a wrong 'disjoint' costs the evidence", async () => {
    const { lane, chatA, chatB } = await twoChats();
    await setScope(lane, chatA, ["server/**"]);
    await setScope(lane, chatB, ["server/api/**"]);

    const startA = await direct(lane, "Take the server", { sessionId: chatA });
    expect(startA.json().dispatched).toBe(true);
    const startB = await direct(lane, "Take the api under it", { sessionId: chatB });
    expect(startB.json().dispatched).toBe(false);
    expect(startB.json().deferred).toContain("overlap");
  });

  it("an unscoped party on either side means exclusivity, exactly as before scopes", async () => {
    const { lane, chatA, chatB } = await twoChats();
    // Running chat scoped, target unscoped: waits.
    await setScope(lane, chatA, ["server/**"]);
    const startA = await direct(lane, "Take the server", { sessionId: chatA });
    expect(startA.json().dispatched).toBe(true);
    const unscoped = await direct(lane, "Do something anywhere", { sessionId: chatB });
    expect(unscoped.json().dispatched).toBe(false);

    // And the other way: unscoped running, scoped target waits too.
    const running = (await executionsOf(lane)).find((row) => row.state !== "completed");
    await report(lane.credential, running!.exe_id, [...live(1), completed(3)]);
    await setScope(lane, chatA, null);
    // chatB's queued direction dispatched on completion; settle the lane.
    const nowRunning = (await executionsOf(lane)).find(
      (row) => !["completed", "stopped"].includes(row.state)
    );
    if (nowRunning) {
      await report(lane.credential, nowRunning.exe_id, [...live(1), completed(3)]);
    }
    await setScope(lane, chatB, ["apps/**"]);
    const startUnscoped = await direct(lane, "Anywhere again", { sessionId: chatA });
    expect(startUnscoped.json().dispatched).toBe(true);
    const scopedWaits = await direct(lane, "My own corner", { sessionId: chatB });
    expect(scopedWaits.json().dispatched).toBe(false);
  });

  it("the baton transfers only when the last writer is done", async () => {
    const { lane, chatA, chatB } = await twoChats();
    await setScope(lane, chatA, ["server/**"]);
    await setScope(lane, chatB, ["apps/desktop/**"]);
    await direct(lane, "Server work", { sessionId: chatA });
    await direct(lane, "Desktop work", { sessionId: chatB });
    const writers = (await executionsOf(lane)).filter(
      (row) => !["completed", "stopped"].includes(row.state)
    );
    expect(writers).toHaveLength(2);
    for (const writer of writers) await report(lane.credential, writer.exe_id, live(1));

    const maya = await harness.signIn("maya-lastwriter");
    const invitation = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/invitations`,
      headers: bearer(kartik),
      payload: { role: "contributor" }
    });
    await harness.app.inject({
      method: "POST",
      url: "/invitations/redeem",
      headers: bearer(maya),
      payload: { token: invitation.json().token }
    });
    const mayaId = (
      await harness.db.query("select user_id from users where login = $1", ["maya-lastwriter"])
    ).rows[0].user_id as string;
    await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/control/offer`,
      headers: bearer(kartik),
      payload: { toUserId: mayaId }
    });
    const detail = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(maya)
    });
    const offerId = detail.json().control.liveOffer.offerId as string;
    expect(
      (
        await harness.app.inject({
          method: "POST",
          url: `/control/offers/${offerId}/accept`,
          headers: bearer(maya)
        })
      ).statusCode
    ).toBe(200);

    // The first writer finishes and declares its boundary: the sibling is
    // still mid-flight, so the baton must not move.
    const [first, second] = writers;
    await report(lane.credential, first!.exe_id, [boundary(3), completed(4)]);
    const midway = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(kartik)
    });
    expect(midway.json().control.holderLogin).toBe("kartik");
    expect(midway.json().control.state).toBe("releasing");

    // The last writer's boundary is the lane's.
    await report(lane.credential, second!.exe_id, [boundary(3), completed(4)]);
    const after = await harness.app.inject({
      method: "GET",
      url: `/missions/${lane.missionId}`,
      headers: bearer(kartik)
    });
    expect(after.json().control.holderLogin).toBe("maya-lastwriter");
  });
});
