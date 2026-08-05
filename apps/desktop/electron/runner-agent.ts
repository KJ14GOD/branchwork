import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ApiErrorSchema,
  DeclaredCommandSchema,
  RunnerCommandsResponseSchema,
  type MissionDetailResponse,
  type RunnerCommand,
  type RunnerEvent,
  type SequencedRunnerEvent
} from "@novus/contracts";
import { z } from "zod";
import type { ControlPlaneClient } from "./api-client";
import { startTurn, type RunningTurn, type TurnResult } from "./execution";
import { EventOutbox } from "./outbox";
import {
  createWorkspaceRuntime,
  secretValuesFor,
  type PinnedCommand,
  type WorkspaceCommandContext
} from "./workspace";
import {
  clonedRepositoryRoot,
  ensureRepositoryClone,
  hasMissionBranch,
  type CloneCredential
} from "./workspace-clone";

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
  /** Re-read one project's configuration and publish what it declares, so a
   *  participant who has just saved settings does not wait for a poll. */
  republish(missionId: string): void;
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
  /** Where a repository lives on this machine, or null if it does not. */
  repositoryPath: (providerRepoId: string) => string | null;
  /** Remembers a checkout Novus fetched itself, in the same machine-local map
   *  a folder the user picked lives in. Absent in tests that never fetch. */
  recordRepositoryPath?: (providerRepoId: string, repoPath: string) => void;
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
  /** Makes the scripted harness ask for permission before it writes, so the
   *  approval round trip is driven through this agent rather than mocked. */
  fakeApproval?: boolean;
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
  const { pathForLocalRepo, recordRepositoryPath } = require("./local-repos") as {
    pathForLocalRepo: (providerRepoId: string) => string | null;
    recordRepositoryPath: (providerRepoId: string, repoPath: string) => void;
  };
  return {
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged,
    label: hostname().slice(0, 120).replace(/[/\\]/g, "-") || "this machine",
    repositoryPath: pathForLocalRepo,
    recordRepositoryPath
  };
}

const DISCOVER_EVERY_MS = 15_000;
const POLL_EVERY_MS = 2_000;
/** How long a stopped turn is given to unwind before the app stops waiting. */
const SHUTDOWN_GRACE_MS = 8_000;
/** Bound on the remembered command ids: enough to cover a relaunch, not a log. */
const COMMAND_MEMORY = 500;
/** How far apart retries of a repository this machine cannot fetch may grow. */
const CHECKOUT_RETRY_CAP_MS = 5 * 60_000;

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
  workspaceId: z.string().min(1).nullable().optional(),
  /**
   * The snapshot the control plane authorized (D-043). The runner executes
   * this, rather than re-reading a configuration file that a harness turn may
   * have edited since the participant pressed the control. Absent only for
   * `stop_command`, which names a process rather than a command line.
   */
  command: DeclaredCommandSchema.nullable().optional()
});

/**
 * The answer to `/runner/clone-credential`: a short-lived, repository-scoped
 * credential for one fetch. Held in memory for the length of that fetch and
 * never written anywhere — not to the enrolment file, not to an event, not to
 * a log line.
 */
const CloneCredentialSchema = z.object({
  remoteUrl: z.string().min(1).max(400),
  username: z.string().min(1).max(120),
  token: z.string().min(1),
  expiresAt: z.string().min(1).max(64)
});

const StartPayloadSchema = z.object({
  directionId: z.string().optional(),
  body: z.string().default(""),
  model: z.string().default(""),
  effort: z.string().default(""),
  resumeSessionId: z.string().nullable().default(null)
});

/**
 * One participant's answer to one harness permission question (D-056).
 *
 * The control plane has already settled the durable request by the time this
 * arrives — this command exists only to carry the decision to the process that
 * is blocked on it. `harnessRequestId` is the harness's own correlation id;
 * nothing else can identify what is waiting.
 */
const ApprovalPayloadSchema = z.object({
  approvalId: z.string().min(1).max(120),
  harnessRequestId: z.string().min(1).max(400),
  decision: z.enum(["approve", "deny"]),
  reason: z.string().max(500).nullable().optional()
});

