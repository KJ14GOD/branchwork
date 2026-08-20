import {
  EXTENSION_LABEL_NAME_MAX,
  ExtensionLabelColorSchema,
  ExtensionSourceSchema,
  MAX_EXTENSION_LABELS,
  MAX_LABELS_PER_EXTENSION,
  SkillNameSchema,
  type ExtensionLabel,
  type ExtensionLabelAssignment
} from "@novus/contracts";
import { z } from "zod";
import type { Queryable } from "./db.ts";
import { withTransaction } from "./db.ts";
import { missionAccess, require as requireCapability } from "./authz.ts";
import { newExtensionLabelId } from "./ids.ts";

/**
 * OWNER of the extension-label routes (D-195).
 *
 * The distinction this module exists to keep: an extension's **origin** is a
 * collection — intrinsic, exclusive, nobody's to edit — and a **label** is a
 * tag, which is a team's own vocabulary laid over the manifests. Labels are
 * organizational and nothing else: no label changes what a turn is handed,
 * which is why they are guarded by `skills.set` rather than by a tier of their
 * own, and why nothing here is event-recorded — the event log is the record of
 * what happened to the work, not of how somebody filed it.
 *
 *   POST   /missions/:missionId/extension-labels            (create)
 *   PATCH  /missions/:missionId/extension-labels/:labelId   (rename, recolour)
 *   DELETE /missions/:missionId/extension-labels/:labelId   (remove everywhere)
 *   PUT    /missions/:missionId/extension-labels/assignments (set one extension's set)
 *
 * Authorization resolves through the named mission exactly as every other
 * lane-scoped route does, so a label is never written under an organization
 * the caller cannot reach.
 */

const NameSchema = z.string().trim().min(1).max(EXTENSION_LABEL_NAME_MAX);

/** Every label the organization keeps, in name order so the picker is stable. */
export async function listExtensionLabels(db: Queryable, orgId: string): Promise<ExtensionLabel[]> {
  const result = await db.query(
    `select label_id, name, color from extension_labels
      where org_id = $1 order by lower(name) limit $2`,
    [orgId, MAX_EXTENSION_LABELS]
  );
  return result.rows.map((row) => ({
    labelId: row.label_id as string,
    name: row.name as string,
    color: row.color as ExtensionLabel["color"]
  }));
}

/**
 * The assignments that describe *this* mission's extensions: its repository's
 * own, plus the machine ones, which are not repository-scoped. Anything filed
 * against another repository is another project's vocabulary and is not sent.
 */
export async function listExtensionLabelAssignments(
  db: Queryable,
  orgId: string,
  repoId: string | null
): Promise<ExtensionLabelAssignment[]> {
  const result = await db.query(
    `select label_id, source, extension_name from extension_label_assignments
      where org_id = $1 and ((source = 'machine') or (source = 'repo' and scope_key = $2))`,
    [orgId, repoId ?? ""]
  );
  return result.rows.map((row) => ({
    labelId: row.label_id as string,
    source: row.source as ExtensionLabelAssignment["source"],
    name: row.extension_name as string
  }));
}

