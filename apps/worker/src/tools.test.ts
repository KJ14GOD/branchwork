import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ListProviderModelsTool,
  RunBuildTool,
  RunCommandTool,
  RunTestsTool,
} from "./tools.ts";

const temporaryRepository = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "novus-tools-"));

const runCommand = (id: string, command: string, args: string[], timeoutMs?: number) =>
  ({
    id,
    name: "run_command" as const,
    input: { command, args, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  });

test("run_command reports exit code and stdout", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  const result = await tool.execute(
    runCommand("1", "node", ["-e", "console.log('ran')"]),
  );

  assert.equal(result.name, "run_command");
  if (result.name !== "run_command") return;

  assert.equal(result.output.exitCode, 0);
  assert.equal(result.output.stdout.trim(), "ran");
  assert.equal(result.output.timedOut, false);
  assert.equal(result.output.truncated, false);
});

test("run_command reports a non-zero exit rather than throwing", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  // A failing command is an observation the model must be able to read, not an
  // error that ends the run.
  const result = await tool.execute(
    runCommand("2", "node", ["-e", "console.error('boom'); process.exit(3)"]),
  );

  if (result.name !== "run_command") return assert.fail("wrong result");

  assert.equal(result.output.exitCode, 3);
  assert.match(result.output.stderr, /boom/);
});

test("run_command does not interpret shell metacharacters", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  // The security property the argv-vector contract exists to provide: this
  // argument must arrive as text, not as a second command.
  const result = await tool.execute(
    runCommand("3", "echo", ["hello; echo pwned"]),
  );

  if (result.name !== "run_command") return assert.fail("wrong result");

  assert.equal(result.output.stdout.trim(), "hello; echo pwned");
  assert.doesNotMatch(result.output.stdout, /^pwned$/m);
});

test("run_command hides secrets from the child environment", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  process.env.NOVUS_TEST_API_KEY = "super-secret";
  process.env.NOVUS_TEST_PLAIN = "visible";

  try {
    const result = await tool.execute(
      runCommand("4", "node", [
        "-e",
        "console.log(process.env.NOVUS_TEST_API_KEY ?? 'absent', process.env.NOVUS_TEST_PLAIN ?? 'absent')",
      ]),
    );

    if (result.name !== "run_command") return assert.fail("wrong result");

    // The model reads this stdout, so a key reaching it is a leak.
    assert.equal(result.output.stdout.trim(), "absent visible");
  } finally {
    delete process.env.NOVUS_TEST_API_KEY;
    delete process.env.NOVUS_TEST_PLAIN;
  }
});

test("run_command refuses git operations that discard work", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  await assert.rejects(
    () => tool.execute(runCommand("5", "git", ["reset", "--hard", "HEAD~1"])),
    /discards uncommitted work/,
  );

  await assert.rejects(
    () => tool.execute(runCommand("6", "git", ["clean", "-fd"])),
    /deletes untracked files/,
  );
});

test("run_command refuses a path instead of a program name", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  await assert.rejects(
    () => tool.execute(runCommand("7", "../../usr/bin/whoami", [])),
    /program name resolved on PATH/,
  );
});

test("run_command kills a command that outruns its timeout", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  const result = await tool.execute(
    runCommand("8", "node", ["-e", "setTimeout(() => {}, 30000)"], 1_000),
  );

  if (result.name !== "run_command") return assert.fail("wrong result");

  assert.equal(result.output.timedOut, true);
  // A signalled process has no exit code, and reporting 0 would read as success.
  assert.equal(result.output.exitCode, null);
});

test("run_command settles when a killed command leaves a descendant holding stdio", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  // The regression this guards: killing only the direct child leaves a
  // grandchild holding the stdout pipe, so `close` never fires and the promise
  // never settles — hanging the session queue forever rather than timing out.
  // `pnpm test` and `npm test` are process launchers, so this is the ordinary
  // shape of a hanging test suite, not an exotic case.
  const result = await tool.execute(
    runCommand(
      "14",
      "node",
      [
        "-e",
        "require('child_process').spawn('sleep', ['30'], { stdio: 'inherit' }); setTimeout(() => {}, 30000)",
      ],
      1_000,
    ),
  );

  if (result.name !== "run_command") return assert.fail("wrong result");

  assert.equal(result.output.timedOut, true);
  assert.ok(
    result.output.durationMs < 10_000,
    `settled in ${result.output.durationMs}ms, so the kill did not reach the group`,
  );
});

test("run_command refuses a destructive git command behind a global flag", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  // `git -c key=value reset --hard` is the same command with a prefix, so
  // matching only the first argument would miss it.
  await assert.rejects(
    () =>
      tool.execute(
        runCommand("15", "git", ["-c", "core.pager=cat", "reset", "--hard"]),
      ),
    /discards uncommitted work/,
  );
});

