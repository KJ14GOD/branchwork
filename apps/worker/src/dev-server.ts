import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";

import {
  ToolResultSchema,
  type ToolCall,
  type ToolResult,
} from "@novus/contracts";

import { scrubbedEnvironment, type AgentTool } from "./tools.ts";

/**
 * Development servers: the one class of process that is supposed to outlive
 * the tool call that started it.
 *
 * run_command's contract is exactly wrong for this — it watches a process to
 * completion and kills it at the timeout, which for a dev server means either
 * blocking the agent loop for the server's whole life or killing the thing
 * the call existed to start. So this tool returns as soon as it can say
 * something true about the server (listening, still starting, or already
 * dead), and the process keeps running behind it.
 *
 * The failure mode that shapes everything here is the leaked server: a
 * process that survived its session and sits invisibly on a port. Three
 * boundaries deal with it. Every server is spawned detached in its own
 * process group, so stopping one kills its whole tree — the same lesson
 * run_command's timeout learned from a grandchild holding stdio. Every live
 * server is registered module-wide, and `stopAllDevServers` is called on the
 * worker's own shutdown path next to `killRunningCommands`. And what this
 * deliberately does NOT survive is the worker process itself: there is no
 * daemonising, no pid file, no reattach — a server's lifetime is bounded by
 * the worker's, because a process nothing can see or stop anymore is the
 * failure, not a feature.
 */

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const READY_POLL_INTERVAL_MS = 150;
const CONNECT_PROBE_TIMEOUT_MS = 400;
const STOP_GRACE_MS = 1_500;

// Above the worker (4319), the relay (4400), the fork port range
// (4400-4911), and below both Vite dev ports (5273/5274) would be nicer, but
// contiguity matters less than not colliding with what Novus itself holds:
// start above the fork range entirely.
const DEV_PORT_BASE = 4_950;
const DEV_PORT_SCAN_LIMIT = 512;

// The last 16k of output, not the first: a dev server logs forever, and the
// recent tail is the part that explains the current failure.
const MAX_LOG_CHARS = 16_000;

type ServerRecord = {
  serverId: string;
  command: string;
  port: number;
  child: ChildProcess;
  pid: number | null;
  startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  logs: string;
  logsTruncated: boolean;
};

// Module-wide, not per tool instance: the worker's shutdown path has to be
// able to take down every server any session started, the same way
// killRunningCommands does not care which session spawned a command.
const liveServers = new Set<ServerRecord>();
// Ports handed out and not yet released, across sessions, so two sessions
// cannot be given the same port even before either server binds it.
const claimedPorts = new Set<number>();

export const stopAllDevServers = (): void => {
  for (const record of liveServers) {
    try {
      if (record.pid !== null) {
        process.kill(-record.pid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }
  liveServers.clear();
  claimedPorts.clear();
};

const sleep = (ms: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, ms));

const isPortFree = (port: number): Promise<boolean> =>
  new Promise((settle) => {
    const server = createServer();

    server.once("error", () => settle(false));
    server.once("listening", () => {
      server.close(() => settle(true));
    });
    // All interfaces, not loopback: BSD SO_REUSEADDR lets a loopback bind
    // succeed over a live 0.0.0.0 listener, so probing loopback hands out
    // ports that are already taken — the same lesson worktree-manager's
    // probe already wrote down.
    server.listen(port, "0.0.0.0");
  });

/** Whether anything accepts a connection on the port right now. */
const canConnect = (port: number): Promise<boolean> =>
  new Promise((settle) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answer: boolean): void => {
      socket.destroy();
      settle(answer);
    };

    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(CONNECT_PROBE_TIMEOUT_MS, () => done(false));
  });

const killGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
};

export class DevServerTool implements AgentTool {
  readonly name = "dev_server";
  private readonly repositoryPath: string;
  private readonly servers = new Map<string, ServerRecord>();

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (call.name !== this.name) {
      throw new Error(`The dev_server tool cannot execute ${call.name}.`);
    }