/** What a stopped execution says it was stopped by. One string, because the
 *  turn path and the never-started path must give the same account. */
const STOPPED_BY_PARTICIPANT = "Stopped by a participant.";

export function startRunnerAgent(deps: RunnerAgentDeps): RunnerAgent {
  const host = deps.host ?? electronHost();
  const httpFetch = deps.fetch ?? fetch;
  const userData = host.userDataPath;
  const credentialPath = join(userData, "runner-credentials.json");
  const commandMemoryPath = join(userData, "runner-commands.json");
  const worktreeRoot = join(userData, "worktrees");
  const fakeHarness =
    deps.fakeHarness ?? (process.env.NOVUS_FAKE_HARNESS === "1" && !host.isPackaged);
  const fakeApproval =
    deps.fakeApproval ?? (process.env.NOVUS_FAKE_HARNESS_APPROVAL === "1" && fakeHarness);
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
  /** Executions a participant has stopped. Consulted by every turn before it
   *  spawns, so a stop that arrives early is honoured rather than swallowed. */
  const stopRequested = new Set<string>();
  /** Repositories this machine could not fetch: when to try again, and what was
   *  last said about why, so one unreachable repository is one event. */
  const checkoutRetry = new Map<string, { after: number; attempts: number; reason: string }>();
  /** The last configuration problem said out loud per workstream, so a broken
   *  settings file is one warning rather than one every discovery pass. */
  const announcedProblem = new Map<string, string>();
  /** Missions whose branch this machine has confirmed it holds, so the check
   *  above costs one `rev-parse` per mission per run rather than one every
   *  fifteen seconds forever. */
  const fetched = new Set<string>();

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
    republish: (missionId) => void republishFor(missionId),
    pollNow: () => void poll(),
    shutdown
  };

  async function republishFor(missionId: string): Promise<void> {
    const workstreamId = workstreamByMission.get(missionId);
    if (workstreamId === undefined || !enrolments.has(workstreamId)) {
      void discover();
      return;
    }
    try {
      const detail = await deps.api.getMission(missionId);
      const repository = detail.mission.repository;
      if (!repository || !detail.workstream) return;
      announcedProblem.delete(workstreamId);
      const missionBranch = detail.workstream.missionBranch;
      const workspaceId = detail.workspace?.workspaceId ?? null;
      chain(workstreamId, () =>
        announceCommands({ missionId, workstreamId, providerRepoId: repository.providerRepoId, missionBranch, workspaceId })
      );
    } catch (error) {
      console.warn("[runner] could not re-read this project's configuration:", messageOf(error));
    }
  }

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
   * Enrol for every workstream this machine can actually run.
   *
   * For a local repository that means the folder is here: one on someone
   * else's disk is not this machine's to run, so it is never claimed. For a
   * GitHub repository it means this machine fetches it first (D-025, D-032) —
   * after which the two are the same thing, and nothing below this function
   * has a case for either.
   */
  async function discover(): Promise<void> {
    if (stopped || discovering || !deps.getToken()) return;
    discovering = true;
    try {
      const missions = await deps.api.listMissions();
      for (const mission of missions) {
        const repository = mission.repository;
        if (!repository) continue;
        const github = repository.provider === "github";
        if (!github && repository.provider !== "local") continue;
        if (!github && host.repositoryPath(repository.providerRepoId) === null) continue;
        const known = workstreamByMission.get(mission.missionId);
        const enrolled = known !== undefined && enrolments.has(known);
        // A local repository is here or it is not. A GitHub one has a second
        // question: this machine may hold the *repository* and not yet hold
        // *this workstream's branch*, which is every mission after the first
        // one on the same repository — and a worktree cannot be made from a ref
        // that is not there.
        if (enrolled && !github && fetched.has(mission.missionId)) continue;

        const detail = await deps.api.getMission(mission.missionId);
        if (!detail.workstream) continue;
        const workstreamId = detail.workstream.workstreamId;
        const missionBranch = detail.workstream.missionBranch;
        workstreamByMission.set(mission.missionId, workstreamId);

        const checkoutPath = host.repositoryPath(repository.providerRepoId);
        const needsCheckout =
          github && !(await hasMissionBranch(checkoutPath, missionBranch));
        if (!needsCheckout) fetched.add(mission.missionId);
        if (enrolled && !needsCheckout) continue;

        if (!enrolments.has(workstreamId)) {
          if (github && !shouldHostGithub(detail)) continue;
          const registered = await deps.api.registerRunner(workstreamId, label);
          enrolments.set(workstreamId, {
            runnerId: registered.runnerId,
            credential: registered.credential,
            expiresAt: registered.expiresAt
          });
          persistEnrolments();
        }
        // Before anything asks for a worktree, so the mission branch the server
        // allocated is here and the worktree starts from the right commit.
        if (needsCheckout) {
          await ensureCheckout(workstreamId, repository.providerRepoId, missionBranch);
          if (await hasMissionBranch(host.repositoryPath(repository.providerRepoId), missionBranch)) {
            fetched.add(mission.missionId);
          }
        }
        // A mission whose branch is not on this machine is not announced at
        // all (D-060). Publishing creates the worktree, and `git worktree add`
        // on a repository that has no such ref fails with `fatal: invalid
        // reference: novus/m-…` — which is the message this product has
        // already been blamed for once. `ensureCheckout` returns silently
        // while it is backing off from a failed fetch, so without this the
        // announce fires on every fifteen-second pass of that window and the
        // failure looks like a mission that can never have a workspace.
        if (!fetched.has(mission.missionId)) continue;

        // Queued on this workstream's own chain, and not awaited here.
        // Publishing reads the project and creates the worktree if it is not
        // there, which is real work on the same files a turn uses — so it takes
        // its turn in the lane rather than running beside one. Not awaiting it
        // keeps discovery from delaying the first poll, which is how a command
        // that is already queued gets picked up.
        const workspaceId = detail.workspace?.workspaceId ?? null;
        chain(workstreamId, () =>
          announceCommands({
            missionId: mission.missionId,
            workstreamId,
            providerRepoId: repository.providerRepoId,
            missionBranch,
            workspaceId
          })
        );
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

  /** Queues work behind whatever this workstream is already doing. One lane per
   *  workstream is what keeps a turn, a command, and a configuration read from
   *  touching the same worktree at the same time. */
  function chain(workstreamId: string, work: () => Promise<void>): void {
    const previous = chains.get(workstreamId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((error: unknown) => console.warn("[runner]", messageOf(error)));
    chains.set(workstreamId, next);
  }

  /**
   * Reads the project's configuration and publishes what it declares (D-043).
   *
   * This is what makes the Run control work for somebody who is not at this
   * machine: they read the list from the control plane rather than from a disk
   * they cannot see. It is also what gives the control plane a snapshot to pin
   * an authorization to. Failure is quiet on purpose — a project with a broken
   * `.novus/settings.toml` says so through the setup surface, and a discovery
   * pass is not the place to relitigate it every fifteen seconds.
   */
  async function announceCommands(context: WorkspaceCommandContext): Promise<void> {
    try {
      await workspace.publishDeclared(context);
    } catch (error) {
      const reason = messageOf(error);
      if (announcedProblem.get(context.workstreamId) === reason) return;
      announcedProblem.set(context.workstreamId, reason);
      console.warn("[runner] could not read this project's configuration:", reason);
    }
  }

  // --- Fetching a GitHub repository onto this machine -------------------------

  /**
   * Whether this machine should take the runner slot for a GitHub workstream.
   * Advisory, like every other capability list a client holds: the control
   * plane decides who may displace whom (D-035). What it prevents is two
   * machines belonging to one person taking the lane from each other forever,
   * which for a local repository could never happen because only one machine
   * held the folder.
   */
  function shouldHostGithub(detail: MissionDetailResponse): boolean {
    // The server allocates a GitHub mission branch; until it exists there is
    // nothing to fetch and nothing to make a worktree from.
    if (detail.workstream?.branchStatus !== "created") return false;
    return !detail.runner || detail.runner.label === label;
  }

  /**
   * Fetches the workstream's repository onto this machine over this runner's
   * own credential and records where it landed. Everything after it — worktree,
   * setup, run, verification, checkpoints, the harness — then works with no
   * idea the repository came from GitHub.
   */
  async function ensureCheckout(
    workstreamId: string,
    providerRepoId: string,
    missionBranch: string
  ): Promise<void> {
    const enrolment = enrolments.get(workstreamId);
    if (!enrolment) return;
    const previous = checkoutRetry.get(workstreamId);
    if (previous && Date.now() < previous.after) return;

    try {
      const credential = await cloneCredential(enrolment, workstreamId);
      const checkout = await ensureRepositoryClone({
        root: clonedRepositoryRoot(userData),
        providerRepoId,
        missionBranch,
        credential
      });
      checkoutRetry.delete(workstreamId);
      host.recordRepositoryPath?.(providerRepoId, checkout.path);
    } catch (error) {
      // A named refusal the room can read, not a workspace half built behind
      // its back. Said once per distinct reason, with a widening gap between
      // attempts, so a repository this machine will never reach does not become
      // an event every fifteen seconds.
      const reason = messageOf(error).slice(0, 400);
      const attempts = (previous?.attempts ?? 0) + 1;
      checkoutRetry.set(workstreamId, {
        after: Date.now() + Math.min(DISCOVER_EVERY_MS * 2 ** (attempts - 1), CHECKOUT_RETRY_CAP_MS),
        attempts,
        reason
      });
      if (previous?.reason !== reason) {
        console.warn("[runner] could not fetch the repository:", reason);
        outboxFor(workstreamId).append(null, {
          kind: "workspace.readiness",
          payload: { readiness: "failed", portRangeStart: null, portRangeEnd: null, setupError: reason }
        });
      }
    }
  }

  /**
   * The short-lived, repository-scoped credential for one fetch. Obtained over
   * the runner credential — a user session cannot ask for it — used, and
   * forgotten: it is never persisted, never logged, and never reported.
   */
  async function cloneCredential(enrolment: Enrolment, workstreamId: string): Promise<CloneCredential> {
    const response = await runnerFetch(enrolment, "/runner/clone-credential", "POST", { workstreamId });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const named = ApiErrorSchema.safeParse(body);
      throw new Error(
        named.success ? named.data.error.message : `Novus could not get repository access (${response.status}).`
      );
    }
    const parsed = CloneCredentialSchema.safeParse(body);
    if (!parsed.success) throw new Error("The control plane answered repository access in an unexpected shape.");
    return parsed.data;
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
    //
    // `stop_execution` belongs here for a sharper reason than lateness: the
    // chain only resolves after the turn has been removed from `active`, so a
    // queued stop found nothing to stop and returned successfully. It was not
    // a delayed interrupt, it was a guaranteed no-op.
    //
    // `respond_approval` is the sharpest case of all: the turn it answers is
    // *blocked on that answer*, so a decision that waited its turn in the lane
    // would wait for the thing it exists to release. That is a deadlock, not a
    // delay, and it is the same shape of fault D-053 found in stop.
    //
    // `boundary_request` joins them for the same reason: the boundary it asks
    // about may be a turn blocked on an approval, and a question asked from
    // behind that turn could never be answered while the turn is the thing
    // holding the lane.
    const interrupt =
      command.kind === "stop_command" ||
      command.kind === "stop_execution" ||
      command.kind === "respond_approval" ||
      command.kind === "boundary_request";
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
      if (!command.executionId) return;
      // Remembered, not just delivered. A stop can arrive before its turn has
      // spawned, between two turns of a multi-turn execution, or while the
      // start command is still queued behind something else — in every one of
      // those the harness is not running *yet*, and a stop that only looked at
      // what was running would be silently swallowed while the turn it was
      // meant to prevent went ahead.
      stopRequested.add(command.executionId);
      const running = active.get(workstreamId);
      // Matched on the execution, because a stale stop re-offered after its own
      // execution ended would otherwise kill whichever turn is running now.
      if (running && running.executionId === command.executionId) {
        running.turn.stop(STOPPED_BY_PARTICIPANT);
      }
      return;
    }
    if (command.kind === "respond_approval") {
      respondToApproval(command, workstreamId);
      return;
    }
    if (command.kind === "boundary_request") {
      // A turn always reports its own boundary when it ends; an idle
      // workstream is already at one, so there is nothing to interrupt.
      //
      // Except one case, which PRODUCT.md names outright: a harness waiting on
      // a permission prompt **is** at a safe boundary. A transfer accepted
      // while a turn is blocked on an approval would otherwise wait for the
      // turn to end, and the turn is waiting for an answer the recipient is the
      // only person allowed to give — so it would wait for ever. The boundary
      // is declared here rather than assumed by the control plane, because only
      // this machine knows the harness is blocked.
      const blocked = active.get(workstreamId);
      if (blocked && blocked.turn.pendingApprovals().length > 0) {
        report(workstreamId, blocked.executionId, {
          kind: "boundary.reached",
          payload: { reason: "permission prompt pending" }
        });
      }
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
      providerRepoId: workstream.providerRepoId,
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
   * Carries one settled decision to the harness process that is waiting on it.
   *
   * Late is the ordinary case and not an error: the turn may have ended, been
   * stopped, or had the question cancelled with it, and the control plane has
   * already recorded whatever actually happened. So an answer with nothing left
   * to answer completes quietly rather than failing the command and having it
   * re-offered for ever.
   *
   * Matched on the execution as well as the request id, for the same reason
   * `stop_execution` is: a decision re-offered after a relaunch must not be
   * written into whatever turn happens to be running now.
   */
  function respondToApproval(command: RunnerCommand, workstreamId: string): void {
    const payload = ApprovalPayloadSchema.safeParse(command.payload);
    if (!payload.success) throw new Error("the approval decision was malformed");
    const running = active.get(workstreamId);
    if (!running || running.executionId !== command.executionId) return;
    running.turn.respondApproval(
      payload.data.harnessRequestId,
      payload.data.decision,
      payload.data.reason ?? null
    );
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
    const pinned: PinnedCommand = { name, snapshot: payload.data.command ?? null };
    if (command.kind === "run_setup") return workspace.runSetup(context, pinned);
    if (command.kind === "run_command") return workspace.runCommand(context, pinned);
    if (command.kind === "stop_command") return workspace.stopCommand(context, name);
    return workspace.runVerification(context, pinned);
  }

  interface TurnArgs {
    workstreamId: string;
    missionId: string;
    executionId: string;
    /** Which project's supplied values the transcript must not repeat. */
    providerRepoId: string;
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

    // The stop may already have arrived — for this execution, before this turn
    // existed. Reported as the terminal outcome rather than started and then
    // killed, so a participant who stopped an execution never sees a harness
    // process run afterwards and never gets a checkpoint from one.
    if (stopRequested.has(args.executionId)) {
      openExecutions.delete(args.executionId);
      report(args.workstreamId, args.executionId, {
        kind: "execution.stopped",
        // Nothing was interrupted and nothing was killed: the stop arrived
        // before any harness process existed, so the turn was prevented. The
        // record says which of the three actually happened.
        payload: { reason: STOPPED_BY_PARTICIPANT, via: "never_started" }
      });
      return;
    }

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
      fakeApproval,
      // Read per emit rather than captured once, and never handed to the
      // renderer or the control plane — the redactor is the only thing in the
      // reporting path that ever sees a value (D-041, D-052).
      secretValues: () => secretValuesFor(host, args.providerRepoId),
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
    // it; otherwise the next direction continues the same run. A *stopped* one
    // never continues: queued direction for a stopped execution is discarded
    // with it, which is what the participant asked for.
    if (
      result.terminal.kind === "execution.completed" &&
      !stopRequested.has(args.executionId) &&
      (await args.pendingApplies())
    ) {
      return;
    }
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

    // Whatever is still queued on a workstream's lane is still touching that
    // workstream's files — publishing what a project declares reads the
    // repository and can create a worktree. Shutdown that returns while one is
    // mid-`git` is claiming to be finished when it is not, and the caller then
    // does the thing callers do after shutdown: remove the directory.
    await Promise.race([
      Promise.allSettled([...chains.values()]),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
    ]);
    chains.clear();

    // No run command outlives the app that started it, and each one reports
    // its own exit on the way out (D-034).
    await workspace.shutdown(reason);

    await Promise.allSettled([...outboxes.values()].map((outbox) => outbox.flush()));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong on this machine.";
}
