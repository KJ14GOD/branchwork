import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * Finishing a mission, over the wire the desktop actually uses.
 *
 * The events landed before these routes did: `mission.completed` and
 * `mission.reopened` existed in the contract and in the projection with nothing
 * able to append them. What is worth pinning here is not that a 201 comes back
 * — it is the three things a later change could quietly undo and still pass a
 * happy-path test:
 *
 * 1. The evidence on the event is the worker's, never the caller's. A client
 *    that could state `verification` could finish a mission as verified having
 *    run nothing, which is the one thing STEERING says this product does not do.
 * 2. Ending a mission is `approve`, so a reviewer can and a viewer cannot, and
 *    an invite to one session cannot end another.
 * 3. Finishing twice and reopening a live mission are refused rather than
 *    quietly succeeding.
 *
 * Nothing here reaches a provider: the adapter never settles, so a run started
 * through it stays running for as long as a test needs it to.
 */

const TOKEN = "mission-route-token-abcdefghijklmnop";

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

type Invited = { token: string; id: string };

const withSession = async (
  run: (context: {
    url: string;
    store: InMemorySessionEventStore;
    sessionId: string;
    invite: (role: "editor" | "reviewer" | "viewer") => Promise<Invited>;
    open: () => Promise<string>;
  }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const participants = new ParticipantRegistry();

  participants.add(
    { sessionId: HOST_SESSION, name: "Host", kind: "human", role: "owner" },
    TOKEN,
  );

  const server = await startEventServer(store, {
    port: 0,
    token: TOKEN,
    sessions,
    participants,
  });

  const open = async (): Promise<string> =>
    (
      (await fetch(`${server.url}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ repositoryPath: process.cwd() }),
      }).then((response) => response.json())) as { id: string }
    ).id;

  try {
    const sessionId = await open();

    const invite = async (
      role: "editor" | "reviewer" | "viewer",
    ): Promise<Invited> => {
      const body = (await fetch(`${server.url}/sessions/${sessionId}/invite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ name: `${role}-guest`, role }),
      }).then((response) => response.json())) as {
        token: string;
        participant: { id: string };
      };

      return { token: body.token, id: body.participant.id };
    };

    await run({ url: server.url, store, sessionId, invite, open });
  } finally {
    await server.close();
  }
};

const post = (
  url: string,
  token: string | null,
  body: unknown,
): Promise<Response> =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const finish = (
  url: string,
  sessionId: string,
  token: string | null,
  body: unknown = {
    outcome: "resolved",
    summary: "The rounding bug is fixed and the checkout test passes again.",
  },
): Promise<Response> =>
  post(`${url}/sessions/${sessionId}/complete`, token, body);

/** A run driven straight into the store, the shortcut the other route tests take. */
const startedRun = (sessionId: string, runId: string) => ({
  sessionId,
  actorId: "agent-1",
  type: "run.started" as const,
  payload: {
    run: {
      id: runId,
      sessionId,
      goal: "Fix the rounding bug.",
      status: "running" as const,
      startedBy: "agent-1",
      model: { provider: "anthropic", model: "test" },
      createdAt: new Date().toISOString(),
    },
  },
});

const appliedPatch = (sessionId: string, runId: string, path: string) => ({
  sessionId,
  actorId: "agent-1",
  type: "tool.completed" as const,
  payload: {
    runId,
    result: {
      toolCallId: `call-${path}`,
      name: "apply_patch" as const,
      output: {
        patchId: `patch-${path}`,
        path,
        status: "applied" as const,
        additions: 3,
        deletions: 1,
      },
    },
  },
});

const ranTests = (sessionId: string, runId: string, passed: boolean) => ({
  sessionId,
  actorId: "agent-1",
  type: "tool.completed" as const,
  payload: {
    runId,
    result: {
      toolCallId: `call-tests-${passed}`,
      name: "run_tests" as const,
      output: {
        command: "pnpm test",
        exitCode: passed ? 0 : 1,
        timedOut: false,
        durationMs: 12,
        stdout: "",
        stderr: "",
        truncated: false,
        passed,
      },
    },
  },
});

