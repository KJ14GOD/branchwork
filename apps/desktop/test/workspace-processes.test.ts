import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeclaredCommand, RunnerEvent } from "@novus/contracts";
import { createSanitizer } from "../electron/evidence";
import { commandDigest } from "../electron/workspace-commands";
import { gitExec, headSha } from "../electron/workspace-git";
import {
  detectPreviewUrl,
  processIsAlive,
  reconcileRecordedProcesses,
  WorkspaceCommandError,
  WorkspaceProcesses,
  type Invocation
} from "../electron/workspace-processes";

/**
 * The process supervisor against real processes in a real worktree. Real is the
 * point: a process group that a stop does not reach, a secret that survives
 * into an event, or a check that claims a revision it did not run against are
 * all faults a mocked child process would happily pretend not to have.
 */

let repo: string;
let worktree: string;
let userData: string;
let events: RunnerEvent[];
let secrets: string[];
let supervisor: WorkspaceProcesses;

async function git(cwd: string, args: string[]): Promise<string> {
  const outcome = await gitExec(cwd, args);
  if (outcome.code !== 0) throw new Error(outcome.stderr);
  return outcome.stdout.trim();
}

function makeSupervisor(overrides: { worktree?: string; sourceRepo?: string } = {}): WorkspaceProcesses {
  const tree = overrides.worktree ?? worktree;
  return new WorkspaceProcesses({
    workstreamId: "wst_test",
    worktree: tree,
    sourceRepo: overrides.sourceRepo ?? repo,
    git: gitExec,
    sanitize: createSanitizer([
      { path: tree, label: "the mission worktree" },
      { path: repo, label: "the repository" }
    ]),
    secretValues: () => secrets,
    emit: (event) => events.push(event),
    recordPath: join(userData, "workspace-processes.json")
  });
}

function of<K extends RunnerEvent["kind"]>(kind: K): Extract<RunnerEvent, { kind: K }>["payload"][] {
  return events
    .filter((event): event is Extract<RunnerEvent, { kind: K }> => event.kind === kind)
    .map((event) => event.payload);
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

/**
 * The old inline specs, sealed into the snapshots the supervisor now takes.
 *
 * That is the real change these helpers stand for: the supervisor no longer
 * resolves a name against a settings file, it runs a `DeclaredCommand` the
 * control plane already pinned (D-043). Tests build one the same way the runner
 * does, so what is exercised is the shape that actually travels.
 */
interface OldSpec {
  name: string;
  command: string;
  cwd?: string;
  env: Record<string, string>;
  category?: DeclaredCommand["category"];
  port?: number | null;
  previewUrl?: string | null;
  readiness?: DeclaredCommand["readiness"];
  timeoutMs?: number | null;
  allowConcurrent?: boolean;
}

function seal(kind: DeclaredCommand["kind"], spec: OldSpec, timeoutMs: number | null): Invocation {
  const command: Omit<DeclaredCommand, "digest"> = {
    kind,
    name: spec.name,
    command: spec.command,
    cwd: spec.cwd ?? null,
    timeoutMs: spec.timeoutMs === undefined ? timeoutMs : spec.timeoutMs,
    category: spec.category ?? null,
    port: spec.port ?? null,
    previewUrl: spec.previewUrl ?? null,
    readiness: spec.readiness ?? null
  };
  return { command: { ...command, digest: commandDigest(command) }, env: spec.env, port: spec.port ?? null };
}

/** Long enough that nothing here trips it by accident; short enough that a test
 *  which *wants* a deadline can pass its own in milliseconds. */
const TEST_TIMEOUT_MS = 5 * 60_000;

const setupOf = (spec: OldSpec): Invocation => seal("setup", spec, TEST_TIMEOUT_MS);
const checkOf = (spec: OldSpec): Invocation => seal("verification", spec, TEST_TIMEOUT_MS);
/** A run command has no deadline at all, by design (D-034). */
const runOf = (spec: OldSpec): Invocation => seal("run", spec, null);
const concurrency = (spec: OldSpec): boolean => spec.allowConcurrent === true;


beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-proc-repo-"));
  worktree = mkdtempSync(join(tmpdir(), "novus-proc-worktree-"));
  userData = mkdtempSync(join(tmpdir(), "novus-proc-userdata-"));
  events = [];
  secrets = [];
  await git(worktree, ["init", "-b", "main"]);
  writeFileSync(join(worktree, "README.md"), "# fixture\n");
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "initial"]);
  supervisor = makeSupervisor();
});

