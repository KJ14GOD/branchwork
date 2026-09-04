import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { AuthorizationError } from "./authz.ts";
import { withTransaction } from "./db.ts";
import type { RouteDeps } from "./routes.ts";

/**
 * OWNER: disconnecting a repository from its organization (D-235). Path owned
 * by this module:
 *
 *   POST /repositories/:repoId/disconnect
 *
 * Connecting (registration and listing) stays in server.ts beside the
 * provider routes; this module is the other half of that act and nothing else.
 *
 * Disconnection is not deletion, and this module deliberately offers none.
 * A repository's missions reference it, and their record — receipts,
 * directions, checkpoints — outlives the connection; a mission branch and a
 * folder on somebody's machine are theirs, not the control plane's to reach.
 * One column is set, the repository leaves the organization's rail, and
 * connecting it again (registering the same folder, creating a mission on the
 * same host repository, restoring one of its archived missions) clears it.
 *
 * Refused while any of the repository's missions is still listed — archived
 * ones are the only ones a disconnected repository may hold — so that a
 * project cannot be made to vanish from the rail while work in it can still be
 * opened, directed, or asked a question. Archiving is the person's own act,
 * mission by mission, judged by `mission.archive` and its own refusals.
 *
 * `org.repo.disconnect` is the org owner's (PRODUCT.md#roles-and-capabilities):
 * a member of the organization is refused by name, and someone outside it is
 * told there is no such repository, because a repository id is never a
 * capability.
 */

type Outcome =
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "listed"; count: number }
  | { kind: "already" }
  | { kind: "disconnected" };

export function registerRepositoryRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/repositories/:repoId/disconnect", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const repoId = (request.params as { repoId?: string }).repoId ?? "";

    const outcome = await withTransaction(deps.db, async (client: pg.PoolClient): Promise<Outcome> => {
      // The repository row is locked for the check-then-set: mission creation
      // updates the same row inside its own transaction (upsertRepository), so
      // a mission created while this runs either lands first and is counted,
      // or lands after and reconnects the repository it was created in.
      const found = await client.query(
        `select r.repo_id, r.disconnected_at, om.org_role
           from repositories r
           left join organization_members om on om.org_id = r.org_id and om.user_id = $2
          where r.repo_id = $1
            for update of r`,
        [repoId, ctx.userId]
      );
      const row = found.rows[0];
      if (!row || !row.org_role) return { kind: "not_found" };
      if (row.org_role !== "owner") return { kind: "forbidden" };
      if (row.disconnected_at) return { kind: "already" };

      const listed = await client.query(
        "select count(*)::int as count from missions where repo_id = $1 and archived_at is null",
        [repoId]
      );
      const count = (listed.rows[0]?.count as number | undefined) ?? 0;
      if (count > 0) return { kind: "listed", count };

      await client.query(
        "update repositories set disconnected_at = now(), disconnected_by = $2 where repo_id = $1",
        [repoId, ctx.userId]
      );
      return { kind: "disconnected" };
    });

    switch (outcome.kind) {
      case "not_found":
        return deps.sendError(reply, 404, "not_found", "No such repository.");
      case "forbidden":
        throw new AuthorizationError(
          "forbidden",
          "Only the organization's owner may remove a project."
        );
      case "listed":
        return deps.sendError(
          reply,
          409,
          "missions_listed",
          outcome.count === 1
            ? "This project still lists a mission. Archive it first."
            : `This project still lists ${outcome.count} missions. Archive them first.`
        );
      case "already":
      case "disconnected":
        // Disconnecting a disconnected repository is what the caller asked for
        // either way, exactly as archiving an archived mission is.
        return reply.send({ ok: true });
    }
  });
}
