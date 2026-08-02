import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  RunnerCommandsResponseSchema,
  type RunnerCommand,
  type RunnerEvent,
  type SequencedRunnerEvent
} from "@novus/contracts";
import { z } from "zod";
import type { ControlPlaneClient } from "./api-client";
import { startTurn, type RunningTurn, type TurnResult } from "./execution";
import { EventOutbox } from "./outbox";
import { createWorkspaceRuntime, type WorkspaceCommandContext } from "./workspace";

/**
 * OWNER: the runner plane's desktop half (D-035).
 *
 * This machine is a runner. The agent discovers the local workstreams it can
 * actually reach, registers for each one, holds the credential in this process
 * only, polls for commands it is authorized to run, executes them through the
 * Claude Code adapter, and reports every observation through a durable outbox.
 *
 * Nothing here is reachable from the renderer, and the credential never
 * crosses the IPC bridge.
 */
export interface RunnerAgent {
  /** Re-scan missions for local workstreams that need a runner registered. */
  discoverNow(): void;
  /** Poll for commands immediately, rather than waiting for the next tick. */
  pollNow(): void;
  /**
   * Kills in-flight turns, records the interruption as an explicit outcome,
   * and flushes the outbox before resolving. Safe to call twice.
   */
  shutdown(reason: string): Promise<void>;
}

/**
 * Everything the agent needs from the machine it runs on. Injectable so the
 * agent itself can be stood up and driven in a plain Node test: the bug this
 * seam exists for — a turn that never started and never failed — is invisible
 * to a test of the pure modules alone.
 */
export interface RunnerHost {
  /** This machine's private state directory. Nothing here crosses IPC. */
  userDataPath: string;
  isPackaged: boolean;
  /** How this machine names itself in the room's evidence; never a path. */
  label: string;
  /** Where a local repository lives on this machine, or null if it does not. */
  repositoryPath: (providerRepoId: string) => string | null;
}

export interface RunnerAgentDeps {
  api: ControlPlaneClient;
  controlPlaneUrl: string;
  getToken: () => string | null;
  /** Absent in the app: Electron and the local-repository map are then loaded
   *  lazily, so neither sits in this module's import graph. */
  host?: RunnerHost;
  fetch?: typeof fetch;
  /** The scripted harness, normally read from the environment. */
  fakeHarness?: boolean;
}

interface ElectronAppShape {
  getPath: (name: string) => string;
  isPackaged: boolean;
}

/**
 * Loaded on demand rather than imported: a static `import ... from "electron"`
 * would drag the whole Electron runtime into every import of this module,
 * including its tests.
 */
function electronHost(): RunnerHost {
  const { app } = require("electron") as { app: ElectronAppShape };
  const { pathForLocalRepo } = require("./local-repos") as {
    pathForLocalRepo: (providerRepoId: string) => string | null;
  };
  return {
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged,
    label: hostname().slice(0, 120).replace(/[/\\]/g, "-") || "this machine",
    repositoryPath: pathForLocalRepo
  };
}

const DISCOVER_EVERY_MS = 15_000;
const POLL_EVERY_MS = 2_000;
/** How long a stopped turn is given to unwind before the app stops waiting. */
const SHUTDOWN_GRACE_MS = 8_000;
/** Bound on the remembered command ids: enough to cover a relaunch, not a log. */
const COMMAND_MEMORY = 500;

interface Enrolment {
  runnerId: string;
  credential: string;
  expiresAt: string;
}

const EnrolmentFileSchema = z.record(
  z.object({
    runnerId: z.string(),
    credential: z.string(),
    expiresAt: z.string()
  })
);

interface ActiveTurn {
  executionId: string;
  turn: RunningTurn;
}

/**
 * What a workspace command carries. A name selects one of the commands the
 * project declared; its absence means the project's default run command, or
 * every configured check. There is deliberately nothing here that could name a
 * command the repository did not declare (D-042).
 */
const WorkspacePayloadSchema = z.object({
  name: z.string().min(1).max(80).nullable().optional(),
  workspaceId: z.string().min(1).nullable().optional()
});

const StartPayloadSchema = z.object({
  directionId: z.string().optional(),
  body: z.string().default(""),
  model: z.string().default(""),
  effort: z.string().default(""),
  resumeSessionId: z.string().nullable().default(null)
});

