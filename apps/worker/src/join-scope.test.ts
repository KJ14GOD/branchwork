import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, type ModelAdapter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";
import { startEventServer } from "./event-server.ts";

/**
 * What joining a session does and does not grant.
 *
 * The desktop app now joins a session with an invite token the same way the
 * browser guest watches one, so the worker is the place that decides what a
 * joined client can actually do: act inside the invited session at the
 * invited role, and nothing about the host's machine beyond it. These tests
 * pin both halves — the role is enforced per capability, and the two routes
 * that are about the *host* rather than about a session (opening a
 * repository, reading the whole session history) refuse any invited caller
 * regardless of role.
 */

const TOKEN = "join-scope-token-abcdefghijklmnopqrstu";

const noopAdapter: ModelAdapter = {
  selection: { provider: "anthropic", model: "test" },
  complete: () => new Promise(() => undefined),
};

const withSession = async (
  run: (context: {
    url: string;
    sessionId: string;
    invite: (
      role: "editor" | "reviewer" | "viewer",
    ) => Promise<{ token: string; id: string }>;
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

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    const invite = async (
      role: "editor" | "reviewer" | "viewer",
    ): Promise<{ token: string; id: string }> => {
      const body = (await fetch(`${server.url}/sessions/${created.id}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name: `${role}-guest`, role }),
      }).then((response) => response.json())) as {
        token: string;
        participant: { id: string };
      };

      return { token: body.token, id: body.participant.id };
    };

    await run({ url: server.url, sessionId: created.id, invite });
  } finally {
    await server.close();
  }
};

test("/me tells the host they are the owner", async () => {
  await withSession(async ({ url, sessionId }) => {
    const response = await fetch(`${url}/sessions/${sessionId}/me`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { participant: { role: string } };
    assert.equal(body.participant.role, "owner");
  });
});

test("/me tells a joined viewer they are a viewer, by their own participant id", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const viewer = await invite("viewer");

    const response = await fetch(`${url}/sessions/${sessionId}/me`, {
      headers: { authorization: `Bearer ${viewer.token}` },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      participant: { id: string; role: string };
    };
    assert.equal(body.participant.id, viewer.id);
    assert.equal(body.participant.role, "viewer");
  });
});

test("/me follows a handoff — the roles a joined window shows move with the authority", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const editor = await invite("editor");

    const handoff = await fetch(`${url}/sessions/${sessionId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ toParticipantId: editor.id }),
    });

    assert.equal(handoff.status, 200);

    const joiner = (await fetch(`${url}/sessions/${sessionId}/me`, {
      headers: { authorization: `Bearer ${editor.token}` },
    }).then((response) => response.json())) as { participant: { role: string } };

    assert.equal(joiner.participant.role, "owner");

    const host = (await fetch(`${url}/sessions/${sessionId}/me`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((response) => response.json())) as { participant: { role: string } };

    assert.equal(host.participant.role, "editor");
  });
});

test("/me is scoped to the invited session, like every other session route", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const viewer = await invite("viewer");

    const other = (await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    assert.notEqual(other.id, sessionId);

    const crossed = await fetch(`${url}/sessions/${other.id}/me`, {
      headers: { authorization: `Bearer ${viewer.token}` },
    });

    assert.equal(crossed.status, 403);
  });
});

test("/me 404s when nobody was ever invited — single-player has nobody to be", async () => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter(noopAdapter.selection),
    [noopAdapter],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    }).then((response) => response.json())) as { id: string };

    const response = await fetch(`${server.url}/sessions/${created.id}/me`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("a joined participant cannot open a repository on the host, whatever their role", async () => {
  await withSession(async ({ url, invite }) => {
    // A reviewer and a viewer are stopped by the capability table itself —
    // POST /sessions asks for "steer", which neither holds. The editor is the
    // case the host-only check exists for: "steer" is a real editor
    // capability, so before the check an invited editor could open any path
    // on the host's filesystem as a new session.
    for (const role of ["editor", "reviewer", "viewer"] as const) {
      const joined = await invite(role);

      const response = await fetch(`${url}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${joined.token}`,
        },
        body: JSON.stringify({ repositoryPath: process.cwd() }),
      });

      assert.equal(response.status, 403, `${role} should be refused`);

      if (role === "editor") {
        const body = (await response.json()) as { error: string };
        assert.match(body.error, /Only the host/);
      }
    }
  });
});

test("the host can still open a repository after inviting people", async () => {
  await withSession(async ({ url, invite }) => {
    await invite("editor");

    const response = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repositoryPath: process.cwd() }),
    });

    assert.equal(response.status, 201);
  });
});

test("a joined participant cannot read the host's session history", async () => {
  await withSession(async ({ url, invite }) => {
    const viewer = await invite("viewer");

    const refused = await fetch(`${url}/sessions/history`, {
      headers: { authorization: `Bearer ${viewer.token}` },
    });

    assert.equal(refused.status, 403);

    const host = await fetch(`${url}/sessions/history`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(host.status, 200);
  });
});

test("a joined session enforces the joiner's role, not the host's", async () => {
  await withSession(async ({ url, sessionId, invite }) => {
    const viewer = await invite("viewer");
    const editor = await invite("editor");

    // The viewer watches and nothing else: direction and steering both 403.
    const viewerDirects = await fetch(`${url}/sessions/${sessionId}/direction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewer.token}`,
      },
      body: JSON.stringify({ goal: "Please do something else" }),
    });

    assert.equal(viewerDirects.status, 403);

    const viewerCancels = await fetch(`${url}/sessions/${sessionId}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewer.token}`,
      },
      body: JSON.stringify({ runId: "any" }),
    });

    assert.equal(viewerCancels.status, 403);

    // The editor's direction is accepted — the same window, a different
    // token, a different answer, which is the whole point of roles.
    const editorDirects = await fetch(`${url}/sessions/${sessionId}/direction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor.token}`,
      },
      body: JSON.stringify({ goal: "Do not change the token schema" }),
    });

    assert.equal(editorDirects.status, 202);

    // Inviting stays with the owner — an editor cannot widen the room.
    const editorInvites = await fetch(`${url}/sessions/${sessionId}/invite`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor.token}`,
      },
      body: JSON.stringify({ name: "someone", role: "viewer" }),
    });

    assert.equal(editorInvites.status, 403);
  });
});
