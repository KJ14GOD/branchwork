import assert from "node:assert/strict";
import test from "node:test";

import { buildMessages, interpretToolCall, OpenAIModelAdapter } from "./openai-model.ts";

/**
 * Deterministic tests only — no network call, no OPENAI_API_KEY required.
 * This file matches `src/*.test.ts` and runs in `pnpm test`, so nothing here
 * may cost money or depend on a key being present; the live proof that a real
 * OpenAI model can complete a real turn lives in `openai-smoke.ts`, run by
 * hand, the same split `scripts/benchmark.sh --live` uses for Anthropic.
 */

test("malformed tool call arguments become an observation, not a thrown error", () => {
  // The provider's own types admit this can happen: "the model does not
  // always generate valid JSON." A throw here would escape agent-runner's
  // loop before any terminal event is recorded — this is the trust boundary
  // model.ts warns about directly.
  const toolCall = {
    id: "call-1",
    type: "function" as const,
    function: { name: "read_file", arguments: "{not valid json" },
  };

  const response = interpretToolCall(toolCall, {});

  assert.equal(response.type, "invalid_tool_call");
  if (response.type === "invalid_tool_call") {
    assert.equal(response.id, "call-1");
    assert.equal(response.name, "read_file");
    assert.match(response.message, /not valid JSON/);
  }
});

test("arguments that parse as JSON but do not match the tool's contract are also an observation", () => {
  const toolCall = {
    id: "call-2",
    type: "function" as const,
    // read_file requires a "path" string; this has neither.
    function: { name: "read_file", arguments: "{}" },
  };

  const response = interpretToolCall(toolCall, {});

  assert.equal(response.type, "invalid_tool_call");
  if (response.type === "invalid_tool_call") {
    assert.match(response.message, /path/);
  }
});

test("valid arguments become a real tool call, carrying usage through untouched", () => {
  const toolCall = {
    id: "call-3",
    type: "function" as const,
    function: { name: "read_file", arguments: JSON.stringify({ path: "package.json" }) },
  };

  const response = interpretToolCall(toolCall, {
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  assert.equal(response.type, "tool_call");
  if (response.type === "tool_call") {
    assert.equal(response.call.name, "read_file");
    assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5 });
  }
});

test("the adapter refuses a selection naming a different provider", () => {
  assert.throws(
    () => new OpenAIModelAdapter({ provider: "anthropic", model: "claude-opus-5" }),
    /requires the openai provider/,
  );
});

test("a goal becomes a system message plus a user message", () => {
  const messages = buildMessages({ history: [], goal: "Fix the bug", toolExchanges: [] });

  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(messages.at(-1), { role: "user", content: "Fix the bug" });
});

test("a tool exchange round-trips as an assistant tool_calls message plus a tool result message", () => {
  const messages = buildMessages({
    history: [],
    goal: "Read the manifest",
    toolExchanges: [
      {
        status: "ok",
        call: { id: "call-1", name: "read_file", input: { path: "package.json" } },
        result: {
          toolCallId: "call-1",
          name: "read_file",
          output: { path: "package.json", content: '{"name":"fixture"}' },
        },
      },
    ],
  });

  const assistant = messages.find(
    (message) => message.role === "assistant" && "tool_calls" in message && message.tool_calls,
  );
  assert.equal(assistant?.role, "assistant");
  if (assistant?.role === "assistant") {
    assert.equal(assistant.tool_calls?.[0]?.id, "call-1");
    assert.equal(
      assistant.tool_calls?.[0]?.type === "function"
        ? assistant.tool_calls[0].function.name
        : undefined,
      "read_file",
    );
    assert.equal(
      assistant.tool_calls?.[0]?.type === "function"
        ? assistant.tool_calls[0].function.arguments
        : undefined,
      JSON.stringify({ path: "package.json" }),
    );
  }

  const toolResult = messages.find((message) => message.role === "tool");
  assert.equal(toolResult?.role, "tool");
  if (toolResult?.role === "tool") {
    assert.equal(toolResult.tool_call_id, "call-1");
    assert.match(String(toolResult.content), /fixture/);
  }
});

test("an error exchange is never elided, however old, and a big old result is", () => {
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

  const text = JSON.stringify(messages);
  assert.match(text, /ENOENT/);
  assert.match(text, /elided to save context/);
});

test("older tool results are not resent in full as the run grows", () => {
  const exchange = (index: number, size: number) => ({
    status: "ok" as const,
    call: { id: `c${index}`, name: "read_file" as const, input: { path: "public/app.js" } },
    result: {
      toolCallId: `c${index}`,
      name: "read_file" as const,
      output: { path: "public/app.js", content: "x".repeat(size) },
    },
  });

  const sizeOf = (reads: number): number =>
    JSON.stringify(
      buildMessages({
        history: [],
        goal: "Read a lot",
        toolExchanges: Array.from({ length: reads }, (_, index) => exchange(index, 20_000)),
      }),
    ).length;

  const two = sizeOf(2);
  const twenty = sizeOf(20);

  assert.ok(
    twenty < two * 3,
    `twenty reads sent ${twenty} characters against ${two} for two — history is still growing with the run`,
  );
});
