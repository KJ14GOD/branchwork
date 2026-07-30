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

test("many small results from a broad task all stay whole", () => {
  // The failure this reproduces: "explain this repo" read fifteen-plus small
  // files and every one of them scrolled out of a fixed four-exchange window
  // within a handful of calls. Each elision told the model to call the tool
  // again, which it did — correctly, forever, because whatever it re-read was
  // elided again before it had gathered enough to answer. A live run spent 79
  // tool calls this way and never produced a summary. A count-based cutoff
  // cannot fit a task that legitimately needs to hold this many results at
  // once; a size budget can, as long as the total stays reasonable.
  const exchange = (index: number) => ({
    status: "ok" as const,
    call: {
      id: `c${index}`,
      name: "read_file" as const,
      input: { path: `file-${index}.js` },
    },
    result: {
      toolCallId: `c${index}`,
      name: "read_file" as const,
      output: { path: `file-${index}.js`, content: "x".repeat(3_000) },
    },
  });

  const messages = JSON.stringify(
    buildMessages({
      history: [],
      goal: "Explain this repo",
      // Fifteen reads at 3,000 characters is 45,000 total — comfortably under
      // the verbatim budget, the way a real repo tour reads many small-to-
      // medium files rather than one huge one.
      toolExchanges: Array.from({ length: 15 }, (_, index) => exchange(index)),
    }),
  );

  assert.doesNotMatch(
    messages,
    /elided to save context/,
    "a broad task within the size budget should never see any of its own reads elided",
  );
});

test("a result too large for the whole budget still shows the model its head", () => {
  // The size budget closed the broad-task livelock and quietly opened another:
  // a single result bigger than the entire 100k budget could never be kept
  // verbatim — not even on the turn the model asked for it — and the elision
  // stub told the model to "call the tool again if you need it verbatim",
  // advice that cannot ever work for such a file. Reading lessong's 567k
  // .cache/all.json produced exactly that trap: read, elided, re-read,
  // elided, forever. Any repository with a lockfile or a bundle can do this.
  // The fix is honesty: show the head, say the file cannot be shown whole,
  // and point at search_repository for the rest.
  const oversize = (id: string) => ({
    status: "ok" as const,
    call: { id, name: "read_file" as const, input: { path: ".cache/all.json" } },
    result: {
      toolCallId: id,
      name: "read_file" as const,
      output: { path: ".cache/all.json", content: "x".repeat(150_000) },
    },
  });

  const first = JSON.stringify(
    buildMessages({
      history: [],
      goal: "Summarize .cache/all.json",
      toolExchanges: [oversize("c1")],
    }),
  );

  // The model must be able to see actual content, not only a stub. The head
  // is 20k characters of the JSON payload, whose envelope eats a few dozen of
  // them, so assert on slightly less than the whole head.
  assert.ok(
    first.includes("x".repeat(19_000)),
    "the newest oversized result should show its head",
  );
  // ...but never the whole thing, which is what the budget exists to prevent.
  assert.ok(
    !first.includes("x".repeat(21_000)),
    "an oversized result must not be sent whole",
  );
  // And never the promise that re-reading will produce the verbatim text.
  assert.doesNotMatch(first, /Call the tool again if you need it verbatim/);

  // The model obeys the note and re-reads anyway: the second read must see the
  // same head, not less — converging where the stub looped.
  const retried = JSON.stringify(
    buildMessages({
      history: [],
      goal: "Summarize .cache/all.json",
      toolExchanges: [oversize("c1"), oversize("c2")],
    }),
  );

  assert.ok(
    retried.includes("x".repeat(19_000)),
    "a re-read of an oversized file should still show its head",
  );
});

test("finished turns do not resend their tool results whole", () => {
  // The verbatim budget is spent per walk, and history turns each took a walk
  // of their own: every finished turn kept up to 100k characters of results
  // the model had already digested into a summary, so an eight-turn session
  // resent ~770k characters on every model call of turn nine. A finished
  // turn's contribution is its summary; its reads elide like anything old,
  // and stay available to read again.
  const exchange = (id: string) => ({
    status: "ok" as const,
    call: { id, name: "read_file" as const, input: { path: "src/app.ts" } },
    result: {
      toolCallId: id,
      name: "read_file" as const,
      output: { path: "src/app.ts", content: "y".repeat(19_000) },
    },
  });
  const turn = (index: number) => ({
    goal: `question ${index}`,
    summary: `answer ${index}`,
    exchanges: Array.from({ length: 5 }, (_, i) => exchange(`t${index}-${i}`)),
  });

  const messages = JSON.stringify(
    buildMessages({
      history: [turn(0), turn(1)],
      goal: "a third question",
      toolExchanges: [],
    }),
  );

  // 190k characters of finished-with reads: none may arrive whole, and the
  // stubs must still say what they were so the model can re-read on demand.
  assert.ok(
    !messages.includes("y".repeat(19_000)),
    "a finished turn's results should be elided, not resent",
  );
  assert.match(messages, /elided to save context/);
  // The summaries are the part a follow-up question actually needs.
  assert.match(messages, /answer 0/);
  assert.match(messages, /answer 1/);
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
