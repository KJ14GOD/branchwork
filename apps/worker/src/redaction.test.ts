import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventSchema, type SessionEvent } from "@novus/contracts";

import {
  createRedactor,
  looksLikeSecretName,
  redactionMarker,
} from "./redaction.ts";

// Not a real key: the prefix is real, the body is keyboard noise.
const PROVIDER_KEY =
  "sk-ant-api03-Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefGHIJKL";

const commandEvent = (
  command: string,
  stdout: string,
  stderr = "",
): SessionEvent =>
  SessionEventSchema.parse({
    eventId: "event-1",
    sessionId: "session-1",
    sequence: 3,
    actorId: "agent-1",
    occurredAt: "2026-07-29T10:00:00.000Z",
    type: "tool.completed",
    payload: {
      runId: "run-1",
      result: {
        toolCallId: "call-1",
        name: "run_command",
        output: {
          command,
          exitCode: 0,
          timedOut: false,
          durationMs: 12,
          stdout,
          stderr,
          truncated: false,
        },
      },
    },
  });

test("a name is secret word-wise, not by substring", () => {
  for (const name of ["API_KEY", "apiKey", "x-auth-token", "DB_PASSWORD"]) {
    assert.equal(looksLikeSecretName(name), true, name);
  }

  for (const name of ["AUTHOR", "KEYWORD", "MONKEY", "path", "command"]) {
    assert.equal(looksLikeSecretName(name), false, name);
  }
});

test("a known key in command output never reaches the outbound event", () => {
  const redactor = createRedactor({
    environment: { ANTHROPIC_API_KEY: PROVIDER_KEY },
  });

  const shared = redactor.redactEvent(
    commandEvent("bash -c env", `ANTHROPIC_API_KEY=${PROVIDER_KEY}\n`),
  );

  const serialised = JSON.stringify(shared);

  assert.equal(serialised.includes(PROVIDER_KEY), false);
  assert.equal(serialised.includes("sk-ant-"), false);
  assert.match(serialised, /redacted/);
});

test("an OpenAI key is redacted the same way, both by name and by the wider sk- shape", () => {
  // Not a real key: the prefix is real, the body is keyboard noise. OpenAI
  // keys need no adapter-specific redaction rule — tools.ts's environment
  // scrub already matches on the OPENAI_API_KEY *name*
  // (/KEY|TOKEN|SECRET|.../i), and redaction.ts's sk- pattern already covers
  // "the wider sk- family," not only Anthropic's sk-ant- prefix.
  const openaiKey = "sk-proj-Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefGHIJKL";
  const redactor = createRedactor({
    environment: { OPENAI_API_KEY: openaiKey },
  });

  const shared = redactor.redactEvent(
    commandEvent("bash -c env", `OPENAI_API_KEY=${openaiKey}\n`),
  );

  const serialised = JSON.stringify(shared);

  assert.equal(serialised.includes(openaiKey), false);
  assert.equal(serialised.includes("sk-proj-"), false);
  assert.match(serialised, /redacted/);
});

test("a key is redacted by shape even when the worker never held it", () => {
  // The environment is empty: nothing here is a *known* secret. A key printed
  // by a command that read it from somewhere else must still not get out.
  const redactor = createRedactor({ environment: {} });

  const shared = redactor.redactEvent(
    commandEvent(
      "grep -r sk- .",
      `config.ts:  const client = new Anthropic({ apiKey: "${PROVIDER_KEY}" });\n`,
    ),
  );

  assert.equal(JSON.stringify(shared).includes(PROVIDER_KEY), false);
});

test("a non-secret payload passes through byte-identical", () => {
  const redactor = createRedactor({
    environment: { ANTHROPIC_API_KEY: PROVIDER_KEY },
  });

  const event = commandEvent(
    "node --test src/diff.test.ts",
    "# tests 12\n# pass 12\n# fail 0\nok 1 - applies a patch to the working tree\n",
    "Warning: 1 file changed, 3 insertions(+), 1 deletion(-)\n",
  );

  assert.equal(
    JSON.stringify(redactor.redactEvent(event)),
    JSON.stringify(event),
  );
});

