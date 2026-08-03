import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_COMMAND_TIMEOUT_MINUTES,
  MIN_SECRET_LENGTH,
  WorkspaceSettingsSchema,
  type DeclaredCommand,
  type RunnerEvent
} from "@novus/contracts";
import { createSanitizer } from "../electron/evidence";
import { commandDigest, declaredCommands } from "../electron/workspace-commands";
import { gitExec } from "../electron/workspace-git";
import {
  parseLoopbackHttpUrl,
  readinessTarget,
  WorkspaceProcesses,
  type Invocation,
  type ReadinessProbe
} from "../electron/workspace-processes";
import { fileSecretStore, SecretStoreError, type SecretCrypto } from "../electron/workspace-secrets";
import {
  createWorkspaceRuntime,
  forgetSecret,
  openPreview,
  saveWorkspaceSettings,
  secretsFor,
  supplySecret,
  worktreeFor,
  type PinnedCommand,
  type WorkspaceCommandContext,
  type WorkspaceHost,
  type WorkspaceTarget
} from "../electron/workspace";

/**
 * The policies the workspace runtime enforces, against real processes.
 *
 * Every one of these is a promise the product makes out loud and could
 * previously only be taken on trust: that a deadline is the project's and not a
 * constant nobody can see, that a run command has none, that "the process
 * started" is not a claim the application is up, that a preview opens only a
 * loopback address something actually reported, that a value Novus cannot
 * redact is refused rather than leaked, and that the command a participant
 * authorized is the command that runs.
 */

const MISSION_ID = "msn_policy";
const WORKSTREAM_ID = "wst_policy";
const MISSION_BRANCH = "novus/m-p0l1cy";
const LOCAL_ID = "local-policy";

let repo: string;
let userData: string;
let events: { workstreamId: string; event: RunnerEvent }[];
let supervisors: WorkspaceProcesses[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const outcome = await gitExec(cwd, args);
  if (outcome.code !== 0) throw new Error(`git ${args.join(" ")}: ${outcome.stderr}`);
  return outcome.stdout.trim();
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const host = (): WorkspaceHost => ({
  userDataPath: userData,
  repositoryPath: (id) => (id === LOCAL_ID ? repo : null)
});

const target: WorkspaceTarget = {
  missionId: MISSION_ID,
  workstreamId: WORKSTREAM_ID,
  localId: LOCAL_ID,
  missionBranch: MISSION_BRANCH
};

const context: WorkspaceCommandContext = {
  missionId: MISSION_ID,
  workstreamId: WORKSTREAM_ID,
  providerRepoId: LOCAL_ID,
  missionBranch: MISSION_BRANCH,
  workspaceId: null
};

function of<K extends RunnerEvent["kind"]>(kind: K): Extract<RunnerEvent, { kind: K }>["payload"][] {
  return events
    .map((entry) => entry.event)
    .filter((event): event is Extract<RunnerEvent, { kind: K }> => event.kind === kind)
    .map((event) => event.payload);
}

/** Everything this file started, so nothing of it is still running when the
 *  next file begins. A suite that leaves live processes behind makes the suite
 *  after it flaky, which is how a green run stops meaning anything. */
let started: { shutdown: (reason: string) => Promise<void> }[] = [];

const track = (supervisor: WorkspaceProcesses): WorkspaceProcesses => {
  supervisors.push(supervisor);
  return supervisor;
};

const runtime = () => {
  const created = createWorkspaceRuntime({
    host: host(),
    emit: (workstreamId, event) => events.push({ workstreamId, event })
  });
  started.push(created);
  return created;
};

/** Commits `.novus/settings.toml` onto the mission branch, the way a project
 *  actually carries its configuration. */
async function commitSettings(body: string): Promise<void> {
  mkdirSync(join(repo, ".novus"), { recursive: true });
  writeFileSync(join(repo, ".novus", "settings.toml"), body);
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "settings"]);
  await git(repo, ["branch", "-f", MISSION_BRANCH, "HEAD"]);
}

/** The pinned snapshot for a name, taken from what the runner published — the
 *  same round trip the control plane makes (D-043). */
