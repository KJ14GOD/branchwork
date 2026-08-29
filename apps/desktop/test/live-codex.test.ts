import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { RunnerEvent } from "@novus/contracts";
import { startTurn } from "../electron/execution";

/**
 * The Codex adapter, in anger (D-230): a real `codex app-server` under the
 * machine's own login runs one supervised turn through the exact production
 * path — the pinned thread (untrusted, user-reviewed, sandboxed), the JSON-RPC
 * dialect, the shared ladder, the checkpoint. Opt-in, because it spends the
 * account's Codex usage:
 *
 *   NOVUS_LIVE_CODEX=1 pnpm --filter @novus/desktop exec vitest run test/live-codex.test.ts
 *
 * This run is what stamps the protocol facts a deterministic build cannot:
 * the model id allowlist, the thread id shape, and the notification grammar
 * as this installed version actually speaks it.
 */

const LIVE = process.env.NOVUS_LIVE_CODEX === "1";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    .toString()
    .trim();

describe.skipIf(!LIVE)("a live Codex turn through the production path (D-230)", () => {
  it(
    "runs one pinned turn: session, speech, a completed result, and a checkpoint",
    async () => {
      const repositoryPath = mkdtempSync(join(tmpdir(), "novus-live-codex-repo-"));
      const worktreeRoot = mkdtempSync(join(tmpdir(), "novus-live-codex-wt-"));
      try {
        git(repositoryPath, ["init", "-b", "main"]);
        writeFileSync(join(repositoryPath, "README.md"), "# live codex probe\n");
        git(repositoryPath, ["add", "-A"]);
        git(repositoryPath, [
          "-c",
          "user.name=Probe",
          "-c",
          "user.email=probe@local",
          "commit",
          "-m",
          "base"
        ]);
        git(repositoryPath, ["branch", "novus/m-livecodex"]);

        const events: RunnerEvent[] = [];
        const turn = startTurn({
          executionId: "exe_livecodex",
          missionId: "msn_livecodex",
          workstreamId: "wst_livecodex",
          repositoryPath,
          worktreeRoot,
          missionBranch: "novus/m-livecodex",
          direction:
            "Reply with exactly one short sentence describing this repository. Do not run commands, do not edit files.",
          harness: "codex",
          model: "gpt-5.1-codex",
          effort: "low",
          resumeSessionId: null,
          announceStart: true,
          fakeHarness: false,
          secretValues: () => [],
          emit: (event) => events.push(event)
        });
        const result = await turn.finished;

        const kinds = events.map((event) => event.kind);
        // The record a supervised turn owes, whatever the dialect.
        expect(kinds).toContain("execution.running");
        const running = events.find((event) => event.kind === "execution.running");
        expect((running?.payload as { harness?: string }).harness).toBe("codex");
        expect(kinds).toContain("harness.session");
        expect(kinds).toContain("harness.text");
        expect(result.sessionId).toBeTruthy();
        expect(result.terminal.kind).toBe("execution.completed");
        // A no-op turn still checkpoints: "nothing changed" is evidence too.
        expect(result.checkpoint?.outcome).toBe("clean");
      } finally {
        rmSync(worktreeRoot, { recursive: true, force: true });
        rmSync(repositoryPath, { recursive: true, force: true });
      }
    },
    300_000
  );
});
