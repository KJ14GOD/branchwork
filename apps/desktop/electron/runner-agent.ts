import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ApiErrorSchema,
  ArtifactSchema,
  BeginArtifactResponseSchema,
  DEFAULT_PERMISSION_PROFILE,
  DeclaredCommandSchema,
  EnabledMcpServersSchema,
  EnabledSkillsSchema,
  PermissionProfileSchema,
  RunnerCommandsResponseSchema,
  type Artifact,
  type EnabledMcpServer,
  type EnabledSkill,
  type MissionDetailResponse,
  type PermissionProfile,
  type RunnerCommand,
  type RunnerEvent,
  type SequencedRunnerEvent
} from "@novus/contracts";
import { z } from "zod";
import { ApiError, type ControlPlaneClient } from "./api-client";
import {
  captureScreenshot as capturePreviewScreenshot,
  type ArtifactUploader
} from "./artifact-capture";
import { CAPTURE_TOOL_FULL_NAME, mintCaptureGrant, registerCaptureTurn } from "./artifact-mcp";
import { startRecording } from "./artifact-recording";
import { SCREENSHOT_CLAIM } from "./artifact-policy";
import { redact } from "./secret-policy";
import { processLogsFor } from "./workspace";
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
import { pushMissionBranch } from "./workspace-push";

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
   * Captures a screenshot of the named lane's live preview as durable
   * evidence, on a person's own click (D-123). The renderer supplied nothing
   * but the lane; every judgment — which pixels, which process, which
   * revision — is this machine's. Throws an ApiError whose message is the
   * refusal in words.
   */
  captureScreenshot(missionId: string, workstreamId: string): Promise<Artifact>;
  /** Starts recording the named lane's live preview (D-123). Stop, cancel,
   *  and status are the recorder module's own, machine-wide verbs. */
  startRecording(missionId: string, workstreamId: string): Promise<void>;
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

/** What a command a *previous* launch began says happened to it. */
const RESTARTED_MID_COMMAND =
  "This machine restarted while the command was still running, so it was not run again.";
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

/**
 * What this machine remembers about a command, and the whole reason it is two
 * words rather than a set of ids.
 *
 * `settled` is "this ran to an end here": offered again after a relaunch, it is
 * completed rather than repeated, which is what the memory has always done.
 * `started` is the case that was missing — written *before* the work begins, so
 * a machine that dies mid-turn leaves a record that it began. Without it the
 * command came back on the next launch indistinguishable from a fresh one and
 * the turn ran a second time, from scratch, against a worktree the first
 * attempt had already changed.
 */
type CommandMemoryState = "started" | "settled";

interface RememberedCommand {
  id: string;
  state: CommandMemoryState;
  /** The execution the command belonged to, so an interrupted one can be
   *  reported by name after the process that was running it is gone. */
  executionId?: string | null;
}

/** The file, in either shape. The array is what earlier launches wrote — every
 *  id in it had finished, so it reads forward as `settled`. */
const CommandMemoryFileSchema = z.union([
  z.array(z.string()),
  z.object({
    version: z.literal(2),
    commands: z.array(
      z.object({
        id: z.string(),
        state: z.enum(["started", "settled"]),
        executionId: z.string().nullable().optional()
      })
    )
  })
]);

interface ActiveTurn {
  executionId: string;
  workstreamId: string;
  /** The turn's pinned scope (D-097), so a sibling's checkpoint can tell
   *  this turn's in-flight territory from genuine drift. */
  scope: string[] | null;
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
  resumeSessionId: z.string().nullable().default(null),
  /** Which conversation this turn belongs to (D-083). Its presence is also a
   *  statement: the server chose `resumeSessionId` deliberately, so a null
   *  there means "start fresh" — never "fall back to the workstream's". */
  sessionId: z.string().nullable().default(null),
  /** What the turn may do to the worktree (D-095). Absent means write. */
  access: z.enum(["write", "read"]).default("write"),
  /** The chat's file scope, pinned at dispatch (D-097, the D-043 pattern):
   *  this turn enforces the scope the controller had approved when it was
   *  authorized, not whatever the row says by the time it runs. Null means
   *  unscoped — the whole workspace, exclusively. */
  scope: z.array(z.string()).nullable().default(null),
  /** The lane's answer policy, pinned at dispatch exactly as the scope is
   *  (D-115). Defaulted to manual so a command from an older control plane
   *  runs as every turn always did: asking. */
  permissionProfile: PermissionProfileSchema.default(DEFAULT_PERMISSION_PROFILE),
  /** The enabled skills, pinned at dispatch (D-118): each at the digest a
   *  person reviewed. Defaulted empty so a command from an older control
   *  plane carries nothing rather than something. */
  skills: EnabledSkillsSchema.default([]),
  /** The enabled MCP servers (D-119), same rule. */
  mcpServers: EnabledMcpServersSchema.default([])
});