/** A typecheck or lint run, which verifies a tree exactly as a test suite does. */
const ranDiagnostics = (
  sessionId: string,
  runId: string,
  ok: boolean,
  id = "call-diagnostics",
) => ({
  sessionId,
  actorId: "agent-1",
  type: "tool.completed" as const,
  payload: {
    runId,
    result: {
      toolCallId: id,
      name: "run_diagnostics" as const,
      output: {
        kind: "typecheck" as const,
        command: "pnpm typecheck",
        exitCode: ok ? 0 : 1,
        timedOut: false,
        durationMs: 20,
        ok,
        diagnostics: [],
        diagnosticsTruncated: false,
        raw: "",
        rawTruncated: false,
      },
    },
  },
});

const completions = (
  store: InMemorySessionEventStore,
  sessionId: string,
): Extract<SessionEvent, { type: "mission.completed" }>[] =>
  store
    .list(sessionId)
    .filter(
      (event): event is Extract<SessionEvent, { type: "mission.completed" }> =>
        event.type === "mission.completed",
    );

test("finishing a mission requires the token", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    const response = await finish(url, sessionId, null);

    assert.equal(response.status, 401);
    assert.equal(completions(store, sessionId).length, 0);
  });
});

test("finishing an unknown session is a 404", async () => {
  await withSession(async ({ url }) => {
    assert.equal((await finish(url, "no-such-session", TOKEN)).status, 404);
  });
});

test("the host finishes a mission and the log carries the outcome", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    const response = await finish(url, sessionId, TOKEN, {
      outcome: "resolved",
      summary: "The rounding bug is fixed and the checkout test passes again.",
    });

    assert.equal(response.status, 201);

    const [event] = completions(store, sessionId);

    assert.ok(event);
    assert.equal(event.payload.outcome, "resolved");
    assert.match(event.payload.summary, /rounding bug/);
    // A mission does not finish itself.
    assert.equal(event.actorId, event.payload.actorId);
  });
});

test("a mission finished on no evidence is unverified, never verified", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    await finish(url, sessionId, TOKEN, {
      outcome: "resolved",
      summary: "Shipped it by hand; the agent only found the file.",
    });

    const [event] = completions(store, sessionId);

    // The whole rule, in one assertion: finishing is not verifying. Nothing
    // ran, so nothing is claimed.
    assert.equal(event?.payload.verification, "unverified");
    assert.equal(event?.payload.filesChanged, 0);
  });
});

test("the evidence frozen onto the event is the worker's, not the caller's", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.test.ts"));
    store.append(ranTests(sessionId, "run-1", false));

    const response = await finish(url, sessionId, TOKEN, {
      outcome: "resolved",
      summary: "Calling it done even though the suite is red.",
      // A client stating its own evidence. Ignored — this is the shape of the
      // bug the payload comment in contracts.ts exists to prevent.
      verification: "verified",
      filesChanged: 99,
    });

    assert.equal(response.status, 201);

    const [event] = completions(store, sessionId);

    assert.equal(event?.payload.verification, "failing");
    assert.equal(event?.payload.filesChanged, 2);
  });
});

test("a check that went green before the last change does not freeze as verified", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    store.append(ranTests(sessionId, "run-1", true));
    // The edit that outdates the green suite. `receipt.ts` refuses to call
    // this verified — "a check that ran before the final edit describes a tree
    // that no longer exists" — and the mission's own verdict has to agree, or
    // the receipt and the completion describe one session and disagree.
    store.append(appliedPatch(sessionId, "run-1", "src/refund.ts"));

    await finish(url, sessionId, TOKEN, {
      outcome: "resolved",
      summary: "Shipping it with the suite one edit out of date.",
    });

    const [event] = completions(store, sessionId);

    assert.equal(event?.payload.verification, "unverified");
    assert.equal(event?.payload.filesChanged, 2);
  });
});

test("a check that ran after the last change is what verified means", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    store.append(ranTests(sessionId, "run-1", true));

    await finish(url, sessionId, TOKEN);

    assert.equal(completions(store, sessionId)[0]?.payload.verification, "verified");
  });
});