export function startRunnerAgent(deps: RunnerAgentDeps): RunnerAgent {
  const host = deps.host ?? electronHost();
  const httpFetch = deps.fetch ?? fetch;
  const userData = host.userDataPath;
  const credentialPath = join(userData, "runner-credentials.json");
  const commandMemoryPath = join(userData, "runner-commands.json");
  const worktreeRoot = join(userData, "worktrees");
  const fakeHarness =
    deps.fakeHarness ?? (process.env.NOVUS_FAKE_HARNESS === "1" && !host.isPackaged);
  const label = host.label;

  const enrolments = new Map<string, Enrolment>(Object.entries(loadEnrolments()));
  const outboxes = new Map<string, EventOutbox>();
  const workstreamByMission = new Map<string, string>();
  const active = new Map<string, ActiveTurn>();
  /** Executions this machine has begun and not yet ended, by workstream, so a
   *  quit mid-turn can close every one of them honestly. */
  const openExecutions = new Map<string, string>();
  const settled = new Set<string>(loadCommandMemory());
  const inFlight = new Set<string>();
  const chains = new Map<string, Promise<void>>();

  /**
   * The workspace runtime: setup, run, and verification commands, their
   * environments, their ports, and their processes. Its observations belong to
   * the workstream rather than to any turn, so they are reported with no
   * execution — a setup command can precede the first turn and a run command
   * outlives one (D-041).
   */
  const workspace = createWorkspaceRuntime({
    host: { userDataPath: host.userDataPath, repositoryPath: host.repositoryPath },
    emit: (workstreamId, event) => outboxFor(workstreamId).append(null, event)
  });

  let discovering = false;
  let polling = false;
  let stopped = false;
  let reconciled = false;

  const discoverTimer = setInterval(() => void discover(), DISCOVER_EVERY_MS);
  const pollTimer = setInterval(() => void poll(), POLL_EVERY_MS);
  void discover();

  return {
    discoverNow: () => void discover(),
    pollNow: () => void poll(),
    shutdown
  };

  // --- Credential custody ---------------------------------------------------

  function loadEnrolments(): Record<string, Enrolment> {
    try {
      if (!existsSync(credentialPath)) return {};
      const parsed = EnrolmentFileSchema.safeParse(JSON.parse(readFileSync(credentialPath, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  /** The credential lives in this process and this file, and nowhere else:
   *  never in a log line, never across the IPC bridge, never in an event. */
  function persistEnrolments(): void {
    try {
      mkdirSync(userData, { recursive: true });
      writeFileSync(credentialPath, JSON.stringify(Object.fromEntries(enrolments)), { mode: 0o600 });
    } catch (error) {
      console.warn("[runner] could not persist runner enrolment:", messageOf(error));
    }
  }

  function loadCommandMemory(): string[] {
    try {
      if (!existsSync(commandMemoryPath)) return [];
      const parsed = z.array(z.string()).safeParse(JSON.parse(readFileSync(commandMemoryPath, "utf8")));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /** A command that already ran must be a no-op after a relaunch, even if its
   *  acknowledgement never reached the control plane. */
  function rememberCommand(commandId: string): void {
    settled.add(commandId);
    const recent = [...settled].slice(-COMMAND_MEMORY);
    settled.clear();
    for (const id of recent) settled.add(id);
    try {
      mkdirSync(userData, { recursive: true });
      writeFileSync(commandMemoryPath, JSON.stringify(recent), { mode: 0o600 });
    } catch (error) {
      console.warn("[runner] could not persist command memory:", messageOf(error));
    }
  }

  // --- Transport ------------------------------------------------------------

  async function runnerFetch(
    enrolment: Enrolment,
    path: string,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<Response> {
    return httpFetch(`${deps.controlPlaneUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: `Runner ${enrolment.credential}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  function outboxFor(workstreamId: string): EventOutbox {
    const existing = outboxes.get(workstreamId);
    if (existing) return existing;
    const created = new EventOutbox({
      filePath: join(userData, "runner-outbox", `${workstreamId}.json`),
      deliver: async (executionId: string | null, batch: SequencedRunnerEvent[]) => {
        const enrolment = enrolments.get(workstreamId);
        if (!enrolment) throw new Error("this machine is no longer enrolled for that workstream");
        const response = await runnerFetch(enrolment, "/runner/events", "POST", { executionId, events: batch });
        if (response.ok) return;
        // A rejection the server will never change its mind about must not
        // wedge the queue behind it; a transport or auth problem retries.
        const permanent = response.status >= 400 && response.status < 500 && ![401, 408, 429].includes(response.status);
        if (permanent) {
          console.warn(`[runner] the control plane refused a report (${response.status}); dropping that batch`);
          return;
        }
        throw new Error(`report rejected (${response.status})`);
      },
      onProblem: (message) => console.warn("[runner]", message)
    });
    outboxes.set(workstreamId, created);
    return created;
  }

  // A declaration, not a `const`: everything below the early `return` above is
  // hoisted, and a `const` here would still be in its temporal dead zone when
  // the first poll fires.
  function report(workstreamId: string, executionId: string, event: RunnerEvent): void {
    outboxFor(workstreamId).append(executionId, event);
  }

  // --- Discovery ------------------------------------------------------------

  /**
   * Enrol for every local workstream whose repository is actually on this
   * machine. A repository that lives on someone else's disk is not this
   * machine's to run, so it is never claimed.
   */
  async function discover(): Promise<void> {
    if (stopped || discovering || !deps.getToken()) return;
    discovering = true;
    try {
      const missions = await deps.api.listMissions();
      for (const mission of missions) {
        const repository = mission.repository;
        if (!repository || repository.provider !== "local") continue;
        if (host.repositoryPath(repository.providerRepoId) === null) continue;

        let workstreamId = workstreamByMission.get(mission.missionId);
        if (!workstreamId) {
          const detail = await deps.api.getMission(mission.missionId);
          if (!detail.workstream) continue;
          workstreamId = detail.workstream.workstreamId;
          workstreamByMission.set(mission.missionId, workstreamId);
        }
        if (enrolments.has(workstreamId)) continue;

        const registered = await deps.api.registerRunner(workstreamId, label);
        enrolments.set(workstreamId, {
          runnerId: registered.runnerId,
          credential: registered.credential,
          expiresAt: registered.expiresAt
        });
        persistEnrolments();
      }
      // Once this machine knows which workstreams are its own, it says what
      // is actually true about the processes the last run recorded — nothing
      // is presented as still running just because a file says so.
      if (!reconciled && enrolments.size > 0) {
        reconciled = true;
        workspace.reconcile();
      }
    } catch (error) {
      // Offline or unauthorized: try again on the next tick rather than
      // tearing down an enrolment that is probably still good.
      console.warn("[runner] discovery failed:", messageOf(error));
    } finally {
      discovering = false;
      if (!stopped) void poll();
    }
  }

  // --- Command loop ---------------------------------------------------------

  async function poll(): Promise<void> {
    if (stopped || polling) return;
    polling = true;
    try {
      for (const [workstreamId, enrolment] of [...enrolments]) {
        await pollWorkstream(workstreamId, enrolment);
      }
    } finally {
      polling = false;
    }
  }

  async function pollWorkstream(workstreamId: string, enrolment: Enrolment): Promise<void> {
    let response: Response;
    try {
      response = await runnerFetch(enrolment, "/runner/commands", "GET");
    } catch {
      return; // offline; the outbox keeps buffering and the next tick retries
    }
    if (response.status === 401) {
      // Revoked or expired: drop the credential so discovery enrols afresh.
      enrolments.delete(workstreamId);
      persistEnrolments();
      return;
    }
    if (!response.ok) return;
    const parsed = RunnerCommandsResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      console.warn("[runner] the control plane answered commands in an unexpected shape");
      return;
    }
    for (const command of parsed.data.commands) {
      dispatch(command, parsed.data.workstream, enrolment);
    }
  }

  /** Queues one command behind its workstream's other work: one turn at a time
   *  per lane, and never the same command twice. */
  function dispatch(
    command: RunnerCommand,
    workstream: z.infer<typeof RunnerCommandsResponseSchema>["workstream"],
    enrolment: Enrolment
  ): void {
    if (inFlight.has(command.commandId)) return;
    inFlight.add(command.commandId);
    // An interrupt cannot queue behind the thing it interrupts. A running check
    // or a live dev server holds the lane for as long as it lasts, so a stop
    // that waited its turn would never arrive — and it must not take the lane
    // over either, or whatever was already queued would lose its place.
    const interrupt = command.kind === "stop_command";
    const previous = interrupt ? Promise.resolve() : (chains.get(workstream.workstreamId) ?? Promise.resolve());
    const next = previous
      .then(() => handle(command, workstream, enrolment))
      .catch((error: unknown) => console.error("[runner] command failed:", messageOf(error)))
      .finally(() => inFlight.delete(command.commandId));
    if (!interrupt) chains.set(workstream.workstreamId, next);
  }

  async function handle(
    command: RunnerCommand,
    workstream: z.infer<typeof RunnerCommandsResponseSchema>["workstream"],
    enrolment: Enrolment
  ): Promise<void> {
    if (stopped) return;
    if (settled.has(command.commandId)) {
      // Already done on a previous launch: settle it, do not run it again.
      await ack(enrolment, command.commandId, { state: "completed" });
      return;
    }
    await ack(enrolment, command.commandId, { state: "acknowledged" });
    try {
      await execute(command, workstream);
      rememberCommand(command.commandId);
      await ack(enrolment, command.commandId, {
        state: "completed",
        ...(command.executionId ? { executionId: command.executionId } : {})
      });
    } catch (error) {
      // The turn ran and failed; re-running it after a relaunch would repeat
      // whatever it already did to the worktree.
      rememberCommand(command.commandId);
      const reason = messageOf(error).slice(0, 400);
      if (command.executionId && openExecutions.has(command.executionId)) {
        openExecutions.delete(command.executionId);
        report(workstream.workstreamId, command.executionId, {
          kind: "execution.failed",
          payload: { classification: "internal", reason }
        });
      }
      await ack(enrolment, command.commandId, { state: "failed", failureReason: reason });
    }
  }

  async function ack(
    enrolment: Enrolment,
    commandId: string,
    body: { state: "acknowledged" | "completed" | "failed"; failureReason?: string; executionId?: string }
  ): Promise<void> {
    try {
      await runnerFetch(enrolment, `/runner/commands/${encodeURIComponent(commandId)}`, "POST", body);
    } catch (error) {
      // The command stays delivered server-side and comes back on the next
      // poll; the persisted memory is what stops the work repeating.
      console.warn("[runner] could not acknowledge a command:", messageOf(error));
    }
  }

  async function execute(
    command: RunnerCommand,
    workstream: z.infer<typeof RunnerCommandsResponseSchema>["workstream"]
  ): Promise<void> {
    const workstreamId = workstream.workstreamId;
    if (command.kind === "stop_execution") {
      const running = active.get(workstreamId);
      if (running) running.turn.stop("Stopped by a participant.");
      return;
    }
    if (command.kind === "boundary_request") {
      // A turn always reports its own boundary when it ends; an idle
      // workstream is already at one, so there is nothing to interrupt.
      return;
    }
    if (
      command.kind === "run_setup" ||
      command.kind === "run_command" ||
      command.kind === "stop_command" ||
      command.kind === "run_verification"
    ) {
      await runWorkspaceCommand(command, workstream);
      return;
    }

    const executionId = command.executionId;
    if (!executionId) throw new Error("the command named no execution");
    const repositoryPath = host.repositoryPath(workstream.providerRepoId);
    if (!repositoryPath) throw new Error("this local repository lives on another machine");
    const payload = StartPayloadSchema.safeParse(command.payload);
    if (!payload.success) throw new Error("the command payload was malformed");

    await runTurn({
      workstreamId,
      missionId: workstream.missionId,
      executionId,
      repositoryPath,
      missionBranch: workstream.missionBranch,
      direction: payload.data.body,
      directionId: payload.data.directionId ?? null,
      model: payload.data.model,
      effort: payload.data.effort,
      resumeSessionId: payload.data.resumeSessionId ?? workstream.harnessSessionId,
      announceStart: command.kind === "start_execution" && !openExecutions.has(executionId),
      pendingApplies: () => pendingAppliesFor(workstreamId, executionId, command.commandId)
    });
  }

  /**
   * One of the four commands the project itself declared. The control plane
   * authorized it and named which one; which *command line* that name means is
   * read from the repository, here, and nowhere else.
   */
  async function runWorkspaceCommand(
    command: RunnerCommand,
    workstream: z.infer<typeof RunnerCommandsResponseSchema>["workstream"]
  ): Promise<void> {
    const payload = WorkspacePayloadSchema.safeParse(command.payload);
    if (!payload.success) throw new Error("the command payload was malformed");
    const context: WorkspaceCommandContext = {
      missionId: workstream.missionId,
      workstreamId: workstream.workstreamId,
      providerRepoId: workstream.providerRepoId,
      missionBranch: workstream.missionBranch,
      workspaceId: payload.data.workspaceId ?? null
    };
    const name = payload.data.name ?? null;
    if (command.kind === "run_setup") return workspace.runSetup(context);
    if (command.kind === "run_command") return workspace.runCommand(context, name);
    if (command.kind === "stop_command") return workspace.stopCommand(context, name);
    return workspace.runVerification(context, name);
  }

  interface TurnArgs {
    workstreamId: string;
    missionId: string;
    executionId: string;
    repositoryPath: string;
    missionBranch: string;
    direction: string;
    directionId: string | null;
    model: string;
    effort: string;
    resumeSessionId: string | null;
    announceStart: boolean;
    pendingApplies: () => Promise<boolean>;
  }

  async function runTurn(args: TurnArgs): Promise<void> {
    let directionPending = args.directionId;
    const emit = (event: RunnerEvent): void => {
      report(args.workstreamId, args.executionId, event);
      // Applied means the harness has it. The session event is the moment the
      // harness actually took the turn, so that is when it is marked.
      if (event.kind === "harness.session" && directionPending) {
        report(args.workstreamId, args.executionId, {
          kind: "direction.applied",
          payload: { directionId: directionPending }
        });
        directionPending = null;
      }
    };

    const turn = startTurn({
      executionId: args.executionId,
      missionId: args.missionId,
      repositoryPath: args.repositoryPath,
      worktreeRoot,
      missionBranch: args.missionBranch,
      direction: args.direction,
      model: args.model,
      effort: args.effort,
      resumeSessionId: args.resumeSessionId,
      announceStart: args.announceStart,
      fakeHarness,
      emit
    });
    active.set(args.workstreamId, { executionId: args.executionId, turn });
    openExecutions.set(args.executionId, args.workstreamId);

    let result: TurnResult;
    try {
      result = await turn.finished;
    } finally {
      active.delete(args.workstreamId);
    }
    if (stopped) return; // shutdown owns the terminal event

    // A completed turn only ends the execution when nothing else is queued for
    // it; otherwise the next direction continues the same run.
    if (result.terminal.kind === "execution.completed" && (await args.pendingApplies())) return;
    openExecutions.delete(args.executionId);
    report(args.workstreamId, args.executionId, result.terminal);
  }

  /**
   * Is more direction already waiting for this execution? The command being
   * served right now is excluded: it is still `acknowledged` server-side, and
   * counting itself would keep the execution open forever.
   */
  async function pendingAppliesFor(
    workstreamId: string,
    executionId: string,
    currentCommandId: string
  ): Promise<boolean> {
    const enrolment = enrolments.get(workstreamId);
    if (!enrolment) return false;
    try {
      const response = await runnerFetch(enrolment, "/runner/commands", "GET");
      if (!response.ok) return false;
      const parsed = RunnerCommandsResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return false;
      return parsed.data.commands.some(
        (command) =>
          command.kind === "apply_direction" &&
          command.executionId === executionId &&
          command.commandId !== currentCommandId &&
          !settled.has(command.commandId)
      );
    } catch {
      return false;
    }
  }

  // --- Shutdown -------------------------------------------------------------

  async function shutdown(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(discoverTimer);
    clearInterval(pollTimer);

    for (const [, running] of active) running.turn.stop(reason);
    await Promise.race([
      Promise.allSettled([...active.values()].map((running) => running.turn.finished)),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
    ]);

    // An execution that was working when the app closed is interrupted, and
    // says so: a room never hangs on "running" forever (D-034).
    for (const [executionId, workstreamId] of openExecutions) {
      report(workstreamId, executionId, {
        kind: "execution.interrupted",
        payload: { reason: reason.slice(0, 400) }
      });
    }
    active.clear();
    openExecutions.clear();

    // No run command outlives the app that started it, and each one reports
    // its own exit on the way out (D-034).
    await workspace.shutdown(reason);

    await Promise.allSettled([...outboxes.values()].map((outbox) => outbox.flush()));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong on this machine.";
}
