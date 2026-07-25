import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter, ScriptedModelAdapter } from "./model.ts";
import { ReadFileTool, SearchRepositoryTool } from "./tools.ts";

test("records a complete run using the selected model", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-runner-"));
  await writeFile(
    join(repositoryPath, "package.json"),
    '{"name":"fixture"}\n',
    "utf8",
  );

  const modelSelection = {
    provider: "scripted",
    model: "scripted-v1",
  };
  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(modelSelection),
    [new ScriptedModelAdapter(modelSelection)],
    [new ReadFileTool(repositoryPath)],
  );

  try {
    const result = await runner.run({
      sessionId: "runner-test-session",
      actorId: "agent-1",
      goal: "Inspect the project configuration",
    });

    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        "run.started",
        "run.progress",
        "tool.requested",
        "tool.completed",
        "run.completed",
      ],
    );
    assert.deepEqual(
      result.events.map((event) => event.sequence),
      [0, 1, 2, 3, 4],
    );

    const startedEvent = result.events[0];
    assert.equal(startedEvent?.type, "run.started");
    if (startedEvent?.type === "run.started") {
      assert.deepEqual(startedEvent.payload.run.model, modelSelection);
    }

    const toolEvent = result.events[3];
    assert.equal(toolEvent?.type, "tool.completed");
    if (toolEvent?.type === "tool.completed") {
      assert.equal(toolEvent.payload.result.name, "read_file");
    }
    if (
      toolEvent?.type === "tool.completed" &&
      toolEvent.payload.result.name === "read_file"
    ) {
      assert.equal(toolEvent.payload.result.output.path, "package.json");
      assert.match(toolEvent.payload.result.output.content, /fixture/);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("read_file rejects paths outside the repository", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-tool-"));
  const tool = new ReadFileTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "outside-read",
        name: "read_file",
        input: {
          path: "../outside.txt",
        },
      }),
      /outside the repository/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("read_file rejects protected repository files", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-protected-"));
  await writeFile(
    join(repositoryPath, ".env"),
    "ANTHROPIC_API_KEY=secret\n",
    "utf8",
  );
  const tool = new ReadFileTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "protected-read",
        name: "read_file",
        input: {
          path: ".env",
        },
      }),
      /protected repository paths/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("search_repository returns structured repository matches", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-search-"));
  await mkdir(join(repositoryPath, "src"));
  await writeFile(
    join(repositoryPath, "src", "runner.ts"),
    "export class AgentRunner {}\n",
    "utf8",
  );
  await writeFile(
    join(repositoryPath, "src", "unrelated.ts"),
    "export const value = 1;\n",
    "utf8",
  );

  const tool = new SearchRepositoryTool(repositoryPath);

  try {
    const result = await tool.execute({
      id: "search-call",
      name: "search_repository",
      input: {
        query: "AgentRunner",
      },
    });

    assert.equal(result.name, "search_repository");
    if (result.name === "search_repository") {
      assert.deepEqual(result.output.matches, [
        {
          path: "src/runner.ts",
          line: 1,
          text: "export class AgentRunner {}",
        },
      ]);
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