afterEach(async () => {
  await supervisor.stopAll("test over");
  for (const path of [repo, worktree, userData]) rmSync(path, { recursive: true, force: true });
});

describe("setup", () => {
  it("moves readiness to ready and reports the process", async () => {
    await supervisor.runSetup(setupOf({ name: "setup", command: "echo installed > installed.txt", env: env() }), { start: 3100, end: 3109 });

    expect(of("workspace.readiness").map((payload) => payload.readiness)).toEqual(["configuring", "ready"]);
    expect(of("workspace.readiness")[1]?.setupError).toBeNull();
    expect(of("workspace.readiness")[1]?.portRangeStart).toBe(3100);
    expect(existsSync(join(worktree, "installed.txt"))).toBe(true);

    const started = of("process.started")[0];
    expect(started?.kind).toBe("setup");
    expect(started?.processId.startsWith("prc_")).toBe(true);
    expect(of("process.exited")[0]).toMatchObject({ state: "exited", exitCode: 0, failureReason: null });
  });

  it("fails readiness by name when the command exits non-zero", async () => {
    await supervisor.runSetup(setupOf({ name: "setup", command: "echo 'no lockfile' >&2; exit 3", env: env() }), { start: 3100, end: 3109 });
    const readiness = of("workspace.readiness")[1];
    expect(readiness?.readiness).toBe("failed");
    expect(readiness?.setupError).toContain("exited with code 3");
    expect(of("process.exited")[0]).toMatchObject({ state: "failed", exitCode: 3 });
  });

  it("refuses a working directory outside the workspace", async () => {
    await expect(
      supervisor.runSetup(setupOf({ name: "setup", command: "echo hi", cwd: "../elsewhere", env: env() }), { start: null, end: null })
    ).rejects.toBeInstanceOf(WorkspaceCommandError);
    expect(of("workspace.readiness")[1]?.readiness).toBe("failed");
  });
});

describe("where a command runs", () => {
  it("runs in the worktree and never in the user's own checkout", async () => {
    await supervisor.runSetup(setupOf({ name: "setup", command: "pwd > where.txt", env: env() }), { start: null, end: null });
    expect(readFileSync(join(worktree, "where.txt"), "utf8").trim()).toContain("novus-proc-worktree-");
    expect(existsSync(join(repo, "where.txt"))).toBe(false);
  });

  it("refuses outright when the workspace would be the user's own checkout", async () => {
    const wrong = makeSupervisor({ worktree: repo, sourceRepo: repo });
    await expect(
      wrong.runSetup(setupOf({ name: "setup", command: "echo hi", env: env() }), { start: null, end: null })
    ).rejects.toThrow(/your own checkout/);
    expect(existsSync(join(repo, "where.txt"))).toBe(false);
  });
});

