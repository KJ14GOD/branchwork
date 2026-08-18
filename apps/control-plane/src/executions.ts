import type { FastifyInstance } from "fastify";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_PROFILE,
  DirectionInputSchema,
  DirectionResolutionSchema,
  EnabledMcpServersSchema,
  EnabledSkillsSchema,
  ExecutionStateSchema,
  PermissionProfileSchema,
  scopesDisjoint,
  TERMINAL_EXECUTION_STATES,
  type EnabledMcpServer,
  type EnabledSkill,
  type FileDiffResponse,
  type PermissionProfile
} from "@novus/contracts";
import { z } from "zod";
import type pg from "pg";
import { settlePendingApprovals } from "./approvals.ts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import type { MissionAccess } from "./authz.ts";
import type { Db } from "./db.ts";
import { withMission, withTransaction } from "./db.ts";
import { cancelDirection, resolveDirection, submitDirection } from "./directions.ts";
import { lastEventAt, recordEvent } from "./events.ts";
import { newExecutionId } from "./ids.ts";
import { activeRunner, enqueueCommand, runnerOnline } from "./runners.ts";
import { scopeOf, sessionResumePoint } from "./sessions.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: durable executions and the dispatch of authorized direction to the
 * host runner. Paths owned by this module:
 *
 *   POST   /missions/:missionId/direction              (submit; dispatches when the author controls)
 *   POST   /directions/:directionId/resolve            (controller: apply | reject | supersede)
 *   POST   /directions/:directionId/cancel             (author)
 *   POST   /missions/:missionId/execution/stop
 *   GET    /file-changes/:changeId                     (diff body, fetched on demand)
 *
 * No other module registers a path under /directions, /file-changes, or
 * /missions/:id/execution.
 */

/** Derived from the contract so a new execution state can never be forgotten
 *  here: everything that is not terminal still occupies the workstream. */
export const ACTIVE_EXECUTION_STATES: string[] = ExecutionStateSchema.options.filter(
  (state) => !TERMINAL_EXECUTION_STATES.includes(state)
);

/** How long an unanswered stop keeps its claim to work before a person may
 *  declare the turn dead (D-111). Generous against the transport: a stop is
 *  delivered within a 2 s poll and answered within a 7 s interrupt-then-kill
 *  window, so a minute of silence is a machine that is not going to answer. */
const FORCE_INTERRUPT_AFTER_MS = 60_000;

/** Said in the log when the machine that was working never answered again. */
const RUNNER_GONE =
  "The runner stopped responding, so the execution ended without a reported outcome.";

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });
const DirectionParamsSchema = z.object({ directionId: z.string().startsWith("dir_") });
const ChangeParamsSchema = z.object({ changeId: z.string().startsWith("chg_") });
/** Stop names its lane; absent means the lane the mission started with. With
 *  read turns alongside (D-095) a lane can hold two live executions, so stop
 *  may also name the conversation whose turn it means; absent means the
 *  lane's write turn — the historical meaning — or the one turn running. */
const StopInputSchema = z.object({
  workstreamId: z.string().startsWith("wst_").optional(),
  sessionId: z.string().startsWith("csn_").optional()
});

export interface DispatchResult {
  executionId: string | null;
  commandId: string | null;
  /** Why nothing was dispatched, when nothing was: no runner, already busy. */
  deferred: string | null;
}

/** The lane's stored answer policy, validated (D-115). Malformed or
 *  pre-migration reads as manual — every question asked — never as a wider
 *  grant, the same failure posture as a malformed scope reading unscoped. */
function profileOf(value: unknown): PermissionProfile {
  const parsed = PermissionProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PERMISSION_PROFILE;
}

/** The lane's enabled skills, validated (D-118). Malformed or pre-migration
 *  reads as none enabled — nothing is ever carried by accident — the same
 *  failure posture as profileOf. */
