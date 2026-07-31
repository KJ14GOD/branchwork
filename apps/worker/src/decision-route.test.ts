import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter } from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });
const TOKEN = "decision-route-token-abcdefghijklmn";

/**
 * The HTTP surface of choosing an attempt: the route the desktop actually
 * calls, not just the function underneath it. These prove the token and
 * capability gates apply to `/decision` the way they apply to every other
 * command, and that a session with writes off still gets a decision on the
 * record even though nothing is written.
 */
const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-decision-repo-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "answer.txt"), "parent\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

/** Opens a session, forks it once, and edits the fork's answer.txt. */
const withChosenAttempt = async (
  repositoryPath: string,
  allowWrites: boolean,
  run: (context: { url: string; sessionId: string; runId: string }) => Promise<void>,
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
      body: JSON.stringify({ repositoryPath, allowWrites }),
    }).then((response) => response.json())) as { id: string };

    const forked = (await fetch(`${server.url}/sessions/${created.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        label: "Attempt A",
        goal: "Change the answer.",
        parentRunId: "run-parent",
      }),
    }).then((response) => response.json())) as {
      fork: { runId: string; worktreePath: string };
    };

    await writeFile(join(forked.fork.worktreePath, "answer.txt"), "attempt a\n");

    await run({ url: server.url, sessionId: created.id, runId: forked.fork.runId });
  } finally {
    await server.close();
  }
};

test("choosing an attempt requires the token", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId, runId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });

      assert.equal(response.status, 401);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("choosing an attempt records a decision and applies it when writes are on", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId, runId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        decision: { runId: string; outcome: { applied: boolean } };
      };
      assert.equal(body.decision.runId, runId);
      assert.equal(body.decision.outcome.applied, true);

      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "attempt a\n");

      const comparison = (await fetch(`${url}/sessions/${sessionId}/compare`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then((response) => response.json())) as { decision: { runId: string } | null };

      assert.equal(comparison.decision?.runId, runId);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session with writes off still records the decision, but does not apply it", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, false, async ({ url, sessionId, runId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        decision: { outcome: { applied: boolean; reason?: string } };
      };
      assert.equal(body.decision.outcome.applied, false);
      assert.match(body.decision.outcome.reason ?? "", /not enabled/);

      // Recorded, but the parent's working tree is untouched.
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown attempt is refused rather than silently ignored", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId: "not-a-real-fork" }),
      });

      assert.equal(response.status, 404);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requesting a revision writes nothing and cuts a new approach carrying the feedback", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId, runId }) => {
      const before = await readFile(join(root, "answer.txt"), "utf8");

      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId,
          kind: "revision",
          rationale: "Right shape, but it drops the retry budget on reconnect.",
        }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        decision: { kind: string; outcome: { applied: boolean } };
        revisionRunId?: string;
        revisionError?: string;
      };

      // Asking for another pass is not adopting. Nothing may reach the tree.
      assert.equal(body.decision.kind, "revision");
      assert.equal(body.decision.outcome.applied, false);
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), before);

      // And it is not merely a note: the feedback becomes an approach, so the
      // revision and the thing it revises can be compared rather than one
      // quietly replacing the other.
      assert.equal(body.revisionError, undefined);
      assert.ok(body.revisionRunId, "no revision approach was started");
      assert.notEqual(body.revisionRunId, runId);

      const comparison = (await fetch(`${url}/sessions/${sessionId}/compare`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then((response) => response.json())) as {
        attempts: { runId: string; label: string }[];
      };

      const revision = comparison.attempts.find(
        (attempt) => attempt.runId === body.revisionRunId,
      );
      assert.ok(revision, "the revision is not among the approaches");
      assert.match(revision.label, /revised/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeping exploring records the decision and writes nothing", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId, runId }) => {
      const before = await readFile(join(root, "answer.txt"), "utf8");

      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId,
          kind: "exploration",
          rationale: "Neither approach covers the reconnect path yet.",
        }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        decision: { kind: string; outcome: { applied: boolean } };
        revisionRunId?: string;
      };

      assert.equal(body.decision.kind, "exploration");
      assert.equal(body.decision.outcome.applied, false);

      // Nothing written and nothing started: "keep exploring" says the work is
      // not finished, not that a particular next attempt was asked for.
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), before);
      assert.equal(body.revisionRunId, undefined);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
