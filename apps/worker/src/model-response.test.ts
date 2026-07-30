import assert from "node:assert/strict";
import test from "node:test";

import { responseFromMessage } from "./anthropic-model.ts";

/**
 * What the adapter makes of a provider message, at the edges a live provider
 * cannot be pinned to producing on demand.
 */

// The SDK's Message type carries fields these tests do not exercise (cache
// usage, citations); the cast keeps the fixtures readable.
const message = (
  fields: Record<string, unknown>,
): Parameters<typeof responseFromMessage>[0] =>
  ({
    usage: { input_tokens: 100, output_tokens: 200 },
    ...fields,
  }) as unknown as Parameters<typeof responseFromMessage>[0];

test("a reply cut off at the output limit says so in its summary", () => {
  // stop_reason was ignored entirely, so a summary that hit the 4k output
  // ceiling stopped mid-sentence and was recorded in run.completed as though
  // it were the whole answer — wrong by omission, presented with full
  // confidence, and invisible unless a person noticed the last sentence had
  // no end. The run still completes; the record just has to say what kind of
  // answer it holds.
  const truncated = responseFromMessage(
    message({
      content: [{ type: "text", text: "The architecture has three layers: the" }],
      stop_reason: "max_tokens",
    }),
  );

  assert.equal(truncated.type, "final");
  if (truncated.type === "final") {
    assert.match(truncated.summary, /output limit/);
    assert.match(truncated.summary, /cut off/);
  }

  // A reply that ended on its own terms carries no such note.
  const whole = responseFromMessage(
    message({
      content: [{ type: "text", text: "The architecture has three layers." }],
      stop_reason: "end_turn",
    }),
  );

  assert.equal(whole.type, "final");
  if (whole.type === "final") {
    assert.doesNotMatch(whole.summary, /output limit/);
  }
});

test("cached tokens count at what they bill, not at face value", () => {
  // The budget treats tokens as what a run costs. A deep trace of this
  // repository ingested two million tokens across 34 calls and died on the
  // token ceiling — but with caching, most of those tokens would have been
  // cache reads billing at a tenth of full price. Counting them at face
  // value would end a cheap cached run at the price of an uncached one;
  // counting them at their billed weight keeps the ceiling meaning spend.
  const response = responseFromMessage(
    message({
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 1_000,
      },
    }),
  );

  assert.equal(response.type, "final");
  if (response.type === "final") {
    // 100 fresh + 10k reads at 0.1x + 1k writes at 1.25x.
    assert.deepEqual(response.usage, { inputTokens: 2_350, outputTokens: 200 });
  }
});

test("a well-formed tool call is unaffected by the stop reason", () => {
  const response = responseFromMessage(
    message({
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "read_file",
          input: { path: "package.json" },
        },
      ],
      stop_reason: "tool_use",
    }),
  );

  assert.equal(response.type, "tool_call");
  if (response.type === "tool_call") {
    assert.equal(response.call.name, "read_file");
    assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 200 });
  }
});