test("a mission verified by a typecheck is verified, not unchecked", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    // Build, typecheck and lint verify a tree as much as a suite does, and the
    // receipt has always counted them. Counting only `run_tests` reported a
    // mission checked by `pnpm typecheck` as checked by nothing.
    store.append(ranDiagnostics(sessionId, "run-1", true));

    await finish(url, sessionId, TOKEN);

    assert.equal(completions(store, sessionId)[0]?.payload.verification, "verified");
  });
});

test("a failing check outranks a missing one", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    store.append(ranDiagnostics(sessionId, "run-1", false));
    // A later green test does not bury the earlier failure: `failing` is a
    // fact and `unverified` is the absence of one, so the fact wins.
    store.append(ranTests(sessionId, "run-1", true));

    await finish(url, sessionId, TOKEN);

    assert.equal(completions(store, sessionId)[0]?.payload.verification, "failing");
  });
});

test("a fork's green checks do not verify the mission they were cut from", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    store.append(startedRun(sessionId, "run-fork"));
    store.append({
      sessionId,
      actorId: "host",
      type: "fork.created",
      payload: {
        fork: {
          runId: "run-fork",
          sessionId,
          parentRunId: "run-1",
          checkpointId: "cp-1",
          label: "Attempt A",
          worktreePath: "/tmp/novus-fork",
          branch: "novus/attempt-a",
          revision: "abc1234",
          devPorts: [5301],
          createdAt: new Date().toISOString(),
        },
      },
    });
    store.append(ranTests(sessionId, "run-fork", true));

    await finish(url, sessionId, TOKEN);

    // A fork's checks are about its own worktree. The parent took neither the
    // changes nor the proof.
    assert.equal(
      completions(store, sessionId)[0]?.payload.verification,
      "unverified",
    );
    assert.equal(completions(store, sessionId)[0]?.payload.filesChanged, 1);
  });
});

test("the verdict a window reads is the verdict the record freezes", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    store.append(startedRun(sessionId, "run-1"));
    store.append(appliedPatch(sessionId, "run-1", "src/tax.ts"));
    store.append(ranTests(sessionId, "run-1", true));
    store.append(appliedPatch(sessionId, "run-1", "src/refund.ts"));

    const read = (await fetch(`${url}/sessions/${sessionId}/evidence`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json())) as {
      verification: string;
      filesChanged: number;
      checksRun: number;
      checksPassed: number;
    };

    await finish(url, sessionId, TOKEN);

    const [event] = completions(store, sessionId);

    // One function, two callers. Not two computations that agree today.
    assert.equal(read.verification, "unverified");
    assert.equal(read.checksRun, 1);
    assert.equal(read.checksPassed, 1);
    assert.equal(event?.payload.verification, read.verification);
    assert.equal(event?.payload.filesChanged, read.filesChanged);
  });
});

test("a summary shorter than a sentence is refused with a message about the summary", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    const response = await finish(url, sessionId, TOKEN, {
      outcome: "resolved",
      summary: "done",
    });

    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /summary needs at least 12 characters/,
    );
    assert.equal(completions(store, sessionId).length, 0);
  });
});

test("a summary past the ceiling is told about the ceiling, not about the floor", async () => {
  await withSession(async ({ url, sessionId }) => {
    const response = await finish(url, sessionId, TOKEN, {
      outcome: "resolved",
      summary: "x".repeat(2_001),
    });

    assert.equal(response.status, 400);

    const { error } = (await response.json()) as { error: string };

    // "Needs at least 12 characters — string must contain at most 2000" is a
    // message that argues with itself, which is what one branch for every
    // non-type failure produced.
    assert.match(error, /longer than 2,000 characters/);
    assert.doesNotMatch(error, /at least 12/);
  });
});

test("a missing summary says what a summary is for", async () => {
  await withSession(async ({ url, sessionId }) => {
    const response = await finish(url, sessionId, TOKEN, {
      outcome: "abandoned",
    });

    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /needs a summary/,
    );
  });
});

test("a mission ends as resolved or abandoned and as nothing else", async () => {
  await withSession(async ({ url, sessionId }) => {
    const response = await finish(url, sessionId, TOKEN, {
      outcome: "shipped",
      summary: "This outcome is not one of the two that exist.",
    });

    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /resolved or abandoned/,
    );
  });
});

