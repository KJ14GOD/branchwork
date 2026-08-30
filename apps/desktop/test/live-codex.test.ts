import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_MODELS, type RunnerEvent } from "@novus/contracts";
import { spawn } from "node:child_process";
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
  it("the contract's model list matches the CLI's own model/list answer", async () => {
    // Vendor drift is real (the first shipped list was stale within a day):
    // the CLI's own enumeration is the only honest source, so this stamp
    // fails the probe when the menu would lie.
    const listed = await new Promise<string[]>((resolve, reject) => {
      const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      const write = (line: object) => child.stdin?.write(`${JSON.stringify(line)}\n`);
      write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "novus-probe", title: "probe", version: "0" } } });
      setTimeout(() => {
        write({ jsonrpc: "2.0", method: "initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} });
      }, 600);
      setTimeout(() => {
        child.kill();
        for (const line of out.split("\n")) {
          try {
            const parsed = JSON.parse(line) as { id?: number; result?: { data?: { id: string }[] } };
            if (parsed.id === 2 && parsed.result?.data) {
              resolve(parsed.result.data.map((entry) => entry.id));
              return;
            }
          } catch {
            /* noise */
          }
        }
        reject(new Error("model/list never answered"));
      }, 6000);
    });
    for (const model of CODEX_MODELS) expect(listed).toContain(model.id);
  }, 30_000);

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
          model: "gpt-5.6-sol",
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