test("redaction leaves an event that still satisfies its contract", () => {
  const redactor = createRedactor({
    environment: { ANTHROPIC_API_KEY: PROVIDER_KEY },
  });

  const shared = redactor.redactEvent(
    commandEvent("cat .env", `ANTHROPIC_API_KEY=${PROVIDER_KEY}\n`),
  );

  // The structural fields are untouched, so the shared copy is still parseable
  // by the same schema the privileged copy was.
  const parsed = SessionEventSchema.parse(shared);

  assert.equal(parsed.eventId, "event-1");
  assert.equal(parsed.sequence, 3);
  assert.equal(parsed.type, "tool.completed");
});

test("every assignment in a dotenv dump is redacted, secret-looking or not", () => {
  const redactor = createRedactor({ environment: {} });

  const shared = redactor.redactEvent(
    commandEvent(
      "cat .env",
      [
        "# local overrides",
        "STRIPE=pk_live_notactuallyreal",
        "export DATABASE_URL=postgres://novus:hunter2@localhost/novus",
        "EMPTY=",
        "",
      ].join("\n"),
    ),
  );

  assert.equal(shared.type, "tool.completed");
  assert.equal(shared.payload.result.name, "run_command");

  const { stdout } = shared.payload.result.output;

  assert.equal(stdout.includes("pk_live_notactuallyreal"), false);
  assert.equal(stdout.includes("hunter2"), false);
  // The names survive: a reviewer sees which values were removed.
  assert.match(stdout, /^STRIPE=\[redacted:env-file\]$/m);
  assert.match(stdout, /^export DATABASE_URL=\[redacted:env-file\]$/m);
  // A comment is not an assignment, and an empty value is not a secret.
  assert.match(stdout, /^# local overrides$/m);
  assert.match(stdout, /^EMPTY=$/m);
});

test("the same file read by a command that never named .env keeps its non-secret values", () => {
  const redactor = createRedactor({ environment: {} });

  const shared = redactor.redactEvent(
    commandEvent("cat config.properties", "STRIPE=pk_live_notactuallyreal\n"),
  );

  assert.equal(shared.type, "tool.completed");
  assert.equal(shared.payload.result.name, "run_command");
  // Honest about the limit: outside a dotenv, a value is only redacted when its
  // name or its shape says so, and `STRIPE` says neither.
  assert.match(shared.payload.result.output.stdout, /pk_live_notactuallyreal/);
});

test("secret-named values and authorization headers are redacted in any text", () => {
  const redactor = createRedactor({ environment: {} });

  assert.equal(
    redactor.redactText('curl -H "Authorization: Bearer abcdefghij0123456789"'),
    `curl -H "Authorization: Bearer ${redactionMarker("api-key")}"`,
  );

  assert.equal(
    redactor.redactText("run with SESSION_TOKEN=abc123def456 attached"),
    `run with SESSION_TOKEN=${redactionMarker("env-value")} attached`,
  );

  assert.equal(
    redactor.redactText('{"apiKey": "whatever-this-is", "path": "src/app.ts"}'),
    `{"apiKey": ${redactionMarker("env-value")}, "path": "src/app.ts"}`,
  );
});

test("prose that merely mentions a key keeps the sentence that explains it", () => {
  const redactor = createRedactor({ environment: {} });

  // A field takes the rest of its line. Firing on English would delete the
  // half of a failure message that says what went wrong.
  for (const line of [
    "could not find the key: config.ts is missing",
    "no auth: falling back to anonymous",
  ]) {
    assert.equal(redactor.redactText(line), line);
  }

  // Structure still redacts, at a line start or inside a quoted context.
  assert.equal(
    redactor.redactText("password: hunter2hunter2"),
    `password: ${redactionMarker("env-value")}`,
  );
  assert.equal(
    redactor.redactText('curl -H "x-api-key: opaque-value-here"'),
    `curl -H "x-api-key: ${redactionMarker("env-value")}"`,
  );
});

test("a private key block is removed whole", () => {
  const redactor = createRedactor({ environment: {} });

  const text = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAxLotsofbase64here",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");

  assert.equal(
    redactor.redactText(`key follows\n${text}\ndone`),
    `key follows\n${redactionMarker("private-key")}\ndone`,
  );
});

