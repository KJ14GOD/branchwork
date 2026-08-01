import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { SessionEvent } from "@novus/contracts";
import { fetchMembership } from "@novus/session-client";

// Reached by path rather than by dependency, deliberately. A joined window
// talks to *somebody else's* worker over HTTP and must never import it —
// declaring `@novus/worker` a dependency of the desktop would make that
// mistake easy to commit. The test needs the real thing on the other end of
// the socket, so it reaches across the workspace for it here and nowhere else.
import { startEventServer } from "../../../worker/src/event-server.ts";
import { FixedModelRouter, type ModelAdapter } from "../../../worker/src/model.ts";
import {
  HOST_SESSION,
  ParticipantRegistry,
} from "../../../worker/src/participants.ts";
import { SessionRegistry } from "../../../worker/src/session-registry.ts";
import { InMemorySessionEventStore } from "../../../session-service/src/session-service.ts";

import {
  answerHandoff,
  completeMission,
  offerControl,
  readAuthority,
  readEvidence,
  readFiles,
  reopenMission,
  requestControl,
  steerRun,
  submitDirection,
  type JoinedTarget,
} from "./joined-api.ts";

/**
 * What a joined window's calls actually do, against the real worker.
 *
 * The renderer tests beside this one pin what is *offered* to whom. They
 * cannot tell you whether the offer is honoured, and a screen that shows a
 * viewer "Request control" is worth nothing if the request 403s. So these
 * drive the same functions the joined tab calls, with real invite tokens,
 * through the real event server, the real SessionRegistry and the real
 * ParticipantRegistry.
 *
 * No provider is contacted. The adapter's `complete` never settles, which is
 * what a test of authority wants: a turn started here stays executing until
 * the test ends, so "a transfer is waiting on a run" is something the test
 * controls rather than races.
 */

// Belt and braces beside the adapter above: nothing here should be able to
// reach Anthropic even if a code path tried.
process.env.ANTHROPIC_API_KEY = "placeholder-not-a-real-key";

const TOKEN = "joined-api-test-token-abcdefghijklmnop";

let enterModel: (() => void) | null = null;
let entered: Promise<void> = Promise.resolve();

const stalledAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  // Parked, and it says when. The run loop drains pending direction at the top
  // of each iteration, and the top of the *first* iteration is a boundary like
  // any other — so a direction posted between `run.started` and the first model
  // call is folded in immediately and correctly, leaving `pendingDirection`
  // empty. That is not the state a test of "queued but not yet applied" is
  // trying to observe, and the window is wide enough under load to fail the
  // gate. Same race, and same fix, as control-lifecycle.test.ts.
  complete: () =>
    new Promise(() => {
      enterModel?.();
    }),
};

type Guest = { target: JoinedTarget; id: string; token: string };

type Context = {
  url: string;
  sessionId: string;
  hostId: string;
  /** The host's own credential, as a target — the host is a participant too. */
  host: JoinedTarget;
  join: (role: "editor" | "reviewer" | "viewer", name?: string) => Promise<Guest>;
  /** A second session on the same worker, for the wrong-session check. */
  otherSession: () => Promise<string>;
  startRun: () => Promise<string>;
  /**
   * Leaves a run paused in the log without going through the loop.
   *
   * A stalled adapter never reaches a pause point, so `POST /pause` is
   * accepted and the run never actually records `run.paused` — and `resume`
   * refuses a run that is not paused, on state rather than on rank. This sets
   * the precondition the way the loop itself would have left it, exactly as
   * `pause-resume-route.test.ts` does, so what the editor's resume proves is
   * authority rather than timing.
   */
  pauseInLog: (runId: string) => void;
  /** The host's log, for asserting what a joined window's call actually wrote. */
  log: (sessionId: string) => SessionEvent[];
  /**
   * A run that changed a file, checked it, and then changed it again.
   *
   * The stale-green shape, written straight into the log: a check followed by
   * an edit is the case where a screen computing its own verdict says green
   * and the receipt says unverified.
   */
  patchAndCheck: () => void;
};

