import {
  EnabledMachineMcpServersSchema,
  EnabledMcpServersSchema,
  EnabledSkillsSchema,
  EnabledGlobalSkillsSchema,
  EnabledSlashCommandsSchema,
  type Workstream
} from "@novus/contracts";
import type { Queryable } from "./db.ts";

/**
 * OWNER: the Workstream (lane) aggregate's reads — the one row shape every
 * module maps through, and the lane→repository lookup every publishing and
 * cloning path shares. Writes stay with the verbs that own them (creation in
 * missions.ts, forking in approaches.ts); what lives here is the knowledge of
 * what a lane row *is*, so it cannot exist twice and drift (it did: two
 * different `toWorkstream` mappers, and the lane→repository join written four
 * ways).
 */

export function toWorkstream(row: Record<string, unknown>): Workstream {
  return {
    workstreamId: row.wst_id as string,
    missionId: row.mission_id as string,
    name: row.name as string,
    baseRef: row.base_ref as string,
    baseSha: row.base_sha as string,
    missionBranch: row.mission_branch as string,
    branchStatus: row.branch_status as Workstream["branchStatus"],
    branchError: (row.branch_error as string | null) ?? null,
    // What makes this lane an approach rather than the one the mission started
    // with (D-074). Absent on every mission that never forked.
    approach: Boolean(row.approach_flag),
    intent: (row.intent as string | null) ?? null,
    forkedFromWorkstreamId: (row.forked_from_wst_id as string | null) ?? null,
    originSha: (row.origin_sha as string | null) ?? null,
    remoteHeadSha: (row.remote_head_sha as string | null) ?? null,
    // The lane's standing answer policy (D-115); the DB CHECK owns validity,
    // and a pre-migration row reads manual — what it always was.
    permissionProfile:
      (row.permission_profile as Workstream["permissionProfile"] | null) ?? "manual",
    // The skills a person enabled on this lane (D-118); malformed or
    // pre-migration reads as none, never as a wider grant.
    enabledSkills: EnabledSkillsSchema.catch([]).parse(row.enabled_skills ?? []),
    // The slash commands (D-187), same posture.
    enabledSlashCommands: EnabledSlashCommandsSchema.catch([]).parse(
      row.enabled_slash_commands ?? []
    ),
    // The machine skills a person enabled (D-191), same posture.
    enabledGlobalSkills: EnabledGlobalSkillsSchema.catch([]).parse(
      row.enabled_global_skills ?? []
    ),
    // And the MCP servers (D-119), same posture.
    enabledMcpServers: EnabledMcpServersSchema.catch([]).parse(row.enabled_mcp_servers ?? []),
    // The machine servers (D-198), same posture.
    enabledMachineMcpServers: EnabledMachineMcpServersSchema.catch([]).parse(
      row.enabled_machine_mcp ?? []
    )
  };
}

export async function listWorkstreams(db: Queryable, missionId: string): Promise<Workstream[]> {
  const result = await db.query(
    `select * from workstreams where mission_id = $1 order by created_at, wst_id`,
    [missionId]
  );
  return result.rows.map(toWorkstream);
}

export interface LaneRepository {
  missionId: string;
  missionBranch: string;
  provider: "github" | "local";
  providerRepoId: string;
  /** The repository row's owning organization — the clone path's guard that a
   *  runner can only mint credentials for its own org's lane. */
  repoOrgId: string;
}

/**
 * The lane and the repository its branch lives in, joined once. Null means no
 * such lane — the caller says "no workstream" in its own words.
 */
export async function laneRepository(
  q: Queryable,
  workstreamId: string
): Promise<LaneRepository | null> {
  const result = await q.query(
    `select w.mission_id, w.mission_branch, repo.provider, repo.provider_repo_id,
            repo.org_id as repo_org_id
       from workstreams w
       join repositories repo on repo.repo_id = w.repo_id
      where w.wst_id = $1`,
    [workstreamId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    missionId: row.mission_id as string,
    missionBranch: row.mission_branch as string,
    provider: row.provider as "github" | "local",
    providerRepoId: row.provider_repo_id as string,
    repoOrgId: row.repo_org_id as string
  };
}