test("user-configured patterns are honoured, and a broken one refuses to start", () => {
  const redactor = createRedactor({
    environment: { NOVUS_REDACT_PATTERNS: "ACME-[0-9]{6}" },
  });

  assert.equal(
    redactor.redactText("badge ACME-123456 issued"),
    `badge ${redactionMarker("known-secret")} issued`,
  );

  assert.throws(
    () => createRedactor({ environment: { NOVUS_REDACT_PATTERNS: "([a-z" } }),
    /NOVUS_REDACT_PATTERNS/,
  );
});

test("the tool request that carried the secret is redacted too", () => {
  const redactor = createRedactor({ environment: {} });

  const event = SessionEventSchema.parse({
    eventId: "event-2",
    sessionId: "session-1",
    sequence: 1,
    actorId: "agent-1",
    occurredAt: "2026-07-29T10:00:00.000Z",
    type: "tool.requested",
    payload: {
      runId: "run-1",
      call: {
        id: "call-2",
        name: "run_command",
        input: {
          command: "curl",
          args: ["-H", `x-api-key: ${PROVIDER_KEY}`, "https://example.test"],
        },
      },
    },
  });

  assert.equal(
    JSON.stringify(redactor.redactEvent(event)).includes(PROVIDER_KEY),
    false,
  );
});

// The three bypasses a post-merge audit found. Each one reached the artifact a
// guest reads most, and each was invisible to the tests that shipped with the
// rule, so they are pinned by the auditor's own examples.

test("a secret added in a diff is redacted, not skipped for its + marker", () => {
  const redact = createRedactor({ environment: {} });

  // The prefix class did not include + or -, so every added and removed line of
  // a unified diff went through untouched while the same text as a context line
  // was redacted. An agent writing a credential into a config file is exactly
  // the accident this rule is for.
  const diff = [
    "--- a/config.env",
    "+++ b/config.env",
    "@@ -1 +1,2 @@",
    " EXISTING=fine",
    "+API_KEY=abcdef1234567890",
    "-SECRET_TOKEN=zyxwvu0987654321",
  ].join("\n");

  const redacted = redact.redactText(diff);

  assert.doesNotMatch(redacted, /abcdef1234567890/);
  assert.doesNotMatch(redacted, /zyxwvu0987654321/);
  // The names stay, so the diff is still reviewable.
  assert.match(redacted, /\+API_KEY=/);
  assert.match(redacted, /-SECRET_TOKEN=/);
});

test("a block-style YAML secret is not shielded by its parent key", () => {
  const redact = createRedactor({ environment: {} });

  // The operator allowed whitespace across a newline, so `environment:` matched
  // with its indented child as the value, decided `environment` was innocent,
  // and returned the whole block unredacted.
  const compose = [
    "services:",
    "  db:",
    "    environment:",
    "      POSTGRES_PASSWORD: s3cr3tvalue123",
    "      POSTGRES_USER: novus",
  ].join("\n");

  const redacted = redact.redactText(compose);

  assert.doesNotMatch(redacted, /s3cr3tvalue123/);
  assert.match(redacted, /POSTGRES_USER: novus/);
});

test("a bare secret name after a diff marker or list dash is still a field", () => {
  const redact = createRedactor({ environment: {} });

  const redacted = redact.redactText(
    ["+  password: hunter2password", "- token: abcdefgh12345678"].join("\n"),
  );

  assert.doesNotMatch(redacted, /hunter2password/);
  assert.doesNotMatch(redacted, /abcdefgh12345678/);
});

