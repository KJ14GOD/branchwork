import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });
const TOKEN = "files-route-token-abcdefghijklmnop";

/**
 * The HTTP surface of the changed-files panel: `GET /sessions/:id/files`.
 *
 * Drives events straight into the store rather than through a real model —
 * the same shortcut `replay.test.ts` takes for `projectSession` itself — so
 * this proves the *route* (auth, session lookup, the fork-exclusion filter)
 * without needing a live provider. The aggregation math itself is already
 * `projectSession`'s, covered there; this is what wraps it in HTTP.
 */
const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-files-repo-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "a.ts"), "a\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

const withServer = async (
  repositoryPath: string,
  run: (context: { url: string; store: InMemorySessionEventStore; sessionId: string }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter({ provider: "anthropic", model: "test" }),
    [],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath, allowWrites: true }),
    }).then((response) => response.json())) as { id: string };

    await run({ url: server.url, store, sessionId: created.id });
  } finally {
    await server.close();
  }
};

const appliedPatch = (
  sessionId: string,
  runId: string,
  path: string,
  additions: number,
  deletions: number,
) => ({
  sessionId,
  actorId: "agent-1",
  type: "tool.completed" as const,
  payload: {
    runId,
    result: {
      toolCallId: `c-${path}-${runId}`,
      name: "apply_patch" as const,
      output: {
        patchId: `p-${path}-${runId}`,
        path,
        status: "applied" as const,
        additions,
        deletions,
      },
    },
  },
});

const startedRun = (sessionId: string, runId: string, goal: string) => ({
  sessionId,
  actorId: "agent-1",
  type: "run.started" as const,
  payload: {
    run: {
      id: runId,
      sessionId,
      goal,
      status: "running" as const,
      startedBy: "agent-1",
      model: { provider: "anthropic", model: "test" },
      createdAt: new Date().toISOString(),
    },
  },
});

