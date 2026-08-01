import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DevServerTool,
  liveDevServerCount,
  stopAllDevServers,
  stopDevServersUnder,
} from "./dev-server.ts";

const temporaryRepository = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "novus-dev-server-"));

const start = (id: string, command: string, args: string[], extra: object = {}) =>
  ({
    id,
    name: "dev_server" as const,
    input: { action: "start" as const, command, args, ...extra },
  });

const canConnect = (port: number): Promise<boolean> =>
  new Promise((settle) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answer: boolean): void => {
      socket.destroy();
      settle(answer);
    };

    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });

// A real server that listens on the PORT Novus hands it — the convention the
// tool's whole port report depends on.
const LISTENER = `const server = require("net").createServer(() => {});
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  console.log("listening on " + process.env.PORT);
});
`;

/**
 * Waits for a server's log tail to contain something.
 *
 * `state: "listening"` comes from probing the port; the log line comes from
 * the child's stdout. Those settle independently, and asserting on the logs
 * the instant after start was reading a buffer that had not necessarily been
 * written to yet — it failed intermittently across back-to-back gate runs.
 *
 * Polling here is not papering over a race: the guarantee the tool actually
 * makes is that the line *arrives*, not that it has arrived by the time the
 * start call returns. This asserts the guarantee that exists.
 */
const logsContaining = async (
  tool: DevServerTool,
  serverId: string,
  pattern: RegExp,
): Promise<string> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await tool.execute({
      id: `log-probe-${attempt}`,
      name: "dev_server",
      input: { action: "logs", serverId },
    });

    if (
      result.name === "dev_server" &&
      result.output.action === "logs" &&
      pattern.test(result.output.logs)
    ) {
      return result.output.logs;
    }

    await new Promise((settle) => setTimeout(settle, 20));
  }

  return "";
};

test("dev_server starts a real listener, reports it, and stop takes it down", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  const started = await tool.execute(start("1", "node", ["-e", LISTENER]));

  if (started.name !== "dev_server") return assert.fail("wrong result");
  if (started.output.action !== "start") return assert.fail("wrong action");

  // The report has to be a fact, not a hope: the tool probed the port before
  // claiming anything answers on it.
  assert.equal(started.output.state, "listening");
  assert.equal(await canConnect(started.output.port), true);
  // The log tail proves the child actually received PORT, which is what makes
  // the reported port the real one rather than a number passed into the void.
  assert.match(
    await logsContaining(
      tool,
      started.output.serverId,
      new RegExp(`listening on ${started.output.port}`),
    ),
    new RegExp(`listening on ${started.output.port}`),
  );

  const stopped = await tool.execute({
    id: "2",
    name: "dev_server",
    input: { action: "stop", serverId: started.output.serverId },
  });

  if (stopped.name !== "dev_server") return assert.fail("wrong result");
  if (stopped.output.action !== "stop") return assert.fail("wrong action");

  assert.equal(stopped.output.stopped, true);
  assert.equal(await canConnect(started.output.port), false);
});

test("a server that dies on startup is an observation, not a hang or a throw", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  // A misconfigured server exiting immediately is the ordinary failure. The
  // model needs the exit code and the stderr to fix it — waiting the full
  // ready timeout for a process that is already dead would just be slower.
  const started = await tool.execute(
    start("3", "node", ["-e", "console.error('missing config'); process.exit(7)"]),
  );

  if (started.name !== "dev_server") return assert.fail("wrong result");
  if (started.output.action !== "start") return assert.fail("wrong action");

  assert.equal(started.output.state, "exited");
  assert.equal(started.output.exitCode, 7);
  assert.match(started.output.logs, /missing config/);
});