describe("a long-lived run command", () => {
  it("starts, is reported running, and takes its whole tree down when stopped", async () => {
    await supervisor.startRun(runOf({
      name: "dev",
      // The shell backgrounds a child, so a stop that only reaches the shell
      // would leave `sleep` behind — which is the orphan this test exists for.
      command: "sleep 45 & echo $! > child.pid; wait",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }), concurrency({
      name: "dev",
      // The shell backgrounds a child, so a stop that only reaches the shell
      // would leave `sleep` behind — which is the orphan this test exists for.
      command: "sleep 45 & echo $! > child.pid; wait",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }));
    expect(supervisor.isRunning("dev")).toBe(true);
    await waitFor("the grandchild to be recorded", () => existsSync(join(worktree, "child.pid")));
    const grandchild = Number(readFileSync(join(worktree, "child.pid"), "utf8").trim());
    expect(processIsAlive(grandchild)).toBe(true);

    await supervisor.stop("dev", "Stopped by a participant.");

    expect(supervisor.isRunning("dev")).toBe(false);
    await waitFor("the whole tree to be gone", () => !processIsAlive(grandchild));
    const exited = of("process.exited")[0];
    expect(exited?.state).toBe("stopped");
    expect(exited?.failureReason).toContain("Stopped by a participant");
  }, 20_000);

  it("can be started again after it was stopped", async () => {
    const spec = {
      name: "dev",
      command: "sleep 30",
      env: env(),
      port: 3100,
      allowConcurrent: false
    };
    await supervisor.startRun(runOf(spec), concurrency(spec));
    await supervisor.stop("dev", "Stopped by a participant.");
    await supervisor.startRun(runOf(spec), concurrency(spec));
    expect(supervisor.isRunning("dev")).toBe(true);
    expect(of("process.started").length).toBe(2);
    // A restart is a new process, not the old one resurrected.
    expect(of("process.started")[0]?.processId).not.toBe(of("process.started")[1]?.processId);
    await supervisor.stopAll("test over");
  }, 20_000);

  it("starting the same command twice while it is alive changes nothing", async () => {
    const spec = { name: "dev", command: "sleep 30", env: env(), port: 3100, allowConcurrent: false };
    await supervisor.startRun(runOf(spec), concurrency(spec));
    await supervisor.startRun(runOf(spec), concurrency(spec));
    expect(of("process.started").length).toBe(1);
  }, 20_000);

  it("refuses a second run command by name unless the project allowed it", async () => {
    await supervisor.startRun(runOf({
      name: "dev",
      command: "sleep 30",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }), concurrency({
      name: "dev",
      command: "sleep 30",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }));
    await expect(
      supervisor.startRun(runOf({ name: "worker", command: "sleep 30", env: env(), port: 3101, allowConcurrent: false }), concurrency({ name: "worker", command: "sleep 30", env: env(), port: 3101, allowConcurrent: false }))
    ).rejects.toThrow(/two run commands at once/);

    await supervisor.startRun(runOf({
      name: "worker",
      command: "sleep 30",
      env: env(),
      port: 3101,
      allowConcurrent: true
    }), concurrency({
      name: "worker",
      command: "sleep 30",
      env: env(),
      port: 3101,
      allowConcurrent: true
    }));
    expect(supervisor.runningNames.sort()).toEqual(["dev", "worker"]);
  }, 20_000);

  it("uses the preview URL the project declared, substituting the allocated port", async () => {
    await supervisor.startRun(runOf({
      name: "dev",
      command: "sleep 0.2; echo '  ➜  Local:   http://localhost:5173/'; sleep 3",
      env: env(),
      port: 3100,
      previewUrl: "http://127.0.0.1:{port}",
      allowConcurrent: false
    }), concurrency({
      name: "dev",
      command: "sleep 0.2; echo '  ➜  Local:   http://localhost:5173/'; sleep 3",
      env: env(),
      port: 3100,
      previewUrl: "http://127.0.0.1:{port}",
      allowConcurrent: false
    }));
    expect(of("process.started")[0]?.previewUrl).toBe("http://127.0.0.1:3100");
    // The project said where its preview is. Whatever the server prints does
    // not overrule the project's own statement.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(of("process.started").length).toBe(1);
  }, 20_000);

  it("replaces its own guess with the URL the server actually printed", async () => {
    await supervisor.startRun(runOf({
      name: "dev",
      command: "sleep 0.2; echo '  ➜  Local:   http://localhost:5173/'; sleep 5",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }), concurrency({
      name: "dev",
      command: "sleep 0.2; echo '  ➜  Local:   http://localhost:5173/'; sleep 5",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }));
    // No declaration, so this is Novus guessing from the port it handed out.
    expect(of("process.started")[0]?.previewUrl).toBe("http://localhost:3100");

    await waitFor("the printed URL", () => of("process.started").length === 2);
    const update = of("process.started")[1];
    expect(update?.previewUrl).toBe("http://localhost:5173/");
    // The same process, now with one more true fact about it.
    expect(update?.processId).toBe(of("process.started")[0]?.processId);
  }, 20_000);

  it("reports a command that could not start rather than leaving it pending", async () => {
    await supervisor.startRun(runOf({
      name: "dev",
      command: "definitely-not-a-real-binary --serve",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }), concurrency({
      name: "dev",
      command: "definitely-not-a-real-binary --serve",
      env: env(),
      port: 3100,
      allowConcurrent: false
    }));
    await waitFor("the failure", () => of("process.exited").length === 1);
    expect(of("process.exited")[0]?.state).toBe("failed");
    expect(supervisor.isRunning("dev")).toBe(false);
  }, 20_000);
});

