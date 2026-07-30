import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunFailure, AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter } from "./model.ts";
import { OpenAIModelAdapter } from "./openai-model.ts";
import { AllowListApprovalGate } from "./policy.ts";
import { ReadFileTool, SearchRepositoryTool } from "./tools.ts";

/**
 * The live existence proof for the OpenAI adapter — a real turn against a
 * real model, the same split `scripts/benchmark.sh --live` uses for
 * Anthropic. Not a `*.test.ts` file on purpose: `apps/worker/package.json`
 * runs `--test 'src/*.test.ts'` in the gate, and a live call there would fail
 * `pnpm test` on any machine without OPENAI_API_KEY and bill money on every
 * commit that does have one. Run by hand:
 *
 *   OPENAI_API_KEY=... node --experimental-strip-types src/openai-smoke.ts [model]
 *
 * or, from the repository root with a key already in .env:
 *
 *   pnpm --filter @novus/worker smoke:openai
 */

const model = process.argv[2] ?? process.env.NOVUS_OPENAI_SMOKE_MODEL ?? "gpt-4.1-mini";

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY is not set. This script makes one real call to OpenAI to prove the adapter's translation logic end to end — export a key, or pass one via --env-file.",
  );
  process.exit(1);
}

const main = async (): Promise<void> => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-openai-smoke-"));

  try {
    await writeFile(
      join(repositoryPath, "package.json"),
      JSON.stringify({ name: "openai-adapter-smoke-fixture", version: "0.0.0" }, null, 2),
      "utf8",
    );

    const selection = { provider: "openai", model };
    const eventStore = new InMemorySessionEventStore();
    const runner = new AgentRunner(
      eventStore,
      new FixedModelRouter(selection),
      [new OpenAIModelAdapter(selection)],
      [new SearchRepositoryTool(repositoryPath), new ReadFileTool(repositoryPath)],
      // Read-class tools only, so this proves the translation without
      // needing a write approval to also be modelled.
      new AllowListApprovalGate([]),
    );

    console.log(`▸ ${selection.provider}/${selection.model} — reading package.json`);

    const start = Date.now();
    let result;

    try {
      result = await runner.run({
        sessionId: "openai-smoke",
        actorId: "smoke-test",
        goal: 'Read package.json and report the exact value of its "name" field. Do not guess — read the file first.',
      });
    } catch (error) {
      // A throw this early means the model call itself never returned — an
      // auth failure, a network error, a bad model name. There is no
      // run.failed for it: AgentRunner only converts a *tool* failure into
      // one, and a call that never reached the provider correctly is
      // SessionRegistry's to report in the real worker. Reported plainly
      // here instead, since this script has no SessionRegistry above it.
      const cause = error instanceof AgentRunFailure ? error.cause : error;
      console.error(`✗ the run never completed: ${(cause as Error).message ?? cause}`);
      process.exitCode = 1;
      return;
    }

    const elapsedMs = Date.now() - start;

    const toolCalls = result.events.filter((event) => event.type === "tool.requested");
    const completed = result.events.find((event) => event.type === "run.completed");
    const failed = result.events.find((event) => event.type === "run.failed");

    console.log(`  ${toolCalls.length} tool call(s), ${elapsedMs}ms`);

    for (const event of result.events) {
      if (event.type === "tool.requested") {
        console.log(`  → ${event.payload.call.name} ${JSON.stringify(event.payload.call.input)}`);
      }
    }

    if (completed?.type === "run.completed") {
      console.log(`\n${completed.payload.summary}\n`);

      const mentionsName = completed.payload.summary.includes(
        "openai-adapter-smoke-fixture",
      );

      console.log(
        mentionsName
          ? "✓ the summary names the actual value read from the file — the adapter round-tripped a real tool call correctly."
          : "✗ the summary never named the fixture's actual package name — read it back and check the translation.",
      );
      process.exitCode = mentionsName ? 0 : 1;
      return;
    }

    if (failed?.type === "run.failed") {
      console.log(`✗ run failed: ${failed.payload.reason}`);
      process.exitCode = 1;
      return;
    }

    console.log("✗ run ended without completing or failing.");
    process.exitCode = 1;
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
};

await main();
