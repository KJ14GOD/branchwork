import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { redactShapes } from "@novus/contracts";
import { pairsOf, rewardOf, type TrajectorySignals } from "./rewards.ts";

/**
 * The export (D-255): one organization's record as a training dataset. Walks
 * the missions the organization owns, assembles one trajectory per
 * execution from durable rows alone — the same rows the receipt projects —
 * passes every text through the shape redaction, and writes JSONL shards
 * under a manifest that names the schema version, the range, the counts
 * and a SHA-256 per shard. The same range over unchanged rows yields the
 * same bytes: a dataset is reproducible, or it is not a dataset.
 */

export const DATASET_SCHEMA_VERSION = 1;

export interface Trajectory {
  datasetSchema: typeof DATASET_SCHEMA_VERSION;
  missionId: string;
  workstreamId: string;
  executionId: string;
  harness: string;
  model: string | null;
  goal: string;
  /** The chat's own text before this turn, redacted, bounded. */
  transcriptBefore: string;
  /** The direction that started the turn, redacted. */
  direction: string;
  /** The turn's own text and tool summaries, in order, redacted. */
  completion: string;
  checkpointSha: string | null;
  filesChanged: number | null;
  additions: number | null;
  deletions: number | null;
  reward: number | null;
  signals: { name: string; contribution: number }[];
  endedAt: string | null;
}

export interface Pair {
  datasetSchema: typeof DATASET_SCHEMA_VERSION;
  missionId: string;
  goal: string;
  direction: string;
  originSha: string;
  chosenWorkstreamId: string;
  rejectedWorkstreamId: string;
  chosen: string;
  rejected: string;
}

export interface Manifest {
  datasetId: string;
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  orgId: string;
  writtenAt: string;
  fromEvent: string | null;
  toEvent: string | null;
  counts: { missions: number; trajectories: number; pairs: number; rewarded: number };
  shards: Record<string, string>;
}

const BOUND = 200_000;
const clean = (text: string | null | undefined): string => redactShapes((text ?? "").slice(0, BOUND));

interface Row {
  [key: string]: unknown;
}

