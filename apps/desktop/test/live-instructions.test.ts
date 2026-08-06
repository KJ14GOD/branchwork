import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent } from "@novus/contracts";
import { startTurn, type TurnResult } from "../electron/execution";

/**
 * The project's own instructions, against the **real Claude Code binary**
 * (D-064), through Novus's own turn path rather than a hand-rolled CLI call.
 *
 * Opt-in, because it spends the machine owner's Claude quota:
 *
 *   NOVUS_LIVE_CLAUDE=1 pnpm --filter @novus/desktop exec vitest run test/live-instructions.test.ts
 *
 * Why this needs a live run at all: `execution-approval.test.ts` proves Novus
 * *passes* `--append-system-prompt-file`, which is a fact about argv. Whether
 * the model then actually has the file in context is a fact about the CLI, and
 * only the CLI can answer it — which matters because the flag exists to undo
 * the one thing `--setting-sources ""` cost (D-062).
 *
 * The trap this test avoids: with tools available the agent can simply *read*
 * `CLAUDE.md` and answer correctly, which proves nothing about the system
 * prompt. So the assertion is two-part — the codeword comes back **and** the
 * turn used no tools at all. A file that was never opened cannot have been the
 * source.
 */

const LIVE = process.env.NOVUS_LIVE_CLAUDE === "1";
const MISSION_BRANCH = "novus/m-live1nst";
const MISSION_ID = "msn_liveinstructions";
/** Worktrees are keyed by the lane, not the mission (D-074). */
const WORKSTREAM_ID = "wst_liveinstructions";
/** The cheapest model on the allowlist; this is about context, not prose. */
const MODEL = "claude-haiku-4-5-20251001";
/** Nothing a model could produce by chance, and nothing in the repository. */
const CODEWORD = "ZEPHYRLINE";

let repo: string;
let worktreeRoot: string;

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)
    );
  });

function run(direction: string): { events: RunnerEvent[]; finished: Promise<TurnResult> } {
  const events: RunnerEvent[] = [];
  const turn = startTurn({
    executionId: "exe_liveinstructions",
    missionId: MISSION_ID,
    workstreamId: WORKSTREAM_ID,
    repositoryPath: repo,
    worktreeRoot,
    missionBranch: MISSION_BRANCH,
    direction,
    model: MODEL,
    effort: "low",
    resumeSessionId: null,
    announceStart: true,
    fakeHarness: false,
    secretValues: () => [],
    emit: (event) => events.push(event)
  });
  return { events, finished: turn.finished };
}

beforeAll(async () => {
  if (!LIVE) return;
  repo = mkdtempSync(join(tmpdir(), "novus-live-instructions-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "novus-live-instructions-worktrees-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@local"]);
  writeFileSync(join(repo, "README.md"), "# live instructions fixture\n");
  // Committed, because a project's instructions are repository content that
  // arrives with the worktree — not something Novus writes into it.
  writeFileSync(
    join(repo, "CLAUDE.md"),
    `# Project instructions\n\nThe project codeword is ${CODEWORD}.\nIf anyone asks for the codeword, reply with that single word and nothing else.\n`
  );
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

describe.skipIf(!LIVE)("the project's instructions reach the real harness", () => {
  it("answers from CLAUDE.md without opening a single file", async () => {
    const live = run(
      "What is the project codeword? Answer with the single word and nothing else. Do not use any tools."
    );
    const result = await live.finished;

    const spoken = live.events
      .filter((event) => event.kind === "harness.text")
      .map((event) => (event.payload as { text: string }).text)
      .join("\n");
    expect(spoken).toContain(CODEWORD);

    // The half that makes it proof rather than a coincidence: no tool ran, so
    // the file was never read — the only way the model could know is the system
    // prompt Novus appended.
    expect(live.events.filter((event) => event.kind === "harness.tool")).toEqual([]);
    expect(result.terminal.kind).toBe("execution.completed");
  }, 240_000);

  it("reports what the turn cost, from the harness's own figures", async () => {
    const live = run("Reply with the single word: ok.");
    await live.finished;

    const usage = live.events.find((event) => event.kind === "harness.usage");
    expect(usage).toBeTruthy();
    const payload = usage?.payload as {
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
      durationMs: number | null;
    };
    // Claims, not billing: what is asserted is that real figures arrive, not
    // what they are (ARCHITECTURE.md#harness-protocol).
    expect(payload.outputTokens).toBeGreaterThan(0);
    expect(payload.durationMs).toBeGreaterThan(0);
    expect(payload.costUsd).not.toBeNull();
  }, 240_000);
});
