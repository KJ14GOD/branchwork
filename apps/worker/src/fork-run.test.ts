import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { ModelSelection, SessionEvent } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import {
  FixedModelRouter,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type ModelToolExchange,
} from "./model.ts";
import { SessionRegistry, type HostDefaults } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });
const TOKEN = "fork-run-token-abcdefghijklmnopqrst";
const SELECTION: ModelSelection = { provider: "scripted", model: "fork-runner" };

/**
 * A fork is supposed to be a child run executing in an isolated worktree.
 * These tests drive that end to end over the real HTTP surface with a real
 * Git repository and a scripted model — no provider call anywhere — because
 * both halves of this capability were once claims without code: the fork
 * route built a worktree and then nothing ever ran in it, and every fork
 * evaporated from /compare the moment the worker restarted, even though
 * fork.created had been durably in the log the whole time.
 */
const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-fork-run-repo-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "answer.txt"), "parent\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

/** Forks land beside the repository; both go when the test is done. */
const cleanup = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
  await rm(join(dirname(root), ".novus-forks", basename(root)), {
    recursive: true,
    force: true,
  });
};

const startWorker = (
  store: InMemorySessionEventStore,
  adapters: ModelAdapter[],
  defaults?: HostDefaults,
) => {
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(SELECTION),
    adapters,
    defaults,
  );

  return startEventServer(store, { port: 0, token: TOKEN, sessions });
};

const post = (url: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

const postJson = async <T>(url: string, path: string, body: unknown): Promise<T> => {
  const response = await post(url, path, body);
  const text = await response.text();

  assert.ok(
    response.status < 300,
    `POST ${path} answered ${response.status}: ${text}`,
  );

  return JSON.parse(text) as T;
};

const getJson = async <T>(url: string, path: string): Promise<T> => {
  const response = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.status, 200, `GET ${path} answered ${response.status}`);

  return (await response.json()) as T;
};