test("a reviewer may end a mission — the judgement is not the host's alone", async () => {
  await withSession(async ({ url, sessionId, invite, store }) => {
    const reviewer = await invite("reviewer");

    const response = await finish(url, sessionId, reviewer.token, {
      outcome: "abandoned",
      summary: "This approach cannot work; the API does not expose the field.",
    });

    assert.equal(response.status, 201);
    assert.equal(completions(store, sessionId)[0]?.actorId, reviewer.id);
  });
});

test("a viewer cannot end a mission, and nothing lands when they try", async () => {
  await withSession(async ({ url, sessionId, invite, store }) => {
    const viewer = await invite("viewer");

    const response = await finish(url, sessionId, viewer.token, {
      outcome: "abandoned",
      summary: "A viewer trying to close somebody else's mission.",
    });

    assert.equal(response.status, 403);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /viewer cannot approve/,
    );
    assert.equal(completions(store, sessionId).length, 0);
  });
});

test("an invite to one mission cannot end another", async () => {
  await withSession(async ({ url, sessionId, invite, open, store }) => {
    const editor = await invite("editor");
    const other = await open();

    const response = await finish(url, other, editor.token, {
      outcome: "abandoned",
      summary: "Ending a mission this invite was never issued for.",
    });

    assert.equal(response.status, 403);
    // Asserting on the log rather than on the status, because the status alone
    // passes against a worker with the session-scope check deleted: an editor
    // carries `approve`, so the capability table would let this through and
    // only the scope check refuses it.
    assert.equal(completions(store, other).length, 0);
    assert.equal(completions(store, sessionId).length, 0);
  });
});

test("a mission cannot be finished twice", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    assert.equal((await finish(url, sessionId, TOKEN)).status, 201);

    const again = await finish(url, sessionId, TOKEN, {
      outcome: "abandoned",
      summary: "Changing my mind about how this mission ended.",
    });

    assert.equal(again.status, 409);
    assert.match(
      ((await again.json()) as { error: string }).error,
      /Reopen it before finishing it again/,
    );
    assert.equal(completions(store, sessionId).length, 1);
  });
});

test("a live mission cannot be reopened, because it was never closed", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    const response = await post(`${url}/sessions/${sessionId}/reopen`, TOKEN, {
      reason: "Reopening something that is not finished.",
    });

    assert.equal(response.status, 409);
    assert.equal(
      store
        .list(sessionId)
        .filter((event) => event.type === "mission.reopened").length,
      0,
    );
  });
});

test("reopening a finished mission puts it back in flight, and it can end again", async () => {
  await withSession(async ({ url, sessionId, store }) => {
    await finish(url, sessionId, TOKEN);

    const reopened = await post(`${url}/sessions/${sessionId}/reopen`, TOKEN, {
      reason: "The fix regressed the refund path, so this is not finished.",
    });

    assert.equal(reopened.status, 201);

    // Completing is a trapdoor if this fails: the second ending is what makes
    // reopening more than a note on the log.
    assert.equal((await finish(url, sessionId, TOKEN)).status, 201);
    assert.equal(completions(store, sessionId).length, 2);
  });
});

test("reopening needs a reason of its own", async () => {
  await withSession(async ({ url, sessionId }) => {
    await finish(url, sessionId, TOKEN);

    const response = await post(`${url}/sessions/${sessionId}/reopen`, TOKEN, {
      reason: "oops",
    });

    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /reason needs at least 12 characters/,
    );
  });
});

test("a viewer cannot reopen a mission either", async () => {
  await withSession(async ({ url, sessionId, invite, store }) => {
    await finish(url, sessionId, TOKEN);

    const viewer = await invite("viewer");
    const response = await post(
      `${url}/sessions/${sessionId}/reopen`,
      viewer.token,
      { reason: "A viewer trying to undo somebody else's ending." },
    );

    assert.equal(response.status, 403);
    assert.equal(
      store
        .list(sessionId)
        .filter((event) => event.type === "mission.reopened").length,
      0,
    );
  });
});
