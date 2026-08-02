import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathForLocalRepo } from "./local-repos";

/**
 * Local execution (D-032, D-017): Claude Code runs on this machine, under the
 * user's own harness login — the one place that is legitimate — against a
 * dedicated worktree of the mission branch, never the user's checkout. Every
 * observation is reported upward as a claim; this module is the local runner
 * in embryo. A deterministic fake harness (test-only) exercises the identical
 * pipeline so the chat room is provable without model calls.
 */

const FAKE_HARNESS = process.env.NOVUS_FAKE_HARNESS === "1" && !app.isPackaged;

export interface ReportedEvent {
  kind:
    | "execution.started"
    | "harness.text"
    | "harness.tool"
    | "execution.completed"
    | "execution.failed"
    | "execution.stopped"
    | "workspace.checkpoint";
  payload: Record<string, unknown>;
}

type Emit = (event: ReportedEvent) => void;

const PROBE_PATH = [process.env.PATH ?? "", join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].join(":");

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, ...args], { timeout: 30_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim())
    );
  });
}

/** One worktree per mission, created from the mission branch, reused across turns. */
async function ensureWorktree(localId: string, missionId: string, missionBranch: string): Promise<string> {
  const repoPath = pathForLocalRepo(localId);
  if (!repoPath) throw new Error("This local repository lives on another machine.");
  const worktreeDir = join(app.getPath("userData"), "worktrees", missionId);
  if (existsSync(worktreeDir)) return worktreeDir;
  mkdirSync(join(app.getPath("userData"), "worktrees"), { recursive: true });
  await git(repoPath, ["worktree", "add", worktreeDir, missionBranch]);
  return worktreeDir;
}

/** Attributed checkpoint commit at the turn boundary (D-025); no-op when clean. */
async function checkpoint(worktree: string, direction: string, emit: Emit): Promise<void> {
  const dirty = await git(worktree, ["status", "--porcelain"]);
  if (!dirty) return;
  await git(worktree, ["add", "-A"]);
  const summary = direction.length > 60 ? `${direction.slice(0, 57)}...` : direction;
  await git(worktree, ["-c", "user.name=Novus", "-c", "user.email=novus@local", "commit", "-m", `Checkpoint: ${summary}`]);
  const sha = await git(worktree, ["rev-parse", "HEAD"]);
  emit({ kind: "workspace.checkpoint", payload: { sha, files: dirty.split("\n").length } });
}

const activeTurns = new Map<string, { kill: () => void }>();

export function stopExecution(missionId: string): boolean {
  const active = activeTurns.get(missionId);
  if (!active) return false;
  active.kill();
  return true;
}

export function isRunning(missionId: string): boolean {
  return activeTurns.has(missionId);
}

/**
 * Runs one direction as one harness turn. Resolves when the turn ends;
 * events stream through `emit` as they happen.
 */
export async function runDirection(args: {
  missionId: string;
  localId: string;
  missionBranch: string;
  direction: string;
  emit: Emit;
}): Promise<void> {
  const { missionId, direction, emit } = args;
  if (activeTurns.has(missionId)) throw new Error("An execution is already running for this mission.");

  const worktree = await ensureWorktree(args.localId, missionId, args.missionBranch);
  emit({ kind: "execution.started", payload: { harness: "claude-code", worktree: "mission worktree" } });

  if (FAKE_HARNESS) {
    await runFakeTurn(worktree, direction, missionId, emit);
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn(
      "claude",
      ["-p", direction, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
      { cwd: worktree, env: { ...process.env, PATH: PROBE_PATH }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stopped = false;
    activeTurns.set(missionId, {
      kill: () => {
        stopped = true;
        child.kill("SIGTERM");
      }
    });

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            type: string;
            message?: { content?: { type: string; text?: string; name?: string }[] };
            result?: string;
            is_error?: boolean;
          };
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text?.trim()) {
                emit({ kind: "harness.text", payload: { text: block.text } });
              } else if (block.type === "tool_use") {
                emit({ kind: "harness.tool", payload: { tool: block.name ?? "tool" } });
              }
            }
          }
        } catch {
          /* non-JSON noise on stdout is tolerated */
        }
      }
    });

    child.on("close", async (code) => {
      activeTurns.delete(missionId);
      try {
        await checkpoint(worktree, direction, emit);
      } catch (error) {
        emit({ kind: "harness.text", payload: { text: `Checkpoint failed: ${error instanceof Error ? error.message : "unknown"}` } });
      }
      if (stopped) emit({ kind: "execution.stopped", payload: {} });
      else if (code === 0) emit({ kind: "execution.completed", payload: {} });
      else emit({ kind: "execution.failed", payload: { exitCode: code } });
      resolve();
    });
  });
}

/** Deterministic scripted turn for e2e: same pipeline, no model, real git. */
async function runFakeTurn(worktree: string, direction: string, missionId: string, emit: Emit): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  activeTurns.set(missionId, { kill: () => undefined });
  await wait(120);
  emit({ kind: "harness.text", payload: { text: `Working on: ${direction}` } });
  await wait(120);
  emit({ kind: "harness.tool", payload: { tool: "Write" } });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(worktree, "NOVUS_FAKE_TURN.md"), `# Fake turn\n\n${direction}\n`);
  await wait(120);
  emit({ kind: "harness.text", payload: { text: "Done. I made the change and it's ready to review." } });
  await checkpoint(worktree, direction, emit);
  activeTurns.delete(missionId);
  emit({ kind: "execution.completed", payload: {} });
}