const openSession = (
  url: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> => postJson<{ id: string }>(url, "/sessions", body);

type ForkResponse = { fork: { runId: string; worktreePath: string } };

const forkSession = (
  url: string,
  sessionId: string,
  label: string,
  goal: string,
): Promise<ForkResponse> =>
  postJson<ForkResponse>(url, `/sessions/${sessionId}/fork`, {
    label,
    goal,
    // The sessions here never ran a parent turn — a scripted parent run would
    // add nothing to what is being tested — so the parent run is named
    // explicitly, the same way decision-route.test.ts already does.
    parentRunId: "run-parent",
  });

/** Polls the store: the routes answer before the attempt's run finishes. */
const waitForEvent = async (
  store: InMemorySessionEventStore,
  sessionId: string,
  what: string,
  predicate: (events: readonly SessionEvent[]) => boolean,
  timeoutMs = 15_000,
): Promise<void> => {
  const startedAt = Date.now();

  while (!predicate(store.list(sessionId))) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${what}. Log so far: ${store
          .list(sessionId)
          .map((event) => event.type)
          .join(", ")}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Waits for the run to end and returns why it failed, or null when it
 * completed — so an assertion on the null carries the actual reason instead
 * of a bare timeout.
 */
const waitForRunEnd = async (
  store: InMemorySessionEventStore,
  sessionId: string,
  runId: string,
): Promise<string | null> => {
  await waitForEvent(store, sessionId, `run ${runId} to end`, (events) =>
    events.some(
      (event) =>
        (event.type === "run.completed" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled") &&
        event.payload.runId === runId,
    ),
  );

  const failed = store
    .list(sessionId)
    .find(
      (event) => event.type === "run.failed" && event.payload.runId === runId,
    );

  return failed?.type === "run.failed" ? failed.payload.reason : null;
};

type Script = (request: ModelRequest) => ModelResponse | Promise<ModelResponse>;

/**
 * One adapter, one deterministic script per goal — which is exactly how two
 * concurrent attempts share a single model boundary in these tests without
 * sharing any state: the goal is the only thing that distinguishes them.
 */
class GoalScriptedAdapter implements ModelAdapter {
  readonly selection = SELECTION;
  /** Every goal string the model was asked with, steering included. */
  readonly seenGoals: string[] = [];
  private readonly scripts: Record<string, Script>;

  constructor(scripts: Record<string, Script>) {
    this.scripts = scripts;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.seenGoals.push(request.goal);

    const script = this.scripts[request.goal];

    if (!script) {
      return {
        type: "final",
        summary: `No script matches this goal, so nothing ran: ${request.goal}`,
      };
    }

    return script(request);
  }
}

const okResult = (exchange: ModelToolExchange) =>
  exchange.status === "ok" ? exchange.result : null;

/**
 * Propose, apply, finish — the smallest write an attempt can make. A denied
 * or failed exchange ends the run with the refusal in the summary, so a
 * permissions test terminates instead of retrying into its budget.
 */
const editsAnswer =
  (newText: string, summary: string): Script =>
  (request) => {
    const refusal = request.toolExchanges.find(
      (exchange) => exchange.status !== "ok",
    );

    if (refusal) {
      return { type: "final", summary: `Stopped: ${refusal.message}` };
    }

    if (
      request.toolExchanges.some(
        (exchange) => okResult(exchange)?.name === "apply_patch",
      )
    ) {
      return { type: "final", summary };
    }

    for (const exchange of request.toolExchanges) {
      const result = okResult(exchange);

      if (result?.name === "propose_patch") {
        return {
          type: "tool_call",
          call: {
            id: crypto.randomUUID(),
            name: "apply_patch",
            input: { patchId: result.output.patchId },
          },
        };
      }
    }

    return {
      type: "tool_call",
      call: {
        id: crypto.randomUUID(),
        name: "propose_patch",
        input: {
          path: "answer.txt",
          intent: "Rewrite the answer for this attempt.",
          edits: [{ oldText: "parent\n", newText }],
        },
      },
    };
  };

/**
 * Requests a pause during its own first model call — the fork equivalent of
 * pause-resume.test.ts's PausingTool — then, once resumed, edits the answer.
 * The run id is read back from the log by goal rather than passed in, because
 * the fork route mints it server-side and the run may reach the model before
 * the HTTP response reaches the test.
 */
const pausesItselfThenEdits =
  (
    store: InMemorySessionEventStore,
    session: { id: string },
    newText: string,
    summary: string,
  ): Script =>
  (request) => {
    if (request.toolExchanges.length === 0) {
      const started = store
        .list(session.id)
        .find(
          (event) =>
            event.type === "run.started" &&
            event.payload.run.goal === request.goal,
        );

      if (started?.type === "run.started") {
        store.append({
          sessionId: session.id,
          actorId: "teammate-1",
          type: "run.pause_requested",
          payload: { runId: started.payload.run.id },
        });
      }

      return {
        type: "tool_call",
        call: {
          id: crypto.randomUUID(),
          name: "read_file",
          input: { path: "answer.txt" },
        },
      };
    }

    return editsAnswer(newText, summary)(request);
  };

/**
 * Everyone waits until all parties are in flight together, or the whole
 * thing fails loudly after the timeout. This is what makes the concurrency
 * test a proof rather than a hope: if fork runs were secretly serialised,
 * the first attempt would sit here forever waiting for a second attempt
 * that can never start, and the timeout names that instead of hanging.
 */
const rendezvous = (parties: number, timeoutMs: number): (() => Promise<void>) => {
  let arrived = 0;
  let release: (() => void) | undefined;
  let refuse: ((error: Error) => void) | undefined;
  const gate = new Promise<void>((resolveGate, rejectGate) => {
    release = resolveGate;
    refuse = rejectGate;
  });
  const timer = setTimeout(() => {
    refuse?.(
      new Error(
        `Only ${arrived} of ${parties} parties were ever in flight together — the attempts are being serialised, not run concurrently.`,
      ),
    );
  }, timeoutMs);

  return async () => {
    arrived += 1;

    if (arrived >= parties) {
      clearTimeout(timer);
      release?.();
    }

    await gate;
  };
};

const captureWarnings = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.warn;

  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  return {
    lines,
    restore: () => {
      console.warn = original;
    },
  };
};

test("a fork executes its goal in its own worktree, under its own run id", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  const adapter = new GoalScriptedAdapter({
    "Rewrite the answer": editsAnswer("attempt a\n", "Rewrote the answer."),
  });
  const server = await startWorker(store, [adapter]);

  try {
    const session = await openSession(server.url, {
      repositoryPath: root,
      allowWrites: true,
    });
    const forked = await forkSession(
      server.url,
      session.id,
      "Attempt A",
      "Rewrite the answer",
    );
    const runId = forked.fork.runId;

    const failure = await waitForRunEnd(store, session.id, runId);
    assert.equal(failure, null, `the fork's run failed: ${failure}`);

    // The work landed in the fork's worktree and nowhere else.
    assert.equal(
      await readFile(join(forked.fork.worktreePath, "answer.txt"), "utf8"),
      "attempt a\n",
    );
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");

    // Every event of the attempt is under the fork's preassigned run id —
    // this is what makes it an attempt the timeline and /compare can see,
    // and it is the exact thing that never used to happen.
    const forRun = store
      .list(session.id)
      .filter(
        (event) =>
          ("runId" in event.payload && event.payload.runId === runId) ||
          (event.type === "run.started" && event.payload.run.id === runId),
      );

    assert.deepEqual(
      forRun.map((event) => event.type),
      [
        "run.started",
        "run.progress",
        "tool.requested",
        "tool.completed",
        "tool.requested",
        "tool.approval_requested",
        "tool.approved",
        "tool.completed",
        "run.completed",
        "receipt.created",
      ],
    );

    const started = forRun[0];

    if (started?.type === "run.started") {
      assert.equal(started.payload.run.goal, "Rewrite the answer");
      assert.deepEqual(started.payload.run.model, SELECTION);
    }

    // The compare screen folds the attempt from those events.
    const comparison = await getJson<{
      attempts: {
        runId: string;
        label: string;
        status: string;
        filesChanged: { path: string; additions: number; deletions: number }[];
        green: boolean | null;
      }[];
    }>(server.url, `/sessions/${session.id}/compare`);

    assert.equal(comparison.attempts.length, 1);
    assert.equal(comparison.attempts[0]?.runId, runId);
    assert.equal(comparison.attempts[0]?.label, "Attempt A");
    assert.equal(comparison.attempts[0]?.status, "completed");
    assert.deepEqual(comparison.attempts[0]?.filesChanged, [
      { path: "answer.txt", additions: 1, deletions: 1 },
    ]);
    // It ran no tests, so it must not read as verified.
    assert.equal(comparison.attempts[0]?.green, null);

    // And the parent's own changed-files panel does not absorb the fork's
    // work — the attempt changed its worktree, not the tree the panel shows.
    const files = await getJson<{ files: unknown[] }>(
      server.url,
      `/sessions/${session.id}/files`,
    );

    assert.deepEqual(files.files, []);
  } finally {
    await server.close();
    await cleanup(root);
  }
});

test("two attempts run at the same time, isolated from each other and from the parent", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  // Three parties: both forks' first model calls, plus the test itself —
  // which only arrives after submitting direction, so the direction is
  // provably in the log while both attempts are still mid-run.
  const arrive = rendezvous(3, 8_000);
  const overlapping =
    (inner: Script): Script =>
    async (request) => {
      if (request.toolExchanges.length === 0) {
        await arrive();
      }

      return inner(request);
    };
  const adapter = new GoalScriptedAdapter({
    "Make it a": overlapping(editsAnswer("attempt a\n", "Made it a.")),
    "Make it b": overlapping(editsAnswer("attempt b\n", "Made it b.")),
  });
  const server = await startWorker(store, [adapter]);

  try {
    const session = await openSession(server.url, {
      repositoryPath: root,
      allowWrites: true,
    });
    const a = await forkSession(server.url, session.id, "A", "Make it a");
    const b = await forkSession(server.url, session.id, "B", "Make it b");

    // Direction submitted while both attempts are held mid-run. It steers
    // the session's own run; neither attempt may swallow it.
    await post(server.url, `/sessions/${session.id}/direction`, {
      goal: "Do not touch the tests",
    });
    await arrive();

    const failureA = await waitForRunEnd(store, session.id, a.fork.runId);
    const failureB = await waitForRunEnd(store, session.id, b.fork.runId);

    assert.equal(failureA, null, `attempt A failed: ${failureA}`);
    assert.equal(failureB, null, `attempt B failed: ${failureB}`);

    // Each attempt's write is visible in its own worktree only, and the
    // parent's tree carries neither.
    assert.equal(
      await readFile(join(a.fork.worktreePath, "answer.txt"), "utf8"),
      "attempt a\n",
    );
    assert.equal(
      await readFile(join(b.fork.worktreePath, "answer.txt"), "utf8"),
      "attempt b\n",
    );
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");

    // One applied patch per attempt, each under its own run id.
    const applied = store
      .list(session.id)
      .filter(
        (event) =>
          event.type === "tool.completed" &&
          event.payload.result.name === "apply_patch",
      );

    assert.equal(applied.length, 2);
    assert.deepEqual(
      new Set(
        applied.flatMap((event) =>
          "runId" in event.payload ? [event.payload.runId] : [],
        ),
      ),
      new Set([a.fork.runId, b.fork.runId]),
    );

    // Neither attempt consumed the session's direction: nothing marked it
    // applied, and no model call ever saw a steered goal.
    assert.equal(
      store
        .list(session.id)
        .filter((event) => event.type === "direction.applied").length,
      0,
    );
    assert.ok(
      adapter.seenGoals.every(
        (goal) => !goal.includes("Direction from the session"),
      ),
      `an attempt saw session direction: ${JSON.stringify(adapter.seenGoals)}`,
    );

    // The comparison shows two competing attempts contesting the same file.
    const comparison = await getJson<{
      attempts: { runId: string; label: string; status: string }[];
      contestedPaths: string[];
    }>(server.url, `/sessions/${session.id}/compare`);

    assert.equal(comparison.attempts.length, 2);
    assert.deepEqual(comparison.contestedPaths, ["answer.txt"]);
    assert.equal(
      comparison.attempts.find((attempt) => attempt.runId === a.fork.runId)
        ?.label,
      "A",
    );
    assert.equal(
      comparison.attempts.find((attempt) => attempt.runId === b.fork.runId)
        ?.label,
      "B",
    );
    assert.ok(
      comparison.attempts.every((attempt) => attempt.status === "completed"),
    );
  } finally {
    await server.close();
    await cleanup(root);
  }
});

