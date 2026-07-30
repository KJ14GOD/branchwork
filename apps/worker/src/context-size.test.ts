import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { buildMessages } from "./anthropic-model.ts";
import { FixedModelRouter, type ModelAdapter, type ModelRequest } from "./model.ts";
import { AllowListApprovalGate } from "./policy.ts";
import { ReadFileTool } from "./tools.ts";

/**
 * What a long run costs to keep asking.
 *
 * Every turn resends every earlier tool result, so a run that reads several
 * large files pays for all of them on every subsequent call. A fifteen-call
 * feature on a real repository spent 605k tokens, most of it on files it had
 * already finished with — cost grows with the square of the run's length, which
 * is the difference between a harness that can work for an hour and one that
 * cannot afford to.
 *
 * These measure the request the adapter would build, not the provider's count.
 * The unit is characters and the shape is what matters.
 */

const SESSION = "context-session";

/** A tool whose result is deliberately large, like reading a real source file. */
const bigFileTool = (size: number) => ({
  name: "read_file" as const,
  async execute(call: { id: string; name: string }) {
    return {
      toolCallId: call.id,
      name: "read_file" as const,
      output: { path: "public/app.js", content: "x".repeat(size) },
    };
  },
});

const runWithReads = async (reads: number, size: number) => {
  const store = new InMemorySessionEventStore();
  const seen: ModelRequest[] = [];
  let asked = 0;

  const adapter: ModelAdapter = {
    selection: { provider: "anthropic", model: "test" },
    async complete(request) {
      seen.push(request);
      asked += 1;

      if (asked <= reads) {
        return {
          type: "tool_call",
          call: { id: `c${asked}`, name: "read_file", input: { path: "public/app.js" } },
        };
      }

      return { type: "final", summary: "Done." };
    },
  };

  const runner = new AgentRunner(
    store,
    new FixedModelRouter(adapter.selection),
    [adapter],
    [bigFileTool(size) as never],
    new AllowListApprovalGate([], "host"),
  );

  await runner.run({ sessionId: SESSION, actorId: "agent-1", goal: "Read a lot" });

  return seen;
};

test("the newest tool results are kept whole", async () => {
  const requests = await runWithReads(6, 8_000);
  const last = requests.at(-1);

  assert.ok(last);

  // The model is reasoning about what it just read; shortening that would be
  // trading correctness for cost.
  const recent = last.toolExchanges.slice(-2);

  for (const exchange of recent) {
    assert.equal(exchange.status, "ok");

    if (exchange.status === "ok" && exchange.result.name === "read_file") {
      assert.equal(exchange.result.output.content.length, 8_000);
    }
  }
});

test("older tool results are not resent in full", () => {
  const exchange = (index: number, size: number) => ({
    status: "ok" as const,
    call: {
      id: `c${index}`,
      name: "read_file" as const,
      input: { path: "public/app.js" },
    },
    result: {
      toolCallId: `c${index}`,
      name: "read_file" as const,
      output: { path: "public/app.js", content: "x".repeat(size) },
    },
  });

  // Measured on the messages the adapter actually builds. The first version of
  // this test counted the runner's exchange list instead, which grows whether or
  // not elision works — it would have passed with the feature deleted.
  const sizeOf = (reads: number): number =>
    JSON.stringify(
      buildMessages({
        history: [],
        goal: "Read a lot",
        toolExchanges: Array.from({ length: reads }, (_, index) =>
          exchange(index, 20_000),
        ),
      }),
    ).length;

  const two = sizeOf(2);
  const twenty = sizeOf(20);

  // Ten times the reads. Without elision that is ten times the payload; with it,
  // only the verbatim tail counts, so the growth is a fraction of that.
  assert.ok(
    twenty < two * 3,
    `twenty reads sent ${twenty} characters against ${two} for two — history is still growing with the run`,
  );

  const elided = JSON.stringify(
    buildMessages({
      history: [],
      goal: "Read a lot",
      toolExchanges: Array.from({ length: 20 }, (_, index) =>
        exchange(index, 20_000),
      ),
    }),
  );

  // The elision has to say what it dropped, or the model cannot tell that a file
  // it read is still available to read again.
  assert.match(elided, /elided to save context/);
  assert.match(elided, /Call the tool again/);
});

test("an error is never elided, however old", () => {
  const messages = buildMessages({
    history: [],
    goal: "Try things",
    toolExchanges: [
      {
        status: "error",
        call: { id: "c0", name: "read_file", input: { path: "missing.ts" } },
        message: "ENOENT: missing.ts does not exist",
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        status: "ok" as const,
        call: {
          id: `c${index + 1}`,
          name: "read_file" as const,
          input: { path: "public/app.js" },
        },
        result: {
          toolCallId: `c${index + 1}`,
          name: "read_file" as const,
          output: { path: "public/app.js", content: "x".repeat(20_000) },
        },
      })),
    ],
  });

  // A truncated explanation of what it did wrong is how a model repeats the
  // mistake, and errors are short enough that keeping them costs nothing.
  assert.match(JSON.stringify(messages), /ENOENT/);
});
