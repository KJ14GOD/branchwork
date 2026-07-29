import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveEndpoint } from "./endpoint.ts";
import { describeConnection } from "./timeline.ts";
import { fetchSessions } from "./worker-api.ts";

const refused = (raw: string): string => {
  const check = resolveEndpoint(raw);

  assert.equal(check.kind, "refused", `${raw} should have been refused`);

  return check.kind === "refused" ? check.reason : "";
};

const accepted = (raw: string): string => {
  const check = resolveEndpoint(raw);

  assert.equal(check.kind, "ok", `${raw} should have been accepted`);

  return check.kind === "ok" ? check.endpoint : "";
};

test("a worker on this machine is accepted, normalised to its origin", () => {
  assert.equal(accepted("http://127.0.0.1:4319"), "http://127.0.0.1:4319");
  assert.equal(accepted("http://localhost:4319/"), "http://localhost:4319");
  assert.equal(accepted("http://[::1]:4319"), "http://[::1]:4319");
  assert.equal(accepted("  http://127.0.0.1:4319  "), "http://127.0.0.1:4319");
  assert.equal(accepted("https://127.0.0.1:4319"), "https://127.0.0.1:4319");
});

test("an endpoint somewhere other than this machine is refused by name", () => {
  // The whole attack is a link: a guest handed ?endpoint=https://evil.example
  // would render that host's frames inside a Novus window under a read-only
  // badge, and keep beaconing to it. Nothing leaks, and it is still a lie.
  const reason = refused("https://evil.example");

  assert.match(reason, /evil\.example/);
  assert.match(reason, /127\.0\.0\.1/);

  // A hostname that merely starts or ends with a loopback name is not one.
  refused("http://127.0.0.1.evil.example");
  refused("http://localhost.evil.example:4319");
  refused("http://evil.example/127.0.0.1");
  // Bound on every interface is not the same as bound to this one.
  refused("http://0.0.0.0:4319");
  refused("http://10.0.0.4:4319");
});

test("only http and https reach a worker", () => {
  assert.match(refused("file:///etc/passwd"), /http/);
  refused("javascript:alert(1)");
  refused("data:text/html,<h1>novus</h1>");
  refused("ws://127.0.0.1:4319");
});

test("credentials and paths are refused rather than trimmed off", () => {
  // http://127.0.0.1@evil.example resolves to evil.example, so the host check
  // alone is not enough to make the address mean what it looks like.
  refused("http://127.0.0.1@evil.example");
  refused("http://user:secret@127.0.0.1:4319");
  refused("http://127.0.0.1:4319/some/prefix");
});

test("a mistyped endpoint is refused, not carried into new URL", () => {
  // This is the bug: ?endpoint=nonsense 404s on /sessions, is read as a worker
  // that does not list sessions, and then throws Invalid URL out of an
  // unawaited async block — leaving the screen saying "locating" forever.
  const reason = refused("nonsense");

  assert.match(reason, /nonsense/);
  assert.match(reason, /http:\/\/127\.0\.0\.1:4319/);
  assert.match(refused(""), /No worker address/);
  refused("   ");
  refused("//evil.example");
});

test("a refused endpoint is never contacted", async () => {
  const original = globalThis.fetch;

  globalThis.fetch = () => {
    throw new Error("The guest contacted a refused endpoint.");
  };

  try {
    const listing = await fetchSessions(
      "https://evil.example",
      new AbortController().signal,
    );

    assert.equal(listing.kind, "refused");
  } finally {
    globalThis.fetch = original;
  }
});

test("a refused endpoint ends in a stated failure, not a stuck locating", () => {
  const stopped = describeConnection(
    { kind: "stopped", reason: "evil.example is not this machine." },
    "https://evil.example",
    "abc",
  );
  const locating = describeConnection(
    { kind: "locating" },
    "https://evil.example",
    "abc",
  );

  // "locating" is the state that reads as progress. A guest that cannot
  // proceed must not sit in it, and must say why in the sentence itself.
  assert.equal(stopped.tone, "error");
  assert.notEqual(stopped.label, locating.label);
  assert.match(stopped.emptyTimeline, /evil\.example is not this machine/);
  assert.match(stopped.emptyTimeline, /not because the run is quiet/);
});
