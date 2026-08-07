import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { SESSION_TITLE_MAX, type ReportableRunnerEvent } from "@novus/contracts";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * Shared sessions inside a workstream (D-083), against a real PostgreSQL.
 *
 * What these tests are for, in order of how badly it would matter if they
 * stopped holding:
 *
 *  - **Continuity is per session.** Each conversation resumes its own harness
 *    history and never a sibling's, and the lane's legacy column mirrors only
 *    its first session's. Crossed resume points would replay one person's
 *    conversation into another's turn — silently.
 *  - **The workspace takes turns.** One live turn per lane stays the law. The
 *    running session's own direction steers it; a sibling's waits visibly with
 *    the running session named; only a *completed* turn dispatches the queue,
 *    because a stop asked for quiet and a broken lane must not chain-fire.
 *  - **A row names its lane.** Stopping, resolving a queued direction,
 *    answering an approval, and enrolment-time dispatch are each judged
 *    against the row's own lane, never the mission's first — the four routing
 *    fixes D-083's audit demanded, pinned so they cannot come back.
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

interface SessionView {
  sessionId: string;
  workstreamId: string;
  title: string | null;
}

beforeAll(async () => {
  harness = await createHarness("novus_test_sessions");
  kartik = await harness.signIn("kartik");
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

/** A local mission with this machine enrolled as its runner. */
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
      goal: "Make the session guard hold",
      successCriteria: "Sessions expire when they should",
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

interface Directed {
  direction: { directionId: string; sessionId: string; state: string };
  dispatched: boolean;
  deferred: string | null;
}

/** A direction into one lane — and, when named, one conversation of it. */
async function direct(
  lane: Lane,
  body: string,
  options: { sessionId?: string; newSession?: boolean; as?: SignedIn } = {}
): Promise<Directed> {
  const submitted = await harness.app.inject({
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
  expect(submitted.statusCode).toBe(200);
  return submitted.json() as Directed;
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

/** The runner declaring a turn underway — enough to occupy the workspace. */
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

/** The harness naming the conversation this turn is having. */
const harnessSession = (
  originSeq: number,
  sessionId: string,
  resumed = false
): ReportableRunnerEvent => ({
  originSeq,
  event: { kind: "harness.session", payload: { sessionId, resumed } }
});

const completed = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: { kind: "execution.completed", payload: {} }
});

const stoppedByHand = (originSeq: number): ReportableRunnerEvent => ({
  originSeq,
  event: {
    kind: "execution.stopped",
    payload: { reason: "Stopped by a participant.", via: "protocol_interrupt" }
  }
});

/** The evidence a lane can be forked on: a commit that touched files. */
function checkpoint(originSeq: number, at: string, path: string): ReportableRunnerEvent {
  return {
    originSeq,
    event: {
      kind: "workspace.checkpoint",
      payload: {
        outcome: "committed",
        sha: at,
        parentSha: null,
        branch: "novus/mission",
        withheldSecrets: 0,
        uncommitted: false,
        error: null,
        files: [
          {
            path,
            previousPath: null,
            changeState: "modified",
            additions: 7,
            deletions: 2,
            binary: false,
            diff: null,
            truncated: false
          }
        ]
      }
    }
  };
}

/** A lane that has produced one checkpoint, so approaches can fork beside it. */
async function laneWithWork(): Promise<{ lane: Lane; executionId: string }> {
  const lane = await mission();
  await direct(lane, "Harden the session guard");
  const turn = await latestExecution(lane.workstreamId);
  await report(lane.credential, turn.executionId, [
    checkpoint(1, sha(`${lane.workstreamId}-first`), "src/session.ts")
  ]);
  return { lane, executionId: turn.executionId };
}

async function fork(lane: Lane, intent: string, as: SignedIn = kartik) {
  return harness.app.inject({
    method: "POST",
    url: `/missions/${lane.missionId}/approaches`,
    headers: bearer(as),
    payload: { fromWorkstreamId: lane.workstreamId, intent }
  });
}

/** Enrols a freshly forked lane so it can be directed and can report. */
async function enrol(missionId: string, workstreamId: string): Promise<Lane> {
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
  return { missionId, workstreamId, credential: enrolled.json().credential as string };
}

async function joinAs(missionId: string, who: string, role: string): Promise<SignedIn> {
  const joiner = await harness.signIn(who);
  const created = await harness.app.inject({
    method: "POST",
    url: `/missions/${missionId}/invitations`,
    headers: bearer(kartik),
    payload: { role }
  });
  await harness.app.inject({
    method: "POST",
    url: "/invitations/redeem",
    headers: bearer(joiner),
    payload: { token: created.json().token }
  });
  return joiner;
}

const detailOf = async (lane: Lane, as: SignedIn = kartik) => {
  const response = await harness.app.inject({
    method: "GET",
    url: `/missions/${lane.missionId}`,
    headers: bearer(as)
  });
  expect(response.statusCode).toBe(200);
  return response.json();
};

const sessionsOf = async (lane: Lane): Promise<SessionView[]> =>
  (await detailOf(lane)).sessions as SessionView[];

/** The lane's newest execution — the turn a direction just started. */
async function latestExecution(workstreamId: string): Promise<{
  executionId: string;
  sessionId: string;
  state: string;
  startingDirectionId: string | null;
}> {
  const result = await harness.db.query(
    `select exe_id, session_id, state, starting_direction_id from executions
      where wst_id = $1 order by created_at desc limit 1`,
    [workstreamId]
  );
  const row = result.rows[0];
  expect(row).toBeTruthy();
  return {
    executionId: row.exe_id as string,
    sessionId: row.session_id as string,
    state: row.state as string,
    startingDirectionId: (row.starting_direction_id as string | null) ?? null
  };
}

async function executionCount(workstreamId: string): Promise<number> {
  const result = await harness.db.query(
    "select count(*)::int as n from executions where wst_id = $1",
    [workstreamId]
  );
  return result.rows[0].n as number;
}

/** The durable command a turn rides out on; the session travels in its payload
 *  because the runner itself does not know sessions exist (D-083). */
async function startCommand(
  executionId: string
): Promise<{ directionId: string; sessionId: string; resumeSessionId: string | null }> {
  const result = await harness.db.query(
    "select payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
    [executionId]
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0].payload as {
    directionId: string;
    sessionId: string;
    resumeSessionId: string | null;
  };
}

const directionState = async (directionId: string): Promise<string> => {
  const result = await harness.db.query("select state from directions where dir_id = $1", [
    directionId
  ]);
  return result.rows[0].state as string;
};

describe("a session is born with its lane", () => {
  it("creating a mission creates the lane's first session, untitled until somebody speaks", async () => {
    const lane = await mission();
    const sessions = await sessionsOf(lane);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toMatch(/^csn_/);
    expect(sessions[0]!.workstreamId).toBe(lane.workstreamId);
    // Words-first: no direction has landed, so the session has no name yet.
    expect(sessions[0]!.title).toBeNull();
  });

  it("the first direction's own trimmed words become the title, and a second direction does not retitle it", async () => {
    const lane = await mission();
    const words = `  Harden   the session guard ${"until it holds ".repeat(8)}everywhere  `;
    await direct(lane, words);

    // The stored body is trimmed on the way in; the title collapses runs of
    // whitespace and truncates — first words, never a form field.
    const expected = words.trim().replace(/\s+/g, " ").slice(0, SESSION_TITLE_MAX);
    expect(expected).toHaveLength(SESSION_TITLE_MAX);
    const [titled] = await sessionsOf(lane);
    expect(titled!.title).toBe(expected);

    // A title is written once. The second direction steers the same
    // conversation and renames nothing.
    await direct(lane, "Now write the tests for it");
    const [after] = await sessionsOf(lane);
    expect(after!.title).toBe(expected);
  });

  it("a forked approach gets its own first session", async () => {
    const { lane } = await laneWithWork();
    const created = await fork(lane, "Try it without the migration");
    expect(created.statusCode).toBe(201);
    const approachId = created.json().workstream.workstreamId as string;

    const sessions = await sessionsOf(lane);
    expect(sessions).toHaveLength(2);
    const own = sessions.find((session) => session.workstreamId === lane.workstreamId);
    const approachSession = sessions.find((session) => session.workstreamId === approachId);
    expect(approachSession).toBeTruthy();
    // Its own conversation, empty and unnamed — not a copy of its sibling's.
    expect(approachSession?.title).toBeNull();
    expect(approachSession?.sessionId).not.toBe(own?.sessionId);
  });

  it("newSession opens a second conversation from the direction's own words; naming one and asking for a new one is refused", async () => {
    const lane = await mission();
    const [first] = await sessionsOf(lane);

    const submitted = await direct(lane, "Review the guard separately", { newSession: true });
    expect(submitted.direction.sessionId).toMatch(/^csn_/);
    expect(submitted.direction.sessionId).not.toBe(first!.sessionId);
    // The row carries the conversation it landed in, durably.
    const row = await harness.db.query("select session_id from directions where dir_id = $1", [
      submitted.direction.directionId
    ]);
    expect(row.rows[0].session_id).toBe(submitted.direction.sessionId);

    // Creation order, always — and only the spoken-in session has a name.
    const sessions = await sessionsOf(lane);
    expect(sessions.map((session) => session.sessionId)).toEqual([
      first!.sessionId,
      submitted.direction.sessionId
    ]);
    expect(sessions[0]!.title).toBeNull();
    expect(sessions[1]!.title).toBe("Review the guard separately");

    // One direction, one target: both at once has no honest reading.
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: {
        body: "Both at once",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: lane.workstreamId,
        sessionId: first!.sessionId,
        newSession: true
      }
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/not both/i);
  });
});

describe("routing a direction to a session", () => {
  it("a direction naming a session lands in it, and its first turn starts with no resume point", async () => {
    const lane = await mission();
    const [named] = await sessionsOf(lane);
    const submitted = await direct(lane, "Keep to this conversation", {
      sessionId: named!.sessionId
    });
    expect(submitted.dispatched).toBe(true);
    expect(submitted.direction.sessionId).toBe(named!.sessionId);

    const row = await harness.db.query("select session_id from directions where dir_id = $1", [
      submitted.direction.directionId
    ]);
    expect(row.rows[0].session_id).toBe(named!.sessionId);
    const turn = await latestExecution(lane.workstreamId);
    expect(turn.sessionId).toBe(named!.sessionId);

    // The runner is told which conversation this is and what to resume — and a
    // conversation's very first turn has nothing to resume.
    const payload = await startCommand(turn.executionId);
    expect(payload.sessionId).toBe(named!.sessionId);
    expect(payload.resumeSessionId).toBeNull();
  });

  it("another lane's session is no session here, an unknown one is not found, and a viewer is refused", async () => {
    const { lane } = await laneWithWork();
    const created = await fork(lane, "Do it in the middleware instead");
    expect(created.statusCode).toBe(201);
    const approachId = created.json().workstream.workstreamId as string;
    const sessions = await sessionsOf(lane);
    const foreign = sessions.find((session) => session.workstreamId === approachId);
    const own = sessions.find((session) => session.workstreamId === lane.workstreamId);

    // A sibling lane's session named against this lane: answered exactly like
    // a foreign lane — it does not exist for you — and nothing is recorded.
    const crossed = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: {
        body: "Land in the sibling's conversation",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: lane.workstreamId,
        sessionId: foreign?.sessionId
      }
    });
    expect(crossed.statusCode).toBe(404);
    const rows = await harness.db.query(
      "select count(*)::int as n from directions where mission_id = $1 and body like 'Land in%'",
      [lane.missionId]
    );
    expect(rows.rows[0].n).toBe(0);

    const unknown = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(kartik),
      payload: {
        body: "Talk to a conversation that never existed",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: lane.workstreamId,
        sessionId: "csn_00000000000000000000"
      }
    });
    expect(unknown.statusCode).toBe(404);

    // Naming a session grants nothing: the capability check comes first.
    const viewer = await joinAs(lane.missionId, "maya-view-session", "viewer");
    const refused = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(viewer),
      payload: {
        body: "Try to speak from the gallery",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: lane.workstreamId,
        sessionId: own?.sessionId
      }
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("continuity is per session", () => {
  it("each conversation resumes its own history, and the lane's column mirrors only the first session's", async () => {
    const lane = await mission();
    const [first] = await sessionsOf(lane);

    // Session A's turn: the harness opens conversation cli-A, and the turn ends.
    await direct(lane, "Carry the guard conversation");
    const turnA = await latestExecution(lane.workstreamId);
    await report(lane.credential, turnA.executionId, [harnessSession(1, "cli-A"), completed(2)]);

    // A brand-new session B starts from its own, empty, history — not from
    // cli-A, which belongs to a different conversation.
    const submittedB = await direct(lane, "Review it in a second conversation", {
      newSession: true
    });
    const sessionB = submittedB.direction.sessionId;
    const turnB = await latestExecution(lane.workstreamId);
    expect(turnB.sessionId).toBe(sessionB);
    expect((await startCommand(turnB.executionId)).resumeSessionId).toBeNull();
    await report(lane.credential, turnB.executionId, [harnessSession(1, "cli-B"), completed(2)]);

    // Directing A again picks its own thread back up.
    await direct(lane, "Back to the guard", { sessionId: first!.sessionId });
    const turnA2 = await latestExecution(lane.workstreamId);
    expect(turnA2.sessionId).toBe(first!.sessionId);
    const payload = await startCommand(turnA2.executionId);
    expect(payload.sessionId).toBe(first!.sessionId);
    expect(payload.resumeSessionId).toBe("cli-A");

    // Each session keeps its own resume point…
    const held = await harness.db.query(
      "select csn_id, harness_session_id from workstream_sessions where wst_id = $1 order by created_at, csn_id",
      [lane.workstreamId]
    );
    expect(held.rows).toEqual([
      { csn_id: first!.sessionId, harness_session_id: "cli-A" },
      { csn_id: sessionB, harness_session_id: "cli-B" }
    ]);
    // …and the lane's legacy column mirrors the first session's alone, so
    // anything still reading the pre-session shape sees what it always did.
    const mirrored = await harness.db.query(
      "select harness_session_id from workstreams where wst_id = $1",
      [lane.workstreamId]
    );
    expect(mirrored.rows[0].harness_session_id).toBe("cli-A");
  });
});

describe("the workspace takes turns", () => {
  it("a sibling session's direction waits its turn, with the running session named", async () => {
    const lane = await mission();
    await direct(lane, "Harden the session guard");
    const turnA = await latestExecution(lane.workstreamId);
    await report(lane.credential, turnA.executionId, live(1));

    const submitted = await direct(lane, "Write the tests in a second conversation", {
      newSession: true
    });
    expect(submitted.dispatched).toBe(false);
    // The wait is visible and says who it is waiting for.
    expect(submitted.deferred).toContain('"Harden the session guard"');
    // Not "in this approach": the commonest sessions live in a lane nobody
    // ever forked, and the room must not assert an approach that was never
    // created (PRODUCT.md — approaches exist only when deliberately made).
    expect(submitted.deferred).toContain("is running; this applies when it finishes");

    // Nothing second started, and the direction waits as durable state.
    expect(await executionCount(lane.workstreamId)).toBe(1);
    expect(await directionState(submitted.direction.directionId)).toBe("queued");
  });

  it("a direction for the running session steers the running turn", async () => {
    const lane = await mission();
    await direct(lane, "Harden the session guard");
    const turnA = await latestExecution(lane.workstreamId);
    await report(lane.credential, turnA.executionId, live(1));

    const steered = await direct(lane, "Also cover the expiry path");
    expect(steered.dispatched).toBe(true);
    expect(steered.deferred).toBeNull();

    // The steer is an apply against the running turn — never a second turn.
    const applies = await harness.db.query(
      "select exe_id, payload from runner_commands where wst_id = $1 and kind = 'apply_direction'",
      [lane.workstreamId]
    );
    expect(applies.rowCount).toBe(1);
    expect(applies.rows[0].exe_id).toBe(turnA.executionId);
    expect((applies.rows[0].payload as { directionId: string }).directionId).toBe(
      steered.direction.directionId
    );
    expect(await executionCount(lane.workstreamId)).toBe(1);
  });

  it("a completed turn dispatches the queued sibling direction, and never re-runs its own starter", async () => {
    const lane = await mission();
    await direct(lane, "Harden the session guard");
    const turnA = await latestExecution(lane.workstreamId);
    await report(lane.credential, turnA.executionId, [...live(1), harnessSession(3, "cli-A")]);

    const queued = await direct(lane, "Review it in a second conversation", { newSession: true });
    expect(queued.dispatched).toBe(false);

    await report(lane.credential, turnA.executionId, [completed(4)]);

    // The queued sibling went out on its own, into its own conversation and
    // with its own (empty) resume point — not A's cli-A.
    const turnB = await latestExecution(lane.workstreamId);
    expect(turnB.executionId).not.toBe(turnA.executionId);
    expect(turnB.sessionId).toBe(queued.direction.sessionId);
    expect(turnB.startingDirectionId).toBe(queued.direction.directionId);
    expect((await startCommand(turnB.executionId)).resumeSessionId).toBeNull();

    // Exactly one new turn: the direction that started A is consumed by A's
    // execution and must not run its words a second time.
    expect(await executionCount(lane.workstreamId)).toBe(2);
  });

  it("a stopped turn dispatches nothing — quiet is what the stop asked for", async () => {
    const lane = await mission();
    await direct(lane, "Harden the session guard");
    const turnA = await latestExecution(lane.workstreamId);
    await report(lane.credential, turnA.executionId, live(1));
    const queued = await direct(lane, "Review it in a second conversation", { newSession: true });
    expect(queued.dispatched).toBe(false);

    await report(lane.credential, turnA.executionId, [stoppedByHand(3)]);

    // The sibling stays queued, readable, and started by nobody.
    expect(await executionCount(lane.workstreamId)).toBe(1);
    expect(await directionState(queued.direction.directionId)).toBe("queued");
  });
});

describe("a row names its lane", () => {
  it("stop names its lane: the approach's turn ends only when the stop says so", async () => {
    const { lane, executionId } = await laneWithWork();
    await report(lane.credential, executionId, [completed(2)]);

    const created = await fork(lane, "Do it in the middleware instead");
    expect(created.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, created.json().workstream.workstreamId as string);
    await direct(approach, "Go the middleware way");
    const turn = await latestExecution(approach.workstreamId);
    await report(approach.credential, turn.executionId, live(1));

    // An unnamed stop resolves the mission's first lane, where nothing is
    // running: it touches nothing — and must not reach across to the
    // approach's live turn under the wrong name.
    const unnamed = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/execution/stop`,
      headers: bearer(kartik),
      payload: {}
    });
    expect(unnamed.statusCode).toBe(200);
    expect((await latestExecution(approach.workstreamId)).state).toBe("running");
    const before = await harness.db.query(
      "select count(*)::int as n from runner_commands where mission_id = $1 and kind = 'stop_execution'",
      [lane.missionId]
    );
    expect(before.rows[0].n).toBe(0);

    // Naming the lane reaches the turn that is actually running.
    const named = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/execution/stop`,
      headers: bearer(kartik),
      payload: { workstreamId: approach.workstreamId }
    });
    expect(named.statusCode).toBe(200);
    expect((await latestExecution(approach.workstreamId)).state).toBe("stopping");
    const stops = await harness.db.query(
      "select wst_id, exe_id from runner_commands where mission_id = $1 and kind = 'stop_execution'",
      [lane.missionId]
    );
    expect(stops.rowCount).toBe(1);
    expect(stops.rows[0].wst_id).toBe(approach.workstreamId);
    expect(stops.rows[0].exe_id).toBe(turn.executionId);
  });

  it("a queued direction on an approach is the approach's own controller's to resolve", async () => {
    const { lane } = await laneWithWork();
    const operator = await joinAs(lane.missionId, "rhea-operator", "operator");
    const contributor = await joinAs(lane.missionId, "sam-contributor", "contributor");

    // The operator forks the approach and so holds its baton; kartik still
    // holds the first lane's.
    const created = await fork(lane, "Do it in the middleware instead", operator);
    expect(created.statusCode).toBe(201);
    const approachId = created.json().workstream.workstreamId as string;

    const queued = await harness.app.inject({
      method: "POST",
      url: `/missions/${lane.missionId}/direction`,
      headers: bearer(contributor),
      payload: {
        body: "Try the middleware first",
        model: "claude-fable-5",
        effort: "high",
        workstreamId: approachId
      }
    });
    expect(queued.statusCode).toBe(200);
    const directionId = queued.json().direction.directionId as string;

    // Judged against the direction's lane: the first lane's baton does not
    // reach across, however senior its holder's role.
    const reached = await harness.app.inject({
      method: "POST",
      url: `/directions/${directionId}/resolve`,
      headers: bearer(kartik),
      payload: { action: "apply" }
    });
    expect(reached.statusCode).toBe(403);
    expect(reached.json().error.message).toMatch(/controller/i);

    const resolved = await harness.app.inject({
      method: "POST",
      url: `/directions/${directionId}/resolve`,
      headers: bearer(operator),
      payload: { action: "apply" }
    });
    expect(resolved.statusCode).toBe(200);
    const authorized = await harness.db.query(
      "select workstream_id from events where mission_id = $1 and kind = 'direction.authorized'",
      [lane.missionId]
    );
    expect(authorized.rows.map((row) => row.workstream_id)).toEqual([approachId]);
  });

  it("an approval raised on an approach lane is the approach controller's to answer", async () => {
    const { lane } = await laneWithWork();
    const operator = await joinAs(lane.missionId, "noor-operator", "operator");
    const created = await fork(lane, "Do it in the middleware instead", operator);
    expect(created.statusCode).toBe(201);
    const approach = await enrol(lane.missionId, created.json().workstream.workstreamId as string);

    await direct(approach, "Go the middleware way", { as: operator });
    const turn = await latestExecution(approach.workstreamId);
    await report(approach.credential, turn.executionId, [
      ...live(1),
      {
        originSeq: 3,
        event: {
          kind: "approval.requested",
          payload: {
            requestId: "harness-request-1",
            toolUseId: "toolu_1",
            toolName: "Write",
            displayName: "Write",
            summary: "the mission worktree/PROBE.md"
          }
        }
      }
    ]);
    const asked = await harness.db.query(
      "select apr_id from approval_requests where exe_id = $1",
      [turn.executionId]
    );
    const approvalId = asked.rows[0].apr_id as string;

    // Judged against the approval's lane: holding the first lane's lease is
    // not holding this one's.
    const refused = await harness.app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/respond`,
      headers: bearer(kartik),
      payload: { decision: "approve" }
    });
    expect(refused.statusCode).toBe(403);

    const answered = await harness.app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/respond`,
      headers: bearer(operator),
      payload: { decision: "approve" }
    });
    expect(answered.statusCode).toBe(200);
    const settled = await harness.db.query(
      "select state, responded_by from approval_requests where apr_id = $1",
      [approvalId]
    );
    expect(settled.rows[0].state).toBe("approved");
    expect(settled.rows[0].responded_by).toBe(operator.userId);
  });

  it("enrolment-time dispatch reaches the enrolled lane", async () => {
    const { lane } = await laneWithWork();
    const created = await fork(lane, "Try it as a background job");
    expect(created.statusCode).toBe(201);
    const approachId = created.json().workstream.workstreamId as string;

    // Directed before any machine exists for the lane: deferred, with the
    // reason said rather than the room pretending an agent is starting.
    const early = await direct(
      { ...lane, workstreamId: approachId },
      "Start the background job way"
    );
    expect(early.dispatched).toBe(false);
    expect(early.deferred).toMatch(/No runner/);

    // Enrolling the lane's machine sends out what was already authorized —
    // into *this* lane and its own first session, never the mission's first.
    await enrol(lane.missionId, approachId);
    const turn = await latestExecution(approachId);
    expect(turn.startingDirectionId).toBe(early.direction.directionId);
    const firstSession = await harness.db.query(
      "select csn_id from workstream_sessions where wst_id = $1 order by created_at, csn_id limit 1",
      [approachId]
    );
    expect(turn.sessionId).toBe(firstSession.rows[0].csn_id);
    const command = await harness.db.query(
      "select wst_id, payload from runner_commands where exe_id = $1 and kind = 'start_execution'",
      [turn.executionId]
    );
    expect(command.rowCount).toBe(1);
    expect(command.rows[0].wst_id).toBe(approachId);
    expect((command.rows[0].payload as { sessionId: string }).sessionId).toBe(
      firstSession.rows[0].csn_id
    );
  });
});