function skillsOf(value: unknown): EnabledSkill[] {
  const parsed = EnabledSkillsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** The lane's enabled MCP servers, same posture (D-119). */
function mcpOf(value: unknown): EnabledMcpServer[] {
  const parsed = EnabledMcpServersSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

interface ActiveExecution {
  executionId: string;
  /** Whose turn it is (D-083): a direction for this session steers it, a
   *  direction for a sibling waits for it. */
  sessionId: string;
}

interface LiveWriter {
  executionId: string;
  sessionId: string;
  /** The scope the writer's session declares now. The turn itself enforces
   *  the scope pinned at its dispatch; this one decides who may join it. */
  scope: string[] | null;
  title: string | null;
}

/** The lane's *writing* turns — one when any is unscoped (exclusivity), and
 *  possibly several provably-disjoint scoped ones (D-097). Read turns hold
 *  nothing and are invisible here (D-095). */
async function liveWriteExecutions(
  client: pg.PoolClient,
  workstreamId: string
): Promise<LiveWriter[]> {
  const result = await client.query(
    `select e.exe_id, e.session_id, s.scope, s.title from executions e
       join workstream_sessions s on s.csn_id = e.session_id
      where e.wst_id = $1 and e.state = any($2::text[]) and e.access = 'write'`,
    [workstreamId, ACTIVE_EXECUTION_STATES]
  );
  return result.rows.map((row) => ({
    executionId: row.exe_id as string,
    sessionId: row.session_id as string,
    scope: scopeOf(row.scope),
    title: (row.title as string | null) ?? null
  }));
}

/** This one conversation's live turn, whatever its access — a session's turns
 *  are serial because they share one harness transcript (D-095's index). */
async function sessionLiveExecution(
  client: pg.PoolClient,
  sessionId: string
): Promise<ActiveExecution | null> {
  const result = await client.query(
    "select exe_id, session_id from executions where session_id = $1 and state = any($2::text[]) limit 1",
    [sessionId, ACTIVE_EXECUTION_STATES]
  );
  const row = result.rows[0];
  return row ? { executionId: row.exe_id as string, sessionId: row.session_id as string } : null;
}

/** The words the composer shows when a direction has to wait its turn. */
async function busyWith(client: pg.PoolClient, sessionId: string): Promise<string> {
  const result = await client.query("select title from workstream_sessions where csn_id = $1", [
    sessionId
  ]);
  const title = (result.rows[0]?.title as string | null | undefined) ?? null;
  return title
    ? `Queued — "${title}" is running; this applies when it finishes.`
    : "Queued — another session is running; this applies when it finishes.";
}

/**
 * Dispatches whatever the controller already authorized but nothing could
 * carry yet. A workstream's very first direction is submitted before its host
 * has finished enrolling as the runner, so it is deferred with a reason and
 * would otherwise sit there: the room would say "queued" for work nobody was
 * waiting on. Enrolment calls this, and the controller's own oldest queued
 * direction goes out at once.
 *
 * Only the lease holder's own direction is dispatched. Someone else's still
 * waits for an explicit apply — a runner appearing is not authority.
 */
export async function dispatchQueuedForController(
  deps: { db: RouteDeps["db"] },
  workstreamId: string
): Promise<DispatchResult | null> {
  const pending = await deps.db.query(
    `select d.dir_id, d.mission_id, d.model, d.effort, u.user_id, u.login
       from directions d
       join control_leases l on l.wst_id = d.wst_id and l.state = 'held'
                            and l.holder_user_id = d.author_user_id
       join users u on u.user_id = d.author_user_id
      where d.wst_id = $1 and d.state = 'queued'
        -- Only direction nothing has ever carried. "Queued" alone is not that:
        -- a direction stays queued until the runner *acknowledges* it, so the
        -- one that started the turn now completing still reads queued — and
        -- re-dispatching it would run the same words twice (D-083's
        -- completed-turn dispatch found this; the enrolment path shared it).
        and not exists (select 1 from executions e where e.starting_direction_id = d.dir_id)
        and not exists (select 1 from runner_commands c
                         where c.wst_id = d.wst_id and c.payload->>'directionId' = d.dir_id)
      order by d.ordinal limit 1`,
    [workstreamId]
  );
  const row = pending.rows[0];
  if (!row) return null;

  // The author's own standing decides this, not the enroller's: authority is
  // read from durable state at command time (ARCHITECTURE.md#authorization) —
  // and against *this* lane, not the mission's first. Resolved without the
  // lane, an approach's own queued direction was judged by the wrong baton and
  // then fetched against the wrong workstream, so it never dispatched (D-083's
  // routing audit).
  const access = await missionAccess(
    deps.db,
    { userId: row.user_id as string },
    row.mission_id as string,
    workstreamId
  );
  if (!access || !access.isController) return null;
  if (!access.capabilities.includes("execution.start")) return null;

  return dispatchDirection(
    deps,
    access,
    { userId: row.user_id as string, login: row.login as string },
    {
      directionId: row.dir_id as string,
      model: (row.model as string | null) ?? DEFAULT_MODEL,
      effort: (row.effort as string | null) ?? DEFAULT_EFFORT
    }
  );
}

/**
 * Sends an authorized direction toward the host runner: starts a new execution
 * when the workstream is idle, or applies it to the running one. Enqueues a
 * durable command; it never marks the direction Applied — only the runner's
 * acknowledgement does that.
 */
export async function dispatchDirection(
  deps: { db: RouteDeps["db"] },
  access: MissionAccess,
  actor: { userId: string; login: string },
  args: { directionId: string; model: string; effort: string }
): Promise<DispatchResult> {
  const workstreamId = access.workstreamId;
  if (!workstreamId) {
    return { executionId: null, commandId: null, deferred: "This mission has no workstream yet." };
  }

  return withMission(deps.db, access.missionId, async (client) => {
    // The dispatch decision reads scopes across two tables, which no unique
    // index can guard (D-097): the mission's advisory lock serializes every
    // dispatch for the mission instead, so two racing directions cannot both
    // conclude the coast is clear.

    // No runner means no execution. Inventing one would put the room in
    // "Agent starting" with nothing behind it.
    const runner = await activeRunner(client, workstreamId);
    const runnerId = runner?.runnerId;
    if (!runnerId) {
      return {
        executionId: null,
        commandId: null,
        deferred: "No runner is registered for this workstream yet."
      };
    }

    const direction = await client.query(
      `select d.body, d.session_id, s.scope, w.permission_profile, w.enabled_skills,
              w.enabled_mcp_servers from directions d
         join workstream_sessions s on s.csn_id = d.session_id
         join workstreams w on w.wst_id = d.wst_id
        where d.dir_id = $1 and d.wst_id = $2`,
      [args.directionId, workstreamId]
    );
    const body = direction.rows[0]?.body as string | undefined;
    const sessionId = direction.rows[0]?.session_id as string | undefined;
    const scope = scopeOf(direction.rows[0]?.scope);
    // The lane's standing answer policy, read under the same lock and pinned
    // into this turn (D-115): a profile change mid-turn speaks from the next
    // dispatch, never into a running one (the D-043 pattern, as with scope).
    const permissionProfile = profileOf(direction.rows[0]?.permission_profile);
    // And the skills a person enabled, pinned the same way (D-118): the turn
    // carries the set — and the exact digests — that stood when it was
    // authorized, so an enablement mid-turn speaks from the next dispatch.
    const skills = skillsOf(direction.rows[0]?.enabled_skills);
    // And the MCP servers (D-119), under exactly the same rule.
    const mcpServers = mcpOf(direction.rows[0]?.enabled_mcp_servers);
    if (body === undefined || sessionId === undefined) {
      return { executionId: null, commandId: null, deferred: "That direction is no longer available." };
    }

    // The images this direction was submitted with (D-150). Addresses and
    // facts, never bytes: the runner fetches each blob under its own
    // credential and hands it to the harness. A command payload is durable and
    // replayable, and a base64 image inside one would be both forever.
    const attachments = (
      await client.query(
        `select a.art_id, a.mime_type, a.label
           from direction_attachments da
           join artifacts a on a.art_id = da.art_id
          where da.dir_id = $1 and a.state = 'available'
          order by da.ordinal`,
        [args.directionId]
      )
    ).rows as { art_id: string; mime_type: string; label: string }[];

    const base = {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      runnerId
    };
    const applyTo = async (executionId: string): Promise<DispatchResult> => ({
      executionId,
      commandId: await enqueueCommand(client, {
        ...base,
        executionId,
        kind: "apply_direction",
        payload: {
          directionId: args.directionId,
          body,
          model: args.model,
          effort: args.effort,
          // The conversation and its own resume point, stated outright. An
          // apply that reaches the runner after its turn already ended starts
          // a fresh process, and a payload that named no session fell back to
          // the workstream's legacy column — the *first* chat's transcript —
          // so a follow-up in a second chat resumed a sibling's conversation
          // (found by the D-109 audit; the D-083 rule, finally applied here).
          sessionId,
          resumeSessionId: await sessionResumePoint(client, sessionId),
          // What the person attached, for the harness to actually see (D-150).
          attachments: attachments.map((row) => ({
            artifactId: row.art_id,
            mimeType: row.mime_type,
            label: row.label
          })),
          // Same reasoning for the profile (D-115): a live turn keeps the one
          // pinned at its own dispatch, and the fresh process an after-end
          // apply spawns must state its policy rather than inherit a default.
          permissionProfile,
          // And for the skills (D-118): the fresh process an after-end apply
          // spawns composes from this pinned set, never from the rows.
          skills,
          mcpServers
        },
        idempotencyKey: `apply:${args.directionId}`
      }),
      deferred: null
    });

    // Whose turn the workspace is on decides everything (D-083): the same
    // session's direction steers the running turn; a sibling session's waits —
    // unless both chats are scoped and their scopes are provably disjoint
    // (D-097), in which case the sibling's turn starts in parallel: the
    // worktree is shared but their files are not. An unscoped chat, on either
    // side, means exclusivity exactly as before scopes existed.
    const writers = await liveWriteExecutions(client, workstreamId);
    const own = writers.find((writer) => writer.sessionId === sessionId);
    if (own) return applyTo(own.executionId);
    const blocking = writers.find(
      (writer) =>
        scope === null || writer.scope === null || !scopesDisjoint(writer.scope, scope)
    );
    if (blocking) {
      return {
        executionId: null,
        commandId: null,
        deferred:
          scope !== null && blocking.scope !== null
            ? blocking.title
              ? `Queued — its files overlap "${blocking.title}"'s scope; this applies when that turn finishes.`
              : "Queued — its files overlap a running chat's scope; this applies when that turn finishes."
            : await busyWith(client, blocking.sessionId)
      };
    }

    // The workspace has room, but this conversation itself may be mid-answer:
    // a session's turns are serial whatever their access, because they share
    // one harness transcript (D-095). The direction waits for its own chat and
    // is dispatched when that turn completes, exactly like waiting for a
    // sibling's write turn.
    const ownTurn = await sessionLiveExecution(client, sessionId);
    if (ownTurn) {
      return {
        executionId: null,
        commandId: null,
        deferred: await busyWith(client, ownTurn.sessionId)
      };
    }

    // This conversation's own resume point, never a sibling's (D-083).
    const resumeSessionId = await sessionResumePoint(client, sessionId);
    const executionId = newExecutionId();

    // The partial unique index is the concurrency guard, not a memory of what
    // this process already started. A second dispatch that loses the race
    // becomes an apply against the winner's execution — but only when the
    // winner is the same conversation; a sibling session's winner means this
    // direction waits its turn.
    await client.query("savepoint start_execution");
    try {
      await client.query(
        `insert into executions (exe_id, org_id, mission_id, wst_id, session_id, harness, model, effort,
                                 runner_id, starting_direction_id, state, started_by, permission_profile)
         values ($1, $2, $3, $4, $5, 'claude-code', $6, $7, $8, $9, 'requested', $10, $11)`,
        [
          executionId,
          access.orgId,
          access.missionId,
          workstreamId,
          sessionId,
          args.model,
          args.effort,
          runnerId,
          args.directionId,
          actor.userId,
          permissionProfile
        ]
      );
      await client.query("release savepoint start_execution");
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      await client.query("rollback to savepoint start_execution");
      // Only the per-session index can refuse this insert now (D-097): the
      // mission lock above serializes writer admission, so a conflict means
      // this conversation's own turn appeared — steer it or wait for it.
      const claimed = await sessionLiveExecution(client, sessionId);
      if (!claimed) throw error;
      const writers = await liveWriteExecutions(client, workstreamId);
      if (writers.some((writer) => writer.executionId === claimed.executionId)) {
        return applyTo(claimed.executionId);
      }
      return {
        executionId: null,
        commandId: null,
        deferred: await busyWith(client, claimed.sessionId)
      };
    }

    const commandId = await enqueueCommand(client, {
      ...base,
      executionId,
      kind: "start_execution",
      payload: {
        directionId: args.directionId,
        body,
        model: args.model,
        effort: args.effort,
        sessionId,
        resumeSessionId,
        // What the person attached (D-150), by address — the first turn of a
        // direction sees the same images a later apply of it would.
        attachments: attachments.map((row) => ({
          artifactId: row.art_id,
          mimeType: row.mime_type,
          label: row.label
        })),
        // Pinned at dispatch (D-097, the D-043 pattern): the turn enforces
        // the scope the controller had approved when it was authorized.
        scope,
        // And the answer policy the lane stood under when this turn was
        // authorized (D-115) — the runner applies exactly this, so a profile
        // change never reaches into a turn already running.
        permissionProfile,
        // And the skills a person had enabled (D-118), each at its approved
        // digest — the runner composes exactly these or drops them by name.
        skills,
        // And the MCP servers (D-119), composed into a strict config or
        // dropped by name under the same digest rule.
        mcpServers
      },
      // Keyed on the *execution*, not the direction. A direction that failed
      // and is directed again is a new attempt and needs a new command; keyed
      // on the direction, the second attempt collided with the first command's
      // idempotency key, `on conflict do nothing` swallowed it, and the new
      // execution sat in `requested` with nothing to run it — for ever, while
      // the room said Starting. Two concurrent dispatches of one direction are
      // already prevented by the partial unique index above, which is the
      // concurrency guard; this key only has to be unique per attempt.
      idempotencyKey: `start:${executionId}`
    });
    await recordEvent(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      executionId,
      kind: "execution.requested",
      actorKind: "user",
      actorId: actor.userId,
      actorLogin: actor.login,
      causeDirectionId: args.directionId,
      causeLeaseId: access.leaseId,
      payload: { harness: "claude-code", model: args.model, effort: args.effort, sessionId }
    });
    return { executionId, commandId, deferred: null };
  });
}

/**
 * Starts a direction's turn alongside the workspace's, read-only, right now
 * (D-095). No queueing and no steering: the read turn is its conversation's
 * own answer, started immediately whatever the write turn is doing. What it
 * may never do is hold the worktree — the runner denies its every permission
 * request and captures no checkpoint, and the indexes admit any number of
 * read turns per lane but only one turn per conversation.
 */
export async function dispatchAlongside(
  deps: { db: RouteDeps["db"] },
  access: MissionAccess,
  actor: { userId: string; login: string },
  args: { directionId: string; model: string; effort: string }
): Promise<DispatchResult> {
  const workstreamId = access.workstreamId;
  if (!workstreamId) {
    return { executionId: null, commandId: null, deferred: "This mission has no workstream yet." };
  }

  return withTransaction(deps.db, async (client) => {
    const runner = await activeRunner(client, workstreamId);
    const runnerId = runner?.runnerId;
    if (!runnerId) {
      return {
        executionId: null,
        commandId: null,
        deferred: "No runner is registered for this workstream yet."
      };
    }

    const direction = await client.query(
      "select body, session_id from directions where dir_id = $1 and wst_id = $2",
      [args.directionId, workstreamId]
    );
    const body = direction.rows[0]?.body as string | undefined;
    const sessionId = direction.rows[0]?.session_id as string | undefined;
    if (body === undefined || sessionId === undefined) {
      return { executionId: null, commandId: null, deferred: "That direction is no longer available." };
    }

    // One turn per conversation, whatever its access: two turns resuming one
    // harness transcript would fork it (D-095's per-session index; checked
    // here for the words, enforced there for the race).
    if (await sessionLiveExecution(client, sessionId)) {
      return {
        executionId: null,
        commandId: null,
        deferred: "This chat is already answering; direct it again when it finishes."
      };
    }

    const resumeSessionId = await sessionResumePoint(client, sessionId);
    const executionId = newExecutionId();
    await client.query("savepoint start_read_execution");
    try {
      await client.query(
        `insert into executions (exe_id, org_id, mission_id, wst_id, session_id, harness, model, effort,
                                 runner_id, starting_direction_id, state, started_by, access)
         values ($1, $2, $3, $4, $5, 'claude-code', $6, $7, $8, $9, 'requested', $10, 'read')`,
        [
          executionId,
          access.orgId,
          access.missionId,
          workstreamId,
          sessionId,
          args.model,
          args.effort,
          runnerId,
          args.directionId,
          actor.userId
        ]
      );
      await client.query("release savepoint start_read_execution");
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      await client.query("rollback to savepoint start_read_execution");
      return {
        executionId: null,
        commandId: null,
        deferred: "This chat is already answering; direct it again when it finishes."
      };
    }

    const commandId = await enqueueCommand(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      runnerId,
      executionId,
      kind: "start_execution",
      payload: {
        directionId: args.directionId,
        body,
        model: args.model,
        effort: args.effort,
        sessionId,
        resumeSessionId,
        access: "read"
      },
      idempotencyKey: `start:${executionId}`
    });
    await recordEvent(client, {
      orgId: access.orgId,
      missionId: access.missionId,
      workstreamId,
      executionId,
      kind: "execution.requested",
      actorKind: "user",
      actorId: actor.userId,
      actorLogin: actor.login,
      causeDirectionId: args.directionId,
      causeLeaseId: access.leaseId,
      payload: {
        harness: "claude-code",
        model: args.model,
        effort: args.effort,
        sessionId,
        access: "read"
      }
    });
    return { executionId, commandId, deferred: null };
  });
}