test("the files route requires the token", async () => {
  const root = await repository();

  try {
    await withServer(root, async ({ url, sessionId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/files`);

      assert.equal(response.status, 401);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session with no applied patches reports no files", async () => {
  const root = await repository();

  try {
    await withServer(root, async ({ url, sessionId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { files: [], additions: 0, deletions: 0 });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files changed across the session's own turns are summed, one entry per path", async () => {
  const root = await repository();

  try {
    await withServer(root, async ({ url, store, sessionId }) => {
      // Two turns (two runs.started), one of them touching a.ts twice — the
      // same "one entry per file, summed" rule projectSession already applies
      // per run should hold across runs too, since this panel is the whole
      // session's story, not one turn's.
      store.append(startedRun(sessionId, "run-1", "First turn"));
      store.append(appliedPatch(sessionId, "run-1", "a.ts", 3, 1));
      store.append(startedRun(sessionId, "run-2", "Second turn"));
      store.append(appliedPatch(sessionId, "run-2", "a.ts", 2, 0));
      store.append(appliedPatch(sessionId, "run-2", "b.ts", 5, 0));

      const response = await fetch(`${url}/sessions/${sessionId}/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = (await response.json()) as {
        files: { path: string; additions: number; deletions: number }[];
        additions: number;
        deletions: number;
      };

      assert.deepEqual(body.files, [
        { path: "a.ts", additions: 5, deletions: 1 },
        { path: "b.ts", additions: 5, deletions: 0 },
      ]);
      assert.equal(body.additions, 10);
      assert.equal(body.deletions, 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork's own changes do not leak into the session's files panel", async () => {
  const root = await repository();

  try {
    await withServer(root, async ({ url, store, sessionId }) => {
      store.append(startedRun(sessionId, "run-1", "First turn"));
      store.append(appliedPatch(sessionId, "run-1", "a.ts", 1, 0));

      const forked = (await fetch(`${url}/sessions/${sessionId}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ label: "Attempt A", goal: "Try something else", parentRunId: "run-1" }),
      }).then((response) => response.json())) as { fork: { runId: string } };

      // The fork's own worktree changes — recorded under the same session id,
      // the way compare.ts already relies on, but this panel is "what changed
      // in the working tree you are looking at", not "everything any attempt
      // ever touched". A run.started for the fork's own run has to exist
      // first: projectSession's tool.completed case looks its runId up and
      // silently no-ops without one, so a fork's applied-patch events would
      // never reach the aggregation at all — and this assertion would pass
      // whether or not the exclusion filter did anything.
      store.append(startedRun(sessionId, forked.fork.runId, "Try something else"));
      store.append(appliedPatch(sessionId, forked.fork.runId, "a.ts", 99, 99));
      store.append(appliedPatch(sessionId, forked.fork.runId, "only-in-fork.ts", 4, 0));

      const response = await fetch(`${url}/sessions/${sessionId}/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = (await response.json()) as {
        files: { path: string; additions: number; deletions: number }[];
      };

      assert.deepEqual(body.files, [{ path: "a.ts", additions: 1, deletions: 0 }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fork's changes stay excluded after the worker that created it is gone", async () => {
  // The prior test only proves exclusion within the process that made the
  // fork — session.forks is an in-memory Map, so that alone would pass even
  // if the route filtered from it instead of from the log. This drops that
  // map entirely: a second server, a fresh SessionRegistry, the same
  // underlying store — the way a real restart leaves the durable log
  // standing and the in-memory registry empty. If exclusion is really
  // derived from fork.created in the log, it survives; if it silently
  // depended on session.forks, this is where that would show up as every
  // fork's files leaking back into the panel.
  const root = await repository();

  try {
    const store = new InMemorySessionEventStore();
    const firstProcess = new SessionRegistry(
      store,
      new FixedModelRouter({ provider: "anthropic", model: "test" }),
      [],
    );
    const serverA = await startEventServer(store, {
      port: 0,
      token: TOKEN,
      sessions: firstProcess,
    });

    let sessionId = "";
    let forkRunId = "";

    try {
      const created = (await fetch(`${serverA.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ repositoryPath: root, allowWrites: true }),
      }).then((response) => response.json())) as { id: string };
      sessionId = created.id;

      store.append(startedRun(sessionId, "run-1", "First turn"));
      store.append(appliedPatch(sessionId, "run-1", "a.ts", 1, 0));

      const forked = (await fetch(`${serverA.url}/sessions/${sessionId}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          label: "Attempt A",
          goal: "Try something else",
          parentRunId: "run-1",
        }),
      }).then((response) => response.json())) as { fork: { runId: string } };
      forkRunId = forked.fork.runId;

      // Required for the same reason noted in the in-process fork test above
      // this one: without its own run.started, projectSession would drop
      // the fork's tool.completed events before the exclusion filter ever
      // saw them, and this test would pass for the wrong reason.
      store.append(startedRun(sessionId, forkRunId, "Try something else"));
      store.append(appliedPatch(sessionId, forkRunId, "only-in-fork.ts", 4, 0));
    } finally {
      await serverA.close();
    }

    // A new process: a SessionRegistry that has never seen this session's
    // fork, or any fork at all — its forks map for this session starts
    // empty, the same as a genuine restart.
    const secondProcess = new SessionRegistry(
      store,
      new FixedModelRouter({ provider: "anthropic", model: "test" }),
      [],
    );
    const serverB = await startEventServer(store, {
      port: 0,
      token: TOKEN,
      sessions: secondProcess,
    });

    try {
      await fetch(`${serverB.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ repositoryPath: root, resume: sessionId }),
      });

      const response = await fetch(`${serverB.url}/sessions/${sessionId}/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = (await response.json()) as {
        files: { path: string; additions: number; deletions: number }[];
      };

      assert.deepEqual(body.files, [{ path: "a.ts", additions: 1, deletions: 0 }]);
      assert.ok(
        !body.files.some((file) => file.path === "only-in-fork.ts"),
        `the fork's file leaked back in after restart: ${JSON.stringify(body.files)}`,
      );
    } finally {
      await serverB.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown session is refused rather than answered with nothing", async () => {
  const root = await repository();

  try {
    await withServer(root, async ({ url }) => {
      const response = await fetch(`${url}/sessions/not-a-real-session/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      assert.equal(response.status, 404);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