const withSession = async (
  run: (context: Context) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(stalledAdapter.selection),
    [stalledAdapter],
  );
  const participants = new ParticipantRegistry();

  const host = participants.add(
    { sessionId: HOST_SESSION, name: "Kartik", kind: "human", role: "owner" },
    TOKEN,
  );

  const server = await startEventServer(store, {
    port: 0,
    token: TOKEN,
    sessions,
    participants,
  });

  const open = async (): Promise<string> => {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    return created.id;
  };

  try {
    const sessionId = await open();

    const join = async (
      role: "editor" | "reviewer" | "viewer",
      name = `${role}-guest`,
    ): Promise<Guest> => {
      const body = (await fetch(
        `${server.url}/sessions/${sessionId}/invite`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({ name, role }),
        },
      ).then((response) => response.json())) as {
        token: string;
        participant: { id: string };
      };

      return {
        target: { endpoint: server.url, sessionId, token: body.token },
        id: body.participant.id,
        token: body.token,
      };
    };

    const hostTarget: JoinedTarget = {
      endpoint: server.url,
      sessionId,
      token: TOKEN,
    };

    /**
     * Starts a turn and waits until the run is actually executing.
     *
     * The route answers 202 before the runner has appended run.started — a
     * turn is accepted, not completed — so a test that assumed the run was
     * live the moment the response arrived would be racing the queue.
     */
    const startRun = async (): Promise<string> => {
      // Armed before the turn is submitted, so a run that reaches the model
      // faster than this function does cannot slip past the signal.
      entered = new Promise<void>((settle) => {
        enterModel = settle;
      });

      const accepted = await fetch(
        `${server.url}/sessions/${sessionId}/turns`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({ goal: "a goal whose model call never returns" }),
        },
      );

      assert.equal(accepted.status, 202, await accepted.text());

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const running = (await readAuthority(hostTarget))?.executingRunIds[0];

        if (running !== undefined) {
          // Parked inside the model call, past the first boundary, where a
          // direction can only be queued rather than immediately drained.
          await entered;
        }

        if (running !== undefined) {
          return running;
        }

        await delay(10);
      }

      assert.fail("the run never started");
    };

    await run({
      url: server.url,
      sessionId,
      hostId: host.participant.id,
      host: hostTarget,
      join,
      otherSession: open,
      startRun,
      pauseInLog: (runId) => {
        store.append({
          sessionId,
          actorId: "agent-1",
          type: "run.paused",
          payload: { runId },
        });
      },
      log: (of) => store.list(of),
      patchAndCheck: () => {
        const runId = "run-evidence";

        store.append({
          sessionId,
          actorId: "agent-1",
          type: "run.started",
          payload: {
            run: {
              id: runId,
              sessionId,
              goal: "Fix the rounding bug.",
              status: "running",
              startedBy: "agent-1",
              model: { provider: "anthropic", model: "test" },
              createdAt: new Date().toISOString(),
            },
          },
        });

        const patch = (path: string, id: string) =>
          store.append({
            sessionId,
            actorId: "agent-1",
            type: "tool.completed",
            payload: {
              runId,
              result: {
                toolCallId: id,
                name: "apply_patch",
                output: {
                  patchId: `patch-${id}`,
                  path,
                  status: "applied",
                  additions: 2,
                  deletions: 1,
                },
              },
            },
          });

        patch("src/tax.ts", "c1");

        store.append({
          sessionId,
          actorId: "agent-1",
          type: "tool.completed",
          payload: {
            runId,
            result: {
              toolCallId: "c2",
              name: "run_tests",
              output: {
                command: "pnpm test",
                exitCode: 0,
                timedOut: false,
                durationMs: 10,
                stdout: "",
                stderr: "",
                truncated: false,
                passed: true,
              },
            },
          },
        });

        // The edit that makes the green check describe a tree that is gone.
        patch("src/refund.ts", "c3");
      },
    });
  } finally {
    await server.close();
  }
};

/** What /me says this token is right now — a handoff changes the answer. */
const roleOf = async (target: JoinedTarget): Promise<string | null> => {
  const report = await fetchMembership(
    target.endpoint,
    target.sessionId,
    target.token,
    new AbortController().signal,
  );

  return report.kind === "ok" ? report.participant.role : null;
};