test("stop kills the whole process group, even a server that ignores SIGTERM", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  // The adversarial shape: the direct child traps SIGTERM and keeps running,
  // and it has a grandchild of its own. Killing only the child would leave
  // the grandchild leaked — the exact bug run_command's group kill exists
  // for, restated for servers.
  const started = await tool.execute(
    start("4", "node", [
      "-e",
      `process.on("SIGTERM", () => {});
require("child_process").spawn("sleep", ["60"], { stdio: "ignore" });
const server = require("net").createServer(() => {});
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
    ]),
  );

  if (started.name !== "dev_server") return assert.fail("wrong result");
  if (started.output.action !== "start") return assert.fail("wrong action");

  assert.equal(started.output.state, "listening");

  const before = Date.now();
  const stopped = await tool.execute({
    id: "5",
    name: "dev_server",
    input: { action: "stop", serverId: started.output.serverId },
  });

  if (stopped.name !== "dev_server") return assert.fail("wrong result");
  if (stopped.output.action !== "stop") return assert.fail("wrong action");

  // The TERM grace expired and the KILL escalation reached the group: the
  // port is free and the call settled in bounded time rather than waiting on
  // a process that had opted out of dying politely.
  assert.equal(stopped.output.stopped, true);
  assert.ok(Date.now() - before < 10_000, "stop did not settle in bounded time");
  assert.equal(await canConnect(started.output.port), false);
});

test("status and logs report the session's servers by id", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  const started = await tool.execute(start("6", "node", ["-e", LISTENER]));

  if (started.name !== "dev_server") return assert.fail("wrong result");
  if (started.output.action !== "start") return assert.fail("wrong action");

  const status = await tool.execute({
    id: "7",
    name: "dev_server",
    input: { action: "status" },
  });

  if (status.name !== "dev_server") return assert.fail("wrong result");
  if (status.output.action !== "status") return assert.fail("wrong action");

  assert.equal(status.output.servers.length, 1);
  assert.equal(status.output.servers[0]?.state, "listening");
  assert.equal(status.output.servers[0]?.port, started.output.port);

  const logs = await tool.execute({
    id: "8",
    name: "dev_server",
    input: { action: "logs", serverId: started.output.serverId },
  });

  if (logs.name !== "dev_server") return assert.fail("wrong result");
  if (logs.output.action !== "logs") return assert.fail("wrong action");

  assert.match(
    await logsContaining(tool, started.output.serverId, /listening on/),
    /listening on/,
  );
  // The command rides along so anything reading these logs later — redaction,
  // most concretely — can tell what produced them without holding state.
  assert.match(logs.output.command, /^node /);

  await tool.execute({
    id: "9",
    name: "dev_server",
    input: { action: "stop", serverId: started.output.serverId },
  });

  // A stopped server stays visible as exited rather than vanishing: "it was
  // here and it ended" is part of what status is for.
  const after = await tool.execute({
    id: "10",
    name: "dev_server",
    input: { action: "status" },
  });

  if (after.name !== "dev_server") return assert.fail("wrong result");
  if (after.output.action !== "status") return assert.fail("wrong action");

  assert.equal(after.output.servers[0]?.state, "exited");
});

test("dev_server refuses paths, unknown ids, and ports that are taken", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  // The same trust boundary as run_command: a path is not a program name,
  // and accepting one would let the repository's own files be executed by
  // spelling them.
  await assert.rejects(
    () => tool.execute(start("11", "./node", [])),
    /program name resolved on PATH/,
  );

  await assert.rejects(
    () =>
      tool.execute({
        id: "12",
        name: "dev_server",
        input: { action: "logs", serverId: "no-such-server" },
      }),
    /No dev server/,
  );

  // A port something else already holds is refused before the server is ever
  // spawned — fighting for it would produce a child that dies with EADDRINUSE
  // after the tool already claimed the port was the server's.
  const blocker = createServer();

  await new Promise<void>((settle) => blocker.listen(0, "0.0.0.0", settle));

  const address = blocker.address();

  if (address === null || typeof address === "string") {
    return assert.fail("no port");
  }

  try {
    await assert.rejects(
      () =>
        tool.execute(
          start("13", "node", ["-e", LISTENER], { port: address.port }),
        ),
      /already in use/,
    );
  } finally {
    await new Promise((settle) => blocker.close(settle));
  }
});

test("a program that does not exist fails with its name, not a hang", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  await assert.rejects(
    () => tool.execute(start("14", "novus-no-such-program", [])),
    /not found on PATH/,
  );
});

test("stopAllDevServers takes down what the worker would otherwise leak", async () => {
  const repository = await temporaryRepository();
  const tool = new DevServerTool(repository);

  const started = await tool.execute(start("15", "node", ["-e", LISTENER]));

  if (started.name !== "dev_server") return assert.fail("wrong result");
  if (started.output.action !== "start") return assert.fail("wrong action");

  assert.ok(liveDevServerCount() >= 1);

  // The worker's shutdown path: no serverIds, no session bookkeeping, just
  // every live group killed. A server that survived this would sit invisibly
  // on its port after Novus is gone — the failure mode this tool's whole
  // lifecycle design exists to prevent.
  stopAllDevServers();

  assert.equal(liveDevServerCount(), 0);

  // The kill is asynchronous from the OS's point of view; give it a moment
  // before asserting the port actually came free.
  await new Promise((settle) => setTimeout(settle, 300));
  assert.equal(await canConnect(started.output.port), false);
});

/**
 * Reclaiming a decided attempt deletes its worktree. A dev server started in
 * that worktree is detached and in its own process group, so it does not go
 * with the directory — it keeps running, keeps its port, and its working
 * directory becomes a path with nothing at it. Teardown opened that door, so
 * teardown has to close it.
 */
test("stopping the servers under a directory leaves the ones outside it running", async () => {
  const reclaimed = await temporaryRepository();
  const kept = await temporaryRepository();

  // Cleanup in a finally, without exception. A detached server that outlives
  // a failing assertion keeps this runner's stdio open and the whole test file
  // hangs instead of reporting — which is how this test first failed, and it
  // took the leak it exists to catch to do it.
  try {
    const doomed = await new DevServerTool(reclaimed).execute(
      start("16", "node", ["-e", LISTENER]),
    );
    const survivor = await new DevServerTool(kept).execute(
      start("17", "node", ["-e", LISTENER]),
    );

    if (doomed.name !== "dev_server") return assert.fail("wrong result");
    if (doomed.output.action !== "start") return assert.fail("wrong action");
    if (survivor.name !== "dev_server") return assert.fail("wrong result");
    if (survivor.output.action !== "start") return assert.fail("wrong action");

    // The caller's path is not a realpath — on macOS every temporary directory
    // is reached through /var, which is a symlink to /private/var — and the
    // recorded root is. Passing the unresolved form is the ordinary case, so
    // it is the one the test uses.
    assert.equal(await stopDevServersUnder(reclaimed), 1);

    await new Promise((settle) => setTimeout(settle, 300));

    assert.equal(
      await canConnect(doomed.output.port),
      false,
      "a server in the directory being deleted has to go with it",
    );
    assert.equal(
      await canConnect(survivor.output.port),
      true,
      "and one anywhere else must be left alone",
    );

    // A directory that merely shares a name prefix is not underneath it. A
    // string comparison would have swept this up.
    assert.equal(await stopDevServersUnder(`${reclaimed}-other`), 0);
    await new Promise((settle) => setTimeout(settle, 100));
    assert.equal(await canConnect(survivor.output.port), true);
  } finally {
    stopAllDevServers();
  }
});
