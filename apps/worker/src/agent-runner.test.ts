import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionEventStore } from "@novus/session-service";

import { AgentRunner } from "./agent-runner.ts";
import { FixedModelRouter, ScriptedModelAdapter } from "./model.ts";
import {
  ProposePatchTool,
  ReadFileTool,
  SearchRepositoryTool,
} from "./tools.ts";

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

const originalSource = [
  "export const greet = (name: string): string => {",
  "  return `hello ${name}`;",
  "};",
].join("\n");

test("propose_patch previews a diff without touching the working tree", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-patch-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const tool = new ProposePatchTool(repositoryPath);

  try {
    const result = await tool.execute({
      id: "patch-call",
      name: "propose_patch",
      input: {
        path: "greet.ts",
        intent: "Greet with an exclamation mark.",
        edits: [
          {
            oldText: "return `hello ${name}`;",
            newText: "return `hello ${name}!`;",
          },
        ],
      },
    });

    assert.equal(result.name, "propose_patch");

    if (result.name === "propose_patch") {
      assert.equal(result.output.status, "proposed");
      assert.equal(result.output.path, "greet.ts");
      assert.equal(result.output.additions, 1);
      assert.equal(result.output.deletions, 1);
      assert.match(result.output.diff, /^\+ {2}return `hello \$\{name\}!`;$/m);

      const proposal = tool.getProposal(result.output.patchId);
      assert.equal(proposal?.path, "greet.ts");
      assert.match(proposal?.proposedContent ?? "", /hello \$\{name\}!/);
    }

    // The proposal is a preview: the file on disk must be untouched.
    assert.equal(await readFile(filePath, "utf8"), `${originalSource}\n`);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("a proposed patch reaches the session event log", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-patch-events-"));
  const filePath = join(repositoryPath, "greet.ts");
  await writeFile(filePath, `${originalSource}\n`, "utf8");

  const selection = { provider: "scripted", model: "patch-proposer" };

  // A minimal adapter that proposes once, then summarises — enough to prove the
  // proposal crosses the runner and lands in the ordered event log.
  const adapter = {
    selection,
    async complete(request: {
      toolExchanges: readonly { result: { name: string } }[];
    }) {
      if (request.toolExchanges.length === 0) {
        return {
          type: "tool_call" as const,
          call: {
            id: "patch-call",
            name: "propose_patch" as const,
            input: {
              path: "greet.ts",
              intent: "Greet with an exclamation mark.",
              edits: [
                {
                  oldText: "return `hello ${name}`;",
                  newText: "return `hello ${name}!`;",
                },
              ],
            },
          },
        };
      }

      return { type: "final" as const, summary: "Proposed one patch." };
    },
  };

  const eventStore = new InMemorySessionEventStore();
  const runner = new AgentRunner(
    eventStore,
    new FixedModelRouter(selection),
    [adapter],
    [new ProposePatchTool(repositoryPath)],
  );

  try {
    const result = await runner.run({
      sessionId: "patch-session",
      actorId: "agent-1",
      goal: "Improve the greeting.",
    });

    const completed = result.events.find(
      (event) => event.type === "tool.completed",
    );

    assert.equal(completed?.type, "tool.completed");

    if (
      completed?.type === "tool.completed" &&
      completed.payload.result.name === "propose_patch"
    ) {
      assert.equal(completed.payload.result.output.status, "proposed");
      assert.match(completed.payload.result.output.diff, /^\+.*!`;$/m);
    }

    assert.equal(await readFile(filePath, "utf8"), `${originalSource}\n`);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("propose_patch rejects an ambiguous edit", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-ambiguous-"));
  const filePath = join(repositoryPath, "repeat.ts");
  await writeFile(filePath, "const a = 1;\nconst a = 1;\n", "utf8");

  const tool = new ProposePatchTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "ambiguous-call",
        name: "propose_patch",
        input: {
          path: "repeat.ts",
          intent: "Change the constant.",
          edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
        },
      }),
      /ambiguous: oldText matches 2 locations/,
    );

    assert.equal(await readFile(filePath, "utf8"), "const a = 1;\nconst a = 1;\n");
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("propose_patch rejects protected repository files", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-patch-env-"));
  await writeFile(
    join(repositoryPath, ".env"),
    "ANTHROPIC_API_KEY=secret\n",
    "utf8",
  );

  const tool = new ProposePatchTool(repositoryPath);

  try {
    await assert.rejects(
      tool.execute({
        id: "protected-patch",
        name: "propose_patch",
        input: {
          path: ".env",
          intent: "Rotate the key.",
          edits: [
            { oldText: "ANTHROPIC_API_KEY=secret", newText: "ANTHROPIC_API_KEY=" },
          ],
        },
      }),
      /protected repository paths/,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
