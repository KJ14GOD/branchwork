import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * Who may settle a comparison.
 *
 * `/decision` was not in the route table, so it fell through to the trailing
 * default and inherited `steer` — the capability for pausing, cancelling and
 * resuming a run in flight. Those are reversible instructions to something
 * still moving. Deciding is the last word on which work survives, and while
 * selection and application share this one route it is also a write into the
 * repository. Every editor invited to a mission was silently its final
 * authority, and could put files in the host's tree by choosing an attempt.
 *
 * These drive the real HTTP surface with real invites. Each refusal is written
 * so that it fails if the `decide` capability is removed — a 403 that a caller
 * would have got anyway, on some other rule, proves nothing. That mistake has
 * been made on this repository before: an invite-scope test used a viewer, who
 * is refused on role alone, and passed with the scope check deleted.
 */

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });
const TOKEN = "decision-authority-token-abcdefghijkl";

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-decide-repo-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "answer.txt"), "parent\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

type Context = {
  url: string;
  sessionId: string;
  otherSessionId: string;
  runId: string;
  /** A participant of this session whose role permits deciding. */
  ownerToken: string;
  editorToken: string;
  reviewerToken: string;
  viewerToken: string;
  /** An owner — of the *other* session. Role permits; scope must not. */
  foreignOwnerToken: string;
};

const withRoles = async (
  repositoryPath: string,
  body: (context: Context) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter({ provider: "anthropic", model: "test" }),
    [],
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

  const open = async (): Promise<string> => {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath, allowWrites: true }),
    }).then((response) => response.json())) as { id: string };

    return created.id;
  };

  const invite = async (sessionId: string, role: string): Promise<string> => {
    const invited = (await fetch(`${server.url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: `A ${role}`, role }),
    }).then((response) => response.json())) as { token: string };

    return invited.token;
  };

  try {
    const sessionId = await open();
    const otherSessionId = await open();

    const forked = (await fetch(`${server.url}/sessions/${sessionId}/fork`, {
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

    // An owner scoped to *this* session, which is the state a control handoff
    // leaves behind: `transferOwnership` moves the owner role onto a
    // session-scoped participant. The invite route deliberately refuses to
    // mint one, so it is added directly.
    const owner = participants.add({
      sessionId,
      name: "Controller",
      kind: "human",
      role: "owner",
    });

    // And an owner of the other session. The whole point of this one is that
    // its *role* permits deciding, so a refusal can only be about scope.
    const foreign = participants.add({
      sessionId: otherSessionId,
      name: "Owner elsewhere",
      kind: "human",
      role: "owner",
    });

    await body({
      url: server.url,
      sessionId,
      otherSessionId,
      runId: forked.fork.runId,
      ownerToken: owner.token,
      editorToken: await invite(sessionId, "editor"),
      reviewerToken: await invite(sessionId, "reviewer"),
      viewerToken: await invite(sessionId, "viewer"),
      foreignOwnerToken: foreign.token,
    });
  } finally {
    await server.close();
  }
};

const decide = (
  url: string,
  sessionId: string,
  token: string,
  runId: string,
): Promise<Response> =>
  fetch(`${url}/sessions/${sessionId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      runId,
      rationale: "Its diff is smaller and the tests it added actually ran.",
    }),
  });

test("the controller of a session can settle its comparison", async () => {
  const root = await repository();

  try {
    await withRoles(root, async ({ url, sessionId, runId, ownerToken }) => {
      const response = await decide(url, sessionId, ownerToken, runId);

      assert.equal(response.status, 201);

      const body = (await response.json()) as {
        decision: { runId: string; outcome: { applied: boolean | string } };
      };
      assert.equal(body.decision.runId, runId);
      // The baseline for every refusal below: this route really does work for
      // somebody, so a 403 elsewhere is about that caller and not about the
      // route being broken.
      assert.equal(body.decision.outcome.applied, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an editor cannot decide merely because it can steer", async () => {
  const root = await repository();

  try {
    await withRoles(root, async ({ url, sessionId, runId, editorToken }) => {
      // First, proof that this editor genuinely holds `steer`. Cancelling a
      // run that does not exist answers 409 from inside the handler, which
      // means the capability gate let it through. Without this the refusal
      // below could just be an editor who cannot do anything.
      const steering = await fetch(`${url}/sessions/${sessionId}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${editorToken}`,
        },
        body: JSON.stringify({ runId: "no-such-run" }),
      });

      assert.equal(
        steering.status,
        409,
        "this editor does not hold steer, so refusing the decision proves nothing",
      );

      const response = await decide(url, sessionId, editorToken, runId);

      assert.equal(response.status, 403);
      // The capability by name. If `/decision` slid back to inheriting
      // `steer`, this editor would be allowed and the status assertion above
      // would already have caught it — but naming it here also catches the
      // subtler regression where the route is gated on some *other*
      // capability an editor happens to lack.
      assert.match(
        ((await response.json()) as { error: string }).error,
        /cannot decide/,
      );

      // And nothing was written on the way to being refused.
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reviewer cannot apply code indirectly by settling the comparison", async () => {
  const root = await repository();

  try {
    await withRoles(root, async ({ url, sessionId, runId, reviewerToken }) => {
      const response = await decide(url, sessionId, reviewerToken, runId);

      assert.equal(response.status, 403);
      // Named, deliberately. A reviewer lacks `steer` as well, so a bare 403
      // would still be returned by the old code and this test would pass
      // against the bug it exists to stop. The *reason* is what distinguishes
      // them: "cannot decide" only exists once deciding is its own capability.
      assert.match(
        ((await response.json()) as { error: string }).error,
        /cannot decide/,
      );

      // The point of the refusal: a role defined as approving without directly
      // executing must not get a write into the host's tree through the one
      // route that both selects and applies.
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a viewer cannot decide", async () => {
  const root = await repository();

  try {
    await withRoles(root, async ({ url, sessionId, runId, viewerToken }) => {
      const response = await decide(url, sessionId, viewerToken, runId);

      assert.equal(response.status, 403);
      assert.match(
        ((await response.json()) as { error: string }).error,
        /cannot decide/,
      );
      assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an owner of one session cannot decide in another on the same worker", async () => {
  const root = await repository();

  try {
    await withRoles(
      root,
      async ({ url, sessionId, otherSessionId, runId, foreignOwnerToken }) => {
        // The baseline that makes this test mean something: this caller's role
        // does permit deciding. A viewer here would be refused on rank alone
        // and the test would pass with the scope check deleted — which is
        // exactly how an earlier invite-scope test managed to prove nothing.
        const own = await fetch(`${url}/sessions/${otherSessionId}/compare`, {
          headers: { authorization: `Bearer ${foreignOwnerToken}` },
        });
        assert.equal(own.status, 200);

        const response = await decide(url, sessionId, foreignOwnerToken, runId);

        assert.equal(response.status, 403);
        assert.match(
          ((await response.json()) as { error: string }).error,
          /different session/,
        );
        assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "parent\n");
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
