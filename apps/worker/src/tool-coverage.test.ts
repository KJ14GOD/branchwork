import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolCallSchema, type ToolCall } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import { FixedModelRouter, ScriptedModelAdapter } from "./model.ts";
import { classifyTool } from "./policy.ts";
import { SessionRegistry } from "./session-registry.ts";
import { TOOL_DESCRIPTIONS } from "./tool-descriptions.ts";

/**
 * The three lists that must agree for a tool to actually work: the contract's
 * union, the descriptions every model reads, and the tools a session
 * registers. They live in three files, only one agreement is
 * compiler-enforced, and the failure when they drift is the worst kind — the
 * model calls a tool it was told about, the runner cannot find it, and
 * `failRun` ends the whole run ("No tool is configured for..."). That exact
 * bug shipped once: list_provider_models was described unconditionally but
 * registered only when the adapter could answer, so one call killed an
 * OpenAI session.
 */

const contractToolNames = (): string[] =>
  ToolCallSchema.options.map(
    (option) => option.shape.name.value as string,
  );

test("every contract tool is described to the model, and nothing else is", () => {
  const contract = contractToolNames().sort();
  const described = TOOL_DESCRIPTIONS.map((tool) => tool.name).sort();

  // A contract tool with no description is invisible to the model — wired
  // and unreachable. A described name outside the contract would be worse:
  // the model calls it, the adapter's safeParse refuses it, and every call
  // burns a turn on invalid_tool_call.
  assert.deepEqual(described, contract);
});

test("every contract tool has a permission class", () => {
  for (const name of contractToolNames()) {
    const toolClass = classifyTool(name as ToolCall["name"]);

    assert.ok(
      toolClass === "read" || toolClass === "write" || toolClass === "dangerous",
      `${name} has no permission class`,
    );
  }
});

test("a real session registers a tool for every described name", async () => {
  const repository = await mkdtemp(join(tmpdir(), "novus-coverage-"));
  const registry = new SessionRegistry(
    new InMemorySessionEventStore(),
    new FixedModelRouter({ provider: "scripted", model: "scripted-v1" }),
    // Deliberately an adapter with no listModels: the session must register
    // list_provider_models anyway (as a tool that fails with a reason),
    // because the description is unconditional and a described-but-missing
    // tool ends the run rather than the call.
    [new ScriptedModelAdapter({ provider: "scripted", model: "scripted-v1" })],
  );

  const session = await registry.create({ repositoryPath: repository });
  const registered = new Set(
    (
      session.runner as unknown as { tools: readonly { name: string }[] }
    ).tools.map((tool) => tool.name),
  );

  for (const description of TOOL_DESCRIPTIONS) {
    assert.ok(
      registered.has(description.name),
      `${description.name} is described to the model but not registered — calling it would end the run, not the call`,
    );
  }
});

test("every dangerous tool is reachable when the host allows commands", async () => {
  const repository = await mkdtemp(join(tmpdir(), "novus-coverage-gate-"));
  const registry = new SessionRegistry(
    new InMemorySessionEventStore(),
    new FixedModelRouter({ provider: "scripted", model: "scripted-v1" }),
    [new ScriptedModelAdapter({ provider: "scripted", model: "scripted-v1" })],
    { allowWrites: true, allowCommands: true },
  );

  const session = await registry.create({ repositoryPath: repository });
  const approvals = (
    session.runner as unknown as {
      approvals: {
        review(request: {
          call: ToolCall;
          toolClass: "write" | "dangerous";
        }): Promise<{ approved: boolean }>;
      };
    }
  ).approvals;

  // The gate's allow list is hand-written in session-registry.ts while the
  // classes live in policy.ts, and the compiler will not connect them. A
  // dangerous tool missing from the list is not denied once and loudly — it
  // is denied on every call of every session that explicitly opted in, which
  // reads as a broken tool rather than a policy decision.
  for (const name of contractToolNames()) {
    const toolClass = classifyTool(name as ToolCall["name"]);

    if (toolClass === "read") {
      continue;
    }

    const decision = await approvals.review({
      call: { id: "probe", name, input: {} } as ToolCall,
      toolClass,
    });

    assert.ok(
      decision.approved,
      `${name} is ${toolClass} but not in the session's allow list — it would be denied even with the host's permission granted`,
    );
  }
});