test("a fork inherits the parent session's permissions, not the host defaults", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  const adapter = new GoalScriptedAdapter({
    "Try to write": editsAnswer("attempt a\n", "Wrote it."),
  });
  // The host permits everything; the session was opened permitting nothing.
  // If the fork's gate were derived from host defaults, the write below
  // would be approved and this test would fail on the denial assertions.
  const server = await startWorker(store, [adapter], {
    allowWrites: true,
    allowCommands: true,
  });

  try {
    const session = await openSession(server.url, {
      repositoryPath: root,
      allowWrites: false,
      allowCommands: false,
    });
    const forked = await forkSession(server.url, session.id, "A", "Try to write");
    const runId = forked.fork.runId;

    // A denial is a decision, not a malfunction — the run completes.
    const failure = await waitForRunEnd(store, session.id, runId);
    assert.equal(failure, null, `the fork's run failed: ${failure}`);

    const events = store.list(session.id);
    const denied = events.filter(
      (event) => event.type === "tool.denied" && event.payload.runId === runId,
    );

    assert.equal(denied.length, 1, "the write was not denied");

    // Refused in fact, not just in the log: nothing landed in the fork's
    // own worktree either.
    assert.equal(
      await readFile(join(forked.fork.worktreePath, "answer.txt"), "utf8"),
      "parent\n",
    );

    // The checkpoint recorded the parent session's policy — the thing the
    // fork's gate is built from — not the host's.
    const checkpointed = events.find(
      (event) => event.type === "checkpoint.created",
    );

    assert.ok(checkpointed?.type === "checkpoint.created");
    assert.deepEqual(checkpointed.payload.checkpoint.toolPolicy, {
      allowWrites: false,
      allowCommands: false,
    });

    // The model was told, which is how the attempt's summary explains itself.
    const completedRun = events.find(
      (event) =>
        event.type === "run.completed" && event.payload.runId === runId,
    );

    assert.ok(completedRun?.type === "run.completed");
    assert.match(completedRun.payload.summary, /Denied/);
  } finally {
    await server.close();
    await cleanup(root);
  }
});