describe("verification", () => {
  it("carries the revision the workspace was on when the check started", async () => {
    const before = await headSha(gitExec, worktree);
    const running = supervisor.runVerification(checkOf({
      name: "test",
      command: "sleep 0.6; exit 0",
      category: "test",
      env: env()
    }));

    // The agent commits while the check is running. The check proves the
    // revision it started on, not whatever the tree has become.
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(join(worktree, "later.txt"), "written mid-check\n");
    await git(worktree, ["add", "-A"]);
    await git(worktree, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "mid-check"]);
    const after = await headSha(gitExec, worktree);
    expect(after).not.toBe(before);

    await running;
    const check = of("verification.completed")[0];
    expect(check?.checkpointSha).toBe(before);
    expect(check?.outcome).toBe("passed");
    expect(check?.exitCode).toBe(0);
    expect(check?.durationMs).toBeGreaterThan(0);
    expect(Date.parse(check?.startedAt ?? "")).toBeLessThanOrEqual(Date.parse(check?.completedAt ?? ""));
  }, 20_000);

  it("records a failing check as failed, with its output and exit code", async () => {
    await supervisor.runVerification(checkOf({
      name: "test",
      command: "echo '2 failing'; exit 1",
      category: "test",
      env: env()
    }));
    const check = of("verification.completed")[0];
    expect(check?.outcome).toBe("failed");
    expect(check?.exitCode).toBe(1);
    expect(check?.output).toContain("2 failing");
    expect(check?.command).toBe("echo '2 failing'; exit 1");
  }, 20_000);

  it("reports a cancelled check as errored rather than inventing a verdict", async () => {
    const running = supervisor.runVerification(checkOf({
      name: "test",
      command: "sleep 20",
      category: "test",
      env: env()
    }));
    await waitFor("the check to start", () => supervisor.isRunning("test"));
    await supervisor.stop("test", "Cancelled by a participant.");
    await running;
    expect(of("verification.completed")[0]?.outcome).toBe("errored");
  }, 20_000);

  it("does not displace a run command that happens to share its name", async () => {
    await supervisor.startRun(runOf({ name: "test", command: "sleep 30", env: env(), port: 3100, allowConcurrent: true }), concurrency({ name: "test", command: "sleep 30", env: env(), port: 3100, allowConcurrent: true }));
    await supervisor.runVerification(checkOf({ name: "test", command: "exit 0", category: "test", env: env() }));
    // The check ended; the run command with the same name is still alive and
    // still stoppable.
    expect(of("verification.completed")[0]?.outcome).toBe("passed");
    expect(supervisor.isRunning("test")).toBe(true);
    await supervisor.stop("test", "Stopped by a participant.");
    expect(supervisor.isRunning("test")).toBe(false);
  }, 20_000);

  it("bounds long output and says it was truncated", async () => {
    await supervisor.runVerification(checkOf({
      name: "test",
      command: "for i in $(seq 1 2000); do echo 'a line of test output that goes on and on'; done",
      category: "test",
      env: env()
    }));
    const check = of("verification.completed")[0];
    expect(check?.truncated).toBe(true);
    expect((check?.output ?? "").length).toBeLessThanOrEqual(4_000);
  }, 20_000);
});