async function pin(
  running: ReturnType<typeof runtime>,
  kind: DeclaredCommand["kind"],
  name?: string
): Promise<PinnedCommand> {
  await running.publishDeclared(context);
  // The most recent publication, not the first: a project whose configuration
  // changed has said two different things, and the current one is the answer.
  const published = of("workspace.declared");
  const declared = (published[published.length - 1]?.commands ?? []).filter(
    (command) => command.kind === kind
  );
  const snapshot = (name === undefined ? declared[0] : declared.find((c) => c.name === name)) ?? null;
  return { name: name ?? snapshot?.name ?? null, snapshot };
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "novus-policy-repo-"));
  userData = mkdtempSync(join(tmpdir(), "novus-policy-userdata-"));
  events = [];
  await git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=T", "-c", "user.email=t@l", "commit", "-m", "initial"]);
  await git(repo, ["branch", MISSION_BRANCH]);
});

afterEach(async () => {
  await Promise.allSettled(started.map((runtime) => runtime.shutdown("test over")));
  await Promise.allSettled(supervisors.map((supervisor) => supervisor.stopAll("test over")));
  started = [];
  supervisors = [];
  await gitExec(repo, ["worktree", "prune"]);
  for (const path of [repo, userData]) rmSync(path, { recursive: true, force: true });
});

// --- Deadlines ----------------------------------------------------------------