test("a viewer can ask for control, and the ask is recorded as pending", async () => {
  await withSession(async ({ join }) => {
    const viewer = await join("viewer");

    const asked = await requestControl(viewer.target, "I have context on this");

    assert.equal(asked.ok, true, asked.ok ? "" : asked.error);

    // Asking is not taking. The worker records a standing fact and control has
    // not moved — this is the distinction the button must never blur.
    const authority = await readAuthority(viewer.target);

    assert.equal(authority?.you, viewer.id);
    assert.notEqual(authority?.controlHeldBy, viewer.id);
    assert.equal(authority?.controlRequests.length, 1);
    assert.equal(authority?.controlRequests[0]?.participantId, viewer.id);
    assert.equal(
      authority?.controlRequests[0]?.reason,
      "I have context on this",
    );
  });
});

test("a viewer can neither direct nor steer, and is told so by the worker", async () => {
  await withSession(async ({ join, startRun }) => {
    const viewer = await join("viewer");
    const runId = await startRun();

    const directed = await submitDirection(viewer.target, "prefer the smaller change");
    const paused = await steerRun(viewer.target, "pause", runId);

    assert.equal(directed.ok, false);
    assert.equal(paused.ok, false);

    // The refusal names the role rather than failing anonymously — a joined
    // window shows this text verbatim.
    assert.match(directed.ok ? "" : directed.error, /viewer cannot direct/);
    assert.match(paused.ok ? "" : paused.error, /viewer cannot steer/);
  });
});

test("an editor can direct, and a live run commits to the direction", async () => {
  await withSession(async ({ join, host, startRun }) => {
    const editor = await join("editor");
    const runId = await startRun();

    const directed = await submitDirection(editor.target, "add a test for it");

    assert.equal(directed.ok, true, directed.ok ? "" : directed.error);

    const authority = await readAuthority(host);
    const pending = authority?.pendingDirection[0];

    // Queued, not merely recorded: the run in flight folds it in at its next
    // turn. The two are different promises to whoever typed it.
    assert.equal(pending?.direction, "add a test for it");
    assert.equal(pending?.queuedForRunId, runId);
  });
});

test("an editor can pause, resume and cancel a run in flight", async () => {
  await withSession(async ({ join, startRun, pauseInLog }) => {
    const editor = await join("editor");
    const runId = await startRun();

    const paused = await steerRun(editor.target, "pause", runId);
    assert.equal(paused.ok, true, paused.ok ? "" : paused.error);

    pauseInLog(runId);

    const resumed = await steerRun(editor.target, "resume", runId);
    assert.equal(resumed.ok, true, resumed.ok ? "" : resumed.error);

    const cancelled = await steerRun(editor.target, "cancel", runId);
    assert.equal(cancelled.ok, true, cancelled.ok ? "" : cancelled.error);
  });
});

test("resume is refused on state, not on rank — the editor got past authority", async () => {
  await withSession(async ({ join, startRun }) => {
    const editor = await join("editor");
    const runId = await startRun();

    const resumed = await steerRun(editor.target, "resume", runId);

    // The distinction the joined window depends on: this editor is allowed to
    // resume and there is simply nothing paused to resume. If the role check
    // ever moved, this would read "a editor cannot steer" instead — a
    // different message the panel would show verbatim.
    assert.equal(resumed.ok, false);
    assert.match(resumed.ok ? "" : resumed.error, /not paused/);
  });
});

test("the participant an offer names can accept it, and /me changes with it", async () => {
  await withSession(async ({ join, host, hostId }) => {
    const editor = await join("editor");

    const offered = await offerControl(host, editor.id);
    assert.equal(offered.ok, true, offered.ok ? "" : offered.error);

    const pending = await readAuthority(editor.target);
    assert.equal(pending?.controlOffer?.state, "offered");
    assert.equal(pending?.controlHeldBy, hostId);

    const accepted = await answerHandoff(
      editor.target,
      pending!.controlOffer!.offerEventId,
      "accept",
    );
    assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error);

    // Control moved, and the roles moved with it. This is what makes the
    // joined window's controls change without a reload: both polls answer
    // differently on their next tick, with no event of their own to catch.
    const after = await readAuthority(editor.target);
    assert.equal(after?.controlHeldBy, editor.id);
    assert.equal(after?.controlOffer, null);

    assert.equal(await roleOf(editor.target), "owner");
    assert.equal(await roleOf(host), "editor");
  });
});