describe("what reaches the room", () => {
  it("keeps a secret value out of every reported payload", async () => {
    secrets = ["postgres://user:hunter2-and-then-some@localhost/app"];
    await supervisor.runVerification(checkOf({
      name: "test",
      command: `echo "connecting to ${secrets[0] ?? ""}"; exit 0`,
      category: "test",
      env: { ...env(), DATABASE_URL: secrets[0] ?? "" }
    }));
    const reported = JSON.stringify(events);
    expect(reported).not.toContain("hunter2");
    expect(reported).toContain("[redacted]");
  }, 20_000);

  it("names no absolute path on this machine", async () => {
    await supervisor.runVerification(checkOf({ name: "test", command: "pwd", category: "test", env: env() }));
    const reported = JSON.stringify(events);
    expect(reported).not.toContain(worktree);
    expect(reported).toContain("the mission worktree");
  }, 20_000);
});

describe("after a relaunch", () => {
  it("reports a recorded process that is not alive as gone", () => {
    const recordPath = join(userData, "workspace-processes.json");
    writeFileSync(
      recordPath,
      JSON.stringify({
        prc_dead: {
          processId: "prc_dead",
          workstreamId: "wst_test",
          kind: "run",
          name: "dev",
          // A pid nothing holds any more, which is what a killed dev server
          // looks like to the next launch.
          pid: 999_999,
          startedAt: new Date().toISOString()
        }
      })
    );

    const seen: { workstreamId: string; event: RunnerEvent }[] = [];
    const reconciled = reconcileRecordedProcesses(
      recordPath,
      (workstreamId, event) => seen.push({ workstreamId, event }),
      () => false
    );

    expect(reconciled.length).toBe(1);
    expect(seen.length).toBe(1);
    expect(seen[0]?.workstreamId).toBe("wst_test");
    const event = seen[0]?.event;
    expect(event?.kind).toBe("process.exited");
    if (event?.kind !== "process.exited") throw new Error("expected an exit");
    expect(event.payload.processId).toBe("prc_dead");
    expect(event.payload.state).toBe("stopped");
    expect(event.payload.failureReason).toContain("no longer running");
    // The record is spent: a second relaunch does not report it again.
    expect(reconcileRecordedProcesses(recordPath, () => undefined, () => false)).toEqual([]);
  });

  it("says a survivor was stopped rather than pretending to supervise it", async () => {
    // A real process this launch never started, standing in for one that
    // outlived the app.
    await supervisor.startRun(runOf({ name: "dev", command: "sleep 40", env: env(), port: 3100, allowConcurrent: false }), concurrency({ name: "dev", command: "sleep 40", env: env(), port: 3100, allowConcurrent: false }));
    const recordPath = join(userData, "workspace-processes.json");
    const records = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, { pid: number }>;
    const pid = Object.values(records)[0]?.pid ?? 0;
    expect(processIsAlive(pid)).toBe(true);

    const seen: RunnerEvent[] = [];
    reconcileRecordedProcesses(recordPath, (_workstreamId, event) => seen.push(event));
    const event = seen[0];
    if (event?.kind !== "process.exited") throw new Error("expected an exit");
    expect(event.payload.failureReason).toContain("no longer supervise");
    await waitFor("the survivor to be gone", () => !processIsAlive(pid));
  }, 20_000);
});

describe("preview URL detection", () => {
  it("reads the line a dev server prints and ignores everything else", () => {
    expect(detectPreviewUrl("  ➜  Local:   http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(detectPreviewUrl("Server running at http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    // A bind address is not somewhere a browser goes.
    expect(detectPreviewUrl("listening on http://0.0.0.0:3000")).toBe("http://localhost:3000");
    expect(detectPreviewUrl("compiled 42 modules in 300ms")).toBeNull();
    expect(detectPreviewUrl("see https://docs.example.com/setup")).toBeNull();
  });
});