test("a heading does not swallow the line beneath it", () => {
  const redact = createRedactor({ environment: {} });

  // The same newline-crossing bug fired the other way, destroying the sentence
  // that explains a failure — which the rule's own comment promised to keep.
  const redacted = redact.redactText(
    "Credentials:\n  loaded 3 profiles from ~/.aws/config",
  );

  assert.match(redacted, /loaded 3 profiles/);
});

// A second audit, of the rules rather than the bypasses: what redaction does to
// output that holds no secret at all, and what it does when the shape it reaches
// into is not the shape it expected.

test("a value already redacted keeps the reason that named it", () => {
  const redact = createRedactor({ environment: {} });

  // The dotenv pass runs first and marks the whole file. The assignment rule
  // then matched the marker as a value and rewrote it, losing the reason and
  // stranding the bracket its own value class had stopped short of:
  // `API_KEY=[redacted:env-file]` came back as `API_KEY=[redacted:env-value]]`.
  assert.equal(
    redact.redactText(`API_KEY=${redactionMarker("env-file")}`),
    `API_KEY=${redactionMarker("env-file")}`,
  );

  const shared = redact.redactEvent(
    commandEvent("cat .env", "API_KEY=abcdef1234567890\nPORT=4319\n"),
  );

  assert.equal(shared.type, "tool.completed");
  assert.equal(shared.payload.result.name, "run_command");

  const { stdout } = shared.payload.result.output;

  assert.match(stdout, /^API_KEY=\[redacted:env-file\]$/m);
  assert.doesNotMatch(stdout, /\]\]/);
});

test("a compiler diagnostic about a file with a secret name survives", () => {
  const redact = createRedactor({ environment: {} });

  // `keys.ts` is a filename, not a field, and the rest of the line is the error
  // that explains the failure. A path with a `/` never matched the rule at all,
  // so this hit grep, node --test locations and root-level tsc output only.
  for (const line of [
    "  keys.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "keys.ts:12:  const total = subtotal + tax",
  ]) {
    assert.equal(redact.redactText(line), line);
  }
});

test("a source location does not shelter the rest of its line", () => {
  const redact = createRedactor({ environment: {} });

  // The exemption above declines a name; it must not skip past what follows,
  // which is what a value taking the rest of the line would have done.
  assert.equal(
    redact.redactText("keys.ts:12:5 - error: api_key: hunter2secret"),
    `keys.ts:12:5 - error: api_key: ${redactionMarker("env-value")}`,
  );

  // And a real secret name is not a filename, whatever its value looks like.
  for (const line of [
    "password: 12:30",
    "token: 123456789:AAHfiqkabcdefghijklmnop",
  ]) {
    assert.doesNotMatch(redact.redactText(line), /12:30|AAHfiqk/);
  }
});

test("redaction cannot end a run by throwing on a shape it did not expect", () => {
  const redact = createRedactor({ environment: {} });

  // The cast is the point: this is the event a later contract change produces,
  // and the throw would land in the event store's unguarded listener loop and
  // propagate out of append into the run.
  const malformed = {
    ...commandEvent("cat .env", "API_KEY=abcdef1234567890\n"),
  } as unknown as SessionEvent;

  delete (malformed as { payload: { result: { output?: unknown } } }).payload
    .result.output;

  assert.doesNotThrow(() => redact.redactEvent(malformed));
});

test("SSH_AUTH_SOCK's path is not registered as a literal secret", () => {
  const socket = "/private/tmp/com.apple.launchd.AbCdEf/Listeners";
  const redact = createRedactor({ environment: { SSH_AUTH_SOCK: socket } });

  // It reads as a secret name and holds a socket path. Registering it means
  // every mention anywhere is replaced, including the message explaining why an
  // SSH push failed.
  assert.match(redact.redactText(`socket at ${socket} is live`), /Listeners/);
});