export function registerExtensionLabelRoutes(
  app: import("fastify").FastifyInstance,
  deps: import("./routes.ts").RouteDeps
): void {
  const missionParams = z.object({ missionId: z.string().startsWith("msn_") });
  const labelParams = missionParams.extend({ labelId: z.string().startsWith("lbl_") });

  /** The mission's own repository, which scopes a repo extension's labels. */
  const repoOf = async (missionId: string): Promise<string | null> => {
    const result = await deps.db.query("select repo_id from missions where mission_id = $1", [
      missionId
    ]);
    return (result.rows[0]?.repo_id as string | null) ?? null;
  };

  app.post("/missions/:missionId/extension-labels", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = missionParams.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed id.");
    const body = z
      .object({ name: NameSchema, color: ExtensionLabelColorSchema })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return deps.sendError(reply, 422, "invalid_label", "A label needs a name and one of the colours.");
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "skills.set");

    const created = await withTransaction(deps.db, async (client) => {
      const existing = await client.query(
        "select label_id, name, color from extension_labels where org_id = $1 and lower(name) = lower($2)",
        [access.orgId, body.data.name]
      );
      // Typing a name that already exists selects it rather than making a
      // second label with the same word on it — the picker's own behavior,
      // enforced here so two people racing cannot produce a duplicate.
      const found = existing.rows[0];
      if (found) {
        return {
          labelId: found.label_id as string,
          name: found.name as string,
          color: found.color as ExtensionLabel["color"]
        };
      }
      const count = await client.query("select count(*)::int as n from extension_labels where org_id = $1", [
        access.orgId
      ]);
      if ((count.rows[0]?.n as number) >= MAX_EXTENSION_LABELS) return null;
      const labelId = newExtensionLabelId();
      await client.query(
        "insert into extension_labels (label_id, org_id, name, color) values ($1, $2, $3, $4)",
        [labelId, access.orgId, body.data.name, body.data.color]
      );
      return { labelId, name: body.data.name, color: body.data.color };
    });
    if (created === null) {
      return deps.sendError(
        reply,
        409,
        "too_many_labels",
        `An organization keeps ${MAX_EXTENSION_LABELS} labels; remove one before adding another.`
      );
    }
    return { label: created };
  });

  app.patch("/missions/:missionId/extension-labels/:labelId", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = labelParams.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed id.");
    const body = z
      .object({ name: NameSchema.optional(), color: ExtensionLabelColorSchema.optional() })
      .safeParse(request.body ?? {});
    if (!body.success || (body.data.name === undefined && body.data.color === undefined)) {
      return deps.sendError(reply, 422, "invalid_label", "Say a new name, a new colour, or both.");
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "skills.set");

    const updated = await withTransaction(deps.db, async (client) => {
      if (body.data.name !== undefined) {
        const clash = await client.query(
          `select 1 from extension_labels
            where org_id = $1 and lower(name) = lower($2) and label_id <> $3`,
          [access.orgId, body.data.name, params.data.labelId]
        );
        if (clash.rowCount) return "taken" as const;
      }
      const result = await client.query(
        `update extension_labels
            set name = coalesce($3, name), color = coalesce($4, color)
          where label_id = $1 and org_id = $2
        returning label_id, name, color`,
        [params.data.labelId, access.orgId, body.data.name ?? null, body.data.color ?? null]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        labelId: row.label_id as string,
        name: row.name as string,
        color: row.color as ExtensionLabel["color"]
      };
    });
    if (updated === "taken") {
      return deps.sendError(reply, 409, "name_taken", "Another label already has that name.");
    }
    if (updated === null) return deps.sendError(reply, 404, "not_found", "No such label.");
    return { label: updated };
  });

  app.delete("/missions/:missionId/extension-labels/:labelId", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = labelParams.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed id.");
    const access = await missionAccess(deps.db, ctx, params.data.missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "skills.set");
    // Assignments cascade: a label that is gone is gone from every row that
    // wore it, rather than leaving ids nothing resolves.
    await deps.db.query("delete from extension_labels where label_id = $1 and org_id = $2", [
      params.data.labelId,
      access.orgId
    ]);
    return { ok: true };
  });

  app.put("/missions/:missionId/extension-labels/assignments", async (request, reply) => {
    const ctx = await deps.requireAuth(request, reply);
    if (!ctx) return;
    const params = missionParams.safeParse(request.params);
    if (!params.success) return deps.sendError(reply, 400, "bad_id", "Malformed id.");
    const body = z
      .object({
        source: ExtensionSourceSchema,
        name: SkillNameSchema,
        labelIds: z.array(z.string().startsWith("lbl_")).max(MAX_LABELS_PER_EXTENSION)
      })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return deps.sendError(
        reply,
        422,
        "invalid_assignment",
        `That is not a label set Novus can apply: an extension wears at most ${MAX_LABELS_PER_EXTENSION}.`
      );
    }
    const access = await missionAccess(deps.db, ctx, params.data.missionId);
    if (!access) return deps.sendError(reply, 404, "not_found", "No such mission.");
    requireCapability(access, "skills.set");
    const scopeKey = body.data.source === "repo" ? ((await repoOf(params.data.missionId)) ?? "") : "";

    const refusal = await withTransaction(deps.db, async (client) => {
      // Every id must be one of this organization's own: a label from
      // somewhere else is not a label here.
      if (body.data.labelIds.length > 0) {
        const owned = await client.query(
          "select label_id from extension_labels where org_id = $1 and label_id = any($2::text[])",
          [access.orgId, body.data.labelIds]
        );
        if (owned.rowCount !== new Set(body.data.labelIds).size) {
          return "unknown" as const;
        }
      }
      // Set semantics, like every other list this product writes.
      await client.query(
        `delete from extension_label_assignments
          where org_id = $1 and source = $2 and scope_key = $3 and extension_name = $4`,
        [access.orgId, body.data.source, scopeKey, body.data.name]
      );
      for (const labelId of new Set(body.data.labelIds)) {
        await client.query(
          `insert into extension_label_assignments
             (label_id, org_id, source, scope_key, extension_name)
           values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [labelId, access.orgId, body.data.source, scopeKey, body.data.name]
        );
      }
      return null;
    });
    if (refusal === "unknown") {
      return deps.sendError(reply, 409, "unknown_label", "One of those labels does not exist here.");
    }
    return { ok: true };
  });
}
