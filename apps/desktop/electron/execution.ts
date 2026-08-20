import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_PROFILE,
  EffortSchema,
  ModelIdSchema,
  pathInScope,
  type ApprovalDecision,
  type EnabledMcpServer,
  type EnabledSkill,
  type PermissionProfile,
  type RunnerEvent
} from "@novus/contracts";
import { captureCheckpoint, createSanitizer, type GitRunner } from "./evidence";
import { composeSkillsPlugin, removeComposedSkills, type ComposedSkills } from "./skills";
import { composeMcpConfig, removeComposedMcp, type ComposedMcp } from "./mcp";
import { HarnessStream, type HarnessApprovalRequest, type HarnessControlMessage } from "./harness-stream";
import { harnessEnv } from "./workspace-env";
import { redact } from "./secret-policy";

/**
 * The Claude Code adapter (D-017, D-032): one direction becomes one supervised
 * headless turn in a dedicated worktree of the mission branch — never the
 * user's own checkout — and everything observed is reported upward as a claim.
 *
 * The rules this module exists to keep:
 *
 *  - No absolute local path may appear in any reported payload. Every event
 *    leaves through one sanitizing gate, so this is structural rather than a
 *    discipline each call site has to remember.
 *  - A turn always ends. A spawn that fails, a harness that dies, a checkpoint
 *    that throws, a stop that the process ignores — each has a named outcome.
 *  - A failed checkpoint is never reported as a completed execution.
 *  - A fresh harness session is never presented as a continuous one.
 *  - The harness asks before it acts, and it asks *Novus* — never the settings
 *    file of whoever's laptop this happens to be (D-056, and below).
 *
 * No Electron import: the app supplies the worktree root, the repository path,
 * and whether it is packaged, which keeps the whole turn testable.
 */

/**
 * The shapes the **server** allocates, and nothing else: a mission's own lane,
 * and a competing approach's sibling branch beside it (D-074). Still a closed
 * pattern rather than a loosened one — a direction can no more name a branch
 * now than it could before.
 */
const MISSION_BRANCH = /^novus\/m-[0-9a-z]+(-a[0-9]+)?$/;

/** How long a stopped harness gets to exit on its own before it is killed. */
const SIGKILL_AFTER_MS = 5_000;

/**
 * How long the harness's own protocol interrupt gets to end the turn before
 * Novus stops asking and signals the process group instead.
 *
 * Deliberately short. Against `claude 2.1.221` the interrupt is answered and
 * the turn ends inside the same tenth of a second, so this is a ceiling on a
 * harness that has stopped listening rather than a wait anybody experiences —
 * a Stop must not become slower because it became gentler (D-053).
 */
const INTERRUPT_GRACE_MS = 2_000;

const MAX_STDERR = 4_000;
const MAX_REASON = 400;

/**
 * The permission policy, **pinned rather than inherited**.
 *
 * D-056 probed the installed CLI and found the thing that would otherwise make
 * every approval guarantee a lie: `harnessEnv` forwards `HOME` and every
 * `CLAUDE_*` variable so the user's own local login keeps working (D-041), and
 * that same forwarding hands Claude Code the operator's `~/.claude/settings.json`
 * — and the repository's committed `.claude/settings.json` — to take its
 * permission rules from. Whether a tool call ever reaches a human therefore
 * depended on whose machine the runner was, and on what the branch happened to
 * commit.
 *
 * Both flags below were verified against `claude 2.1.221` on 2026-08-04:
 *
 *  - `--setting-sources ""` loads none of the three sources (user, project,
 *    local). With a `.claude/settings.json` in the worktree saying
 *    `{"permissions":{"allow":["Write"],"defaultMode":"acceptEdits"}}`, the same
 *    Write was routed to Novus with this flag and silently performed without
 *    it, where the session reported `permissionMode: acceptEdits` and asked
 *    nobody. It also stops the operator's settings hooks from running: the
 *    `hook_started` / `hook_response` messages present in an unpinned run are
 *    absent here.
 *  - `--permission-mode manual` states the asking mode outright, so nothing
 *    inherited can choose a different one. It overrides a settings file that
 *    says `acceptEdits`, which was checked on its own.
 *
 * What is deliberately *never* passed, whatever the lane's permission profile
 * (D-115): `acceptEdits` (which is what made this a gap), `auto`, `dontAsk`,
 * `bypassPermissions`, `--dangerously-skip-permissions`, and `--allowedTools`.
 * Each of those makes the CLI act **without asking**, and everything Novus
 * guarantees — the record of every act, the scope enforcement (D-097), the
 * read-turn containment (D-095) — rides the asking. A profile is Novus's own
 * answer policy at this router, not a CLI mode: the harness always asks over
 * this channel, and what the profile changes is who answers. The CLI's own
 * read-only classification still applies underneath: `Bash: ls` never reaches
 * the router and a Bash command that writes a file always does. Novus neither
 * widens nor narrows that; it makes it the *only* thing deciding what asks.
 *
 * The one profile that changes the flag is `plan`: `--permission-mode plan`
 * is passed so the CLI's own plan mode tells the model to propose rather than
 * thrash against denials. The value is accepted by the installed CLI
 * (`claude 2.1.228 --help` lists it, probed 2026-08-11); what plan mode does
 * live is deliberately not load-bearing, because the router below still
 * denies every privileged act a plan turn asks for — the flag is behaviour,
 * the router is the guarantee. A CLI too old to know the value fails the
 * turn with the CLI's own words rather than running it less supervised.
 *
 * Authentication is unaffected — it does not come from settings — and every
 * probe above ran under the machine's existing Claude Code login.
 */
function pinnedPermissionArgs(profile: PermissionProfile): string[] {
  return ["--setting-sources", "", "--permission-mode", profile === "plan" ? "plan" : "manual"];
}

/**
 * Flags Novus asks for but can run without.
 *
 * `--forward-subagent-text` makes the CLI forward what its **own** subagents
 * say, tagged with the tool call that spawned them (observed on 2.1.223).
 * Without it a `Task` that runs for four minutes is one tool row and then
 * silence, which reads as a wedged turn and is the opposite of what a room
 * watching a long run needs.
 *
 * Separated from the pinned permission args because the two must fail
 * differently. A CLI that will not route permission to Novus is a CLI Novus
 * refuses to run (D-062). A CLI that has never heard of subagent forwarding is
 * simply older, and losing a nicety must not lose the turn — so an unknown
 * option that names one of these is retried once without them.
 */
const OPTIONAL_ARGS = ["--forward-subagent-text"] as const;

/** Larger than any instruction file a person wrote, small enough that a
 *  generated one cannot become the whole prompt. */
const MAX_INSTRUCTIONS_BYTES = 100_000;

/**
 * The project's own instructions, handed to the harness explicitly (D-064).
 *
 * Pinning the setting sources is what stops a `.claude/settings.json` in the
 * worktree deciding what gets asked (D-062), and it cost this: `CLAUDE.md` no
 * longer loaded, so a project could not tell the agent its own conventions.
 * The file is read here and passed with `--append-system-prompt-file`, which
 * needs no settings source at all.
 *
 * **Instructions are not authority, and that is the whole reason this is safe
 * to restore while settings stay pinned.** Both files are things the agent can
 * write. A settings file can grant *permission* — allow-rules, and hooks that
 * run before the permission check — so reading one lets a supervised turn widen
 * what the next turn may do without asking. `CLAUDE.md` cannot: every tool call
 * still reaches the permission router, so an agent that writes "you may always
 * write files" into it has written a sentence, not a grant. The worst it can do
 * is mislead the model, which is what any file in the repository can do.
 *
 * Resolved through `realpath` and required to stay inside the worktree, because
 * a symlinked `CLAUDE.md` pointing at `~/.ssh/config` is an ordinary relative
 * path right up until something reads it. (This repository's own `CLAUDE.md` is
 * a symlink — to `AGENTS.md`, beside it — so following them is required, and
 * following them *out* is not.)
 */