test("forks and their evidence survive a worker restart, and the decision still applies", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  let sessionId = "";
  let runId = "";

  const serverA = await startWorker(store, [
    new GoalScriptedAdapter({
      "Change the answer": editsAnswer("attempt a\n", "Changed it."),
    }),
  ]);

  try {
    const session = await openSession(serverA.url, {
      repositoryPath: root,
      allowWrites: true,
    });

    sessionId = session.id;

    const forked = await forkSession(
      serverA.url,
      session.id,
      "Attempt A",
      "Change the answer",
    );

    runId = forked.fork.runId;

    const failure = await waitForRunEnd(store, session.id, runId);
    assert.equal(failure, null, `the fork's run failed: ${failure}`);
  } finally {
    await serverA.close();
  }

  // A fresh process: new registry, new server, the same durable log — the
  // shape of a real restart, the same as files-route.test.ts uses.
  const serverB = await startWorker(store, [new GoalScriptedAdapter({})]);

  try {
    const resumed = await openSession(serverB.url, {
      repositoryPath: root,
      resume: sessionId,
      allowWrites: true,
    });

    assert.equal(resumed.id, sessionId);

    // The attempt and its evidence come back from the log, not from any
    // memory of the process that forked it.
    const comparison = await getJson<{
      attempts: {
        runId: string;
        label: string;
        status: string;
        filesChanged: { path: string; additions: number; deletions: number }[];
      }[];
    }>(serverB.url, `/sessions/${sessionId}/compare`);

    assert.equal(comparison.attempts.length, 1);
    assert.equal(comparison.attempts[0]?.runId, runId);
    assert.equal(comparison.attempts[0]?.label, "Attempt A");
    assert.equal(comparison.attempts[0]?.status, "completed");
    assert.deepEqual(comparison.attempts[0]?.filesChanged, [
      { path: "answer.txt", additions: 1, deletions: 1 },
    ]);

    // And the decision still works, because the worktree was re-adopted at
    // session open — the restarted worker can operate the fork, not merely
    // list it.
    const decision = await postJson<{
      decision: { runId: string; outcome: { applied: boolean } };
    }>(serverB.url, `/sessions/${sessionId}/decision`, { runId });

    assert.equal(decision.decision.runId, runId);
    assert.equal(decision.decision.outcome.applied, true);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "attempt a\n");
  } finally {
    await serverB.close();
    await cleanup(root);
  }
});

