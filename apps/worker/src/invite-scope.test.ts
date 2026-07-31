import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * An invite is for one session, and only that session.
 *
 * The capability table only ever asked what *role* a caller held, never which
 * session they were invited to. So a viewer invited to watch one repository
 * could read and act on any other session the same worker was hosting, just
 * by knowing its id — and knowing it is not hard, since it is in the URL of
 * every link the host has ever pasted.
 *
 * Worth being precise about the shape: this was not a broken permission
 * check, it was a *missing* one. Every role check passed, correctly, on a
 * request that should never have been evaluated against that session at all.
 *
 * The host is deliberately exempt. The worker outlives any one session and
 * its owner is the person running it, not a guest of a session — scoping the
 * host to a single session id would break opening a second repository.
 */

const TOKEN = "invite-scope-host-token-abcdefghijkl";

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

const withTwoSessions = async (
  run: (context: {
    url: string;
    mine: string;
    theirs: string;
    guestToken: string;
    editorToken: string;
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

  const open = async (): Promise<string> => {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    return created.id;
  };

  try {
    const mine = await open();
    const theirs = await open();

    // A real invite, minted the way the product mints one: a viewer, scoped
    // by the server to the session it was issued for.
    const invited = (await fetch(`${server.url}/sessions/${mine}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "Teammate", role: "viewer" }),
    }).then((response) => response.json())) as { token: string };

    // An editor of `mine` as well. The action test needs a caller whose role
    // *would* permit the call, or a refusal proves only that viewers cannot
    // steer — which the role table already guarantees without any scoping.
    const editor = (await fetch(`${server.url}/sessions/${mine}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "Editor", role: "editor" }),
    }).then((response) => response.json())) as { token: string };

    await run({
      url: server.url,
      mine,
      theirs,
      guestToken: invited.token,
      editorToken: editor.token,
    });
  } finally {
    await server.close();
  }
};

test("an invite works on the session it was issued for", async () => {
  await withTwoSessions(async ({ url, mine, guestToken }) => {
    const response = await fetch(`${url}/sessions/${mine}/files`, {
      headers: { authorization: `Bearer ${guestToken}` },
    });

    // Baseline. Without this the refusals below could be a token that simply
    // does not work anywhere, which would prove nothing about scoping.
    assert.equal(response.status, 200);
  });
});

test("an invite cannot read another session on the same worker", async () => {
  await withTwoSessions(async ({ url, theirs, guestToken }) => {
    for (const path of ["files", "compare", "presence"]) {
      const response = await fetch(`${url}/sessions/${theirs}/${path}`, {
        headers: { authorization: `Bearer ${guestToken}` },
      });

      assert.equal(
        response.status,
        403,
        `GET /sessions/:id/${path} leaked another session to a guest of a different one`,
      );
    }
  });
});

test("an invite cannot act on another session on the same worker", async () => {
  await withTwoSessions(async ({ url, mine, theirs, editorToken }) => {
    // Baseline first: this editor really can act on its own session, so the
    // refusals below are about *which* session and not about the role. An
    // earlier version of this test used a viewer and passed with the scoping
    // check deleted — it had been proving the role table worked, not this.
    const allowed = await fetch(`${url}/sessions/${mine}/direction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify({ goal: "Steer my own run" }),
    });

    assert.equal(allowed.status, 202);

    const post = (path: string, body: unknown) =>
      fetch(`${url}/sessions/${theirs}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${editorToken}`,
        },
        body: JSON.stringify(body),
      });

    // Every one of these would otherwise be judged only on the caller's role,
    // against a session they were never invited to.
    const turns = await post("turns", { goal: "Do something in someone else's repo" });
    const direction = await post("direction", { goal: "Steer someone else's run" });
    assert.equal(turns.status, 403);
    assert.equal(direction.status, 403);
  });
});

test("the host is not scoped to one session, because the worker is not", async () => {
  await withTwoSessions(async ({ url, mine, theirs }) => {
    // The exemption is load-bearing rather than a loophole: scoping the host
    // the same way would stop them opening a second repository in their own
    // worker, which is the ordinary case.
    for (const id of [mine, theirs]) {
      const response = await fetch(`${url}/sessions/${id}/files`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      assert.equal(response.status, 200);
    }
  });
});