export function projectInstructionsFile(worktreePath: string): string | null {
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return null;
  }
  const candidate = join(root, "CLAUDE.md");
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null; // absent, which is the ordinary case
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) return null;
  try {
    const stats = statSync(real);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_INSTRUCTIONS_BYTES) return null;
  } catch {
    return null;
  }
  return real;
}

/** A CLI that does not know these flags says so before it does anything. */
const UNSUPPORTED_FLAG = /(unknown option|argument missing|unknown command)/i;

/** What a denial says to the harness when the responder gave no words. */
const DENIED = "A participant denied this in Novus.";
/** What a read-alongside turn is told when it asks to act (D-095). */
const READ_ONLY_DENIED =
  "This chat is running alongside the workspace's turn, read-only. It may not change anything; answer in words, and ask again from a turn that holds the workspace.";
/** What a scoped turn is told when it reaches outside its files (D-097). */
const SCOPE_DENIED =
  "That path is outside this chat's declared scope. Work only inside the files this chat owns; changes elsewhere belong to another chat or to an unscoped turn.";
/** What a plan-profile turn is told when it asks to act (D-115): the refusal
 *  carries the instruction, so the model proposes instead of retrying. */
const PLAN_DENIED =
  "This lane is in the Plan profile: Novus approves no changes in it. Present what you would do — the files, the commands, the order — as your reply; a person reads the plan and either switches the profile or directs the work from there.";

/** The tools whose requests name their filesystem targets outright, and can
 *  therefore be decided by scope policy (D-097). Bash is deliberately not
 *  here: a shell command's effects are declared nowhere, so it stays a human
 *  question however scoped the turn is. */
const PATH_SCOPED_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/** The tools that are a shell. The `auto` profile answers everything except
 *  these (D-115), for D-097's reason: a shell command declares its targets
 *  nowhere, so it is the one act `auto` still hands to a person — and the
 *  only line between `auto` and `dont_ask`. */
const SHELL_TOOLS = new Set(["Bash"]);

/** An MCP server's tools arrive as `mcp__{server}__{tool}` (probed on
 *  2.1.229). Their effects are declared nowhere Novus can read — exactly the
 *  shell's problem — so `auto` never answers one either: enabling a server
 *  (D-119) put its tools in the room, and only `dont_ask` answers them by
 *  policy. */
const isMcpTool = (toolName: string): boolean => toolName.startsWith("mcp__");

/** Serializes checkpoint capture per worktree (D-097): parallel scoped turns
 *  share one git index, and two captures interleaving `add` and `commit`
 *  would stage each other's files. The lock is the whole capture, status to
 *  commit, so what each one stages is exactly what it commits. */
const captureLocks = new Map<string, Promise<unknown>>();
function withCaptureLock<T>(worktree: string, work: () => Promise<T>): Promise<T> {
  const previous = captureLocks.get(worktree) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  captureLocks.set(
    worktree,
    next.catch(() => undefined)
  );
  return next;
}

export type TerminalEvent = Extract<
  RunnerEvent,
  {
    kind:
      | "execution.completed"
      | "execution.stopped"
      | "execution.failed"
      | "execution.interrupted";
  }
>;

export interface TurnRequest {
  executionId: string;
  missionId: string;
  /** The lane this turn belongs to. Worktrees are keyed by it, so a mission's
   *  competing approaches never share a checkout (D-074). */
  workstreamId: string;
  /** The user's repository, from which the mission worktree is created. */
  repositoryPath: string;
  /** The app-owned directory that holds one worktree per mission. */
  worktreeRoot: string;
  missionBranch: string;
  direction: string;
  model: string;
  effort: string;
  /** The session this workstream continues, or null for a fresh one. */
  resumeSessionId: string | null;
  /** Images the person attached to this direction (D-150), already fetched
   *  from the artifact store by the machine running the turn. They ride in the
   *  same stream-json user message the words do — the harness reads image
   *  content blocks directly, so nothing is written into the worktree and no
   *  checkpoint can sweep an attachment in. Empty for a turn with none. */
  attachments?: readonly {
    mimeType: string;
    base64: string;
    label: string;
    /** Where the file was staged in the worktree, for anything the harness
     *  cannot be handed directly (D-153). Null for an inlined image or PDF. */
    path: string | null;
  }[];
  /** Pinned references (D-182): worktree files and snapshotted checks the
   *  person pointed this direction at, said to the harness in words beside
   *  the direction. References, never bytes — the agent holds the worktree. */
  context?: readonly (
    | { kind: "file"; path: string }
    | {
        kind: "check";
        checkId: string;
        name: string;
        outcome: string;
        command: string;
        output: string | null;
      }
  )[];
  /** What this turn may do to the worktree (D-095). `read` runs alongside the
   *  lane's write turn: every permission request is denied on the spot with
   *  the reason, no approval ever reaches the room, no checkpoint is captured,
   *  and no boundary is declared — a read turn ending is not the safe point a
   *  waiting handoff may complete at. Absent means `write`, the ordinary turn. */
  access?: "write" | "read";
  /** The chat's file scope, pinned at dispatch (D-097). A scoped write turn's
   *  path-carrying tools are decided here by policy — inside the scope
   *  auto-allowed (the controller approved the scope, which is what a scope
   *  is), outside it auto-denied with the reason — while Bash and every other
   *  tool whose targets the request does not name stay human questions
   *  exactly as before. Its checkpoint commits only scoped paths. Null means
   *  unscoped: the whole workspace, every act asked about, as always. */
  scope?: readonly string[] | null;
  /** The lane's answer policy, pinned at dispatch (D-115). Decides what this
   *  turn's permission questions get answered with **at this machine**, on
   *  the record: `manual` routes every card to the room as always; `plan`
   *  denies every privileged act with the reason and asks the CLI's own plan
   *  mode for a proposal; `accept_edits` allows the path-naming edit tools;
   *  `auto` allows everything but a shell command; `dont_ask` allows
   *  everything. Ordered under containment and ownership: a read turn is
   *  denied whatever the profile says (D-095), and a scope's verdict on the
   *  edit tools stands whatever the profile says (D-097) — a profile is
   *  trust, a scope is a sibling's territory. Absent means manual. */
  permissionProfile?: PermissionProfile;
  /** The scopes of parallel sibling turns still running in this worktree,
   *  read at checkpoint time (D-097) — their territory in flight is theirs,
   *  not this turn's drift. */
  siblingScopes?: () => readonly (readonly string[])[];
  /** The project skills a person enabled, pinned at dispatch (D-118) — each
   *  at the exact digest that was reviewed. The turn composes a skills-only
   *  plugin directory from the worktree and carries a skill only when its
   *  bytes still match; a mismatch drops it with the reason on the record.
   *  Absent or empty means no `--plugin-dir` at all — exactly the pre-D-118
   *  spawn. */
  skills?: readonly EnabledSkill[] | null;
  /** The project MCP servers a person enabled, pinned at dispatch (D-119).
   *  Composed into a strict config Novus authors, or dropped by name under
   *  the same digest rule. Absent or empty means no `--mcp-config` at all —
   *  unless `novusCapture` is present, which always composes a config. */
  mcpServers?: readonly EnabledMcpServer[] | null;
  /** Novus's own capture endpoint for this turn (D-123): composed into the
   *  strict config as the `novus` server so the agent can *ask* for a
   *  screenshot. Asking is all it grants — the tool call routes through this
   *  module's ladder like every MCP tool, and the endpoint additionally
   *  demands the grant the router mints on an allow. Absent in tests that
   *  predate it and for read-alongside turns. */
  novusCapture?: { url: string; token: string } | null;
  /** Router hook (D-123): called with the tool name whenever a permission
   *  request is *allowed* — by a person's answer or by the lane's profile —
   *  after the allow is written. The capture grant is minted here. */
  onToolAllowed?: (toolName: string) => void;
  /** Announce the execution's start; a follow-up turn inside the same
   *  execution does not repeat it. */
  announceStart: boolean;
  /** Deterministic scripted harness for tests; the caller gates it. */
  fakeHarness: boolean;
  /** Makes the scripted harness ask before it writes, so the approval path can
   *  be driven end to end without a model call. Ignored unless `fakeHarness`. */
  fakeApproval?: boolean;
  /** The values this machine holds for the project, read at emit time so a
   *  secret supplied mid-turn protects the rest of that turn. */
  secretValues: () => readonly string[];
  emit: (event: RunnerEvent) => void;
  /** How often the turn states its pulse while the process is alive (D-114).
   *  Overridden only by tests; the default is minutes, because the pulse
   *  exists to tell a long tool call from a dead machine, not to be a clock. */
  heartbeatMs?: number;
}

