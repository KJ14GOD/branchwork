import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@novus/contracts";
import { startTurn } from "../electron/execution";

/**
 * The plan profile against the **real Claude Code binary** (D-115).
 *
 * Opt-in, because it spends the machine owner's Claude quota:
 *
 *   NOVUS_LIVE_PLAN=1 pnpm --filter @novus/desktop exec vitest run test/live-plan.test.ts
 *
 * Everything else about the plan profile is deterministic evidence: the argv
 * carries `--permission-mode plan` (execution-approval.test.ts, real spawn),
 * and the router denies every privileged act a plan turn asks for
 * (execution.test.ts, the production parser). What no fake can say is how the
 * real model behaves under that flag through Novus's own pipeline — whether it
 * answers with a plan, whether it asks anyway and takes our denial, whether
 * anything at all reaches the worktree. This is one cheap turn that watches.
 *
 * The safety claims are asserted hard: nothing is written, no card is
 * published, the turn ends as an ordinary completion with a reply. Whether
 * the CLI's own plan mode denied internally (zero `approval.policy` events)
 * or asked and took the router's denial (some, each recorded) is genuinely
 * the CLI's business — both are within D-115's contract, and the run prints
 * which one happened so PROGRESS can state what was observed.
 */

const LIVE = process.env.NOVUS_LIVE_PLAN === "1";
const MISSION_BRANCH = "novus/m-live0002";
const MISSION_ID = "msn_liveplan";
const WORKSTREAM_ID = "wst_liveplan";
/** The cheapest model on the allowlist; this test is about policy, not prose. */
const MODEL = "claude-haiku-4-5-20251001";

let repo: string;
let worktreeRoot: string;

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

const worktree = () => join(worktreeRoot, WORKSTREAM_ID);

beforeAll(async () => {
  if (!LIVE) return;
  repo = mkdtempSync(join(tmpdir(), "novus-live-plan-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "novus-live-plan-worktrees-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# live plan fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
}, 60_000);

afterAll(async () => {
  if (!LIVE) return;
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("real Claude Code under the plan profile", () => {
  it("changes nothing, publishes no card, and answers with a plan", async () => {
    const events: RunnerEvent[] = [];
    const turn = startTurn({
      executionId: "exe_liveplan",
      missionId: MISSION_ID,
      workstreamId: WORKSTREAM_ID,
      repositoryPath: repo,
      worktreeRoot,
      missionBranch: MISSION_BRANCH,
      direction:
        "Create a file named PLANNED.md containing a haiku about planning. If you cannot, describe exactly what you would do instead.",
      model: MODEL,
      effort: "low",
      resumeSessionId: null,
      permissionProfile: "plan",
      announceStart: true,
      fakeHarness: false,
      secretValues: () => [],
      emit: (event) => events.push(event)
    });
    const result = await turn.finished;

    // The hard claims: nothing reached the worktree, nothing waited on a
    // person, and the turn ended as an ordinary answer.
    expect(existsSync(join(worktree(), "PLANNED.md"))).toBe(false);
    expect(events.some((event) => event.kind === "approval.requested")).toBe(false);
    expect(turn.pendingApprovals()).toHaveLength(0);
    expect(result.terminal.kind).toBe("execution.completed");
    expect(result.checkpoint?.filesChanged ?? 0).toBe(0);
    // The worktree holds exactly what the branch held: the fixture README and
    // git's own plumbing, nothing the model made.
    expect(readdirSync(worktree()).filter((name) => name !== ".git")).toEqual(["README.md"]);

    // The model spoke: a plan profile that returns silence would be a worse
    // product than one that returns denials.
    const said = events
      .filter((event) => event.kind === "harness.text")
      .map((event) => (event.payload as { text: string }).text)
      .join("\n");
    expect(said.trim().length).toBeGreaterThan(0);

    // The observation this run exists for, stated for the record: which side
    // of the flag did the asking. Both are within D-115's contract.
    const denials = events.filter((event) => event.kind === "approval.policy");
    process.stdout.write(
      `\n[live-plan] permissionProfile=plan on the real CLI: ` +
        `${denials.length} privileged act(s) routed and denied by the router; ` +
        `reply length ${said.trim().length} chars.\n[live-plan] reply begins: ${JSON.stringify(
          said.trim().slice(0, 300)
        )}\n`
    );
    for (const denial of denials) {
      expect((denial.payload as { profile?: string }).profile).toBe("plan");
      expect((denial.payload as { decision?: string }).decision).toBe("denied");
    }
  }, 300_000);
});