test("a paused fork resumes in its own worktree, not the parent's", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  const sessionBox = { id: "" };
  const adapter = new GoalScriptedAdapter({
    "Pause then write": pausesItselfThenEdits(
      store,
      sessionBox,
      "resumed attempt\n",
      "Finished after the pause.",
    ),
  });
  const server = await startWorker(store, [adapter]);

  try {
    const session = await openSession(server.url, {
      repositoryPath: root,
      allowWrites: true,
    });

    sessionBox.id = session.id;

    const forked = await forkSession(
      server.url,
      session.id,
      "P",
      "Pause then write",
    );
    const runId = forked.fork.runId;

    await waitForEvent(store, session.id, `run ${runId} to pause`, (events) =>
      events.some(
        (event) =>
          event.type === "run.paused" && event.payload.runId === runId,
      ),
    );

    // Paused before any write happened anywhere.
    assert.equal(
      await readFile(join(forked.fork.worktreePath, "answer.txt"), "utf8"),
      "parent\n",
    );

    const resumed = await post(server.url, `/sessions/${session.id}/resume`, {
      runId,
    });

    assert.equal(resumed.status, 202);

    const failure = await waitForRunEnd(store, session.id, runId);
    assert.equal(failure, null, `the resumed fork failed: ${failure}`);
    assert.ok(
      store
        .list(session.id)
        .some(
          (event) =>
            event.type === "run.resumed" && event.payload.runId === runId,
        ),
    );

    // The continuation executed in the fork's worktree. Before resumeTurn
    // learned to tell fork runs apart, this resume would have run inside the
    // parent's tree with the parent's runner — the exact tree the fork
    // exists to keep the attempt out of.
    assert.equal(
      await readFile(join(forked.fork.worktreePath, "answer.txt"), "utf8"),
      "resumed attempt\n",
    );
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
  } finally {
    await server.close();
    await cleanup(root);
  }
});