export interface TurnResult {
  /** What the execution's terminal event should be. The caller emits it when
   *  the execution actually ends, so a follow-up direction can extend the run. */
  terminal: TerminalEvent;
  /** The session the harness used, for the next turn to continue. */
  sessionId: string | null;
  /** What the turn's checkpoint said, for the work that follows the turn on
   *  the lane: a committed checkpoint that changed files is what the declared
   *  checks run against. Null when the checkpoint threw before saying anything. */
  checkpoint: { outcome: "committed" | "clean" | "failed"; sha: string | null; filesChanged: number } | null;
}

export interface RunningTurn {
  stop(reason: string): void;
  /**
   * Answers one harness permission question.
   *
   * Returns false when nothing is waiting under that id — a duplicate answer, a
   * late one, or one for a turn that has already ended. The caller settles the
   * command either way: a decision that arrives too late is a no-op, never a
   * second write to a process that has moved on.
   */
  respondApproval(requestId: string, decision: ApprovalDecision, reason: string | null): boolean;
  /** The harness request ids this turn is still blocked on. */
  pendingApprovals(): string[];
  readonly finished: Promise<TurnResult>;
}

const gitExec: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))
    );
  });

/** Every string in every reported payload passes through here. */
function sanitizeEvent(event: RunnerEvent, sanitize: (text: string) => string): RunnerEvent {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return sanitize(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return { kind: event.kind, payload: walk(event.payload) } as RunnerEvent;
}

/**
 * One worktree per mission, created from the mission branch and reused across
 * turns. Stale metadata from a worktree the user deleted by hand is pruned
 * first, and a directory left behind without its git link is rebuilt, so
 * recovery never needs manual git surgery.
 */
async function ensureWorktree(
  git: GitRunner,
  repositoryPath: string,
  worktreeRoot: string,
  workstreamId: string,
  missionBranch: string
): Promise<string> {
  const worktree = join(worktreeRoot, workstreamId);
  await git(repositoryPath, ["worktree", "prune"]).catch(() => undefined);
  if (existsSync(join(worktree, ".git"))) return worktree;
  mkdirSync(worktreeRoot, { recursive: true });
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  await git(repositoryPath, ["worktree", "add", "--", worktree, missionBranch]);
  return worktree;
}

/** Claude Code's own signals that the machine is not signed in. */
const AUTH_HINTS =
  /(invalid api key|authentication|unauthori[sz]ed|not logged in|please run\s+\/?login|no api key)/i;

/** The vendor refusing for money reasons — a different problem with a
 *  different fix, so it never wears the "sign in again" sentence (D-109). */
const BILLING_HINTS = /(credit balance|billing|payment required|usage limit|quota (?:exceeded|reached))/i;

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError: string | null;
}

