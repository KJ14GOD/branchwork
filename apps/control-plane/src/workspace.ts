import type { FastifyInstance, FastifyReply } from "fastify";
import { DeclaredCommandSchema, WorkspaceCommandInputSchema, type DeclaredCommand, type ProcessKind } from "@novus/contracts";
import { z } from "zod";
import type pg from "pg";
import { missionAccess, require as requireCapability } from "./authz.ts";
import type { MissionAccess } from "./authz.ts";
import { withTransaction } from "./db.ts";
import { recordEvent } from "./events.ts";
import { newCommandId, newWorkspaceId } from "./ids.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: the workspace runtime's control-plane half (D-040 … D-042). Paths:
 *
 *   POST /missions/:missionId/workspace/command   (setup | run | verification)
 *   POST /missions/:missionId/workspace/stop
 *
 * There is deliberately no shell path. A remote controller may invoke the
 * commands the project itself declared and nothing else, which is why the
 * absence is structural rather than a check someone could forget.
 *
 * This module authorizes and enqueues; it never learns how to build anything.
 * What a command *is* lives in the repository's `.novus/settings.toml` and is
 * resolved by the runner (ARCHITECTURE.md#workspace-configuration-environments-and-processes).
 */

/**
 * The commands this workspace's runner last published (D-043).
 *
 * The control plane still does not know how to build anything: it never parses
 * `.novus/settings.toml` and cannot. What it holds is a list a runner handed it,
 * which it hands back verbatim with the command it enqueues — so the runner runs
 * the snapshot a participant authorized rather than re-reading a file that a
 * harness turn may have edited in between.
 */
async function declaredFor(client: pg.PoolClient, workstreamId: string): Promise<DeclaredCommand[]> {
  const result = await client.query("select declared from workspaces where wst_id = $1", [workstreamId]);
  const parsed = DeclaredCommandSchema.array().safeParse(result.rows[0]?.declared ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * Which declared command a request names. Setup has exactly one; a run or a
 * check with no name means the project's default, which is the first the runner
 * published of that kind, because that is the order the room shows them in.
 */
function pick(declared: DeclaredCommand[], kind: ProcessKind, name: string | null): DeclaredCommand | null {
  const ofKind = declared.filter((command) => command.kind === kind);
  if (name === null) return ofKind[0] ?? null;
  return ofKind.find((command) => command.name === name) ?? null;
}

/** A state the database should make impossible; raised rather than papered over. */
export class WorkspaceStateError extends Error {
  readonly code = "workspace_state";
}

/** The runner command each declared kind becomes. There is no shell kind, so
 *  there is nothing here to authorize incorrectly (D-042). */
const COMMAND_KIND: Record<ProcessKind, "run_setup" | "run_command" | "run_verification"> = {
  setup: "run_setup",
  run: "run_command",
  verification: "run_verification"
};

const MissionParamsSchema = z.object({ missionId: z.string().startsWith("msn_") });
/** The same name rule the declared command carries — taken from the contract
 *  rather than restated, so the two can never drift. */
const CommandNameSchema = WorkspaceCommandInputSchema.shape.name.unwrap();
const StopInputSchema = z.object({ name: CommandNameSchema });

/** What a request became. `already_queued` is a double-click, not an error. */
type Enqueued = "enqueued" | "already_queued" | "no_runner" | "not_declared";

/**
 * The machine this workstream's work happens on. The rule matches the one
 * dispatch uses (executions.ts): registered, unrevoked, unexpired. Liveness of
 * the *connection* is a separate question the room answers with the
 * `runner_offline` overlay; refusing a command because a heartbeat is a few
 * seconds stale would make a freshly launched desktop look broken.
 */
async function liveRunner(client: pg.PoolClient, workstreamId: string): Promise<string | null> {
  const result = await client.query(
    `select runner_id from runners
      where wst_id = $1 and revoked_at is null and expires_at > now()
      order by created_at desc limit 1`,
    [workstreamId]
  );
  return (result.rows[0]?.runner_id as string | undefined) ?? null;
}

/**
 * The workstream's workspace row, created `unconfigured` on first touch. A
 * workspace exists as soon as anything addresses it: the room then says
 * *Workspace needs setup* honestly instead of showing nothing at all
 * (PRODUCT.md#the-mission-state-model). Shared with the ingest path so the
 * `workspaces` table has exactly one writer of new rows.
 */
export async function ensureWorkspace(
  client: pg.PoolClient,
  args: { orgId: string; missionId: string; workstreamId: string; runnerId: string | null }
): Promise<string> {
  const inserted = await client.query(
    `insert into workspaces (wsp_id, org_id, mission_id, wst_id, runner_id, readiness)
     values ($1, $2, $3, $4, $5, 'unconfigured')
     on conflict (wst_id) do nothing
     returning wsp_id`,
    [newWorkspaceId(), args.orgId, args.missionId, args.workstreamId, args.runnerId]
  );
  const fresh = inserted.rows[0]?.wsp_id as string | undefined;
  if (fresh !== undefined) return fresh;
  const existing = await client.query("select wsp_id from workspaces where wst_id = $1", [
    args.workstreamId
  ]);
  const found = existing.rows[0]?.wsp_id as string | undefined;
  if (found === undefined) {
    throw new WorkspaceStateError("The workspace for this workstream could not be resolved.");
  }
  return found;
}

/**
 * Enqueues one declared command toward the host runner.
 *
 * The idempotency key is deliberately **not** the direction-style stable key.
 * `apply:${directionId}` is stable because a direction is applied exactly once
 * for all time; a declared command is the opposite — the whole point of a
 * saved verification command is running it again after the next change. A
 * stable key would let a check run once per workstream and then silently
 * collapse into the row that already exists. So the key carries a fresh
 * command id, and the *double-click* case — which a stable key would otherwise
 * have handled — is answered by state instead: an unsettled command of the
 * same kind and name is reused rather than duplicated. Once it completes or
 * fails, the next request is a genuinely new command with a new key.
 */
async function enqueueWorkspaceCommand(
  client: pg.PoolClient,
  args: {
    orgId: string;
    missionId: string;
    workstreamId: string;
    runnerId: string;
    kind: "run_setup" | "run_command" | "run_verification" | "stop_command";
    name: string | null;
    /** The exact command being authorized. Null only for `stop_command`, which
     *  names a live process rather than a command line. */
    command: DeclaredCommand | null;
    requestedBy: string;
  }
): Promise<Enqueued> {
  const pending = await client.query(
    `select cmd_id from runner_commands
      where wst_id = $1 and kind = $2 and payload->>'name' is not distinct from $3
        and state in ('pending', 'delivered', 'acknowledged')
      limit 1`,
    [args.workstreamId, args.kind, args.name]
  );
  if (pending.rows[0] !== undefined) return "already_queued";

  const commandId = newCommandId();
  await client.query(
    `insert into runner_commands (cmd_id, org_id, mission_id, wst_id, exe_id, runner_id, kind,
                                  payload, idempotency_key, state)
     values ($1, $2, $3, $4, null, $5, $6, $7, $8, 'pending')`,
    [
      commandId,
      args.orgId,
      args.missionId,
      args.workstreamId,
      args.runnerId,
      args.kind,
      // The requester travels with the command because a check has to record
      // who asked for it: a participant-run check is attributed evidence, not
      // an anonymous green row (D-037). `exe_id` is null above — a run command
      // is not an execution. The snapshot travels with it because the runner
      // must execute what was authorized, not what the file says later (D-043).
      JSON.stringify({ name: args.name, command: args.command, requestedBy: args.requestedBy }),
      `${args.kind}:${args.name ?? "*"}:${commandId}`
    ]
  );
  return "enqueued";
}

/** Resolves the caller's standing, or replies and returns null. A
 *  non-participant is told the mission does not exist — never that they lack
 *  the capability, which would make a mission id probeable (D-036). */
async function authorizeCommand(
  deps: RouteDeps,
  ctx: { userId: string },
  missionId: string,
  reply: FastifyReply
): Promise<MissionAccess | null> {
  const access = await missionAccess(deps.db, ctx, missionId);
  if (!access) {
    await deps.sendError(reply, 404, "not_found", "No such mission in your organization.");
    return null;
  }
  // Server-enforced, every time: controlling a mission is not owning the host
  // machine, and the interface hiding a button is not enforcement (D-042,
  // AGENTS.md rule 13).
  requireCapability(access, "workspace.command");
  return access;
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/missions/:missionId/workspace/command", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = WorkspaceCommandInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(
        reply,
        422,
        "invalid_command",
        body.error.issues[0]?.message ?? "That isn't a command this project declared."
      );
    }
    const access = await authorizeCommand(deps, ctx, params.data.missionId, reply);
    if (!access) return;
    const workstreamId = access.workstreamId;
    if (!workstreamId) {
      return deps.sendError(reply, 409, "no_workstream", "This mission has no workstream yet.");
    }

    const outcome = await withTransaction(deps.db, async (client) => {
      // The same per-mission ordering point the event log uses, so two clicks
      // racing cannot both pass the unsettled-command check
      // (ARCHITECTURE.md#authorization: concurrent commands resolve
      // deterministically).
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);

      // No machine, no command. Enqueueing into the void would leave the room
      // claiming work was requested that nothing can ever pick up.
      const runnerId = await liveRunner(client, workstreamId);
      if (!runnerId) return "no_runner" as const;

      await ensureWorkspace(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        runnerId
      });

      const name = body.data.name ?? null;
      // Pinned here, at the moment of authorization. A name that this project
      // does not declare is refused rather than sent onward hopefully — and a
      // workspace whose configuration has never been read has nothing to pin,
      // which is also a refusal rather than a guess (D-043).
      const command = pick(await declaredFor(client, workstreamId), body.data.kind, name);
      if (command === null) return "not_declared" as const;

      const enqueued = await enqueueWorkspaceCommand(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        runnerId,
        kind: COMMAND_KIND[body.data.kind],
        name: command.name,
        command,
        requestedBy: ctx.userId
      });
      if (enqueued === "enqueued") {
        await recordEvent(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          kind: "workspace.command_requested",
          actorKind: "user",
          actorId: ctx.userId,
          actorLogin: ctx.login,
          causeLeaseId: access.leaseId,
          // The digest is what makes the record answer "which command was
          // this?" months later, when the file has moved on.
          payload: { kind: body.data.kind, name: command.name, digest: command.digest }
        });
      }
      return enqueued;
    });

    if (outcome === "no_runner") {
      return deps.sendError(
        reply,
        409,
        "no_runner",
        "No machine is running this workstream, so there's nothing to run the command on."
      );
    }
    if (outcome === "not_declared") {
      return deps.sendError(
        reply,
        409,
        "not_declared",
        "This project has not declared that command, so there is nothing Novus can honestly run."
      );
    }
    return { ok: true };
  });

  app.post("/missions/:missionId/workspace/stop", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = MissionParamsSchema.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed mission id.");
    const body = StopInputSchema.safeParse(request.body);
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_command", "Name the command to stop.");
    }
    // Stopping is the same authority as starting: it acts on the same machine.
    const access = await authorizeCommand(deps, ctx, params.data.missionId, reply);
    if (!access) return;
    const workstreamId = access.workstreamId;
    if (!workstreamId) {
      return deps.sendError(reply, 409, "no_workstream", "This mission has no workstream yet.");
    }

    const outcome = await withTransaction(deps.db, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [access.missionId]);
      const runnerId = await liveRunner(client, workstreamId);
      if (!runnerId) return "no_runner" as const;
      const enqueued = await enqueueWorkspaceCommand(client, {
        orgId: access.orgId,
        missionId: access.missionId,
        workstreamId,
        runnerId,
        kind: "stop_command",
        name: body.data.name,
        // Stopping names a live process rather than a command line, so there is
        // nothing to pin: what it does is bounded by what is already running.
        command: null,
        requestedBy: ctx.userId
      });
      if (enqueued === "enqueued") {
        await recordEvent(client, {
          orgId: access.orgId,
          missionId: access.missionId,
          workstreamId,
          kind: "workspace.stop_requested",
          actorKind: "user",
          actorId: ctx.userId,
          actorLogin: ctx.login,
          causeLeaseId: access.leaseId,
          payload: { name: body.data.name }
        });
      }
      return enqueued;
    });

    if (outcome === "no_runner") {
      return deps.sendError(
        reply,
        409,
        "no_runner",
        "No machine is running this workstream, so there's nothing to stop."
      );
    }
    return { ok: true };
  });
}
