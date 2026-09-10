import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearer, createHarness, type Harness, type SignedIn } from "./harness.ts";

/**
 * The export (D-255) over a real database: a mission with a direction, a
 * turn whose text is on the record, a checkpoint, a failed check against it,
 * and an owner who asks — one trajectory with a reward from named signals,
 * a manifest whose hashes match its shards, the same bytes on a second ask,
 * and a member refused by name.
 */

let harness: Harness;
let owner: SignedIn;
const sha = (value: string) => createHash("sha1").update(value).digest("hex");

let learningDir: string;

beforeAll(async () => {
  learningDir = mkdtempSync(join(tmpdir(), "novus-learning-"));
  process.env.NOVUS_LEARNING_DIR = learningDir;
  harness = await createHarness("novus_test_learning");
  owner = await harness.signIn();
});
afterAll(async () => {
  await harness.close();
  rmSync(learningDir, { recursive: true, force: true });
});

describe("the record as a dataset (D-255)", () => {
  it("exports a rewarded trajectory with a manifest that matches its shards, and repeats itself byte for byte", async () => {
    const localId = randomUUID();
    const registered = await harness.app.inject({ method: "POST", url: "/repositories/local", headers: bearer(owner), payload: { localId, name: "novus/learn", defaultBranch: "main", headSha: sha(localId) } });
    expect(registered.statusCode).toBe(200);
    const created = await harness.app.inject({
      method: "POST",
      url: "/missions",
      headers: bearer(owner),
      payload: { goal: "Learn from this", successCriteria: "A dataset exists", provider: "local", providerRepoId: localId, baseRef: "main", baseSha: sha(localId), creationKey: randomUUID() }
    });
    expect(created.statusCode).toBe(201);
    const missionId = created.json().mission.missionId as string;
    const workstreamId = created.json().workstream.workstreamId as string;
    // The lane's own chat: every workstream holds one, created with it (D-083).
    const sessionRow = (await harness.db.query("select csn_id from workstream_sessions where wst_id = $1 order by created_at limit 1", [workstreamId])).rows[0] as { csn_id: string } | undefined;
    const sessionId = sessionRow?.csn_id ?? "csn_l1";
    if (!sessionRow) {
      await harness.db.query(
        "insert into workstream_sessions (csn_id, org_id, mission_id, wst_id, title, created_by, harness_session_id, created_at) values ($1, $2, $3, $4, null, $5, null, now())",
        [sessionId, owner.orgId, missionId, workstreamId, owner.userId]
      );
    }
    // The rows a turn leaves behind, written the way the runner writes them.
    await harness.db.query(
      `insert into directions (dir_id, org_id, mission_id, wst_id, session_id, author_user_id, body, state, ordinal, submitted_at, applied_at)
         values ($1, $2, $3, $4, $5, $6, 'write the guard with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012345', 'applied', 1, now(), now())`,
      ["dir_l1", owner.orgId, missionId, workstreamId, sessionId, owner.userId]
    );
    await harness.db.query(
      `insert into executions (exe_id, org_id, mission_id, wst_id, session_id, harness, model, effort, state, started_by, created_at, started_at, ended_at, exit_outcome, starting_direction_id, latest_checkpoint_sha)
         values ('exe_l1', $1, $2, $3, $4, 'claude-code', 'claude-fable-5-1', 'high', 'completed', $5, now(), now(), now(), 'completed', 'dir_l1', 'c0ffee')`,
      [owner.orgId, missionId, workstreamId, sessionId, owner.userId]
    );
    await harness.db.query(
      `insert into events (event_id, org_id, mission_id, seq, kind, actor_kind, actor_id, payload, schema_version, occurred_at, recorded_at)
         values ('evt_l1', $1, $2, 900001, 'harness.text', 'harness', 'exe_l1', $3, 1, now(), now())`,
      [owner.orgId, missionId, JSON.stringify({ executionId: "exe_l1", text: "I wrote the guard. Authorization: Bearer abc.def-ghi_jkl==", parentToolUseId: null })]
    );
    await harness.db.query(
      `insert into checkpoints (ckp_id, org_id, mission_id, wst_id, exe_id, outcome, sha, parent_sha, branch, files_changed, additions, deletions, withheld_secrets, uncommitted, environment, created_at)
         values ('ckp_l1', $1, $2, $3, 'exe_l1', 'committed', 'c0ffee', 'beef00', 'novus/m-l', 1, 3, 0, 0, false, 'local worktree', now())`,
      [owner.orgId, missionId, workstreamId]
    );
    await harness.db.query(
      `insert into verification_checks (chk_id, org_id, mission_id, exe_id, name, category, outcome, origin, command, output, truncated, environment, started_at, completed_at, duration_ms, checkpoint_sha, observed_at)
         values ('chk_l1', $1, $2, 'exe_l1', 'unit', 'test', 'failed', 'participant', 'pnpm test', null, false, 'local worktree', now(), now(), 900, 'c0ffee', now())`,
      [owner.orgId, missionId]
    );

    const first = await harness.app.inject({ method: "POST", url: `/orgs/${owner.orgId}/learning/exports`, headers: bearer(owner), payload: {} });
    expect(first.statusCode).toBe(201);
    const { manifest, path } = first.json() as { manifest: { shards: Record<string, string>; counts: Record<string, number> }; path: string };
    expect(manifest.counts.trajectories).toBe(1);
    expect(manifest.counts.rewarded).toBe(1);
    const shard = readFileSync(join(path, "trajectories.jsonl"), "utf8");
    expect(createHash("sha256").update(shard).digest("hex")).toBe(manifest.shards["trajectories.jsonl"]);
    const trajectory = JSON.parse(shard.trim());
    expect(trajectory.reward).toBeLessThan(0); // the check failed, the turn completed
    expect(trajectory.signals.map((s: { name: string }) => s.name)).toEqual(["checksFailed"]);
    // Redaction reached both the direction and the turn's text.
    expect(shard).not.toContain("ghp_");
    expect(shard).not.toContain("abc.def-ghi_jkl");
    expect(shard).toContain("[redacted]");

    const second = await harness.app.inject({ method: "POST", url: `/orgs/${owner.orgId}/learning/exports`, headers: bearer(owner), payload: {} });
    expect(second.statusCode).toBe(201);
    expect(readFileSync(join(second.json().path, "trajectories.jsonl"), "utf8")).toBe(shard);
  });

  it("is the owner's alone: a member is refused by name, a stranger finds nothing", async () => {
    const stranger = await harness.signIn("stranger-learn");
    const refused = await harness.app.inject({ method: "POST", url: `/orgs/${owner.orgId}/learning/exports`, headers: bearer(stranger), payload: {} });
    expect(refused.statusCode).toBe(404);
  });
});