describe("the timeout a project states", () => {
  /** A supervisor over the worktree, so a deadline can be given in
   *  milliseconds rather than waited out in real minutes. */
  function supervisor(worktree: string): WorkspaceProcesses {
    return track(new WorkspaceProcesses({
      workstreamId: WORKSTREAM_ID,
      worktree,
      sourceRepo: repo,
      git: gitExec,
      sanitize: createSanitizer([{ path: worktree, label: "the mission worktree" }]),
      secretValues: () => [],
      emit: (event) => events.push({ workstreamId: WORKSTREAM_ID, event }),
      recordPath: join(userData, "workspace-processes.json")
    }));
  }

  function seal(overrides: Partial<DeclaredCommand> & Pick<DeclaredCommand, "kind" | "name" | "command">) {
    const command: Omit<DeclaredCommand, "digest"> = {
      cwd: null,
      timeoutMs: null,
      category: null,
      port: null,
      previewUrl: null,
      readiness: null,
      ...overrides
    };
    return { ...command, digest: commandDigest(command) };
  }

  const invocation = (command: DeclaredCommand): Invocation => ({
    command,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    port: null
  });

  it("ends a finite command at its own deadline, and says it timed out", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-policy-tree-"));
    const processes = supervisor(worktree);
    await processes.runVerification(
      invocation(seal({ kind: "verification", name: "slow", command: "sleep 30", timeoutMs: 250 }))
    );

    const check = of("verification.completed")[0];
    // No verdict was reached, and the room is told which of the three reasons
    // it was — not simply "failed".
    expect(check?.outcome).toBe("errored");
    expect(check?.ending).toBe("timeout");
    const exited = of("process.exited")[0];
    expect(exited?.ending).toBe("timeout");
    expect(exited?.state).toBe("failed");
    expect(exited?.failureReason).toContain("past the");
    rmSync(worktree, { recursive: true, force: true });
  }, 20_000);

  it("takes the whole process tree with it, not only the shell it started", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-policy-tree-"));
    const processes = supervisor(worktree);
    await processes.runVerification(
      invocation(
        seal({
          kind: "verification",
          name: "spawns",
          // The shell backgrounds a child and waits: a deadline that only
          // reached the shell would leave `sleep` behind, which is the orphan
          // this assertion exists for.
          command: "sleep 45 & echo $! > child.pid; wait",
          timeoutMs: 400
        })
      )
    );
    const pid = Number(readFileSync(join(worktree, "child.pid"), "utf8").trim());
    expect(Number.isInteger(pid)).toBe(true);
    await waitFor("the whole tree to be gone", () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    rmSync(worktree, { recursive: true, force: true });
  }, 20_000);

  it("gives a run command no deadline at all, because it is not finite", async () => {
    await commitSettings(
      ['[[run]]', 'name = "dev"', 'command = "sleep 30"', '', '[timeouts]', 'setupMinutes = 1'].join("\n")
    );
    const running = runtime();
    const pinned = await pin(running, "run");
    expect(pinned.snapshot?.timeoutMs).toBeNull();

    // And a check under the same configuration does have one, so the absence
    // above is a decision rather than an oversight. Written into the worktree,
    // which is where configuration is read from once one exists.
    const worktree = worktreeFor(userData, MISSION_ID);
    writeFileSync(
      join(worktree, ".novus", "settings.toml"),
      [
        '[[run]]',
        'name = "dev"',
        'command = "sleep 30"',
        '',
        '[[verify]]',
        'name = "unit"',
        'command = "exit 0"',
        '',
        '[timeouts]',
        'verifyMinutes = 2'
      ].join("\n")
    );
    const check = await pin(runtime(), "verification", "unit");
    expect(check.snapshot?.timeoutMs).toBe(2 * 60_000);
  }, 30_000);

  it("lets a single command override the project's default", () => {
    const settings = WorkspaceSettingsSchema.parse({
      timeouts: { verifyMinutes: 20 },
      verify: [
        { name: "unit", command: "pnpm test" },
        { name: "e2e", command: "pnpm e2e", timeoutMinutes: 90 }
      ]
    });
    const commands = declaredCommands(settings);
    expect(commands.find((c) => c.name === "unit")?.timeoutMs).toBe(20 * 60_000);
    expect(commands.find((c) => c.name === "e2e")?.timeoutMs).toBe(90 * 60_000);
  });

  it("refuses a timeout outside the documented bounds, by name", () => {
    const tooLong = WorkspaceSettingsSchema.safeParse({
      timeouts: { setupMinutes: MAX_COMMAND_TIMEOUT_MINUTES + 1 }
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toContain(`${MAX_COMMAND_TIMEOUT_MINUTES} minutes or fewer`);

    expect(WorkspaceSettingsSchema.safeParse({ timeouts: { verifyMinutes: 0 } }).success).toBe(false);
    expect(
      WorkspaceSettingsSchema.safeParse({ verify: [{ name: "u", command: "x", timeoutMinutes: 1.5 }] }).success
    ).toBe(false);
    // A run command has nowhere to put one, which is how the contract says a
    // run command is not finite.
    expect(
      "timeoutMinutes" in
        (WorkspaceSettingsSchema.parse({ run: [{ name: "dev", command: "x" }] }).run[0] ?? {})
    ).toBe(false);
  });

  it("is never applied to a coding-agent execution, which has its own path", () => {
    // Asserted by absence, and it is the absence that matters: the harness
    // adapter does not import the supervisor at all, so there is no code path
    // by which a finite-command deadline could reach a Claude or Codex turn
    // (D-034 — an authorized execution has no Novus ceiling).
    const adapter = readFileSync(join(__dirname, "..", "electron", "execution.ts"), "utf8");
    expect(adapter).not.toContain("workspace-processes");
    expect(adapter).not.toContain("timeoutMs");
  });
});

// --- Readiness -----------------------------------------------------------------

describe("readiness is a declared signal, not a running process", () => {
  function supervisor(worktree: string, probe: ReadinessProbe): WorkspaceProcesses {
    return track(new WorkspaceProcesses({
      workstreamId: WORKSTREAM_ID,
      worktree,
      sourceRepo: repo,
      git: gitExec,
      sanitize: (text) => text,
      secretValues: () => [],
      emit: (event) => events.push({ workstreamId: WORKSTREAM_ID, event }),
      recordPath: join(userData, "workspace-processes.json"),
      probe
    }));
  }

  const runCommand = (readiness: DeclaredCommand["readiness"]): Invocation => {
    const command: Omit<DeclaredCommand, "digest"> = {
      kind: "run",
      name: "dev",
      command: "sleep 20",
      cwd: null,
      timeoutMs: null,
      category: null,
      port: null,
      previewUrl: null,
      readiness
    };
    return {
      command: { ...command, digest: commandDigest(command) },
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      port: 4321
    };
  };

  it("reports a process as starting until its declared signal answers", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-ready-tree-"));
    let answers = false;
    const processes = supervisor(worktree, () => Promise.resolve(answers));
    await processes.startRun(
      runCommand({
        kind: "http",
        url: "http://localhost:{port}/healthz",
        port: null,
        timeoutSeconds: 5,
        stopOnFailure: false
      }),
      false
    );

    // Started, and deliberately not claimed to be serving anything.
    expect(of("process.started")[0]?.readiness).toBe("pending");
    expect(of("process.readiness").length).toBe(0);

    answers = true;
    await waitFor("readiness to be reported", () => of("process.readiness").length > 0);
    const ready = of("process.readiness")[0];
    expect(ready?.readiness).toBe("ready");
    // The probe confirmed an address, so that is the one worth offering.
    expect(ready?.previewUrl).toBe("http://localhost:4321/healthz");
    await processes.stopAll("test over");
    rmSync(worktree, { recursive: true, force: true });
  }, 20_000);

  it("says a health check never answered without killing the process", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-ready-tree-"));
    const processes = supervisor(worktree, () => Promise.resolve(false));
    await processes.startRun(
      runCommand({ kind: "port", url: null, port: null, timeoutSeconds: 1, stopOnFailure: false }),
      false
    );

    await waitFor("the readiness deadline to pass", () => of("process.readiness").length > 0);
    expect(of("process.readiness")[0]?.readiness).toBe("unreachable");
    expect(of("process.readiness")[0]?.detail).toContain("did not answer");
    // Still running: a failed health check is a fact about the application, and
    // stopping somebody's server over it is only Novus's decision to make when
    // the project said so.
    expect(processes.isRunning("dev")).toBe(true);
    expect(of("process.exited").length).toBe(0);

    await processes.stopAll("test over");
    rmSync(worktree, { recursive: true, force: true });
  }, 20_000);

  it("stops the process only when the project asked it to", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-ready-tree-"));
    const processes = supervisor(worktree, () => Promise.resolve(false));
    await processes.startRun(
      runCommand({ kind: "port", url: null, port: null, timeoutSeconds: 1, stopOnFailure: true }),
      false
    );
    await waitFor("the process to be stopped", () => of("process.exited").length > 0);
    expect(of("process.exited")[0]?.ending).toBe("cancelled");
    rmSync(worktree, { recursive: true, force: true });
  }, 20_000);

  it("asks nothing at all when the project declared no signal", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-ready-tree-"));
    const processes = supervisor(worktree, () => {
      throw new Error("no probe should have run");
    });
    await processes.startRun(runCommand(null), false);
    expect(of("process.started")[0]?.readiness).toBe("not_required");
    await processes.stopAll("test over");
    rmSync(worktree, { recursive: true, force: true });
  }, 20_000);

  it("fills the allocated port into the signal the project declared", () => {
    expect(
      readinessTarget(
        { kind: "http", url: "http://127.0.0.1:{port}/up", port: null, timeoutSeconds: 5, stopOnFailure: false },
        4100
      )
    ).toEqual({ kind: "http", url: "http://127.0.0.1:4100/up", port: 4100 });
    expect(
      readinessTarget({ kind: "port", url: null, port: null, timeoutSeconds: 5, stopOnFailure: false }, 4100)
    ).toEqual({ kind: "port", url: null, port: 4100 });
    expect(
      readinessTarget({ kind: "process", url: null, port: null, timeoutSeconds: 5, stopOnFailure: false }, 4100)
    ).toBeNull();
  });
});