    const input = call.input;

    switch (input.action) {
      case "start":
        return this.start(call.id, input);
      case "stop":
        return this.stop(call.id, input.serverId);
      case "status":
        return this.status(call.id);
      case "logs":
        return this.logs(call.id, input.serverId);
    }
  }

  private record(serverId: string): ServerRecord {
    const record = this.servers.get(serverId);

    if (!record) {
      throw new Error(
        `No dev server ${serverId} exists in this session. Use action "status" to list the ones that do.`,
      );
    }

    return record;
  }

  private async allocatePort(requested: number | undefined): Promise<number> {
    if (requested !== undefined) {
      if (claimedPorts.has(requested)) {
        throw new Error(
          `Port ${requested} is already held by another dev server started through Novus. Stop that server first, or omit the port to have one allocated.`,
        );
      }

      if (!(await isPortFree(requested))) {
        throw new Error(
          `Port ${requested} is already in use by something outside Novus. Choose another port, or omit it to have a free one allocated.`,
        );
      }

      claimedPorts.add(requested);
      return requested;
    }

    for (
      let port = DEV_PORT_BASE;
      port < DEV_PORT_BASE + DEV_PORT_SCAN_LIMIT;
      port += 1
    ) {
      if (claimedPorts.has(port)) {
        continue;
      }

      if (await isPortFree(port)) {
        claimedPorts.add(port);
        return port;
      }
    }

    throw new Error(
      `No free port between ${DEV_PORT_BASE} and ${DEV_PORT_BASE + DEV_PORT_SCAN_LIMIT} for a dev server.`,
    );
  }

  private async start(
    callId: string,
    input: {
      command: string;
      args: readonly string[];
      port?: number | undefined;
      readyTimeoutMs?: number | undefined;
    },
  ): Promise<ToolResult> {
    // The same rule as run_command, for the same reason: a program name
    // resolved on PATH, never a path — a path reaches into the repository or
    // out of it, and either way runs something the name did not say.
    if (input.command.includes("/") || input.command.includes("\\")) {
      throw new Error(
        "dev_server takes a program name resolved on PATH, not a path. Pass arguments in args.",
      );
    }

    const repositoryRoot = await realpath(this.repositoryPath);
    const port = await this.allocatePort(input.port);
    const commandLine = [input.command, ...input.args].join(" ");

    const child = spawn(input.command, [...input.args], {
      cwd: repositoryRoot,
      // The scrub run_command uses, for the identical reason: this process's
      // output comes back to the model through `logs`. PORT on top, because
      // it is the one convention most dev servers honour, and honouring it is
      // what makes the reported port true.
      env: {
        ...scrubbedEnvironment(),
        PORT: String(port),
        NOVUS_DEV_PORT: String(port),
        // Everything else in Novus is loopback-only — the worker, the relay,
        // both Vite servers — and a dev server an *agent* started should not
        // be the one thing that quietly listens to the network. HOST is the
        // convention Vite, Next, Nuxt, and CRA all honour. It is a request,
        // not a guarantee: a server is free to ignore it and bind
        // 0.0.0.0 anyway, which is why the tool reports the port it observed
        // rather than claiming an interface it did not verify.
        HOST: "127.0.0.1",
      },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const record: ServerRecord = {
      serverId: crypto.randomUUID(),
      command: commandLine,
      port,
      child,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      exitedAt: null,
      exitCode: null,
      logs: "",
      logsTruncated: false,
    };

    const append = (chunk: Buffer): void => {
      const next = record.logs + chunk.toString("utf8");

      if (next.length > MAX_LOG_CHARS) {
        record.logs = next.slice(-MAX_LOG_CHARS);
        record.logsTruncated = true;
      } else {
        record.logs = next;
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    // `exit`, never `close`: a grandchild inheriting the pipes can hold
    // `close` open indefinitely, and this record must learn the direct
    // child died even so.
    child.on("exit", (code) => {
      record.exitedAt = Date.now();
      record.exitCode = code;
      liveServers.delete(record);
      claimedPorts.delete(record.port);
    });

    const spawned = await new Promise<Error | null>((settle) => {
      child.once("spawn", () => settle(null));
      child.once("error", (error) => settle(error));
    });

    if (spawned !== null) {
      claimedPorts.delete(port);
      throw new Error(
        `Unable to start ${input.command}: ${(spawned as NodeJS.ErrnoException).code === "ENOENT" ? `${input.command} was not found on PATH` : spawned.message}`,
      );
    }

    this.servers.set(record.serverId, record);
    liveServers.add(record);

    // Wait — briefly, this blocks the agent loop — until something true can
    // be said: the port answered, the process died, or the wait ran out and
    // "still starting" is the honest report.
    const deadline =
      Date.now() + (input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    let state: "listening" | "starting" | "exited" = "starting";

    for (;;) {
      if (record.exitedAt !== null) {
        state = "exited";
        break;
      }

      if (await canConnect(port)) {
        state = "listening";
        break;
      }

      if (Date.now() >= deadline) {
        break;
      }

      await sleep(READY_POLL_INTERVAL_MS);
    }

    return ToolResultSchema.parse({
      toolCallId: callId,
      name: this.name,
      output: {
        action: "start",
        serverId: record.serverId,
        command: commandLine,
        port,
        pid: record.pid,
        state,
        exitCode: record.exitCode,
        logs: record.logs,
      },
    });
  }

  private async stop(callId: string, serverId: string): Promise<ToolResult> {
    const record = this.record(serverId);
    let stopped = false;

    if (record.exitedAt === null && record.pid !== null) {
      // TERM first so a server that traps it can close its sockets, KILL to
      // the whole group when the grace runs out — a bundler's worker pool
      // does not always die with its parent.
      killGroup(record.pid, "SIGTERM");

      const deadline = Date.now() + STOP_GRACE_MS;

      while (record.exitedAt === null && Date.now() < deadline) {
        await sleep(50);
      }

      if (record.exitedAt === null) {
        killGroup(record.pid, "SIGKILL");

        const hardDeadline = Date.now() + STOP_GRACE_MS;

        while (record.exitedAt === null && Date.now() < hardDeadline) {
          await sleep(50);
        }
      }

      stopped = true;
    }

    // Bookkeeping regardless of how it ended: the exit handler usually did
    // this already, but a process whose exit event never fired must not
    // keep its port claimed forever.
    liveServers.delete(record);
    claimedPorts.delete(record.port);

    return ToolResultSchema.parse({
      toolCallId: callId,
      name: this.name,
      output: {
        action: "stop",
        serverId,
        stopped,
      },
    });
  }

  private async status(callId: string): Promise<ToolResult> {
    const servers = [];

    for (const record of this.servers.values()) {
      const state =
        record.exitedAt !== null
          ? ("exited" as const)
          : (await canConnect(record.port))
            ? ("listening" as const)
            : ("starting" as const);

      servers.push({
        serverId: record.serverId,
        command: record.command,
        port: record.port,
        pid: record.pid,
        state,
        uptimeMs: (record.exitedAt ?? Date.now()) - record.startedAt,
      });
    }

    return ToolResultSchema.parse({
      toolCallId: callId,
      name: this.name,
      output: {
        action: "status",
        servers,
      },
    });
  }

  private async logs(callId: string, serverId: string): Promise<ToolResult> {
    const record = this.record(serverId);

    return ToolResultSchema.parse({
      toolCallId: callId,
      name: this.name,
      output: {
        action: "logs",
        serverId,
        command: record.command,
        logs: record.logs,
        truncated: record.logsTruncated,
      },
    });
  }
}

/** How many dev servers are currently live, for tests and for shutdown checks. */
export const liveDevServerCount = (): number => liveServers.size;
