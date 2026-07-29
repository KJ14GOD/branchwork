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