// --- The preview bridge ---------------------------------------------------------

describe("opening a local preview", () => {
  it("accepts a loopback address and rebuilds it from validated parts", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "novus-preview-tree-"));
    const processes = new WorkspaceProcesses({
      workstreamId: WORKSTREAM_ID,
      worktree,
      sourceRepo: repo,
      git: gitExec,
      sanitize: (text) => text,
      secretValues: () => [],
      emit: (event) => events.push({ workstreamId: WORKSTREAM_ID, event }),
      recordPath: join(userData, "workspace-processes.json")
    });
    void processes;
    rmSync(worktree, { recursive: true, force: true });

    for (const accepted of [
      "http://localhost:3000",
      "http://127.0.0.1:5173/app",
      "https://localhost:8443/",
      "http://[::1]:3000/"
    ]) {
      expect(parseLoopbackHttpUrl(accepted)).not.toBeNull();
    }
  });

  it("accepts the encodings the URL parser resolves to literal loopback", () => {
    // `http://2130706433/` and `http://0177.0.0.1/` are 127.0.0.1 written
    // differently, and `new URL` normalises both before the allowlist sees
    // them. Accepting those is correct — they are this machine. Asserted here
    // so the behaviour is a decision on the record rather than a surprise.
    expect(parseLoopbackHttpUrl("http://2130706433/")?.hostname).toBe("127.0.0.1");
    expect(parseLoopbackHttpUrl("http://0177.0.0.1/")?.hostname).toBe("127.0.0.1");
  });

  it("refuses everything that is not a loopback http address", () => {
    for (const refused of [
      // A scheme the operating system would hand to some other application.
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "vscode://file/etc/passwd",
      "smb://server/share",
      // Somewhere that is not this machine.
      "https://evil.example/login",
      "http://192.168.1.10:3000",
      // The authority is `evil.example`; a `startsWith` check waves it through.
      "http://localhost@evil.example/",
      "https://user:pass@localhost:3000/",
      // A name that merely resolves to loopback is still somebody else's host.
      "http://localtest.me:3000",
      "http://127.0.0.1.nip.io:3000",
      // `[::ffff:127.0.0.1]` is a distinct hostname string, and the allowlist
      // is on the literal: it is refused rather than reasoned about.
      "http://[::ffff:127.0.0.1]/",
      // A bind address, not somewhere a browser goes.
      "http://0.0.0.0:3000",
      // Smuggled control characters.
      "http://localhost:3000/\nSet-Cookie: x",
      "not a url at all",
      ""
    ]) {
      expect(parseLoopbackHttpUrl(refused)).toBeNull();
    }
  });

  it("opens only an address something in this workspace actually reported", async () => {
    const opened: string[] = [];
    // Nothing has run, so nothing has reported an address to open.
    await expect(
      openPreview(WORKSTREAM_ID, "http://localhost:3000", async (url) => {
        opened.push(url);
      })
    ).rejects.toThrow(/reported that address/);
    expect(opened).toEqual([]);

    // And a refused address never reaches the operating system at all.
    await expect(
      openPreview(WORKSTREAM_ID, "https://evil.example/", async (url) => {
        opened.push(url);
      })
    ).rejects.toThrow(/loopback/);
    expect(opened).toEqual([]);
  });
});

