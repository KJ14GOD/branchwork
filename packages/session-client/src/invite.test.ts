import assert from "node:assert/strict";
import test from "node:test";

import { parseInvite } from "./invite.ts";

const FALLBACK = "http://127.0.0.1:4319";

test("a worker invite carries session and token", () => {
  const checked = parseInvite(
    "http://127.0.0.1:5274/?session=abc-123&token=tok-1",
    FALLBACK,
  );

  assert.equal(checked.kind, "ok");
  assert.deepEqual(checked.kind === "ok" && checked.invite, {
    kind: "worker",
    endpoint: "http://127.0.0.1:4319",
    sessionId: "abc-123",
    token: "tok-1",
  });
});

test("an explicit endpoint in the invite wins over the fallback", () => {
  const checked = parseInvite(
    `http://127.0.0.1:5274/?endpoint=${encodeURIComponent("http://127.0.0.1:4471")}&session=s&token=t`,
    FALLBACK,
  );

  assert.equal(checked.kind, "ok");
  assert.equal(
    checked.kind === "ok" && checked.invite.kind === "worker"
      ? checked.invite.endpoint
      : null,
    "http://127.0.0.1:4471",
  );
});

test("a worker invite pointing off this machine is refused before contact", () => {
  const checked = parseInvite(
    `http://127.0.0.1:5274/?endpoint=${encodeURIComponent("http://192.168.1.20:4319")}&session=s&token=t`,
    FALLBACK,
  );

  assert.equal(checked.kind, "refused");
  assert.match(checked.kind === "refused" ? checked.reason : "", /not this machine/);
});

test("a relay invite yields the relay and the token, and no session id", () => {
  const checked = parseInvite(
    `http://127.0.0.1:5274/?relay=${encodeURIComponent("wss://relay.example:4400")}&token=watch-1`,
    FALLBACK,
  );

  assert.deepEqual(checked, {
    kind: "ok",
    invite: { kind: "relay", relay: "wss://relay.example:4400", token: "watch-1" },
  });
});

test("a plaintext relay off this machine is refused — desktop or not, the wire is the same", () => {
  const checked = parseInvite(
    `http://127.0.0.1:5274/?relay=${encodeURIComponent("ws://relay.example:4400")}&token=watch-1`,
    FALLBACK,
  );

  assert.equal(checked.kind, "refused");
  assert.match(checked.kind === "refused" ? checked.reason : "", /wss:\/\//);
});

test("a loopback ws relay stays legal, because there is no path to be on", () => {
  const checked = parseInvite(
    `http://127.0.0.1:5274/?relay=${encodeURIComponent("ws://127.0.0.1:4400")}&token=watch-1`,
    FALLBACK,
  );

  assert.equal(checked.kind, "ok");
});

test("a link with no token is refused with the reason", () => {
  const checked = parseInvite("http://127.0.0.1:5274/?session=abc", FALLBACK);

  assert.equal(checked.kind, "refused");
  assert.match(checked.kind === "refused" ? checked.reason : "", /no token/);
});

test("a link with a token but neither session nor relay is refused", () => {
  const checked = parseInvite("http://127.0.0.1:5274/?token=t", FALLBACK);

  assert.equal(checked.kind, "refused");
  assert.match(checked.kind === "refused" ? checked.reason : "", /nothing to join/);
});

test("text that is not a URL is refused, not guessed at", () => {
  const checked = parseInvite("join my session please", FALLBACK);

  assert.equal(checked.kind, "refused");
});

test("an empty paste asks for the link rather than erroring", () => {
  const checked = parseInvite("   ", FALLBACK);

  assert.equal(checked.kind, "refused");
  assert.match(checked.kind === "refused" ? checked.reason : "", /Paste the invite/);
});

test("when a link carries both relay and session, the relay wins — a relay serves the session its token authorises", () => {
  const checked = parseInvite(
    `http://127.0.0.1:5274/?relay=${encodeURIComponent("ws://127.0.0.1:4400")}&session=ignored&token=t`,
    FALLBACK,
  );

  assert.equal(checked.kind, "ok");
  assert.equal(checked.kind === "ok" ? checked.invite.kind : null, "relay");
});