test("a fork resumed after a restart does not regain writes the session no longer allows", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  const sessionBox = { id: "" };
  const script = () =>
    pausesItselfThenEdits(
      store,
      sessionBox,
      "should never land\n",
      "Should not have been allowed to finish a write.",
    );
  let sessionId = "";
  let runId = "";
  let worktreePath = "";

  // First life: the session allows writes, the fork is cut with that policy
  // recorded, and its run pauses before writing anything.
  const serverA = await startWorker(store, [
    new GoalScriptedAdapter({ "Pause then write": script() }),
  ]);

  try {
    const session = await openSession(serverA.url, {
      repositoryPath: root,
      allowWrites: true,
    });

    sessionId = session.id;
    sessionBox.id = session.id;

    const forked = await forkSession(
      serverA.url,
      session.id,
      "P",
      "Pause then write",
    );

    runId = forked.fork.runId;
    worktreePath = forked.fork.worktreePath;

    await waitForEvent(store, session.id, `run ${runId} to pause`, (events) =>
      events.some(
        (event) =>
          event.type === "run.paused" && event.payload.runId === runId,
      ),
    );
  } finally {
    await serverA.close();
  }

  // Second life: the host's defaults deny writes and the session is resumed
  // without asking for them — the same rule sessions already follow
  // ("permissions are deliberately not restored"), now extended to the
  // fork's continuation. The checkpoint recorded writes-allowed; the live
  // session says otherwise; the live session wins.
  const serverB = await startWorker(
    store,
    [new GoalScriptedAdapter({ "Pause then write": script() })],
    { allowWrites: false, allowCommands: false },
  );

  try {
    await openSession(serverB.url, { repositoryPath: root, resume: sessionId });

    const resumed = await post(serverB.url, `/sessions/${sessionId}/resume`, {
      runId,
    });

    assert.equal(resumed.status, 202);

    const failure = await waitForRunEnd(store, sessionId, runId);
    assert.equal(failure, null, `the resumed fork failed: ${failure}`);

    const events = store.list(sessionId);
    const denied = events.filter(
      (event) => event.type === "tool.denied" && event.payload.runId === runId,
    );

    assert.equal(denied.length, 1, "the write after resume was not denied");

    const completedRun = events.find(
      (event) =>
        event.type === "run.completed" && event.payload.runId === runId,
    );

    assert.ok(completedRun?.type === "run.completed");
    assert.match(completedRun.payload.summary, /Denied/);

    // Nothing landed, in either tree.
    assert.equal(
      await readFile(join(worktreePath, "answer.txt"), "utf8"),
      "parent\n",
    );
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
  } finally {
    await serverB.close();
    await cleanup(root);
  }
});