// --- Secret values ---------------------------------------------------------------

describe("supplying a value only this machine has", () => {
  /** A credential store that works, so the rules can be exercised without an
   *  Electron app; the availability rule gets its own case below. */
  const workingCrypto = (): SecretCrypto => ({
    available: () => true,
    encrypt: (plaintext) => Buffer.from(plaintext, "utf8"),
    decrypt: (ciphertext) => ciphertext.toString("utf8")
  });

  const withStore = (crypto: SecretCrypto): WorkspaceHost => ({
    ...host(),
    secretStore: fileSecretStore(join(userData, "secrets"), crypto)
  });

  async function declareSecret(): Promise<void> {
    await saveWorkspaceSettings(
      target,
      "shared",
      WorkspaceSettingsSchema.parse({ secretNames: ["DATABASE_URL", "STRIPE_KEY"] }),
      host()
    );
  }

  it("shows which names are supplied without ever showing a value", async () => {
    const hosted = withStore(workingCrypto());
    await declareSecret();

    let state = await secretsFor(target, hosted);
    expect(state.encryptionAvailable).toBe(true);
    expect(state.names).toEqual([
      { name: "DATABASE_URL", supplied: false },
      { name: "STRIPE_KEY", supplied: false }
    ]);

    state = await supplySecret(target, "DATABASE_URL", "postgres://hunter2@localhost/app", hosted);
    expect(state.names).toContainEqual({ name: "DATABASE_URL", supplied: true });
    // The whole answer, serialized: there is no field a value could be hiding in.
    expect(JSON.stringify(state)).not.toContain("hunter2");

    state = await forgetSecret(target, "DATABASE_URL", hosted);
    expect(state.names).toContainEqual({ name: "DATABASE_URL", supplied: false });
  }, 20_000);

  it("names a value it still holds for a variable the project dropped", async () => {
    const hosted = withStore(workingCrypto());
    await declareSecret();
    await supplySecret(target, "STRIPE_KEY", "sk_live_not_a_real_key", hosted);

    await saveWorkspaceSettings(
      target,
      "shared",
      WorkspaceSettingsSchema.parse({ secretNames: ["DATABASE_URL"] }),
      host()
    );
    const state = await secretsFor(target, hosted);
    expect(state.names.map((entry) => entry.name)).toEqual(["DATABASE_URL"]);
    expect(state.orphaned).toEqual(["STRIPE_KEY"]);
  }, 20_000);

  it("refuses a value too short to remove from command output", async () => {
    const hosted = withStore(workingCrypto());
    await declareSecret();
    await expect(supplySecret(target, "DATABASE_URL", "short", hosted)).rejects.toThrow(
      new RegExp(`${MIN_SECRET_LENGTH} characters`)
    );
    const state = await secretsFor(target, hosted);
    expect(state.names).toContainEqual({ name: "DATABASE_URL", supplied: false });
  }, 20_000);

  it("fails closed, and says so, when the operating system offers no encryption", () => {
    const store = fileSecretStore(join(userData, "secrets"), {
      available: () => false,
      encrypt: () => Buffer.from(""),
      decrypt: () => ""
    });
    expect(store.available()).toBe(false);
    // Not a silent no-op: the caller can tell nothing was stored.
    expect(() => store.put(LOCAL_ID, "DATABASE_URL", "a-long-enough-value")).toThrow(SecretStoreError);
    expect(existsSync(join(userData, "secrets"))).toBe(false);
  });

  it("enforces the length floor in the store itself, not only at the bridge", () => {
    const store = fileSecretStore(join(userData, "secrets"), workingCrypto());
    expect(() => store.put(LOCAL_ID, "SHORT", "abc")).toThrow(SecretStoreError);
    expect(store.suppliedNames(LOCAL_ID)).toEqual([]);
  });
});