/** One mission's trajectories and pairs, from its rows. */
export async function exportMission(client: pg.PoolClient, orgId: string, missionId: string): Promise<{ trajectories: Trajectory[]; pairs: Pair[]; lastEventId: string | null }> {
  const mission = (await client.query("select goal from missions where mission_id = $1 and org_id = $2", [missionId, orgId])).rows[0] as Row | undefined;
  if (!mission) return { trajectories: [], pairs: [], lastEventId: null };
  const goal = clean(mission.goal as string);
  const executions = (await client.query(
    `select exe_id, wst_id, harness, model, starting_direction_id, exit_outcome, ended_at, latest_checkpoint_sha
       from executions where mission_id = $1 order by created_at`,
    [missionId]
  )).rows as Row[];
  const directions = new Map<string, string>();
  for (const row of (await client.query("select dir_id, body from directions where mission_id = $1", [missionId])).rows as Row[]) {
    directions.set(row.dir_id as string, clean(row.body as string));
  }
  const events = (await client.query(
    `select event_id, kind, payload, occurred_at, payload->>'executionId' as exe_hint
       from events where mission_id = $1 and kind in ('harness.text','harness.tool','approval.respond','review.approve')
       order by seq`,
    [missionId]
  )).rows as Row[];
  const textsByExecution = new Map<string, string[]>();
  const deniedByExecution = new Map<string, number>();
  for (const event of events) {
    const payload = (event.payload ?? {}) as Row;
    const exe = (payload.executionId as string | undefined) ?? (event.exe_hint as string | undefined) ?? null;
    if (!exe) continue;
    if (event.kind === "harness.text") {
      textsByExecution.set(exe, [...(textsByExecution.get(exe) ?? []), clean(payload.text as string)]);
    } else if (event.kind === "harness.tool") {
      textsByExecution.set(exe, [...(textsByExecution.get(exe) ?? []), `[tool ${clean(payload.tool as string)}${payload.detail ? ` ${clean(payload.detail as string)}` : ""}]`]);
    } else if (event.kind === "approval.respond" && payload.answer === "deny") {
      deniedByExecution.set(exe, (deniedByExecution.get(exe) ?? 0) + 1);
    }
  }
  const checkpoints = (await client.query("select exe_id, sha, files_changed, additions, deletions from checkpoints where mission_id = $1 and sha is not null", [missionId])).rows as Row[];
  const checkpointByExecution = new Map<string, Row>();
  for (const row of checkpoints) checkpointByExecution.set(row.exe_id as string, row);
  const checks = (await client.query("select checkpoint_sha, outcome from verification_checks where mission_id = $1 and checkpoint_sha is not null", [missionId])).rows as Row[];
  const decisions = (await client.query("select wst_id, checkpoint_sha, superseded_at from decisions where mission_id = $1", [missionId])).rows as Row[];
  const revisions = new Set<string>();
  for (const event of events) {
    const payload = (event.payload ?? {}) as Row;
    if (event.kind === "review.approve" && payload.kind === "revision" && typeof payload.workstreamId === "string") revisions.add(payload.workstreamId);
  }
  const pull = (await client.query("select wst_id, state from pull_requests where mission_id = $1 order by created_at desc limit 1", [missionId])).rows[0] as Row | undefined;
  const workstreams = (await client.query("select wst_id, base_sha, approach_flag from workstreams where mission_id = $1", [missionId])).rows as Row[];

  const trajectories: Trajectory[] = [];
  const transcriptSoFar = new Map<string, string[]>();
  for (const execution of executions) {
    const exe = execution.exe_id as string;
    const wst = execution.wst_id as string;
    const checkpoint = checkpointByExecution.get(exe) ?? null;
    const sha = (checkpoint?.sha as string | undefined) ?? null;
    const signals: TrajectorySignals = {
      executionId: exe,
      workstreamId: wst,
      checkpointSha: sha,
      checks: checks.filter((check) => check.checkpoint_sha === sha).map((check) => ({ outcome: check.outcome as "passed" | "failed" | "skipped" | "errored" })),
      approvals: Array.from({ length: deniedByExecution.get(exe) ?? 0 }, () => ({ answer: "deny" as const })),
      decisions: decisions.map((decision) => ({ workstreamId: decision.wst_id as string, checkpointSha: decision.checkpoint_sha as string, supersededAt: (decision.superseded_at as string | null) ?? null })),
      revisionRequested: revisions.has(wst),
      pull: pull && pull.wst_id === wst ? { state: pull.state as "merged" | "closed" | "open" | "draft" } : null,
      exitOutcome: (execution.exit_outcome as "completed" | "failed" | "interrupted" | "stopped" | null) ?? null
    };
    const reward = rewardOf(signals);
    const completion = (textsByExecution.get(exe) ?? []).join("\n").slice(0, BOUND);
    const before = (transcriptSoFar.get(wst) ?? []).join("\n").slice(-BOUND);
    const direction = directions.get(execution.starting_direction_id as string) ?? "";
    trajectories.push({
      datasetSchema: DATASET_SCHEMA_VERSION,
      missionId,
      workstreamId: wst,
      executionId: exe,
      harness: execution.harness as string,
      model: (execution.model as string | null) ?? null,
      goal,
      transcriptBefore: before,
      direction,
      completion,
      checkpointSha: sha,
      filesChanged: (checkpoint?.files_changed as number | null) ?? null,
      additions: (checkpoint?.additions as number | null) ?? null,
      deletions: (checkpoint?.deletions as number | null) ?? null,
      reward: reward.value,
      signals: reward.signals,
      endedAt: (execution.ended_at as string | null) ?? null
    });
    transcriptSoFar.set(wst, [...(transcriptSoFar.get(wst) ?? []), `Direction: ${direction}`, completion]);
  }

  // Pairs: the lanes forked at one checkpoint, their first completion each,
  // against the standing decision.
  const standing = decisions.find((decision) => decision.superseded_at === null) ?? null;
  const lanes = workstreams.map((lane) => {
    const first = trajectories.find((trajectory) => trajectory.workstreamId === lane.wst_id && trajectory.completion.length > 0) ?? null;
    return { workstreamId: lane.wst_id as string, originSha: (lane.base_sha as string) ?? "", completion: first?.completion ?? null, direction: first?.direction ?? "" };
  });
  const pairs: Pair[] = pairsOf(lanes, standing ? { workstreamId: standing.wst_id as string } : null).map((pair) => ({
    datasetSchema: DATASET_SCHEMA_VERSION,
    missionId,
    goal,
    direction: lanes.find((lane) => lane.workstreamId === pair.chosenWorkstreamId)?.direction ?? "",
    ...pair
  }));
  const lastEvent = (await client.query("select event_id from events where mission_id = $1 order by seq desc limit 1", [missionId])).rows[0] as Row | undefined;
  return { trajectories, pairs, lastEventId: (lastEvent?.event_id as string | undefined) ?? null };
}

/** Writes shards and the manifest; the same rows give the same bytes. */
export function writeDataset(root: string, dataset: { datasetId: string; orgId: string; writtenAt: string; missions: number; trajectories: Trajectory[]; pairs: Pair[]; fromEvent: string | null; toEvent: string | null }): Manifest {
  mkdirSync(root, { recursive: true });
  const shards: Record<string, string> = {};
  const write = (name: string, rows: object[]) => {
    const bytes = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
    writeFileSync(join(root, name), bytes);
    shards[name] = createHash("sha256").update(bytes).digest("hex");
  };
  write("trajectories.jsonl", dataset.trajectories);
  write("pairs.jsonl", dataset.pairs);
  const manifest: Manifest = {
    datasetId: dataset.datasetId,
    schemaVersion: DATASET_SCHEMA_VERSION,
    orgId: dataset.orgId,
    writtenAt: dataset.writtenAt,
    fromEvent: dataset.fromEvent,
    toEvent: dataset.toEvent,
    counts: { missions: dataset.missions, trajectories: dataset.trajectories.length, pairs: dataset.pairs.length, rewarded: dataset.trajectories.filter((t) => t.reward !== null).length },
    shards
  };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
