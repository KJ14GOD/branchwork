import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter } from "./model.ts";
import { HOST_SESSION, ParticipantRegistry } from "./participants.ts";
import { SessionRegistry } from "./session-registry.ts";

import { isAllowedOrigin, mintAccessToken, offeredToken, tokensMatch } from "./access.ts";
import { startEventServer } from "./event-server.ts";

const TOKEN = "test-token-abcdefghijklmnop";

// `null` is now how a caller says "no gate" out loud — the option is required,
// so forgetting it is a type error rather than an open server.
const withServer = async (
  run: (url: string) => Promise<void>,
  token: string | null = TOKEN,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const server = await startEventServer(store, { port: 0, token });

  try {
    await run(server.url);
  } finally {
    await server.close();
  }
};

test("a minted token is long and unpredictable", () => {
  const first = mintAccessToken();
  const second = mintAccessToken();

  assert.notEqual(first, second);
  // 32 bytes of base64url. Short enough to paste, far past guessing.
  assert.ok(first.length >= 40, `token was only ${first.length} characters`);
});

test("token comparison rejects a prefix and a longer string", () => {
  assert.ok(tokensMatch(TOKEN, TOKEN));
  assert.ok(!tokensMatch(TOKEN, TOKEN.slice(0, -1)));
  assert.ok(!tokensMatch(TOKEN, `${TOKEN}x`));
  assert.ok(!tokensMatch(TOKEN, ""));
});

test("a token is read from either the header or the query", () => {
  const url = new URL("http://127.0.0.1:4319/events?token=from-query");

  assert.equal(offeredToken("Bearer from-header", url), "from-header");
  assert.equal(offeredToken(undefined, url), "from-query");
  assert.equal(
    offeredToken(undefined, new URL("http://127.0.0.1:4319/events")),
    null,
  );
});

test("only loopback origins may ask, and a missing origin is not a page", () => {
  assert.ok(isAllowedOrigin("http://127.0.0.1:5273"));
  assert.ok(isAllowedOrigin("http://localhost:5274"));
  // No Origin header means the caller is not a browser page — curl, the
  // Electron main process, a test — and is judged on its token alone.
  assert.ok(isAllowedOrigin(undefined));

  assert.ok(!isAllowedOrigin("https://evil.example"));
  assert.ok(!isAllowedOrigin("http://127.0.0.1.evil.example"));
  assert.ok(!isAllowedOrigin("file://"));
  assert.ok(!isAllowedOrigin("null"));
});

test("an unauthenticated request is refused", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/sessions`);

    assert.equal(response.status, 401);
  });
});

test("a wrong token is refused", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/sessions`, {
      headers: { authorization: "Bearer not-the-token" },
    });

    assert.equal(response.status, 401);
  });
});

test("the right token is accepted, by header and by query", async () => {
  await withServer(async (url) => {
    const byHeader = await fetch(`${url}/events?session=s1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // EventSource cannot set a header, so the query form has to work too.
    const byQuery = await fetch(`${url}/events?session=s1&token=${TOKEN}`);

    assert.equal(byHeader.status, 200);
    assert.equal(byQuery.status, 200);

    await byHeader.body?.cancel();
    await byQuery.body?.cancel();
  });
});

test("health stays open, because it is how a client finds the worker", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/health`);

    assert.equal(response.status, 200);
    // And it must not leak the credential it is exempt from.
    assert.doesNotMatch(await response.text(), new RegExp(TOKEN));
  });
});

test("a page on a non-loopback origin is refused before its token is read", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/sessions`, {
      headers: {
        origin: "https://evil.example",
        authorization: `Bearer ${TOKEN}`,
      },
    });

    // 403, not 401: the token was valid. The origin is what disqualified it,
    // which is the case that matters — a hostile page cannot borrow a token it
    // somehow learned.
    assert.equal(response.status, 403);
  });
});

test("a refused origin gets no CORS headers either", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/sessions`, {
      headers: { origin: "https://evil.example" },
    });

    // Without these the browser rejects the response even if the server had
    // answered, so the refusal holds on both sides.
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("an allowed origin is reflected, never starred", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/events?session=s1`, {
      headers: {
        origin: "http://localhost:5274",
        authorization: `Bearer ${TOKEN}`,
      },
    });

    // `*` would forbid credentials and let any page read the answer.
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "http://localhost:5274",
    );
    assert.match(response.headers.get("vary") ?? "", /Origin/);

    await response.body?.cancel();
  });
});

test("the event stream is not reachable without a token", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/events?session=anything`);

    // The stream is the whole session history. Before this it answered anyone.
    assert.equal(response.status, 401);
  });
});