// --- The command a participant authorized ----------------------------------------

describe("an authorized command is pinned to what it was", () => {
  it("runs the snapshot even after the configuration changed underneath it", async () => {
    await commitSettings(
      ['[[verify]]', 'name = "unit"', 'command = "echo authorized > witness.txt"'].join("\n")
    );
    const running = runtime();
    // What a participant saw and pressed.
    const authorized = await pin(running, "verification", "unit");
    expect(authorized.snapshot?.command).toContain("authorized");

    // A turn edits the project's configuration between the click and the run.
    const worktree = worktreeFor(userData, MISSION_ID);
    mkdirSync(join(worktree, ".novus"), { recursive: true });
    writeFileSync(
      join(worktree, ".novus", "settings.toml"),
      ['[[verify]]', 'name = "unit"', 'command = "echo substituted > witness.txt"'].join("\n")
    );

    await running.runVerification(context, authorized);

    // What ran is what was authorized. The edit changes the *next* command.
    expect(readFileSync(join(worktree, "witness.txt"), "utf8").trim()).toBe("authorized");
    expect(of("verification.completed")[0]?.command).toContain("authorized");

    const republished = await pin(runtime(), "verification", "unit");
    expect(republished.snapshot?.command).toContain("substituted");
    expect(republished.snapshot?.digest).not.toBe(authorized.snapshot?.digest);
  }, 30_000);

  it("gives the same configuration the same digest, and a changed one a different digest", () => {
    const settings = WorkspaceSettingsSchema.parse({
      setup: { command: "pnpm install" },
      verify: [{ name: "unit", command: "pnpm test" }]
    });
    const first = declaredCommands(settings);
    const again = declaredCommands(WorkspaceSettingsSchema.parse(JSON.parse(JSON.stringify(settings))));
    expect(first.map((c) => c.digest)).toEqual(again.map((c) => c.digest));

    const changed = declaredCommands(
      WorkspaceSettingsSchema.parse({
        setup: { command: "pnpm install" },
        verify: [{ name: "unit", command: "pnpm test --silent" }]
      })
    );
    expect(changed.map((c) => c.digest)).not.toEqual(first.map((c) => c.digest));
  });
});
