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

const BASELINE_RUN = "run-parent";

/**
 * The parent turn the fork branches from.
 *
 * Driven straight into the store rather than run through a model, the same
 * shortcut `files-route.test.ts` takes: what matters here is that the
 * projection has a run for the comparison to call the baseline, not what that
 * run did. Without it `compareAttempts` finds no baseline at all and the
 * baseline half of these tests would be asserting against an empty card.
 */
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

/** Opens a session, forks it once, and edits the fork's answer.txt. */
const withChosenAttempt = async (
  repositoryPath: string,
  allowWrites: boolean,
  run: (context: {
    url: string;
    store: InMemorySessionEventStore;
    sessionId: string;
    runId: string;
  }) => Promise<void>,
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

    store.append(startedRun(created.id, BASELINE_RUN, "Fix the answer."));

    const forked = (await fetch(`${server.url}/sessions/${created.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        label: "Attempt A",
        goal: "Change the answer.",
        parentRunId: BASELINE_RUN,
      }),
    }).then((response) => response.json())) as {
      fork: { runId: string; worktreePath: string };
    };

    await writeFile(join(forked.fork.worktreePath, "answer.txt"), "attempt a\n");

    await run({
      url: server.url,
      store,
      sessionId: created.id,
      runId: forked.fork.runId,
    });
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
        body: JSON.stringify({
          runId,
          rationale: "Nobody without a token gets this far.",
        }),
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
        body: JSON.stringify({
          runId,
          rationale: "Its diff is the smaller one and it kept the old signature.",
        }),
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
        body: JSON.stringify({
          runId,
          rationale: "Right answer, and this session cannot write it out.",
        }),
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
        body: JSON.stringify({
          runId: "not-a-real-fork",
          // A valid rationale on purpose: the 404 has to come from the run id
          // being unknown, not from the body failing validation first.
          rationale: "Naming a run that does not exist should be refused.",
        }),
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

test("a conflicting apply still records the decision, and says the write was blocked", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, store, sessionId, runId }) => {
      // The parent moves under the attempt after it was cut. `apply_patch`'s
      // drift check refuses a file that changed since the proposal, which is
      // the same protection the agent's own writes get.
      await writeFile(join(root, "answer.txt"), "parent, edited since\n");

      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId,
          rationale: "Its approach to the retry budget is the one we want.",
        }),
      });

      // A conflict is not a failed decision. The judgement stands; only the
      // mechanics did not land, and the log has to keep the two apart.
      assert.equal(response.status, 201);

      const body = (await response.json()) as {
        decision: {
          rationale?: string;
          outcome: {
            applied: boolean | string;
            conflicts?: { path: string }[];
          };
        };
      };

      assert.equal(body.decision.outcome.applied, false);
      assert.equal(body.decision.outcome.conflicts?.length, 1);
      assert.match(body.decision.rationale ?? "", /retry budget/);

      // On the log, with its rationale, exactly as a clean apply would be.
      const decided = store
        .list(sessionId)
        .findLast((event) => event.type === "decision.recorded");
      assert.equal(decided?.type, "decision.recorded");
      assert.match(decided.payload.rationale ?? "", /retry budget/);

      // And the parent's own edit was not clobbered on the way to refusing.
      assert.equal(
        await readFile(join(root, "answer.txt"), "utf8"),
        "parent, edited since\n",
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Selecting the baseline — "the current work is the right answer".
 *
 * This was impossible, and why is worth restating: the route resolved every
 * run through the worktree manager, and the baseline is precisely the approach
 * with no fork worktree. So the most ordinary outcome a review can have — none
 * of these alternatives beat what we already had — could not be recorded, and
 * the Decision Room's baseline card said so in its footer. The mission's
 * history stayed silent about the one call a human actually made.
 */
test("the baseline can be selected, and the decision names it as the baseline", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId: BASELINE_RUN,
          rationale:
            "The alternative rewrote the parser for no measured gain; what we have already passes.",
        }),
      });

      assert.equal(response.status, 201);

      const body = (await response.json()) as {
        decision: {
          runId: string;
          target?: string;
          checkpointId?: string;
          alternatives?: string[];
          kind?: string;
          rationale?: string;
          outcome: { applied: boolean | string; reason?: string };
        };
      };

      assert.equal(body.decision.runId, BASELINE_RUN);
      assert.equal(body.decision.target, "baseline");
      assert.equal(body.decision.kind, "adopt");
      assert.match(body.decision.rationale ?? "", /no measured gain/);

      // The comparison context, not just the winner. `checkpointId` is the
      // checkpoint the alternatives were cut from — the shared starting point
      // that is the reason this run is the baseline at all — and
      // `alternatives` is what it was chosen over.
      assert.ok(
        body.decision.checkpointId,
        "the baseline decision does not name the checkpoint that made it the baseline",
      );
      assert.deepEqual(body.decision.alternatives?.length, 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selecting the baseline writes no files, and is not reported as a failed application", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId }) => {
      // Writes are on for this session, so nothing but the baseline's own
      // nature is keeping a write from happening here.
      const before = await readFile(join(root, "answer.txt"), "utf8");

      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId: BASELINE_RUN,
          rationale: "Keeping what is already here; the attempt was not better.",
        }),
      });

      const body = (await response.json()) as {
        decision: { outcome: { applied: boolean | string; reason?: string } };
      };

      // Not `true`: nothing was written, and an empty file list would still be
      // claiming a write. Not `false` either: that is the shape every screen
      // paints as a refused application, and no application was owed.
      assert.equal(body.decision.outcome.applied, "unnecessary");
      assert.notEqual(body.decision.outcome.applied, true);
      assert.notEqual(body.decision.outcome.applied, false);
      assert.match(body.decision.outcome.reason ?? "", /already in the working tree/);

      assert.equal(before, "parent\n");
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), before);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a baseline selection is a completed decision, and survives a refresh with its rationale", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, sessionId, runId }) => {
      await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId: BASELINE_RUN,
          rationale: "The current work already handles the reconnect path.",
        }),
      });

      // A refresh is a fresh GET of the comparison — the request the Decision
      // Room makes on mount. A decision that only lived in the 201 body would
      // vanish here, which is why the comparison carries one at all.
      const comparison = (await fetch(`${url}/sessions/${sessionId}/compare`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then((response) => response.json())) as {
        attempts: { runId: string; baseline: boolean }[];
        decision: {
          runId: string;
          target?: string;
          rationale?: string;
          decidedBy?: string;
          outcome: { applied: boolean | string };
        } | null;
      };

      assert.ok(comparison.decision, "the comparison forgot the decision on reload");
      assert.equal(comparison.decision.runId, BASELINE_RUN);
      assert.equal(comparison.decision.target, "baseline");
      assert.match(comparison.decision.rationale ?? "", /reconnect path/);
      assert.equal(comparison.decision.outcome.applied, "unnecessary");
      // The decider, read off the event's actor. A record of a call nobody
      // made is not a record of a decision.
      assert.equal(comparison.decision.decidedBy, "host");

      // The rejected alternative is still on the screen. Choosing the baseline
      // is not a way of deleting what lost.
      const alternative = comparison.attempts.find(
        (attempt) => attempt.runId === runId,
      );
      assert.ok(alternative, "the rejected alternative left the comparison");
      assert.equal(alternative.baseline, false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected alternatives stay in the event history after the baseline is chosen", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, store, sessionId, runId }) => {
      await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          runId: BASELINE_RUN,
          rationale: "Neither alternative earned the churn it would cost.",
        }),
      });

      const events = store.list(sessionId);

      // The fork that lost is still there, with its label and its parent.
      const fork = events.find(
        (event) =>
          event.type === "fork.created" && event.payload.fork.runId === runId,
      );
      assert.ok(fork, "the rejected alternative was erased from the log");

      // And the decision itself names it, so a reader three weeks later sees
      // what was on the table rather than what happens to exist by then.
      const decided = events.findLast(
        (event) => event.type === "decision.recorded",
      );
      assert.equal(decided?.type, "decision.recorded");
      assert.deepEqual(decided.payload.alternatives, [runId]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The rationale, enforced where it cannot be walked around.
 *
 * It was a React `disabled` attribute and nothing else, so the rule held for
 * exactly one build of one renderer. curl, a stale desktop, or any client
 * written next year wrote rationale-free decisions into a log whose entire
 * purpose is to say why. The form's disabled button is the courtesy; this is
 * the boundary.
 */
test("a decision with no rationale is refused at the route", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, store, sessionId, runId }) => {
      const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId }),
      });

      assert.equal(response.status, 400);

      const body = (await response.json()) as { error: string };
      // The message has to name the actual problem. "A runId is required" was
      // the answer to every rejection, and it would send somebody who wrote
      // three words off to check their run id.
      assert.match(body.error, /rationale/i);

      // Refused, not recorded and then complained about: nothing reached the
      // log, so there is no half-decision for a projection to find.
      assert.equal(
        store.list(sessionId).some((event) => event.type === "decision.recorded"),
        false,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rationale too short to mean anything is refused at the route", async () => {
  const root = await repository();

  try {
    await withChosenAttempt(root, true, async ({ url, store, sessionId, runId }) => {
      // The last of these is eleven characters padded to fifteen. The floor is
      // on the trimmed text, so whitespace is not a way past it.
      for (const rationale of ["ok", "lgtm", "  good enough  "]) {
        const response = await fetch(`${url}/sessions/${sessionId}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ runId, rationale }),
        });

        assert.equal(
          response.status,
          400,
          `a rationale of "${rationale}" was accepted`,
        );
        assert.match(
          ((await response.json()) as { error: string }).error,
          /rationale/i,
        );
      }

      assert.equal(
        store.list(sessionId).some((event) => event.type === "decision.recorded"),
        false,
      );

      // And the floor is exactly the screen's, not a stricter one invented at
      // the boundary: twelve characters is enough, here and there.
      const accepted = await fetch(`${url}/sessions/${sessionId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ runId, rationale: "smaller diff" }),
      });

      assert.equal(accepted.status, 201);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