/** The push the control plane authorized (D-099): the branch, and the exact
 *  decided revision the remote must serve afterwards. */
const PushPayloadSchema = z.object({
  branch: z.string().min(1).max(200),
  sha: z.string().regex(/^[0-9a-f]{40}$/)
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

/** The commands that drive a harness turn, and are therefore the ones whose
 *  abandonment leaves an execution the room is still describing. */
const HARNESS_COMMANDS: RunnerCommand["kind"][] = ["start_execution", "apply_direction"];

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
  // Keyed by **execution**, not workstream: a lane can hold a write turn and
  // a read-alongside turn at once (D-095), and a workstream key would let the
  // second overwrite the first — a stop or an approval answer would then find
  // the wrong turn, or none.
  const active = new Map<string, ActiveTurn>();
  /** Executions this machine has begun and not yet ended, by workstream, so a
   *  quit mid-turn can close every one of them honestly. */
  const openExecutions = new Map<string, string>();
  const memory = new Map<string, RememberedCommand>(
    loadCommandMemory().map((entry) => [entry.id, entry])
  );
  /**
   * Commands a *previous* launch of this machine began and never finished.
   * Snapshotted at start-up, because once this process starts writing `started`
   * of its own the two cases are indistinguishable in the map.
   */
  const abandoned = new Map<string, RememberedCommand>(
    [...memory.values()].filter((entry) => entry.state === "started").map((entry) => [entry.id, entry])
  );
  const inFlight = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  /** Executions a participant has stopped. Consulted by every turn before it
   *  spawns, so a stop that arrives early is honoured rather than swallowed. */
  const stopRequested = new Set<string>();
  /** Repositories this machine could not fetch: when to try again, and what was
   *  last said about why, so one unreachable repository is one event. */
  const checkoutRetry = new Map<string, { after: number; attempts: number; reason: string }>();
  /** One checkout mutation at a time per repository: discovery's pass and a
   *  first turn waiting on the fetch must never clone or fetch into the same
   *  path at once (the same shape of fault D-058 found in worktrees). */
  const checkoutQueue = new Map<string, Promise<void>>();
  /** The last configuration problem said out loud per workstream, so a broken
   *  settings file is one warning rather than one every discovery pass. */
  const announcedProblem = new Map<string, string>();
  /** Lanes whose branch this machine has confirmed it holds, keyed
   *  `mission:workstream`, so the check above costs one `rev-parse` per lane
   *  per run rather than one every fifteen seconds forever. */
  const fetched = new Set<string>();
  /** What each enrolled lane is, refreshed by every command poll: the facts a
   *  capture needs (D-123) without asking the control plane again. */
  const laneInfo = new Map<string, { missionId: string; providerRepoId: string }>();

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

  /**
   * A buffer that survived a relaunch used to sit unread until something new
   * happened on its workstream — a terminal event could wait on disk forever
   * while the room said Running (D-110). Constructing the outbox restores the
   * file; the flush delivers it. Only enrolled workstreams: a file for a lane
   * this machine no longer runs has no credential to deliver with.
   */
  function pumpPersistedOutboxes(): void {
    let names: string[] = [];
    try {
      names = readdirSync(join(userData, "runner-outbox"));
    } catch {
      return; // no directory yet: nothing buffered, nothing to do
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const workstreamId = name.slice(0, -".json".length);
      if (!enrolments.has(workstreamId)) continue;
      void outboxFor(workstreamId).flush();
    }
  }

  const discoverTimer = setInterval(() => void discover(), DISCOVER_EVERY_MS);
  const pollTimer = setInterval(() => void poll(), POLL_EVERY_MS);
  // Parked is no longer forever: every discovery pass re-offers delivery to
  // any outbox still holding events, so ~32 s of control-plane downtime costs
  // fifteen more seconds of delay, not silence until the app quits (D-110).
  const outboxTimer = setInterval(() => {
    for (const outbox of outboxes.values()) {
      if (outbox.pending > 0) void outbox.flush();
    }
  }, DISCOVER_EVERY_MS);
  void discover();
  pumpPersistedOutboxes();

  return {
    discoverNow: () => void discover(),
    republish: (missionId) => void republishFor(missionId),
    pollNow: () => void poll(),
    captureScreenshot: capturePersonScreenshot,
    startRecording: startPersonRecording,
    shutdown
  };

  /** The known-secret redaction for a lane's project (D-052), applied to
   *  every textual capture field before it leaves this machine. */
  function captureSanitizer(workstreamId: string): (text: string) => string {
    const providerRepoId = laneInfo.get(workstreamId)?.providerRepoId ?? null;
    return (text) =>
      redact(text, providerRepoId === null ? [] : secretValuesFor(host, providerRepoId));
  }

  /** A refusal from an artifact route, surfaced in the server's own words. */
  async function artifactRefusal(response: Response): Promise<ApiError> {
    const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
    return parsed.success
      ? new ApiError(parsed.data.error.code, parsed.data.error.message, response.status)
      : new ApiError("artifact_failed", `The control plane answered ${response.status}.`, response.status);
  }

  /** A person's capture uploads under their own session (D-122). */
  function personUploader(missionId: string, workstreamId: string): ArtifactUploader {
    return {
      begin: (input) => deps.api.beginArtifact(missionId, { ...input, workstreamId }),
      complete: (artifactId, outcome, failureReason) =>
        deps.api.completeArtifact(artifactId, outcome, failureReason)
    };
  }

  /** An agent-requested capture uploads under this runner's credential,
   *  naming the requesting execution (D-123). */
  function runnerUploader(executionId: string, enrolment: Enrolment): ArtifactUploader {
    return {
      begin: async (input) => {
        const response = await runnerFetch(enrolment, "/runner/artifacts", "POST", {
          ...input,
          executionId
        });
        if (!response.ok) throw await artifactRefusal(response);
        return BeginArtifactResponseSchema.parse(await response.json());
      },
      complete: async (artifactId, outcome, failureReason) => {
        const response = await runnerFetch(
          enrolment,
          `/runner/artifacts/${artifactId}/complete`,
          "POST",
          { outcome, ...(failureReason ? { failureReason } : {}) }
        );
        if (!response.ok) throw await artifactRefusal(response);
        const body = (await response.json()) as { artifact: unknown };
        return ArtifactSchema.parse(body.artifact);
      }
    };
  }

  async function capturePersonScreenshot(missionId: string, workstreamId: string): Promise<Artifact> {
    return capturePreviewScreenshot({
      workstreamId,
      worktreePath: join(worktreeRoot, workstreamId),
      logs: processLogsFor(workstreamId),
      sanitize: captureSanitizer(workstreamId),
      uploader: personUploader(missionId, workstreamId)
    });
  }

  async function startPersonRecording(missionId: string, workstreamId: string): Promise<void> {
    await startRecording({
      missionId,
      workstreamId,
      worktreePath: join(worktreeRoot, workstreamId),
      logs: () => processLogsFor(workstreamId),
      sanitize: captureSanitizer(workstreamId),
      uploader: personUploader(missionId, workstreamId)
    });
  }

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

  function loadCommandMemory(): RememberedCommand[] {
    try {
      if (!existsSync(commandMemoryPath)) return [];
      const parsed = CommandMemoryFileSchema.safeParse(JSON.parse(readFileSync(commandMemoryPath, "utf8")));
      if (!parsed.success) return [];
      return Array.isArray(parsed.data)
        ? parsed.data.map((id) => ({ id, state: "settled" as const }))
        : parsed.data.commands;
    } catch {
      return [];
    }
  }

  /**
   * Records where a command has got to, before and after it runs.
   *
   * Written before the work as well as after it, because the question a
   * relaunch has to answer is not "did this finish" but "did this machine
   * already begin it" — a turn that got halfway through editing a worktree and
   * then lost its process must not be started again from the top.
   */
  function rememberCommand(
    commandId: string,
    state: CommandMemoryState,
    executionId?: string | null
  ): void {
    const previous = memory.get(commandId);
    memory.delete(commandId);
    memory.set(commandId, {
      id: commandId,
      state,
      executionId: executionId ?? previous?.executionId ?? null
    });
    const recent = [...memory.values()].slice(-COMMAND_MEMORY);
    memory.clear();
    for (const entry of recent) memory.set(entry.id, entry);
    try {
      mkdirSync(userData, { recursive: true });
      writeFileSync(commandMemoryPath, JSON.stringify({ version: 2, commands: recent }), { mode: 0o600 });
    } catch (error) {
      console.warn("[runner] could not persist command memory:", messageOf(error));
    }
  }

  function isSettled(commandId: string): boolean {
    return memory.get(commandId)?.state === "settled";
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
        // wedge the queue behind it — and must not vanish either: "refused"
        // makes the outbox leave a gap marker where the batch stood, so a
        // dropped terminal event is a stated gap, never a room that says
        // Running forever (D-110).
        const permanent = response.status >= 400 && response.status < 500 && ![401, 408, 429].includes(response.status);
        if (permanent) {
          console.warn(`[runner] the control plane refused a report (${response.status}); recording the gap`);
          return "refused";
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
        const detail = await deps.api.getMission(mission.missionId);
        // Every lane of the mission, not just the one it started with: a
        // competing approach is a sibling workstream with its own branch,
        // worktree, credential and command queue (D-074).
        const lanes = detail.workstreams?.length ? detail.workstreams : detail.workstream ? [detail.workstream] : [];
        if (lanes.length === 0) continue;
        workstreamByMission.set(mission.missionId, lanes[0]!.workstreamId);

        for (const lane of lanes) {
          const workstreamId = lane.workstreamId;
          const missionBranch = lane.missionBranch;
          // A branch the server has not finished allocating cannot be fetched
          // and cannot be worktree'd; the next pass will find it created.
          if (lane.branchStatus !== "created") continue;
          const laneEnrolled = enrolments.has(workstreamId);
          const laneKey = `${mission.missionId}:${workstreamId}`;
          if (laneEnrolled && !github && fetched.has(laneKey)) continue;

          const checkoutPath = host.repositoryPath(repository.providerRepoId);
          const needsCheckout = github && !(await hasMissionBranch(checkoutPath, missionBranch));
          if (!needsCheckout) fetched.add(laneKey);
          if (laneEnrolled && !needsCheckout) continue;

          if (!laneEnrolled) {
            if (github && !shouldHostGithub(detail)) continue;
            const registered = await deps.api.registerRunner(workstreamId, label);
            enrolments.set(workstreamId, {
              runnerId: registered.runnerId,
              credential: registered.credential,
              expiresAt: registered.expiresAt
            });
            persistEnrolments();
          }
          // Before anything asks for a worktree, so the mission branch the
          // server allocated is here and the worktree starts from the right
          // commit.
          if (needsCheckout) {
            await ensureCheckout(workstreamId, repository.providerRepoId, missionBranch);
            if (await hasMissionBranch(host.repositoryPath(repository.providerRepoId), missionBranch)) {
              fetched.add(laneKey);
            }
          }
          // A lane whose branch is not on this machine is not announced at
          // all (D-060). Publishing creates the worktree, and `git worktree
          // add` on a repository that has no such ref fails with `fatal:
          // invalid reference: novus/m-…` — which is the message this product
          // has already been blamed for once. `ensureCheckout` returns silently
          // while it is backing off from a failed fetch, so without this the
          // announce fires on every fifteen-second pass of that window and the
          // failure looks like a mission that can never have a workspace.
          if (!fetched.has(laneKey)) continue;

          // Queued on this workstream's own chain, and not awaited here.
          // Publishing reads the project and creates the worktree if it is not
          // there, which is real work on the same files a turn uses — so it
          // takes its turn in the lane rather than running beside one.
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
  function ensureCheckout(
    workstreamId: string,
    providerRepoId: string,
    missionBranch: string
  ): Promise<void> {
    const previous = checkoutQueue.get(providerRepoId) ?? Promise.resolve();
    const next = previous.then(() => ensureCheckoutNow(workstreamId, providerRepoId, missionBranch));
    // ensureCheckoutNow never rejects, but the chain must survive even if that
    // ever changes: a poisoned queue would silently end fetching forever.
    checkoutQueue.set(providerRepoId, next.catch(() => undefined));
    return next;
  }

  async function ensureCheckoutNow(
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

  /** The write-scoped sibling (D-099): one push, one credential, forgotten. */
  async function pushCredential(enrolment: Enrolment, workstreamId: string): Promise<CloneCredential> {
    const response = await runnerFetch(enrolment, "/runner/push-credential", "POST", { workstreamId });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const named = ApiErrorSchema.safeParse(body);
      throw new Error(
        named.success ? named.data.error.message : `Novus could not get push access (${response.status}).`
      );
    }
    const parsed = CloneCredentialSchema.safeParse(body);
    if (!parsed.success) throw new Error("The control plane answered push access in an unexpected shape.");
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
    laneInfo.set(workstreamId, {
      missionId: parsed.data.workstream.missionId,
      providerRepoId: parsed.data.workstream.providerRepoId
    });
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
    // A read-alongside turn (D-095) bypasses the lane's chain by design: the
    // chain exists to keep worktree-touching work serial, and a read turn
    // touches nothing — it neither writes files, nor runs git, nor captures a
    // checkpoint. Chained, it would wait behind the very write turn it exists
    // to run beside. Per-conversation seriality is the server's index. A
    // *scoped* write turn (D-097) bypasses it for the same reason it was
    // admitted at all: the server already proved its files disjoint from
    // every running sibling's, and chaining it here would undo the
    // parallelism the scopes exist to grant — checkpoint capture holds its
    // own per-worktree lock for the one step that truly shares state.
    const startPayload =
      command.kind === "start_execution"
        ? (command.payload as { access?: string; scope?: unknown } | null)
        : null;
    const parallelStart =
      startPayload !== null &&
      (startPayload.access === "read" || Array.isArray(startPayload.scope));
    const interrupt =
      command.kind === "stop_command" ||
      command.kind === "stop_execution" ||
      command.kind === "respond_approval" ||
      command.kind === "boundary_request" ||
      parallelStart;
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
    if (isSettled(command.commandId)) {
      // Already done on a previous launch: settle it, do not run it again.
      await ack(enrolment, command.commandId, { state: "completed" });
      return;
    }
    const begun = abandoned.get(command.commandId);
    if (begun) {
      // This machine started this command and lost its process before it
      // ended. Running it again would repeat whatever the first attempt had
      // already done to the worktree — a second harness turn from the top,
      // against files the first one had half-edited, with no record that the
      // first ever happened. So it is settled as what it was: begun here,
      // interrupted here (D-034).
      abandoned.delete(command.commandId);
      rememberCommand(command.commandId, "settled");
      const executionId = command.executionId ?? begun.executionId ?? null;
      if (executionId && HARNESS_COMMANDS.includes(command.kind)) {
        // The room stops saying *Running* about a turn whose process is gone,
        // now rather than when the liveness sweep gets to it — and *Execution
        // interrupted* is the state whose action is Restart, which is the human
        // choice PRODUCT.md keeps for exactly this (D-034).
        report(workstream.workstreamId, executionId, {
          kind: "execution.interrupted",
          payload: { reason: RESTARTED_MID_COMMAND }
        });
      }
      await ack(enrolment, command.commandId, {
        state: "failed",
        failureReason: RESTARTED_MID_COMMAND
      });
      return;
    }
    // Before the work, not after it: the memory has to be able to say "this
    // machine began it" even when nothing ever comes back to say how it ended.
    rememberCommand(command.commandId, "started", command.executionId ?? null);
    await ack(enrolment, command.commandId, { state: "acknowledged" });
    try {
      await execute(command, workstream);
      rememberCommand(command.commandId, "settled");
      await ack(enrolment, command.commandId, {
        state: "completed",
        ...(command.executionId ? { executionId: command.executionId } : {})
      });
    } catch (error) {
      // The turn ran and failed; re-running it after a relaunch would repeat
      // whatever it already did to the worktree.
      rememberCommand(command.commandId, "settled");
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
      // Keyed on the execution, because a stale stop re-offered after its own
      // execution ended must not kill whichever turn is running now — and
      // because a lane can hold two turns (D-095), only one of which this
      // stop means.
      const running = active.get(command.executionId);
      if (running) {
        running.turn.stop(STOPPED_BY_PARTICIPANT);
        return;
      }
      // The stop found no live process. If this machine still holds the
      // execution open — between turns, waiting for its next apply — the stop
      // ends that quietly as prevention. If it holds nothing at all, saying
      // nothing left the execution in `stopping` forever on a live runner
      // (the D-111 audit's dead end); the honest answer is that the turn
      // already ended here without its outcome being delivered.
      const openHere = openExecutions.has(command.executionId);
      if (openHere) {
        report(workstreamId, command.executionId, {
          kind: "execution.stopped",
          payload: { reason: STOPPED_BY_PARTICIPANT, via: "never_started" }
        });
        openExecutions.delete(command.executionId);
        return;
      }
      // A stop can also beat its own *queued* start: the start command is
      // still waiting its turn in the chain, and `stopRequested` will end it
      // as prevented the moment it runs. Only when no start or apply for this
      // execution is still pending is "already ended" the true sentence.
      const stillComing = await hasPendingHarnessCommand(
        workstreamId,
        command.executionId,
        command.commandId
      );
      if (!stillComing) {
        report(workstreamId, command.executionId, {
          kind: "execution.interrupted",
          payload: {
            reason:
              "The stop found nothing running on this machine for that turn — it had already ended without its outcome being delivered."
          }
        });
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
      // The lane's turn that is actually blocked on a question. Only a write
      // turn can be — a read turn's requests are denied on the spot (D-095) —
      // so scanning this lane's turns for pending approvals finds at most one.
      const blocked = [...active.values()].find(
        (candidate) =>
          candidate.workstreamId === workstreamId && candidate.turn.pendingApprovals().length > 0
      );
      if (blocked) {
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
    if (command.kind === "push_branch") {
      // The remote-head guarantee's working half (D-099): push the decided
      // revision to the host, with a write-scoped credential minted for this
      // one push and forgotten. Success is reported as the workstream's own
      // fact; failure settles the command with its reason and moves nothing.
      const payload = PushPayloadSchema.safeParse(command.payload);
      if (!payload.success) throw new Error("the push command payload was malformed");
      const repositoryPath = host.repositoryPath(workstream.providerRepoId);
      if (!repositoryPath) throw new Error("this repository's checkout lives on another machine");
      const enrolment = enrolments.get(workstreamId);
      if (!enrolment) throw new Error("this machine is no longer enrolled for that workstream");
      const credential = await pushCredential(enrolment, workstreamId);
      const pushed = await pushMissionBranch({
        repositoryPath,
        branch: payload.data.branch,
        sha: payload.data.sha,
        credential
      });
      outboxFor(workstreamId).append(null, {
        kind: "workspace.pushed",
        payload: { branch: payload.data.branch, sha: pushed.sha }
      });
      return;
    }

    const executionId = command.executionId;
    if (!executionId) throw new Error("the command named no execution");
    let repositoryPath = host.repositoryPath(workstream.providerRepoId);
    if (
      workstream.provider === "github" &&
      (repositoryPath === null || !(await hasMissionBranch(repositoryPath, workstream.missionBranch)))
    ) {
      // The mission's first turn is dispatched the moment this machine takes
      // the lane, and taking the lane necessarily precedes the fetch: the
      // clone credential is minted over the runner credential, so enrolment
      // cannot wait for the checkout. The turn therefore waits for the fetch
      // here instead of failing on the race — the dispatch-path sibling of
      // discovery's D-060 guard, which covered announce and left this path to
      // fail a real first turn with `invalid reference` or a misdiagnosed
      // "lives on another machine". A person just asked for this turn, so a
      // standing retry backoff is reset rather than waited out: one fresh
      // attempt per human act, never a five-minute wait for a click.
      checkoutRetry.delete(workstreamId);
      await ensureCheckout(workstreamId, workstream.providerRepoId, workstream.missionBranch);
      repositoryPath = host.repositoryPath(workstream.providerRepoId);
      if (repositoryPath === null || !(await hasMissionBranch(repositoryPath, workstream.missionBranch))) {
        throw new Error(
          checkoutRetry.get(workstreamId)?.reason ?? "this machine could not fetch the repository"
        );
      }
    }
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
      // A session-aware server states the resume point outright, and a null
      // from it means this conversation genuinely has no history — falling
      // back to the workstream's would resume a *sibling's* transcript
      // (D-083). The fallback survives only for a payload from before
      // sessions, which named no session at all.
      resumeSessionId:
        payload.data.sessionId !== null
          ? payload.data.resumeSessionId
          : (payload.data.resumeSessionId ?? workstream.harnessSessionId),
      access: payload.data.access,
      scope: payload.data.scope,
      permissionProfile: payload.data.permissionProfile,
      skills: payload.data.skills,
      mcpServers: payload.data.mcpServers,
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
  function respondToApproval(command: RunnerCommand, _workstreamId: string): void {
    const payload = ApprovalPayloadSchema.safeParse(command.payload);
    if (!payload.success) throw new Error("the approval decision was malformed");
    const running = command.executionId ? active.get(command.executionId) : undefined;
    if (!running) return;
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
    /** What the turn may do to the worktree (D-095). */
    access: "write" | "read";
    /** The chat's file scope, pinned at dispatch (D-097); null unscoped. */
    scope: string[] | null;
    /** The lane's answer policy, pinned at dispatch (D-115). */
    permissionProfile: PermissionProfile;
    /** The enabled skills, pinned at dispatch (D-118). */
    skills: EnabledSkill[];
    /** The enabled MCP servers, pinned at dispatch (D-119). */
    mcpServers: EnabledMcpServer[];
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

    // The turn's own capture surface (D-123): the `novus` endpoint the strict
    // MCP config carries, alive exactly as long as the turn is. Asking rides
    // the router; the grant an allow mints is what the endpoint spends; and
    // the capture itself faces every check a person's does. Write turns only —
    // a read-alongside turn may look and speak, never capture. Registered
    // *before* the stop check below: it awaits, and a stop landing in an
    // async gap between that check and the spawn would be swallowed — the
    // exact zombie-turn window the check exists to close.
    let releaseCapture: (() => void) | null = null;
    let novusCapture: { url: string; token: string } | null = null;
    if (args.access === "write") {
      try {
        const endpoint = await registerCaptureTurn(args.executionId, async () => {
          const enrolment = enrolments.get(args.workstreamId);
          if (!enrolment) {
            return { text: "Capture failed: this machine is no longer enrolled for the lane.", isError: true };
          }
          try {
            const artifact = await capturePreviewScreenshot({
              workstreamId: args.workstreamId,
              worktreePath: join(worktreeRoot, args.workstreamId),
              logs: processLogsFor(args.workstreamId),
              sanitize: captureSanitizer(args.workstreamId),
              uploader: runnerUploader(args.executionId, enrolment)
            });
            return {
              text:
                `Captured "${artifact.label}" (${artifact.artifactId}) from the live preview` +
                `${artifact.revisionSha ? ` at revision ${artifact.revisionSha.slice(0, 8)}` : ""}. ` +
                SCREENSHOT_CLAIM,
              isError: false
            };
          } catch (error) {
            return { text: `Capture refused: ${messageOf(error)}`, isError: true };
          }
        });
        releaseCapture = endpoint.release;
        novusCapture = { url: endpoint.url, token: endpoint.token };
      } catch (error) {
        // A machine whose loopback endpoint cannot start still runs the turn;
        // the agent simply has no capture tool this turn.
        console.warn("[runner] the capture endpoint did not start:", messageOf(error));
      }
    }

    // The stop may already have arrived — for this execution, before this turn
    // existed, including during the endpoint registration just above. Reported
    // as the terminal outcome rather than started and then killed, so a
    // participant who stopped an execution never sees a harness process run
    // afterwards and never gets a checkpoint from one.
    if (stopRequested.has(args.executionId)) {
      releaseCapture?.();
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
      workstreamId: args.workstreamId,
      repositoryPath: args.repositoryPath,
      worktreeRoot,
      missionBranch: args.missionBranch,
      direction: args.direction,
      model: args.model,
      effort: args.effort,
      resumeSessionId: args.resumeSessionId,
      access: args.access,
      scope: args.scope,
      permissionProfile: args.permissionProfile,
      skills: args.skills,
      mcpServers: args.mcpServers,
      novusCapture,
      onToolAllowed: (toolName) => {
        if (toolName === CAPTURE_TOOL_FULL_NAME) mintCaptureGrant(args.executionId);
      },
      siblingScopes: () =>
        [...active.values()]
          .filter(
            (turn) =>
              turn.workstreamId === args.workstreamId && turn.executionId !== args.executionId
          )
          .map((turn) => turn.scope)
          .filter((siblingScope): siblingScope is string[] => siblingScope !== null),
      announceStart: args.announceStart,
      fakeHarness,
      fakeApproval,
      // Read per emit rather than captured once, and never handed to the
      // renderer or the control plane — the redactor is the only thing in the
      // reporting path that ever sees a value (D-041, D-052).
      secretValues: () => secretValuesFor(host, args.providerRepoId),
      emit
    });
    active.set(args.executionId, {
      executionId: args.executionId,
      workstreamId: args.workstreamId,
      scope: args.scope,
      turn
    });
    openExecutions.set(args.executionId, args.workstreamId);

    let result: TurnResult;
    try {
      result = await turn.finished;
    } finally {
      active.delete(args.executionId);
      // The endpoint token and any unspent grant die with the turn.
      releaseCapture?.();
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

    // A checkpoint that changed files is work nothing has verified yet, so the
    // declared checks run now, by themselves. After the terminal report and on
    // the lane's own chain rather than inside the turn: the room hears the turn
    // end first, and the checks can never touch a worktree a next turn holds.
    // A stopped execution stays quiet — the participant asked for nothing more
    // to happen — and the deadline each check runs under is the project's own.
    //
    // A **scoped** turn defers this to the drain (D-097): while a parallel
    // sibling is still writing, any check would exercise a moving tree and
    // bind its verdict to a revision that does not describe it. When the
    // lane's last turn ends, one integration pass runs the declared checks
    // against the settled result — unless unattributed changes sit
    // uncommitted, which is reported instead: a check against a tree no
    // recorded revision describes would be evidence about nothing.
    const checkpoint = result.checkpoint;
    if (
      result.terminal.kind !== "execution.stopped" &&
      checkpoint !== null &&
      checkpoint.outcome === "committed" &&
      checkpoint.filesChanged > 0 &&
      args.scope === null
    ) {
      chain(args.workstreamId, () =>
        workspace.runAutoVerifications({
          missionId: args.missionId,
          workstreamId: args.workstreamId,
          providerRepoId: args.providerRepoId,
          missionBranch: args.missionBranch,
          workspaceId: null
        })
      );
    }
    if (
      args.scope !== null &&
      result.terminal.kind === "execution.completed" &&
      ![...active.values()].some((turn) => turn.workstreamId === args.workstreamId)
    ) {
      const scopedCommitted = checkpoint !== null && checkpoint.outcome === "committed";
      chain(args.workstreamId, async () => {
        const dirty = await worktreeDirtyPaths(join(worktreeRoot, args.workstreamId));
        if (dirty === null) return; // the worktree could not even be asked
        if (dirty.length > 0) {
          report(args.workstreamId, args.executionId, {
            kind: "integration.blocked",
            payload: { paths: dirty.slice(0, 50).map((path) => path.slice(0, 300)) }
          });
          return;
        }
        if (!scopedCommitted) return;
        await workspace.runAutoVerifications({
          missionId: args.missionId,
          workstreamId: args.workstreamId,
          providerRepoId: args.providerRepoId,
          missionBranch: args.missionBranch,
          workspaceId: null
        });
      });
    }
  }

  /** The worktree's uncommitted paths, or null when git itself failed. */
  async function worktreeDirtyPaths(worktree: string): Promise<string[] | null> {
    try {
      const output = await new Promise<string>((resolve, rejectWith) => {
        execFile("git", ["-C", worktree, "status", "--porcelain"], (error: Error | null, stdout: string) =>
          error ? rejectWith(error) : resolve(stdout)
        );
      });
      return output
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter((line) => line.length > 0);
    } catch {
      return null;
    }
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
          !isSettled(command.commandId) &&
          // A command a dead launch began is not more work waiting: it is
          // about to be settled as interrupted, and counting it would hold the
          // execution open for a turn that is never going to run.
          !abandoned.has(command.commandId)
      );
    } catch {
      return false;
    }
  }

  /** Is a start or apply for this execution still on its way? Consulted by a
   *  stop that found nothing running, so "already ended" is only ever said
   *  about a turn that genuinely ran (D-111). */
  async function hasPendingHarnessCommand(
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
          HARNESS_COMMANDS.includes(command.kind) &&
          command.executionId === executionId &&
          command.commandId !== currentCommandId &&
          !isSettled(command.commandId) &&
          !abandoned.has(command.commandId)
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
    clearInterval(outboxTimer);

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
