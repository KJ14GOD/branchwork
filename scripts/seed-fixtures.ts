/**
 * Every mission state, in a throwaway log, for zero provider credit.
 *
 * The Workroom renders a different composition per mission state, and most of
 * those states are expensive or slow to reach by actually running an agent —
 * "verified" needs a green test run, "stopped before it changed anything"
 * needs a failure. This writes each one straight onto a scratch event log so
 * the screens can be looked at, and looked at again after a styling change,
 * without a single model call.
 *
 * Every event goes through the real store and the real contract, so a fixture
 * that would not survive the schema cannot be screenshotted into looking fine.
 *
 *   ./scripts/fixtures.sh
 *
 * or, by hand:
 *
 *   node --experimental-strip-types scripts/seed-fixtures.ts <repoDir> <dbPath>
 *
 * `repoDir` is the directory the fixture repositories live in; the sessions
 * name `<repoDir>/checkout-service`, which fixtures.sh creates.
 */
import { SessionEventStore } from "../apps/session-service/src/event-store.ts";

const repositoryPath = process.argv[2]!;
const databasePath = process.argv[3]!;

const store = new SessionEventStore({ databasePath });

const HOST = crypto.randomUUID();

const session = (id: string, name: string) => {
  store.append({
    sessionId: id,
    actorId: HOST,
    type: "session.created",
    payload: {
      session: {
        id,
        repositoryPath: `${repositoryPath}/${name}`,
        goal: null,
        status: "active",
        createdAt: new Date().toISOString(),
      },
    },
  });

  return id;
};

const run = (
  sessionId: string,
  runId: string,
  goal: string,
  model = "claude-sonnet-5",
) => {
  store.append({
    sessionId,
    actorId: HOST,
    type: "run.started",
    payload: {
      run: {
        id: runId,
        sessionId,
        goal,
        status: "running",
        startedBy: HOST,
        model: { provider: "anthropic", model },
        createdAt: new Date().toISOString(),
      },
    },
  });
};

const reads = (sessionId: string, runId: string, paths: string[]) => {
  for (const path of paths) {
    const toolCallId = crypto.randomUUID();

    store.append({
      sessionId,
      actorId: HOST,
      type: "tool.requested",
      payload: { runId, call: { id: toolCallId, name: "read_file", input: { path } } },
    });
    store.append({
      sessionId,
      actorId: HOST,
      type: "tool.completed",
      payload: {
        runId,
        result: {
          toolCallId,
          name: "read_file",
          output: { path, content: "// …" },
        },
      },
    });
  }
};

const patch = (
  sessionId: string,
  runId: string,
  path: string,
  additions: number,
  deletions: number,
) => {
  store.append({
    sessionId,
    actorId: HOST,
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: crypto.randomUUID(),
        name: "apply_patch",
        output: {
          patchId: crypto.randomUUID(),
          path,
          status: "applied",
          additions,
          deletions,
        },
      },
    },
  });
};

const tests = (sessionId: string, runId: string, passed: boolean) => {
  store.append({
    sessionId,
    actorId: HOST,
    type: "tool.completed",
    payload: {
      runId,
      result: {
        toolCallId: crypto.randomUUID(),
        name: "run_tests",
        output: {
          command: "pnpm test",
          exitCode: passed ? 0 : 1,
          timedOut: false,
          durationMs: 4_120,
          stdout: passed ? "42 passing" : "40 passing, 2 failing",
          stderr: "",
          truncated: false,
          passed,
        },
      },
    },
  });
};

/* ---------- 1. repository opened, nothing requested ---------- */
const empty = session(crypto.randomUUID(), "checkout-service");

/* ---------- 2/3. an agent actively working ---------- */
const working = session(crypto.randomUUID(), "checkout-service");
const workingRun = crypto.randomUUID();
run(
  working,
  workingRun,
  "Migrate authentication from session cookies to scoped tokens",
);
reads(working, workingRun, [
  "src/auth/session.ts",
  "src/auth/middleware.ts",
  "src/auth/index.ts",
  "src/routes/login.ts",
]);
patch(working, workingRun, "src/auth/tokens.ts", 84, 0);
reads(working, workingRun, ["src/auth/tokens.test.ts"]);