export function startTurn(request: TurnRequest): RunningTurn {
  const worktree = join(request.worktreeRoot, request.workstreamId);
  // The mask list is built before anything can be emitted, so the very first
  // event is already free of machine-local paths.
  const maskPaths = createSanitizer([
    { path: worktree, label: "the mission worktree" },
    { path: request.repositoryPath, label: "the repository" },
    { path: request.worktreeRoot, label: "the mission worktrees" }
  ]);
  // Paths, then values. The transcript is the one reported surface that used to
  // get only the first half: a harness that runs `env`, or prints a failing
  // request, or quotes a config file it just read, put the value straight into
  // the room — where it is durable, distributed to every participant, and
  // projected into receipts. Process output has been redacted since D-044; this
  // is the same protection reaching the path that talks the most (D-052).
  const sanitize = (text: string): string => redact(maskPaths(text), request.secretValues());
  const readOnly = request.access === "read";
  const scope = request.scope ?? null;
  /** The lane's answer policy, pinned at dispatch (D-115); absent is manual. */
  const profile = request.permissionProfile ?? DEFAULT_PERMISSION_PROFILE;
  /** Requests the scope policy already answered (D-097): their card must not
   *  reach the room, and the prompt boundary the stream declares for them is
   *  not real — nothing is pending. */
  const policyDecided = new Set<string>();
  let suppressPromptBoundary = 0;
  const emit = (event: RunnerEvent): void => {
    // A read turn's permission questions never reach the room: they are
    // answered deny at this machine the moment they arrive (D-095), so
    // publishing the request would put a card in front of people about a
    // question that no longer exists. The harness's own transcript still
    // shows the attempt and the refusal. And a read turn declares no
    // boundary from any source — not turn-complete, not the stream's
    // prompt-pending, not the never-started path — because none of them says
    // anything about whether the *write* turn is at a safe point.
    if (readOnly && (event.kind === "approval.requested" || event.kind === "boundary.reached")) return;
    // The same suppression, narrowly, for a scoped turn's policy-decided
    // writes (D-097): no card for a question that no longer exists, and no
    // "permission prompt pending" boundary for a prompt that never pended.
    if (
      event.kind === "approval.requested" &&
      policyDecided.has((event.payload as { requestId?: string }).requestId ?? "")
    ) {
      suppressPromptBoundary += 1;
      return;
    }
    if (
      event.kind === "boundary.reached" &&
      (event.payload as { reason?: string }).reason === "permission prompt pending" &&
      suppressPromptBoundary > 0
    ) {
      suppressPromptBoundary -= 1;
      return;
    }
    request.emit(sanitizeEvent(event, sanitize));
  };

  /** The scope policy's answer for one request (D-097): allow inside the
   *  scope, deny outside it or outside the worktree entirely, null for any
   *  tool whose targets the request does not name — that stays a human
   *  question. */
  const scopeVerdictFor = (message: HarnessApprovalRequest): "allow" | "deny" | null => {
    if (scope === null || readOnly) return null;
    if (!PATH_SCOPED_TOOLS.has(message.toolName)) return null;
    if (message.targetPaths.length === 0) return null;
    for (const target of message.targetPaths) {
      const absolute = isAbsolute(target) ? target : join(worktree, target);
      const relativePath = relative(worktree, absolute);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) return "deny";
      if (!pathInScope(relativePath.split(sep).join("/"), scope)) return "deny";
    }
    return "allow";
  };

  let stopReason: string | null = null;
  let child: ChildProcess | null = null;
  let escalation: NodeJS.Timeout | null = null;
  /** The turn's composed skills directory (D-118), built once per turn after
   *  the worktree exists and removed when the turn ends. Null until then. */
  let composedSkills: ComposedSkills | null = null;
  let composedMcp: ComposedMcp | null = null;
  const cleanupComposedSkills = (): void => {
    if (composedSkills !== null && composedSkills.dir !== null) {
      removeComposedSkills(composedSkills.dir);
    }
    if (composedMcp !== null && composedMcp.file !== null) {
      removeComposedMcp(composedMcp.file);
    }
  };
  let interruptAsked = false;
  /** Which path actually ended the turn, for the terminal event to name. */
  let stoppedVia: "protocol_interrupt" | "process_signal" = "process_signal";
  /**
   * The questions this turn is blocked on, by the harness's own request id.
   *
   * Process-local and nothing more: the raw tool input is never in here,
   * because a `{"behavior":"allow"}` with no `updatedInput` is accepted (probed
   * against 2.1.221), so a `Write`'s whole file body never has to be held
   * anywhere in order to say yes to it.
   */
  const pending = new Map<string, HarnessApprovalRequest>();
  /** The scripted harness's stand-in for stdin, set while one is running. */
  let fakeControl: ((message: unknown) => void) | null = null;

  /** Writes one line into the harness's stdin, or reports that it could not. */
  const writeControl = (message: unknown): boolean => {
    if (fakeControl !== null) {
      fakeControl(message);
      return true;
    }
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      // The process died between the check and the write; the turn's own
      // termination path already owns what happens next.
      return false;
    }
  };

  /** Every leftover question, settled, so nothing is left pending for ever. */
  const cancelPending = (reason: string): void => {
    if (pending.size === 0) return;
    const outstanding = [...pending.keys()];
    pending.clear();
    for (const requestId of outstanding) {
      emit({ kind: "approval.cancelled", payload: { requestId, reason: bounded(reason, MAX_REASON) } });
    }
  };

  /**
   * Answers one request by the lane's pinned profile (D-115): the response on
   * the harness's own channel, the card and its false prompt boundary
   * suppressed exactly as a scope verdict's are, and — unlike a scope verdict,
   * which keeps D-097's recorded silence — the decision **recorded**, as
   * `approval.policy` with the same bounded, redacted summary a card would
   * have carried. A person's standing instruction answered this act, and the
   * receipt gets to say so.
   */
  const decideByProfile = (
    message: HarnessApprovalRequest,
    decision: "allowed" | "denied",
    reason?: string
  ): void => {
    policyDecided.add(message.requestId);
    emit({
      kind: "approval.policy",
      payload: {
        requestId: message.requestId,
        toolName: message.toolName,
        decision,
        profile,
        summary: message.summary
      }
    });
    writeControl({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.requestId,
        response:
          decision === "allowed"
            ? { behavior: "allow" }
            : { behavior: "deny", message: reason ?? DENIED }
      }
    });
    // The allow is on the record above before anything is minted from it
    // (D-123): a policy-decided capture is a person's standing instruction
    // answering, and the grant is that answer's receipt.
    if (decision === "allowed") request.onToolAllowed?.(message.toolName);
  };

  /**
   * Control traffic, which never reaches the transcript. An approval is
   * remembered so it can be answered; anything Novus cannot answer is answered
   * with an error, because the CLI blocks on what it sends and silence would
   * wedge the turn rather than ignore a message.
   *
   * The order of the ladder is the order of the claims (D-115): containment
   * first (a read turn may not act, whatever the lane trusts), then the plan
   * profile (a refusal of every privileged act, even an in-scope one — the
   * person asked for a proposal), then ownership (a scope's verdict on the
   * path-naming tools, a sibling's territory being no one's to trust away),
   * then trust (the profile's allows), then the room.
   */
  const handleControl = (message: HarnessControlMessage): void => {
    if (message.kind === "approval") {
      // A read-alongside turn may look but not act (D-095): the answer is
      // deny, immediately, at this machine — no card, no waiting, no baton.
      // The reason travels back on the harness's own channel, so the model
      // knows why and can say so in its reply.
      if (readOnly) {
        writeControl({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.requestId,
            response: { behavior: "deny", message: READ_ONLY_DENIED }
          }
        });
        return;
      }
      // Plan: nothing changes the workspace, and the denial carries the
      // instruction so the model presents its plan instead of retrying.
      if (profile === "plan") {
        decideByProfile(message, "denied", PLAN_DENIED);
        return;
      }
      // A scoped turn's path-naming writes are policy, not questions (D-097):
      // the controller approved the scope, and the scope is the answer —
      // allow inside it, deny outside it, both decided here with no card.
      // A tool that does not name its targets (Bash) falls through to the
      // human exactly as before.
      const verdict = scopeVerdictFor(message);
      if (verdict !== null) {
        policyDecided.add(message.requestId);
        writeControl({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.requestId,
            response:
              verdict === "allow"
                ? { behavior: "allow" }
                : { behavior: "deny", message: SCOPE_DENIED }
          }
        });
        return;
      }
      // The profile's standing allows (D-115), each one recorded: dont_ask
      // answers everything; auto answers everything but a shell command,
      // which declares its targets nowhere (D-097's reason); accept_edits
      // answers the path-naming edit tools alone.
      if (
        profile === "dont_ask" ||
        // `auto` answers neither a shell nor an MCP tool (D-119): both act
        // through effects the request does not declare, so they stay human
        // questions under every profile but `dont_ask`.
        (profile === "auto" && !SHELL_TOOLS.has(message.toolName) && !isMcpTool(message.toolName)) ||
        (profile === "accept_edits" && PATH_SCOPED_TOOLS.has(message.toolName))
      ) {
        decideByProfile(message, "allowed");
        return;
      }
      pending.set(message.requestId, message);
      return;
    }
    if (message.kind === "unsupported") {
      writeControl({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: message.requestId,
          error: `Novus does not implement the ${message.subtype} control request.`
        }
      });
    }
    // An acknowledgement is the CLI answering our interrupt. Nothing to do:
    // the turn ends because the harness ends it, and the escalation timer is
    // what covers the case where it does not.
  };

  const respondApproval = (
    requestId: string,
    decision: ApprovalDecision,
    reason: string | null
  ): boolean => {
    const question = pending.get(requestId);
    if (!question) return false;
    pending.delete(requestId);
    // A person's allow mints the same receipt a policy allow does (D-123).
    if (decision === "approve") request.onToolAllowed?.(question.toolName);
    // Approve once, or deny. There is no third answer and nothing is
    // remembered: `permission_suggestions` — the CLI's offer to write an allow
    // rule into local settings, or to switch the session to acceptEdits — is
    // read by the parser and discarded, because taking it would turn one
    // person's single approval into a standing grant nobody gave (D-056).
    const response =
      decision === "approve"
        ? { behavior: "allow" }
        : { behavior: "deny", message: bounded(sanitize(reason?.trim() || DENIED), MAX_REASON) };
    return writeControl({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response }
    });
  };

  /** The bounded fallback: signal the process group, then insist. */
  const forceStop = (running: ChildProcess): void => {
    stoppedVia = "process_signal";
    if (escalation) clearTimeout(escalation);
    // The harness spawns its own children; signalling the group is the only
    // way an interrupted turn does not leave orphans behind.
    killTree(running, "SIGTERM");
    escalation = setTimeout(() => killTree(running, "SIGKILL"), SIGKILL_AFTER_MS);
    escalation.unref?.();
  };

  const stop = (reason: string): void => {
    stopReason = reason;
    const running = child;
    // Nothing to interrupt: a turn stopped before it spawned is prevented
    // rather than interrupted, which the caller already reports as stopped.
    if (!running?.pid && fakeControl === null) return;
    if (interruptAsked) return; // asked once; the escalation timer owns the rest
    interruptAsked = true;
    // Ask first. The harness's own interrupt ends the turn without destroying
    // the process or the session, so a stopped mission is still resumable —
    // which the process-group kill this replaces could never be (D-053, D-056).
    const asked = writeControl({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt", cancel_queued: true }
    });
    if (!asked) {
      if (running) forceStop(running);
      return;
    }
    stoppedVia = "protocol_interrupt";
    if (escalation) clearTimeout(escalation);
    // The harness gets a bounded moment to end its own turn. If it does not,
    // the process group is signalled anyway: a Stop is not a request.
    if (running) {
      escalation = setTimeout(() => forceStop(running), INTERRUPT_GRACE_MS);
      escalation.unref?.();
    }
  };

  const finished = (async (): Promise<TurnResult> => {
    try {
      return await run();
    } finally {
      if (escalation) clearTimeout(escalation);
      // The composed skills directory is the turn's own staging, not state:
      // the next turn composes afresh from its own pinned list (D-118).
      cleanupComposedSkills();
      // Whatever ended the turn, nothing is left waiting on an answer that can
      // no longer be delivered.
      cancelPending("The turn ended before this was answered.");
    }
  })();

  return { stop, respondApproval, pendingApprovals: () => [...pending.keys()], finished };

  async function run(): Promise<TurnResult> {
    if (request.announceStart) emit({ kind: "execution.starting", payload: {} });

    if (!MISSION_BRANCH.test(request.missionBranch)) {
      return terminate({
        kind: "execution.failed",
        payload: { classification: "internal", reason: "Refusing to run against an unrecognized branch name." }
      });
    }

    let worktreePath: string;
    try {
      worktreePath = await ensureWorktree(
        gitExec,
        request.repositoryPath,
        request.worktreeRoot,
        request.workstreamId,
        request.missionBranch
      );
    } catch (error) {
      return terminate({
        kind: "execution.failed",
        payload: { classification: "internal", reason: bounded(sanitize(messageOf(error)), MAX_REASON) }
      });
    }

    // The allowlist in the contracts package is the only list of models and
    // efforts; anything else falls back rather than reaching the CLI.
    const chosenModel = ModelIdSchema.safeParse(request.model);
    const chosenEffort = EffortSchema.safeParse(request.effort);
    const model: string = chosenModel.success ? chosenModel.data : DEFAULT_MODEL;
    const effort: string = chosenEffort.success ? chosenEffort.data : DEFAULT_EFFORT;

    // The enabled skills, composed once per turn from the pinned list (D-118):
    // each file re-read and digest-checked against the approval, the verified
    // bytes written into a directory only Novus authors, a mismatch dropped by
    // name. Composed before the running event so the turn's record states what
    // it actually carries, and removed when the turn ends.
    composedSkills = composeSkillsPlugin(
      worktreePath,
      request.skills ?? [],
      join(request.worktreeRoot, ".skills-staging", request.executionId)
    );
    // The enabled MCP servers, under the same rule (D-119): re-derived from
    // the worktree, digest-checked against the approval, written into a
    // strict config only Novus authors — carrying, when the runner provided
    // one, the `novus` capture endpoint (D-123). A read turn carries no
    // endpoint: it may look and speak, never capture.
    composedMcp = composeMcpConfig(
      worktreePath,
      request.mcpServers ?? [],
      join(request.worktreeRoot, ".mcp-staging", `${request.executionId}.json`),
      readOnly ? null : request.novusCapture ?? null
    );
    emit({
      kind: "execution.running",
      payload: {
        harness: "claude-code",
        model,
        effort,
        permissionProfile: profile,
        skills: composedSkills.carried,
        skillsDropped: composedSkills.dropped,
        mcpServers: composedMcp.carried,
        mcpServersDropped: composedMcp.dropped
      }
    });

    // The turn's pulse (D-114): while the harness process is alive, say so
    // every few minutes. A twenty-minute test run produces no transcript
    // events at all, and from the room that silence was indistinguishable
    // from a dead machine — the heartbeat is what tells them apart. It is
    // liveness only; the control plane records it and the stall watch never
    // counts it as progress.
    const pulse = setInterval(
      () => emit({ kind: "execution.heartbeat", payload: {} }),
      Math.max(1, request.heartbeatMs ?? 180_000)
    );
    pulse.unref?.();

    let resumeSessionId = request.resumeSessionId;
    let optional = true;
    let stream = new HarnessStream({ resumeSessionId, sanitize, onControl: handleControl });
    let outcome = await attempt(worktreePath, model, effort, stream, resumeSessionId, optional);
    cancelPending("The harness process ended before this was answered.");

    // An older CLI that does not know an optional flag refused before it did
    // anything, so there is nothing to undo: drop the niceties and run the turn
    // it was actually asked for. The pinned permission flags are never in this
    // set, so this can never quietly become an unsupervised run.
    if (stopReason === null && refusedOptionalFlag(outcome)) {
      optional = false;
      stream = new HarnessStream({ resumeSessionId, sanitize, onControl: handleControl });
      outcome = await attempt(worktreePath, model, effort, stream, resumeSessionId, optional);
      cancelPending("The harness process ended before this was answered.");
    }

    // A session the CLI no longer holds must not silently become a fresh
    // conversation presented as continuous: retry once, openly fresh. A CLI
    // that refused a flag is excluded — the second spawn would refuse the same
    // flag, and the reason is not the session.
    if (
      resumeSessionId !== null &&
      stopReason === null &&
      stream.sessionId === null &&
      !UNSUPPORTED_FLAG.test(outcome.stderr) &&
      (outcome.spawnError !== null || outcome.code !== 0)
    ) {
      resumeSessionId = null;
      stream = new HarnessStream({ resumeSessionId: null, sanitize, onControl: handleControl });
      outcome = await attempt(worktreePath, model, effort, stream, null, optional);
      cancelPending("The harness process ended before this was answered.");
    }

    for (const event of stream.end()) emit(event);

    // The harness has actually stopped working: this is the safe boundary a
    // pending control transfer waits for (PRODUCT.md#control). A read turn
    // declares none (D-095): it never held the worktree, so its ending says
    // nothing about whether the *write* turn is at a safe point — a handoff
    // completed on its word would move the baton mid-tool-call.
    if (!readOnly) emit({ kind: "boundary.reached", payload: { reason: "turn complete" } });

    // A read turn also captures nothing (D-095): committing the worktree now
    // would take whatever half-done state the write turn has on disk and
    // record it as this chat's evidence — the exact fabrication that keeps
    // writes exclusive. Nothing changed by this turn, because nothing could.
    if (readOnly) {
      clearInterval(pulse);
      return {
        terminal: classify(outcome, stream, null),
        sessionId: stream.sessionId,
        checkpoint: null
      };
    }

    // "Nothing changed" is evidence too, so a clean turn still checkpoints.
    // Captured under the worktree's own lock (D-097): parallel scoped turns
    // share one git index, and what a capture stages must be exactly what it
    // commits.
    let checkpointFailed: string | null = null;
    let captured: TurnResult["checkpoint"] = null;
    try {
      const checkpoint = await withCaptureLock(worktreePath, () =>
        captureCheckpoint(gitExec, worktreePath, {
          branch: request.missionBranch,
          summary: bounded(request.direction.replace(/\s+/g, " ").trim(), 72),
          sanitize,
          scope,
          siblingScopes: request.siblingScopes?.() ?? []
        })
      );
      emit({ kind: "workspace.checkpoint", payload: checkpoint });
      captured = { outcome: checkpoint.outcome, sha: checkpoint.sha, filesChanged: checkpoint.files.length };
      if (checkpoint.outcome === "failed") checkpointFailed = checkpoint.error ?? "The checkpoint failed.";
    } catch (error) {
      const reason = bounded(sanitize(messageOf(error)), MAX_REASON);
      checkpointFailed = reason;
      emit({
        kind: "workspace.checkpoint",
        payload: {
          outcome: "failed",
          sha: null,
          parentSha: null,
          branch: request.missionBranch,
          withheldSecrets: 0,
          uncommitted: true,
          error: reason,
          files: [],
          driftPaths: []
        }
      });
    }

    clearInterval(pulse);
    return {
      terminal: classify(outcome, stream, checkpointFailed),
      sessionId: stream.sessionId,
      checkpoint: captured
    };
  }

  /** One harness process, from spawn to exit. Never rejects. */
  function attempt(
    worktreePath: string,
    model: string,
    effort: string,
    stream: HarnessStream,
    resumeSessionId: string | null,
    optional: boolean
  ): Promise<ProcessOutcome> {
    if (request.fakeHarness) return fakeAttempt(worktreePath, stream);

    // Read per attempt rather than once: a turn that edits the project's
    // instructions is describing how the *next* turn should work.
    const instructionsFile = projectInstructionsFile(worktreePath);
    const instructions = instructionsFile ? ["--append-system-prompt-file", instructionsFile] : [];
    // The composed skills directory (D-118): Novus's own staging, holding the
    // person-approved bytes and nothing else. Absent when nothing was enabled
    // or everything enabled was dropped — then no flag is passed at all.
    const skills = composedSkills?.dir ? ["--plugin-dir", composedSkills.dir] : [];
    // The strict MCP config (D-119): only the approved servers exist to the
    // CLI — `--strict-mcp-config` is what keeps every other source out.
    const mcp = composedMcp?.file ? ["--mcp-config", composedMcp.file, "--strict-mcp-config"] : [];

    return new Promise<ProcessOutcome>((resolve) => {
      const args = [
        "-p",
        // The direction travels on stdin as a stream-json message rather than
        // as an argument, because stdin has to stay open for the control
        // channel: that is the same pipe the harness's permission questions are
        // answered on and the interrupt is sent on (D-056).
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
        ...pinnedPermissionArgs(profile),
        ...(optional ? OPTIONAL_ARGS : []),
        ...instructions,
        ...skills,
        ...mcp,
        "--model",
        model,
        "--effort",
        effort,
        ...(resumeSessionId === null ? ["--session-id", randomUUID()] : ["--resume", resumeSessionId])
      ];
      let settled = false;
      const settle = (outcome: ProcessOutcome): void => {
        if (settled) return;
        settled = true;
        child = null;
        resolve(outcome);
      };

      let spawned: ChildProcess;
      try {
        spawned = spawn("claude", args, {
          cwd: worktreePath,
          // The harness environment, not this process's (D-041): the user's own
          // local Claude Code login still works, and nothing a project declared
          // as a secret is in it.
          env: harnessEnv(),
          // stdin is a pipe now, and stays open for as long as the turn does:
          // it carries the direction in, then every control response and the
          // interrupt. Closing it early would end the turn's only way to answer.
          stdio: ["pipe", "pipe", "pipe"],
          // Its own process group, so a stop reaches the tools it started.
          detached: true
        });
      } catch (error) {
        settle({ code: null, signal: null, stderr: "", spawnError: messageOf(error) });
        return;
      }
      child = spawned;
      // A write that races the process's death must not take the app with it.
      spawned.stdin?.on("error", () => undefined);
      // The direction, as the first stream-json message. Written before any
      // stop is honoured so the two orderings converge on the same place: an
      // interrupt for a turn that has not started still ends it.
      // The direction, and anything the person attached to it. The images come
      // first: a picture followed by the words about it is the order a person
      // writes in, and the order the harness reads best.
      // Two roads for what a person attached (D-153). An image is *seen* and a
      // PDF is *read* — different content blocks, each verified against the
      // real CLI, because sending one as the other is not an error the CLI
      // reports, it is an answer about nothing. Everything else has no block
      // to be: it was staged on disk, and the turn is told where, so the
      // agent's own tools can open it.
      const attached = request.attachments ?? [];
      const inlined = attached.filter((file) => file.path === null);
      const staged = attached.filter((file) => file.path !== null);
      const stagedNote =
        staged.length === 0
          ? []
          : [
              {
                type: "text",
                text:
                  `The person attached ${staged.length === 1 ? "this file" : "these files"} ` +
                  `to this message. ${staged.length === 1 ? "It is" : "They are"} in the ` +
                  `working directory:\n` +
                  staged.map((file) => `- ${file.path} (${file.label}, ${file.mimeType})`).join("\n") +
                  `\nOpen ${staged.length === 1 ? "it" : "them"} with your own tools if the ` +
                  `request needs it.`
              }
            ];
      // The pinned references (D-182), in words before the words they steer:
      // a file is named as the path the person pointed at — the agent holds
      // the worktree and opens it itself — and a check carries the facts
      // snapshotted when the person referenced it, its output fenced so a
      // stack trace reads as the quotation it is.
      const refs = request.context ?? [];
      const files = refs.filter((ref) => ref.kind === "file");
      const checks = refs.filter((ref) => ref.kind === "check");
      const contextNote =
        refs.length === 0
          ? []
          : [
              {
                type: "text",
                text: [
                  ...(files.length > 0
                    ? [
                        `The person pinned ${files.length === 1 ? "this file" : "these files"} to this message — look at ${files.length === 1 ? "it" : "them"} in the working directory:\n` +
                          files.map((ref) => `- ${ref.path}`).join("\n")
                      ]
                    : []),
                  ...checks.map(
                    (ref) =>
                      `The person referenced the verification check "${ref.name}" (${ref.outcome} when referenced; command: ${ref.command}).` +
                      (ref.output ? `\nIts output then:\n\`\`\`\n${ref.output}\n\`\`\`` : "")
                  )
                ].join("\n\n")
              }
            ];
      writeControl({
        type: "user",
        message: {
          role: "user",
          content: [
            ...inlined.map((file) => ({
              type: file.mimeType === "application/pdf" ? "document" : "image",
              source: { type: "base64", media_type: file.mimeType, data: file.base64 }
            })),
            ...contextNote,
            ...stagedNote,
            { type: "text", text: request.direction }
          ]
        }
      });
      if (stopReason !== null) stop(stopReason); // stopped between the decision and the spawn

      // Without this listener a missing binary is an unhandled error event and
      // the promise never settles: the turn would hang forever.
      spawned.on("error", (error) => {
        settle({ code: null, signal: null, stderr: "", spawnError: messageOf(error) });
      });

      spawned.stdout?.on("data", (chunk: Buffer) => {
        // Defensive by construction: the parser drops anything it cannot read
        // rather than throwing into the data handler.
        for (const event of stream.push(chunk.toString())) emit(event);
        // The CLI does not exit while stdin is open — it is waiting for another
        // turn. Its own final verdict is the signal that there is nothing left
        // to say, so that is where the pipe closes and the process ends.
        if (stream.result !== null) spawned.stdin?.end();
      });

      // stderr is Novus/system diagnostics. It is never the harness speaking,
      // so it never becomes harness.text.
      let stderr = "";
      spawned.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString().slice(0, MAX_STDERR - stderr.length);
      });

      spawned.on("close", (code, signal) => {
        settle({ code, signal, stderr, spawnError: null });
      });
    });
  }

  /** The scripted harness: the identical pipeline, real git, no model call. */
  async function fakeAttempt(worktreePath: string, stream: HarnessStream): Promise<ProcessOutcome> {
    const approvalId = `fake-approval-${randomUUID()}`;
    /** The answer this scripted turn is waiting for, once one arrives. */
    let decided: { behavior?: string; message?: string } | null = null;
    let wake: (() => void) | null = null;
    // No process, so no stdin — but the same `writeControl` call, the same
    // response shape, and the same interrupt. Routing the double through this
    // seam is what makes the approval and interrupt paths testable at all
    // without spending a model call on every assertion.
    fakeControl = (message) => {
      const line = message as {
        type?: string;
        response?: { request_id?: string; response?: { behavior?: string; message?: string } };
        request?: { subtype?: string };
      };
      if (line.type === "control_response" && line.response?.request_id === approvalId) {
        decided = line.response.response ?? { behavior: "allow" };
      }
      wake?.();
    };
    try {
      const sessionId = request.resumeSessionId ?? randomUUID();
      // The deterministic turn writes one file. A direction may name which —
      // `[fake-write:relative/path.md]` — so a test can stage two scoped
      // chats writing genuinely different files at once (D-097); without the
      // token it stays the fixed root file every existing test knows.
      const namedTarget = /\[fake-write:([^\]\s]+)\]/.exec(request.direction)?.[1] ?? null;
      const filePath = join(worktreePath, namedTarget ?? "NOVUS_FAKE_TURN.md");
      const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "fake-harness" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `Working on: ${request.direction}` }] }
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_fake_write",
                name: "Write",
                // Deliberately absolute: the sanitizing gate has to earn its keep.
                input: { file_path: filePath }
              }
            ]
          }
        })
      ];
      // The double runs as fast as it can by default. An end-to-end test that
      // needs to *catch* a turn — press Stop while it is working — cannot do
      // that against a turn that is over in a tenth of a second, so its pace is
      // adjustable. Only ever consulted on this branch, which the caller gates.
      const pace = Number.parseInt(process.env.NOVUS_FAKE_HARNESS_PACE_MS ?? "", 10);
      const perLine = Number.isFinite(pace) && pace > 0 ? Math.min(pace, 10_000) : 20;
      for (const line of lines) {
        if (stopReason !== null) return { code: null, signal: "SIGTERM", stderr: "", spawnError: null };
        for (const event of stream.push(`${line}\n`)) emit(event);
        await delay(perLine);
      }

      // The permission question, in the shape the real CLI sends and through
      // the same parser, so what a test drives is the production path. A
      // direction may name which tool asks — `[fake-ask:Bash]` — so the
      // profile ladder's one meaningful line (a shell command is not an edit,
      // D-115) can be driven without a model call; without the token it stays
      // the Write every existing test knows.
      let allowed = true;
      if (request.fakeApproval) {
        // Underscores admitted so a scripted turn can ask as an MCP tool —
        // `[fake-ask:mcp__docs__echo]` — through the same production router.
        const askTool = /\[fake-ask:([A-Za-z0-9_]+)\]/.exec(request.direction)?.[1] ?? "Write";
        for (const event of stream.push(
          `${JSON.stringify({
            type: "control_request",
            request_id: approvalId,
            request: {
              subtype: "can_use_tool",
              tool_name: askTool,
              display_name: askTool,
              input:
                askTool === "Write"
                  ? { file_path: filePath, content: "# Fake turn\n" }
                  : { command: "echo fake-shell" },
              description: askTool === "Write" ? "NOVUS_FAKE_TURN.md" : "echo fake-shell",
              permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
              tool_use_id: "toolu_fake_write"
            }
          })}\n`
        )) {
          emit(event);
        }
        // Blocked, exactly as the CLI is: nothing else happens until someone
        // answers or the turn is stopped.
        while (decided === null && stopReason === null) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25).unref?.();
          });
        }
        wake = null;
        if (stopReason !== null) return { code: null, signal: "SIGTERM", stderr: "", spawnError: null };
        const answer = decided as { behavior?: string; message?: string } | null;
        allowed = answer?.behavior !== "deny";
        for (const event of stream.push(
          `${JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: allowed ? "Approved. Writing the file." : `Denied: ${answer?.message ?? "no reason given"}`
                }
              ]
            }
          })}\n`
        )) {
          emit(event);
        }
        // An allowed capture-tool ask is followed by the tool call itself,
        // exactly as the real CLI follows an allow (D-123): the scripted turn
        // POSTs the endpoint's own tools/call, so the production endpoint,
        // grant, and capture path are what a deterministic test drives.
        if (allowed && askTool === "mcp__novus__capture_screenshot" && request.novusCapture) {
          const called = await fetch(request.novusCapture.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${request.novusCapture.token}`
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "capture_screenshot", arguments: {} }
            })
          })
            .then(
              (response) =>
                response.json() as Promise<{
                  result?: { content?: { text?: string }[]; isError?: boolean };
                }>
            )
            .catch((error: unknown) => ({
              result: {
                content: [{ text: `Capture failed: ${messageOf(error)}` }],
                isError: true
              }
            }));
          const said = called.result?.content?.[0]?.text ?? "The capture endpoint said nothing.";
          for (const event of stream.push(
            `${JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: said }] }
            })}\n`
          )) {
            emit(event);
          }
        }
      }

      if (stopReason !== null) return { code: null, signal: "SIGTERM", stderr: "", spawnError: null };

      // Two of the harness's own workers, in the exact line shapes the real
      // CLI emits and through the same parser (D-107): the Task spawns, their
      // tagged activity, and the Task results — one success, one failure — so
      // an end-to-end test drives the production worker join.
      if (/\[fake-workers\]/.test(request.direction)) {
        const workerLines = [
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", id: "toolu_fake_w1", name: "Task", input: { description: "Research the repository" } },
                { type: "tool_use", id: "toolu_fake_w2", name: "Task", input: { description: "Run API tests" } }
              ]
            }
          }),
          JSON.stringify({
            type: "assistant",
            parent_tool_use_id: "toolu_fake_w1",
            message: {
              content: [
                { type: "text", text: "Found three call sites." },
                { type: "tool_use", id: "toolu_fake_w1_read", name: "Read", input: { file_path: "src/auth.ts" } }
              ]
            }
          }),
          JSON.stringify({
            type: "assistant",
            parent_tool_use_id: "toolu_fake_w2",
            message: {
              content: [
                { type: "tool_use", id: "toolu_fake_w2_read", name: "Read", input: { file_path: "test/api.test.ts" } }
              ]
            }
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "toolu_fake_w1", content: "Three call sites documented." }
              ]
            }
          }),
          JSON.stringify({
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "toolu_fake_w2", content: "The tests could not start.", is_error: true }
              ]
            }
          })
        ];
        for (const workerLine of workerLines) {
          if (stopReason !== null) return { code: null, signal: "SIGTERM", stderr: "", spawnError: null };
          for (const event of stream.push(`${workerLine}\n`)) emit(event);
          await delay(perLine);
        }
      }

      for (const event of stream.push(
        `${JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Done. The change is in the worktree." }] }
        })}\n`
      )) {
        emit(event);
      }
      // A denial is the whole point: the file is not written.
      if (allowed) {
        mkdirSync(join(filePath, ".."), { recursive: true });
        writeFileSync(filePath, `# Fake turn\n\n${request.direction}\n`);
      }
      // No trailing newline: the flush path is part of what is being exercised.
      stream.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
      return { code: 0, signal: null, stderr: "", spawnError: null };
    } catch (error) {
      // An exception in the double must still end the turn, or a test run
      // hangs on an execution that never terminates.
      return { code: null, signal: null, stderr: "", spawnError: messageOf(error) };
    } finally {
      fakeControl = null;
    }
  }

  function classify(
    outcome: ProcessOutcome,
    stream: HarnessStream,
    checkpointFailed: string | null
  ): TerminalEvent {
    if (stopReason !== null) {
      return {
        kind: "execution.stopped",
        payload: { reason: bounded(sanitize(stopReason), MAX_REASON), via: stoppedVia }
      };
    }
    if (outcome.spawnError !== null) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "spawn_failed",
          reason: bounded(sanitize(`Claude Code could not start: ${outcome.spawnError}`), MAX_REASON)
        }
      };
    }
    // A CLI that does not know these flags refuses before it does anything, and
    // Novus refuses with it. There is no fallback here on purpose: every way of
    // running without the control channel is a way of running unsupervised, and
    // the whole point of this path is that nothing changes a repository without
    // a person saying so (D-056).
    if (outcome.code !== 0 && UNSUPPORTED_FLAG.test(outcome.stderr)) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "unsupported_harness",
          reason: bounded(
            sanitize(
              `This machine's Claude Code can't route approvals to Novus (${outcome.stderr.trim().split("\n")[0] ?? "unknown option"}). Update the CLI and direct again.`
            ),
            MAX_REASON
          )
        }
      };
    }
    const result = stream.result;
    const diagnostics = `${result?.message ?? ""}\n${outcome.stderr}`;
    // Money before identity: "credit balance is too low" contains no auth
    // word by accident, but a billing message that also says "unauthorized"
    // must still not be answered with "sign in again" (D-109).
    if ((result?.isError === true || outcome.code !== 0) && BILLING_HINTS.test(diagnostics)) {
      const detail = (result?.message ?? outcome.stderr).trim().split("\n")[0] ?? "";
      return {
        kind: "execution.failed",
        payload: {
          classification: "billing",
          reason: bounded(
            sanitize(
              detail
                ? `Claude Code reports a spending or usage limit: ${detail}`
                : "Claude Code reports a spending or usage limit on this machine."
            ),
            MAX_REASON
          )
        }
      };
    }
    if ((result?.isError === true || outcome.code !== 0) && AUTH_HINTS.test(diagnostics)) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "authentication",
          reason: "Claude Code isn't signed in on this machine. Sign in to the CLI and direct again."
        }
      };
    }
    // The harness's own word for "I stopped because I hit my turn budget":
    // real work happened, nothing failed, and the turn is not finished. It is
    // interrupted — resumable by directing again — never "Work finished",
    // which is the lie the discarded subtype used to produce (D-109).
    if (result?.subtype === "error_max_turns") {
      return {
        kind: "execution.interrupted",
        payload: {
          reason: bounded(
            "Claude Code ran out of its turn budget before finishing. Direct it again to continue from where it stopped.",
            MAX_REASON
          )
        }
      };
    }
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim() || result?.message || `exit ${outcome.code ?? "unknown"}`;
      return {
        kind: "execution.failed",
        payload: {
          classification: "nonzero_exit",
          reason: bounded(sanitize(`Claude Code exited unsuccessfully: ${detail}`), MAX_REASON)
        }
      };
    }
    if (result?.isError === true) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "harness_error",
          reason: bounded(sanitize(result.message ?? "The harness reported an error."), MAX_REASON)
        }
      };
    }
    // Reached last on purpose: an unreconciled checkpoint failure can never be
    // dressed up as a completed execution.
    if (checkpointFailed !== null) {
      return {
        kind: "execution.failed",
        payload: {
          classification: "checkpoint_failed",
          reason: bounded(sanitize(`The work could not be checkpointed: ${checkpointFailed}`), MAX_REASON)
        }
      };
    }
    // A clean exit with no result line is not a success — it is a stream that
    // ended before the harness said how it ended. Calling it completed would
    // fabricate an outcome the harness never reported (D-109).
    if (result === null) {
      return {
        kind: "execution.interrupted",
        payload: {
          reason: bounded(
            "Claude Code ended without reporting an outcome, so this turn cannot be called finished.",
            MAX_REASON
          )
        }
      };
    }
    return { kind: "execution.completed", payload: {} };
  }

  /** A turn that ends before the harness ran still reports a boundary, so a
   *  pending control transfer is never left waiting on a dead execution. */
  function terminate(terminal: TerminalEvent): TurnResult {
    emit({ kind: "boundary.reached", payload: { reason: "turn ended before the harness started" } });
    return { terminal, sessionId: null, checkpoint: null };
  }
}

/**
 * Did the CLI refuse one of the flags Novus can do without, by name?
 *
 * Both halves matter. Without the name, a CLI refusing `--permission-prompt-tool`
 * would be retried as though it were an old version missing a nicety, and the
 * turn that came back would be the unsupervised one D-062 exists to refuse.
 */
function refusedOptionalFlag(outcome: ProcessOutcome): boolean {
  if (outcome.code === 0 || !UNSUPPORTED_FLAG.test(outcome.stderr)) return false;
  return OPTIONAL_ARGS.some((flag) => outcome.stderr.includes(flag));
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    // The group is already gone, or the platform refused; fall back to the
    // process itself rather than leaving it running.
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown failure.";
}