test("the newly promoted controller can hand control onward, and take the offer back", async () => {
  await withSession(async ({ join, host, hostId }) => {
    const editor = await join("editor");

    await offerControl(host, editor.id);
    const offered = await readAuthority(editor.target);
    await answerHandoff(
      editor.target,
      offered!.controlOffer!.offerEventId,
      "accept",
    );

    // The promotion is real, not cosmetic: offering control needs `transfer`,
    // which this token did not have a moment ago.
    const handedBack = await offerControl(editor.target, hostId);
    assert.equal(handedBack.ok, true, handedBack.ok ? "" : handedBack.error);

    const inFlight = await readAuthority(editor.target);
    assert.equal(inFlight?.controlOffer?.fromParticipantId, editor.id);

    const withdrawn = await answerHandoff(
      editor.target,
      inFlight!.controlOffer!.offerEventId,
      "withdraw",
    );
    assert.equal(withdrawn.ok, true, withdrawn.ok ? "" : withdrawn.error);

    const settled = await readAuthority(editor.target);
    assert.equal(settled?.controlOffer, null);
    assert.equal(settled?.controlHeldBy, editor.id);
  });
});

test("the participant an offer names can decline it, and control stays put", async () => {
  await withSession(async ({ join, host, hostId }) => {
    const editor = await join("editor");

    await offerControl(host, editor.id);
    const offered = await readAuthority(editor.target);

    const declined = await answerHandoff(
      editor.target,
      offered!.controlOffer!.offerEventId,
      "decline",
    );
    assert.equal(declined.ok, true, declined.ok ? "" : declined.error);

    const after = await readAuthority(editor.target);
    assert.equal(after?.controlOffer, null);
    assert.equal(after?.controlHeldBy, hostId);
    assert.equal(await roleOf(editor.target), "editor");
  });
});

test("a bystander cannot answer somebody else's offer", async () => {
  await withSession(async ({ join, host, hostId }) => {
    const editor = await join("editor");
    const bystander = await join("editor", "third-party");

    await offerControl(host, editor.id);
    const offered = await readAuthority(bystander.target);

    // The bystander can see it — an offer is a fact about the session, not a
    // private message — and cannot settle it.
    assert.equal(offered?.controlOffer?.toParticipantId, editor.id);

    for (const answer of ["accept", "decline", "withdraw"] as const) {
      const attempted = await answerHandoff(
        bystander.target,
        offered!.controlOffer!.offerEventId,
        answer,
      );

      assert.equal(attempted.ok, false, `a bystander was allowed to ${answer}`);
    }

    assert.equal((await readAuthority(host))?.controlHeldBy, hostId);
  });
});

test("an acceptance during a live run waits on the boundary rather than moving", async () => {
  await withSession(async ({ join, host, hostId, startRun }) => {
    const editor = await join("editor");
    const runId = await startRun();

    await offerControl(host, editor.id);
    const offered = await readAuthority(editor.target);
    await answerHandoff(
      editor.target,
      offered!.controlOffer!.offerEventId,
      "accept",
    );

    const waiting = await readAuthority(editor.target);

    // The middle state, as the joined panel renders it: agreed, not yet moved,
    // and naming the run that is holding it.
    assert.equal(waiting?.controlOffer?.state, "accepted");
    assert.equal(waiting?.controlHeldBy, hostId);
    assert.deepEqual(waiting?.executingRunIds, [runId]);
  });
});

test("an invite for one session cannot read or act on another", async () => {
  await withSession(async ({ join, otherSession, url }) => {
    const editor = await join("editor");
    const elsewhere = await otherSession();
    const crossed: JoinedTarget = {
      endpoint: url,
      sessionId: elsewhere,
      token: editor.token,
    };

    // Null covers the refusal the same way an absent registry does, which is
    // the point: the joined window shows nobody in control rather than
    // somebody else's session.
    assert.equal(await readAuthority(crossed), null);

    const asked = await requestControl(crossed);
    const directed = await submitDirection(crossed, "not your session");

    assert.equal(asked.ok, false);
    assert.equal(directed.ok, false);
  });
});

test("a joined window can read the mission's changes and its verdict", async () => {
  await withSession(async ({ join }) => {
    const reviewer = await join("reviewer");

    // Both reads are `watch`, which every participant has — this is the
    // evidence a teammate is being asked to agree a mission on, and a joined
    // window could reach none of it before.
    const files = await readFiles(reviewer.target);
    const evidence = await readEvidence(reviewer.target);

    assert.ok(files, "a reviewer could not read the changed files");
    assert.deepEqual(files.files, []);
    assert.ok(evidence, "a reviewer could not read the verdict");
    assert.equal(evidence.verification, "unverified");
    assert.equal(evidence.checksRun, 0);
  });
});