test("a worker started without a token still serves, for tests only", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/events?session=s1`);

    assert.equal(response.status, 200);
    await response.body?.cancel();
  }, null);
});


/**
 * The two routes the vulnerability was actually about.
 *
 * The rest of this file tested GET routes, because the helper above builds a
 * server with no session registry — and without one these two return 404
 * whatever the token says, so they would have passed while asserting nothing.
 * "Any site could POST a turn and start an agent run" is the sentence that
 * justified this work, and until now nothing held it.
 */
const withCommandServer = async (
  run: (url: string) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter({ provider: "anthropic", model: "test" }),
    [],
  );
  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });

  try {
    await run(server.url);
  } finally {
    await server.close();
  }
};

test("opening a repository requires the token", async () => {
  await withCommandServer(async (url) => {
    const anonymous = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath: "/tmp" }),
    });

    assert.equal(anonymous.status, 401);

    // And the same request with the token gets past the gate — a 401 for every
    // caller would satisfy the assertion above while breaking the product.
    const authorised = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ repositoryPath: "/definitely/not/a/repository" }),
    });

    assert.notEqual(authorised.status, 401);
  });
});

test("submitting a turn requires the token", async () => {
  await withCommandServer(async (url) => {
    const response = await fetch(`${url}/sessions/any-session/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "do something in this repository" }),
    });

    // This is the drive-by: a page the user merely had open, starting a run.
    assert.equal(response.status, 401);
  });
});

test("a hostile page cannot POST a turn even holding the token", async () => {
  await withCommandServer(async (url) => {
    const response = await fetch(`${url}/sessions/any-session/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ goal: "do something in this repository" }),
    });

    assert.equal(response.status, 403);
  });
});

/**
 * Roles, enforced on the routes rather than merely declared.
 *
 * The registry's own tests prove the capability table is right. These prove the
 * server consults it — which is the part that was decorative until now, because
 * every caller held the same token and the server had no way to tell them apart.
 */
const withParticipants = async (
  run: (context: {
    url: string;
    ownerToken: string;
    add: (
      role: "editor" | "reviewer" | "viewer",
      sessionId?: string,
    ) => string;
  }) => Promise<void>,
): Promise<void> => {
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter({ provider: "anthropic", model: "test" }),
    [],
  );
  const participants = new ParticipantRegistry();
  const ownerToken = "owner-token-abcdefghijklmnop";

  participants.add(
    { sessionId: "host", name: "Host", kind: "human", role: "owner" },
    ownerToken,
  );

  const server = await startEventServer(store, {
    port: 0,
    token: ownerToken,
    sessions,
    participants,
  });

  try {
    await run({
      url: server.url,
      ownerToken,
      add: (role, sessionId = HOST_SESSION) =>
        participants.add({
          sessionId,
          name: role,
          kind: "human",
          role,
        }).token,
    });
  } finally {
    await server.close();
  }
};

test("a viewer may watch and may not steer", async () => {
  await withParticipants(async ({ url, add }) => {
    const viewer = add("viewer");

    const watching = await fetch(`${url}/events?session=s1&token=${viewer}`);
    assert.equal(watching.status, 200);
    await watching.body?.cancel();

    const steering = await fetch(`${url}/sessions/any/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${viewer}`,
      },
      body: JSON.stringify({ goal: "do something" }),
    });

    // 403 and not 401: the token is valid and the person is in the session.
    // What they are is what disqualifies them.
    assert.equal(steering.status, 403);
  });
});

test("a reviewer approves and evaluates, and cannot direct or steer", async () => {
  await withParticipants(async ({ url, add }) => {
    const reviewer = add("reviewer");

    for (const route of ["turns", "direction"]) {
      const response = await fetch(`${url}/sessions/host/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${reviewer}`,
        },
        body: JSON.stringify({ goal: "do it differently" }),
      });

      // README: a reviewer "comments, evaluates, and approves without directly
      // executing", and direction is free text appended to the goal — so
      // granting it would hand this role the power the definition withholds,
      // through a text field.
      assert.equal(response.status, 403, `reviewer reached /${route}`);
    }
  });
});

test("an editor may direct, which is the role that owns it", async () => {
  await withParticipants(async ({ url, add }) => {
    const editor = add("editor");

    const response = await fetch(`${url}/sessions/host/direction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor}`,
      },
      body: JSON.stringify({ goal: "do not change the token schema" }),
    });

    // 404 would be the session id; what matters is that it is not a refusal.
    assert.notEqual(response.status, 403);
  });
});

test("an invite for one session cannot act on another", async () => {
  await withParticipants(async ({ url, add }) => {
    // Bound to a real session, the way an invited participant is. The host's own
    // participant is deliberately exempt — the worker outlives any one session
    // and its owner is the person running it, not a guest of a session — so an
    // editor scoped to "host" would prove nothing here.
    const editor = add("editor", "the-session-they-were-invited-to");

    const elsewhere = await fetch(`${url}/sessions/a-different-session/direction`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor}`,
      },
      body: JSON.stringify({ goal: "steer a session I was not invited to" }),
    });

    assert.equal(elsewhere.status, 403);
  });
});

test("only the owner can invite", async () => {
  await withParticipants(async ({ url, ownerToken, add }) => {
    const editor = add("editor");

    const refused = await fetch(`${url}/sessions/any/invite`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${editor}`,
      },
      body: JSON.stringify({ name: "Someone", role: "viewer" }),
    });
    assert.equal(refused.status, 403);

    const allowed = await fetch(`${url}/sessions/any/invite`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ name: "Someone", role: "viewer" }),
    });
    assert.notEqual(allowed.status, 403);
  });
});

test("a token belonging to nobody is refused even when it looks right", async () => {
  await withParticipants(async ({ url }) => {
    const response = await fetch(`${url}/events?session=s1`, {
      headers: { authorization: "Bearer owner-token-abcdefghijklmnoq" },
    });

    assert.equal(response.status, 401);
  });
});