test("run_command keeps SSH_AUTH_SOCK, which only looks like a secret", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  process.env.SSH_AUTH_SOCK = "/tmp/novus-test-agent.sock";

  try {
    const result = await tool.execute(
      runCommand("16", "node", [
        "-e",
        "console.log(process.env.SSH_AUTH_SOCK ?? 'absent')",
      ]),
    );

    if (result.name !== "run_command") return assert.fail("wrong result");

    // Dropping it breaks every git fetch and push over SSH with an auth error
    // that says nothing about the cause.
    assert.equal(result.output.stdout.trim(), "/tmp/novus-test-agent.sock");
  } finally {
    delete process.env.SSH_AUTH_SOCK;
  }
});

test("run_command runs inside the selected repository", async () => {
  const repository = await temporaryRepository();
  const tool = new RunCommandTool(repository);

  const result = await tool.execute(
    runCommand("9", "node", ["-e", "console.log(process.cwd())"]),
  );

  if (result.name !== "run_command") return assert.fail("wrong result");

  // macOS reports /private/var for /var, so compare the resolved tail.
  assert.ok(result.output.stdout.trim().endsWith(repository.replace(/^\/private/, "")));
});

test("run_tests reports a passing suite", async () => {
  const repository = await temporaryRepository();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "exit 0" } }),
  );
  await writeFile(join(repository, "package-lock.json"), "{}");

  const result = await new RunTestsTool(repository).execute({
    id: "10",
    name: "run_tests",
    input: { args: [] },
  });

  if (result.name !== "run_tests") return assert.fail("wrong result");

  assert.equal(result.output.passed, true);
  assert.equal(result.output.exitCode, 0);
});

test("run_tests reports a failing suite as failed rather than throwing", async () => {
  const repository = await temporaryRepository();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "exit 1" } }),
  );
  await writeFile(join(repository, "package-lock.json"), "{}");

  const result = await new RunTestsTool(repository).execute({
    id: "11",
    name: "run_tests",
    input: { args: [] },
  });

  if (result.name !== "run_tests") return assert.fail("wrong result");

  assert.equal(result.output.passed, false);
  assert.notEqual(result.output.exitCode, 0);
});

test("run_tests explains itself when the project declares no test script", async () => {
  const repository = await temporaryRepository();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );

  await assert.rejects(
    () =>
      new RunTestsTool(repository).execute({
        id: "12",
        name: "run_tests",
        input: { args: [] },
      }),
    /requires a "test" script/,
  );
});

test("run_tests explains itself when there is no package.json at all", async () => {
  const repository = await temporaryRepository();

  await assert.rejects(
    () =>
      new RunTestsTool(repository).execute({
        id: "13",
        name: "run_tests",
        input: { args: [] },
      }),
    /no package.json/,
  );
});

test("run_build reports success and failure as verdicts, not throws", async () => {
  const repository = await temporaryRepository();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { build: "exit 0" } }),
  );
  await writeFile(join(repository, "package-lock.json"), "{}");

  const tool = new RunBuildTool(repository);
  const passing = await tool.execute({
    id: "17",
    name: "run_build",
    input: { args: [] },
  });

  if (passing.name !== "run_build") return assert.fail("wrong result");

  assert.equal(passing.output.succeeded, true);
  assert.equal(passing.output.exitCode, 0);

  // A failing build is an observation the model reads and reacts to — the
  // same invariant run_tests holds, because a build that ends the run would
  // hide the one piece of evidence the model needed.
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { build: "exit 2" } }),
  );

  const failing = await tool.execute({
    id: "18",
    name: "run_build",
    input: { args: [] },
  });

  if (failing.name !== "run_build") return assert.fail("wrong result");

  assert.equal(failing.output.succeeded, false);
  assert.equal(failing.output.exitCode, 2);
});

test("run_build explains itself when the project declares no build script", async () => {
  const repository = await temporaryRepository();
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );

  // The refusal names what is missing and what to do instead — the project
  // declares how it builds, and the tool must not invent a compiler
  // invocation on its behalf.
  await assert.rejects(
    () =>
      new RunBuildTool(repository).execute({
        id: "19",
        name: "run_build",
        input: { args: [] },
      }),
    /requires a "build" script/,
  );
});

test("list_provider_models reports what the provider says, as a contract result", async () => {
  // The tool exists because a run judged a model id it found in a repository
  // against its own training data and got it wrong — the provider is the only
  // authority on which ids it serves, and until this tool nothing in the tool
  // set could ask. The fetcher is injected so the tool layer never learns
  // which provider it is talking to.
  const tool = new ListProviderModelsTool("anthropic", async () => [
    "claude-opus-5",
    "claude-opus-4-8",
  ]);

  const result = await tool.execute({
    id: "14",
    name: "list_provider_models",
    input: {},
  });

  assert.equal(result.name, "list_provider_models");
  if (result.name !== "list_provider_models") return;

  assert.equal(result.output.provider, "anthropic");
  assert.deepEqual(result.output.models, ["claude-opus-5", "claude-opus-4-8"]);
});