/* ---------- 4. changed, nothing verified ---------- */
const unverified = session(crypto.randomUUID(), "checkout-service");
const unverifiedRun = crypto.randomUUID();
run(
  unverified,
  unverifiedRun,
  "Migrate authentication from session cookies to scoped tokens",
);
reads(unverified, unverifiedRun, ["src/auth/session.ts", "src/auth/middleware.ts"]);
patch(unverified, unverifiedRun, "src/auth/tokens.ts", 84, 0);
patch(unverified, unverifiedRun, "src/auth/middleware.ts", 31, 22);
patch(unverified, unverifiedRun, "src/routes/login.ts", 12, 9);
store.append({
  sessionId: unverified,
  actorId: HOST,
  type: "direction.queued",
  payload: {
    runId: unverifiedRun,
    directionEventId: crypto.randomUUID(),
    direction: "Leave the cookie path in place until the rollout flag is off.",
  },
});
store.append({
  sessionId: unverified,
  actorId: HOST,
  type: "run.completed",
  payload: {
    runId: unverifiedRun,
    summary: "Replaced the cookie session with scoped tokens across three routes.",
  },
});

/* ---------- 5. verified ---------- */
const verified = session(crypto.randomUUID(), "checkout-service");
const verifiedRun = crypto.randomUUID();
run(verified, verifiedRun, "Add rate limiting to the public token endpoint");
reads(verified, verifiedRun, ["src/routes/token.ts"]);
patch(verified, verifiedRun, "src/routes/token.ts", 46, 3);
tests(verified, verifiedRun, true);
store.append({
  sessionId: verified,
  actorId: HOST,
  type: "run.completed",
  payload: { runId: verifiedRun, summary: "Added a token-bucket limiter." },
});

/* ---------- 6. failed before producing changes ---------- */
const failed = session(crypto.randomUUID(), "checkout-service");
const failedRun = crypto.randomUUID();
run(failed, failedRun, "Upgrade the payment SDK to v9");
reads(failed, failedRun, ["package.json"]);
store.append({
  sessionId: failed,
  actorId: HOST,
  type: "run.failed",
  payload: {
    runId: failedRun,
    reason:
      "The provider returned 401: invalid x-api-key. The key in ANTHROPIC_API_KEY was shadowed by the parent environment, so --env-file never applied.",
  },
});

/* ---------- 7. two agents, one mission ---------- */
const twoAgents = session(crypto.randomUUID(), "checkout-service");
const runA = crypto.randomUUID();
const runB = crypto.randomUUID();
run(twoAgents, runA, "Split the billing worker out of the monolith");
run(twoAgents, runB, "Split the billing worker out of the monolith", "gpt-5-codex");
reads(twoAgents, runA, ["src/billing/index.ts", "src/billing/queue.ts"]);
patch(twoAgents, runA, "src/billing/worker.ts", 210, 4);
reads(twoAgents, runB, ["src/billing/index.ts"]);
patch(twoAgents, runB, "src/billing/worker.ts", 96, 12);
tests(twoAgents, runB, false);

process.stdout.write(
  JSON.stringify(
    { empty, working, unverified, verified, failed, twoAgents },
    null,
    2,
  ) + "\n",
);

/* ---------- 8. two agents on one mission: a real fork ---------- */
const forked = session(crypto.randomUUID(), "checkout-service");
const parentRun = crypto.randomUUID();
const forkRun = crypto.randomUUID();
const checkpointId = crypto.randomUUID();
const revision = "a".repeat(40);

run(forked, parentRun, "Split the billing worker out of the monolith");
reads(forked, parentRun, ["src/billing/index.ts", "src/billing/queue.ts"]);
patch(forked, parentRun, "src/billing/worker.ts", 210, 4);

store.append({
  sessionId: forked,
  actorId: HOST,
  type: "checkpoint.created",
  payload: {
    checkpoint: {
      id: checkpointId,
      sessionId: forked,
      parentRunId: parentRun,
      parentSequence: 8,
      base: { revision, patch: null },
      agentState: "Read the queue and the entry point; the worker is next.",
      contextManifest: ["src/billing/index.ts", "src/billing/queue.ts"],
      goal: "Split the billing worker out of the monolith",
      constraints: [],
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      toolPolicy: { allowWrites: true, allowCommands: true },
      budget: { remainingModelCalls: null, remainingTokens: null },
      createdAt: new Date().toISOString(),
    },
  },
});

store.append({
  sessionId: forked,
  actorId: HOST,
  type: "fork.created",
  payload: {
    fork: {
      runId: forkRun,
      sessionId: forked,
      checkpointId,
      parentRunId: parentRun,
      label: "Keep the queue in process",
      worktreePath: "/tmp/novus-fork-1",
      branch: "novus/fork-1",
      revision,
      devPorts: [5310],
      createdAt: new Date().toISOString(),
    },
  },
});

run(forked, forkRun, "Keep the queue in process", "gpt-5-codex");
reads(forked, forkRun, ["src/billing/index.ts"]);
patch(forked, forkRun, "src/billing/worker.ts", 96, 12);
tests(forked, forkRun, false);
store.append({
  sessionId: forked,
  actorId: HOST,
  type: "run.completed",
  payload: { runId: forkRun, summary: "Kept the queue in process." },
});

process.stdout.write(`forked ${forked}\n`);