test("the panel's verdict is the one the record would freeze", async () => {
  await withSession(async ({ join, sessionId, log, patchAndCheck }) => {
    const editor = await join("editor");

    // Green checks, then a later change: the case where a panel computing its
    // own numbers said verified and the record said unverified.
    patchAndCheck();

    const panel = await readEvidence(editor.target);

    assert.equal(panel?.verification, "unverified");

    await completeMission(
      editor.target,
      "resolved",
      "Calling it done with the suite out of date.",
    );

    const frozen = log(sessionId).find(
      (event) => event.type === "mission.completed",
    );

    assert.ok(frozen && frozen.type === "mission.completed");
    // One computation, not two that agree. This assertion is the guarantee.
    assert.equal(frozen.payload.verification, panel?.verification);
    assert.equal(frozen.payload.filesChanged, panel?.filesChanged);
  });
});

test("an invite for one session reads no evidence from another", async () => {
  await withSession(async ({ join, otherSession, url }) => {
    const editor = await join("editor");
    const crossed: JoinedTarget = {
      endpoint: url,
      sessionId: await otherSession(),
      token: editor.token,
    };

    assert.equal(await readFiles(crossed), null);
    assert.equal(await readEvidence(crossed), null);
  });
});

test("a reviewer can finish the mission, and the worker states the evidence", async () => {
  await withSession(async ({ join, sessionId, log }) => {
    const reviewer = await join("reviewer");

    const finished = await completeMission(
      reviewer.target,
      "resolved",
      "The rounding is fixed and we walked the checkout by hand.",
    );

    assert.equal(finished.ok, true, finished.ok ? "" : finished.error);

    const completed = log(sessionId).find(
      (event) => event.type === "mission.completed",
    );

    assert.ok(completed && completed.type === "mission.completed");
    assert.equal(completed.payload.outcome, "resolved");
    assert.equal(completed.actorId, reviewer.id);
    // The joined window sent an outcome and a sentence. It did not send this,
    // and could not have: nothing ran, so nothing is claimed.
    assert.equal(completed.payload.verification, "unverified");
    assert.equal(completed.payload.filesChanged, 0);
  });
});

test("a viewer cannot finish a mission, and is told so in the worker's words", async () => {
  await withSession(async ({ join }) => {
    const viewer = await join("viewer");

    const finished = await completeMission(
      viewer.target,
      "abandoned",
      "A viewer trying to close somebody else's mission.",
    );

    assert.equal(finished.ok, false);
    assert.match(finished.ok ? "" : finished.error, /viewer cannot approve/);
  });
});

test("a summary that says nothing is refused at the boundary, not in React", async () => {
  await withSession(async ({ join }) => {
    const editor = await join("editor");

    const finished = await completeMission(editor.target, "resolved", "done");

    assert.equal(finished.ok, false);
    // The message the joined window shows verbatim. A client-side length check
    // is a courtesy; this is the rule.
    assert.match(
      finished.ok ? "" : finished.error,
      /at least 12 characters/,
    );
  });
});

test("finishing twice is refused, and reopening is the way to change an ending", async () => {
  await withSession(async ({ join }) => {
    const editor = await join("editor");
    const summary = "The tax rounding is fixed and checkout works again.";

    assert.equal((await completeMission(editor.target, "resolved", summary)).ok, true);

    const again = await completeMission(editor.target, "abandoned", summary);

    assert.equal(again.ok, false);
    assert.match(again.ok ? "" : again.error, /Reopen it before finishing/);

    const reopened = await reopenMission(
      editor.target,
      "The refund path regressed, so this is not finished after all.",
    );

    assert.equal(reopened.ok, true, reopened.ok ? "" : reopened.error);

    // Completing is a trapdoor if this fails: the second ending is the whole
    // point of being able to reopen.
    assert.equal(
      (await completeMission(editor.target, "abandoned", summary)).ok,
      true,
    );
  });
});

test("a live mission cannot be reopened", async () => {
  await withSession(async ({ join }) => {
    const editor = await join("editor");

    const reopened = await reopenMission(
      editor.target,
      "Reopening a mission that was never finished.",
    );

    assert.equal(reopened.ok, false);
    assert.match(reopened.ok ? "" : reopened.error, /nothing to reopen/);
  });
});