/** The harness settings this lane last ran with, so applying a queued
 *  direction does not silently switch model or effort behind the controller. */
async function lastHarnessSettings(db: Db, workstreamId: string): Promise<{ model: string; effort: string }> {
  const result = await db.query(
    "select model, effort from executions where wst_id = $1 order by created_at desc limit 1",
    [workstreamId]
  );
  const row = result.rows[0];
  return {
    model: (row?.model as string | undefined) ?? DEFAULT_MODEL,
    effort: (row?.effort as string | undefined) ?? DEFAULT_EFFORT
  };
}

/** The mission — and the lane — a direction belongs to, before any
 *  authorization is computed. The lane matters: resolving a queued direction
 *  is judged against the *direction's* lane's lease, never the mission's
 *  first (ARCHITECTURE.md#authorization, D-083's routing audit). */
async function missionOfDirection(
  db: Db,
  directionId: string
): Promise<{ missionId: string; workstreamId: string } | null> {
  const result = await db.query("select mission_id, wst_id from directions where dir_id = $1", [
    directionId
  ]);
  const row = result.rows[0];
  return row
    ? { missionId: row.mission_id as string, workstreamId: row.wst_id as string }
    : null;
}

export function registerExecutionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/direction", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    const body = DirectionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const message = body.success ? "Malformed mission id." : body.error.issues[0]?.message ?? "Invalid direction.";
      return deps.sendError(reply, params.success ? 422 : 400, "invalid_direction", message);
    }
    // One direction, one target: naming a session and asking for a new one at
    // once has no honest reading, so it is refused rather than guessed at.
    if (body.data.sessionId && body.data.newSession) {
      return deps.sendError(
        reply,
        400,
        "invalid_direction",
        "Name a session or ask for a new one, not both."
      );
    }
    // Resolved against the lane the direction names, so an approach's own
    // controller decides its queue rather than the first lane's (D-074).
    const access = await missionAccess(
      deps.db,
      ctx,
      params.data.missionId,
      body.data.workstreamId ?? null
    );
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "direction.submit");

    // Running alongside is the baton holder's call (D-095): it spends the
    // host machine's quota exactly as an immediate dispatch does, and quota
    // is what the baton already gates. Refused in words, not silently queued
    // — never do something different from what was asked.
    if (body.data.alongside && !access.isController) {
      return deps.sendError(
        reply,
        403,
        "not_controller",
        "Only the person holding the baton can run a chat alongside."
      );
    }

    const actor = { userId: ctx.userId, login: ctx.login };
    const submitted = await submitDirection(
      deps.db,
      access,
      actor,
      body.data.body,
      {
        model: body.data.model,
        effort: body.data.effort
      },
      {
        ...(body.data.sessionId ? { sessionId: body.data.sessionId } : {}),
        newSession: body.data.newSession
      },
      body.data.attachmentIds
    );
    // Only the controller's own direction proceeds toward the harness; anyone
    // else's waits, visibly, for whoever holds the baton. Alongside starts a
    // read turn immediately instead of queueing (D-095).
    const dispatch = !submitted.authorIsController
      ? null
      : body.data.alongside
        ? await dispatchAlongside(deps, access, actor, {
            directionId: submitted.direction.directionId,
            model: body.data.model,
            effort: body.data.effort
          })
        : await dispatchDirection(deps, access, actor, {
            directionId: submitted.direction.directionId,
            model: body.data.model,
            effort: body.data.effort
          });

    return {
      direction: submitted.direction,
      dispatched: dispatch !== null && dispatch.commandId !== null,
      deferred: dispatch?.deferred ?? null
    };
  });

  app.post("/directions/:directionId/resolve", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = DirectionParamsSchema.safeParse(request.params);
    const body = DirectionResolutionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return deps.sendError(reply, 400, "bad_request", "Malformed resolution.");
    }
    const owner = await missionOfDirection(deps.db, params.data.directionId);
    if (!owner) return deps.sendError(reply, 404, "not_found", "No such direction.");
    // Against the direction's own lane: an approach's queued direction is the
    // approach's controller's to apply, and the first lane's baton must not
    // reach across (D-080's rule, applied to a request that arrives through a
    // row rather than a mission id — D-083).
    const access = await missionAccess(deps.db, ctx, owner.missionId, owner.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such direction.");
    requireCapability(access, "direction.apply");

    const actor = { userId: ctx.userId, login: ctx.login };
    const resolved = await resolveDirection(
      deps.db,
      access,
      actor,
      params.data.directionId,
      body.data.action,
      body.data.reason
    );
    if (!resolved) return deps.sendError(reply, 404, "not_found", "No such direction.");
    if (body.data.action === "apply" && access.workstreamId) {
      const settings = await lastHarnessSettings(deps.db, access.workstreamId);
      await dispatchDirection(deps, access, actor, {
        directionId: params.data.directionId,
        model: settings.model,
        effort: settings.effort
      });
    }
    return { ok: true };
  });

  app.post("/directions/:directionId/cancel", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = DirectionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed direction id.");
    const owner = await missionOfDirection(deps.db, params.data.directionId);
    if (!owner) return deps.sendError(reply, 404, "not_found", "No such direction.");
    const access = await missionAccess(deps.db, ctx, owner.missionId, owner.workstreamId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such direction.");
    // Participation is the gate here; authorship is enforced inside, because
    // "only the author may cancel" is a rule about the row, not about a role.
    requireCapability(access, "mission.view");
    const cancelled = await cancelDirection(deps.db, access, { userId: ctx.userId, login: ctx.login }, params.data.directionId);
    if (!cancelled) return deps.sendError(reply, 404, "not_found", "No such direction.");
    return { ok: true };
  });

  app.post("/missions/:missionId/execution/stop", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = StopInputSchema.safeParse(request.body ?? {});
    if (!body.success) return deps.sendError(reply, 400, "bad_request", "Malformed stop request.");
    // The lane travels on the wire (D-080, D-083's routing audit): resolved
    // without it, a Stop pressed while reading an Alternative reached the
    // mission's *first* lane — a no-op there, while the Alternative's turn
    // kept running under the very control that claimed to stop it.
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId ?? null);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "execution.stop");
    const workstreamId = access.workstreamId;
    if (!workstreamId) return { ok: true };

    await withTransaction(deps.db, async (client) => {
      const running = await client.query(
        "select exe_id, runner_id, session_id, access from executions where wst_id = $1 and state = any($2::text[]) for update",
        [workstreamId, ACTIVE_EXECUTION_STATES]
      );
      // Which turn the stop means (D-095): the named conversation's; else the
      // write turn, which is what stop has always meant; else the one turn
      // running. A named session with nothing live is nothing to stop.
      const rows = running.rows as { exe_id: string; runner_id: string | null; session_id: string; access: string }[];
      const row = body.data.sessionId
        ? rows.find((candidate) => candidate.session_id === body.data.sessionId)
        : (rows.find((candidate) => candidate.access === "write") ?? (rows.length === 1 ? rows[0] : undefined));
      // Nothing is running: stopping is already true, so say so by doing
      // nothing rather than recording a stop that never happened.
      if (!row) return;
      const executionId = row.exe_id;

      const runner = await activeRunner(client, workstreamId);
      const online = runnerOnline(runner?.lastSeenAt ?? null);
      const runnerId = runner?.runnerId ?? (row.runner_id as string | null);

      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId,
        kind: "execution.stop_requested",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { runnerOnline: online }
      });

      // A Stop settles the questions the turn was blocked on, in the same
      // transaction that decides it. Waiting for the runner's terminal report
      // would leave the room saying *Needs approval* about a turn a participant
      // has already ended, and would let a decision made in that window be
      // enqueued toward a harness that is being interrupted (D-056).
      await settlePendingApprovals(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId,
        outcome: "cancelled",
        reason: "A participant stopped the execution before this was answered."
      });

      if (!online) {
        // Waiting for a machine that has gone would leave the workstream
        // blocked by the active-execution index with no way back. D-034's
        // honest reading: a lost host ends the execution as an explicit
        // interrupted outcome, never a silent stall.
        await client.query(
          `update executions
              set state = 'interrupted', ended_at = now(),
                  exit_outcome = 'interrupted', failure_reason = $2
            where exe_id = $1`,
          [executionId, RUNNER_GONE]
        );
        await recordEvent(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          executionId,
          kind: "execution.interrupted",
          actorKind: "system",
          actorId: "control-plane",
          payload: { reason: RUNNER_GONE }
        });
        return;
      }

      await client.query("update executions set state = 'stopping' where exe_id = $1", [executionId]);
      if (runnerId) {
        await enqueueCommand(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          executionId,
          runnerId,
          kind: "stop_execution",
          payload: { executionId },
          idempotencyKey: `stop:${executionId}`
        });
      }
    });
    return { ok: true };
  });

  /**
   * Declaring a turn dead after a stop went unanswered (D-111). Not a second
   * Stop: it is refused outright while the ordinary stop still has a claim to
   * work — the execution must already be `stopping`, and either the stop must
   * have gone unanswered past its grace or the machine must have gone quiet.
   * What it does then is exactly what the runner-gone path has always done:
   * an explicit, attributed `interrupted` outcome that frees the lane. If the
   * machine was partitioned rather than dead, its process may still finish on
   * that laptop — every later report is recorded but changes nothing, which
   * is the same honesty the offline-stop path already accepted.
   */
  app.post("/missions/:missionId/execution/force-interrupt", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = StopInputSchema.safeParse(request.body ?? {});
    if (!body.success) return deps.sendError(reply, 400, "bad_request", "Malformed request.");
    const access = await missionAccess(deps.db, ctx, params.data.missionId, body.data.workstreamId ?? null);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    requireCapability(access, "force_interrupt");
    const workstreamId = access.workstreamId;
    if (!workstreamId) return deps.sendError(reply, 409, "nothing_running", "Nothing is running to interrupt.");

    const refusal = await withTransaction(deps.db, async (client): Promise<string | null> => {
      const running = await client.query(
        "select exe_id, state, session_id, access from executions where wst_id = $1 and state = any($2::text[]) for update",
        [workstreamId, ACTIVE_EXECUTION_STATES]
      );
      const rows = running.rows as { exe_id: string; state: string; session_id: string; access: string }[];
      const row = body.data.sessionId
        ? rows.find((candidate) => candidate.session_id === body.data.sessionId)
        : (rows.find((candidate) => candidate.access === "write") ?? (rows.length === 1 ? rows[0] : undefined));
      if (!row) return "Nothing is running to interrupt.";
      if (row.state !== "stopping") {
        return "Stop it first — declaring a turn dead is for a stop that went unanswered.";
      }

      const runner = await activeRunner(client, workstreamId);
      const online = runnerOnline(runner?.lastSeenAt ?? null);

      const askedAt = await lastEventAt(client, row.exe_id, "execution.stop_requested");
      const unanswered = askedAt !== null && Date.now() - askedAt.getTime() >= FORCE_INTERRUPT_AFTER_MS;
      if (online && !unanswered) {
        return "The stop is still being delivered and the machine is connected — give it a minute before declaring the turn dead.";
      }

      const reason = `${ctx.login} declared the turn dead after the stop went unanswered.`;
      const moved = await client.query(
        `update executions
            set state = 'interrupted', ended_at = now(),
                exit_outcome = 'interrupted', failure_reason = $2
          where exe_id = $1 and state = 'stopping'`,
        [row.exe_id, reason]
      );
      if (moved.rowCount === 0) return "The turn already ended.";
      await recordEvent(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId: row.exe_id,
        kind: "execution.interrupted",
        actorKind: "user",
        actorId: ctx.userId,
        actorLogin: ctx.login,
        causeLeaseId: access.leaseId,
        payload: { reason }
      });
      // The stop already settled the turn's questions; a straggler asked in
      // the window settles now, in the same transaction that ends the turn.
      await settlePendingApprovals(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        executionId: row.exe_id,
        outcome: "cancelled",
        reason: "The turn was declared dead before this was answered."
      });
      return null;
    });
    if (refusal) return deps.sendError(reply, 409, "not_forceable", refusal);
    return { ok: true };
  });

  app.get("/file-changes/:changeId", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = ChangeParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed change id.");
    const result = await deps.db.query(
      "select chg_id, mission_id, path, diff, is_binary, truncated from file_changes where chg_id = $1",
      [params.data.changeId]
    );
    const row = result.rows[0];
    if (!row) return deps.sendError(reply, 404, "not_found", "No such change.");
    // A change id is not a capability: the viewer must participate in the
    // mission the change belongs to.
    const access = await missionAccess(deps.db, ctx, row.mission_id as string);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such change.");

    const response: FileDiffResponse = {
      changeId: row.chg_id as string,
      path: row.path as string,
      diff: (row.diff as string | null) ?? null,
      binary: Boolean(row.is_binary),
      truncated: Boolean(row.truncated)
    };
    return response;
  });
}