test("a fork whose worktree was deleted keeps its evidence, and the decision refuses rather than misapplies", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  let sessionId = "";
  let runId = "";
  let worktreePath = "";

  const serverA = await startWorker(store, [
    new GoalScriptedAdapter({
      "Change the answer": editsAnswer("attempt a\n", "Changed it."),
    }),
  ]);

  try {
    const session = await openSession(serverA.url, {
      repositoryPath: root,
      allowWrites: true,
    });

    sessionId = session.id;

    const forked = await forkSession(
      serverA.url,
      session.id,
      "Attempt A",
      "Change the answer",
    );

    runId = forked.fork.runId;
    worktreePath = forked.fork.worktreePath;

    const failure = await waitForRunEnd(store, session.id, runId);
    assert.equal(failure, null, `the fork's run failed: ${failure}`);
  } finally {
    await serverA.close();
  }

  // The human deletes the fork's checkout between restarts.
  await rm(worktreePath, { recursive: true, force: true });

  const serverB = await startWorker(store, [new GoalScriptedAdapter({})]);
  const warnings = captureWarnings();

  try {
    try {
      await openSession(serverB.url, {
        repositoryPath: root,
        resume: sessionId,
        allowWrites: true,
      });
    } finally {
      warnings.restore();
    }

    // Said, not swallowed.
    assert.ok(
      warnings.lines.some((line) => /could not be re-attached/.test(line)),
      `no warning about the missing worktree: ${JSON.stringify(warnings.lines)}`,
    );

    // The evidence is the log's, so it is still on the compare screen.
    const comparison = await getJson<{
      attempts: { runId: string; status: string; filesChanged: unknown[] }[];
    }>(serverB.url, `/sessions/${sessionId}/compare`);

    assert.equal(comparison.attempts.length, 1);
    assert.equal(comparison.attempts[0]?.runId, runId);
    assert.equal(comparison.attempts[0]?.status, "completed");
    assert.equal(comparison.attempts[0]?.filesChanged.length, 1);

    // But the apply needs the worktree, which is gone — refused, and the
    // parent's tree is untouched.
    const decision = await post(serverB.url, `/sessions/${sessionId}/decision`, {
      runId,
    });

    assert.equal(decision.status, 404);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
  } finally {
    await serverB.close();
    await cleanup(root);
  }
});

test("a fork that can never start is a failed attempt on the record, not a silent one", async () => {
  const root = await repository();
  const store = new InMemorySessionEventStore();
  // No adapter matches the router's selection, so the attempt's run cannot
  // start at all. The fork's id exists in the log regardless — fork.created
  // named it — so unlike the parent path ("does not invent a run to fail"),
  // this failure is attributable and must be attributed.
  const server = await startWorker(store, []);

  try {
    const session = await openSession(server.url, {
      repositoryPath: root,
      allowWrites: true,
    });
    const forked = await forkSession(server.url, session.id, "A", "Try anyway");
    const runId = forked.fork.runId;

    await waitForEvent(store, session.id, `run ${runId} to fail`, (events) =>
      events.some(
        (event) =>
          event.type === "run.failed" && event.payload.runId === runId,
      ),
    );

    const failed = store
      .list(session.id)
      .find(
        (event) =>
          event.type === "run.failed" && event.payload.runId === runId,
      );

    assert.ok(failed?.type === "run.failed");
    assert.match(failed.payload.reason, /No model adapter/);

    // And the compare screen shows the attempt as failed with that reason,
    // rather than dropping an attempt that has no run.started to project.
    const comparison = await getJson<{
      attempts: { runId: string; status: string; failure: string | null }[];
    }>(server.url, `/sessions/${session.id}/compare`);

    assert.equal(comparison.attempts.length, 1);
    assert.equal(comparison.attempts[0]?.runId, runId);
    assert.equal(comparison.attempts[0]?.status, "failed");
    assert.match(comparison.attempts[0]?.failure ?? "", /No model adapter/);
  } finally {
    await server.close();
    await cleanup(root);
  }
});
