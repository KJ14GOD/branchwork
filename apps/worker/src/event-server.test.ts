import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { startEventServer } from "./event-server.ts";
import { createRedactor } from "./redaction.ts";

// Not a real key: the prefix is real, the body is keyboard noise.
const PROVIDER_KEY =
  "sk-ant-api03-Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcdefGHIJKL";

const SESSION = "session-1";

const commandDraft = (command: string, stdout: string) => ({
  sessionId: SESSION,
  actorId: "agent-1",
  type: "tool.completed" as const,
  payload: {
    runId: "run-1",
    result: {
      toolCallId: "call-1",
      name: "run_command" as const,
      output: {
        command,
        exitCode: 0,
        timedOut: false,
        durationMs: 12,
        stdout,
        stderr: "",
        truncated: false,
      },
    },
  },
});

/** Reads the SSE stream until the backlog has been written, then disconnects. */
const readStream = async (url: string, expectedEvents: number) => {
  const controller = new AbortController();
  const response = await fetch(`${url}/events?session=${SESSION}`, {
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";

  try {
    while (received.split("\n\n").length <= expectedEvents) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      received += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
  }

  return received;
};

test("a known key in the store never reaches a connected client", async () => {
  const store = new InMemorySessionEventStore();
  const server = await startEventServer(store, {
    port: 0,
    redactor: createRedactor({
      environment: { ANTHROPIC_API_KEY: PROVIDER_KEY },
    }),
  });

  try {
    const recorded = store.append(
      commandDraft("cat .env", `ANTHROPIC_API_KEY=${PROVIDER_KEY}\n`),
    );

    // The host's own log keeps the whole thing. That is the asymmetry: the
    // privileged copy is complete, the shared copy is clean.
    assert.equal(recorded.type, "tool.completed");
    assert.equal(recorded.payload.result.name, "run_command");
    assert.match(recorded.payload.result.output.stdout, /sk-ant-/);

    const received = await readStream(server.url, 1);

    assert.equal(received.includes(PROVIDER_KEY), false);
    assert.equal(received.includes("sk-ant-"), false);
    assert.match(received, /redacted/);
    // Still an addressable event, not a hole in the stream.
    assert.match(received, /^id: 0$/m);
  } finally {
    await server.close();
  }
});

test("an event with nothing sensitive in it arrives unchanged", async () => {
  const store = new InMemorySessionEventStore();
  const server = await startEventServer(store, {
    port: 0,
    redactor: createRedactor({
      environment: { ANTHROPIC_API_KEY: PROVIDER_KEY },
    }),
  });

  try {
    const recorded = store.append(
      commandDraft("node --test src/diff.test.ts", "# pass 12\n# fail 0\n"),
    );

    const received = await readStream(server.url, 1);
    const line = received
      .split("\n")
      .find((entry) => entry.startsWith("data: "));

    assert.ok(line);
    assert.equal(line.slice("data: ".length), JSON.stringify(recorded));
  } finally {
    await server.close();
  }
});
