import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ModelSelection } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import {
  FixedModelRouter,
  type ModelAdapter,
  type ModelResponse,
} from "./model.ts";
import { SessionRegistry } from "./session-registry.ts";

const run = promisify(execFile);

const selection: ModelSelection = {
  provider: "scripted",
  model: "scripted-v1",
};

/** A provider call that rejects, which is how a run throws in practice. */
class RejectingModelAdapter implements ModelAdapter {
  readonly selection = selection;

  async complete(): Promise<ModelResponse> {
    throw new Error("the provider refused the call");
  }
}

/**
 * A log that works once and then refuses, the way a filling disk does.
 *
 * Refusing *every* append would fail at `create`, which now records
 * session.created — and that is correct behaviour rather than a problem: a
 * session whose creation could not be logged does not exist as far as history is
 * concerned, and failing at the boundary beats failing midway. But the case
 * under test here is a log that breaks partway through a session, which is both
 * what a full disk actually looks like and the harder thing to handle.
 */
class UnwritableEventStore extends InMemorySessionEventStore {
  private allowed = 1;

  override append(
    ...args: Parameters<InMemorySessionEventStore["append"]>
  ): ReturnType<InMemorySessionEventStore["append"]> {
    if (this.allowed > 0) {
      this.allowed -= 1;

      return super.append(...args);
    }

    throw new Error("SQLITE_FULL: database or disk is full");
  }
}

const captureErrors = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const original = console.error;

  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
};

test("tells the session when a turn throws instead of only the host", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-registry-"));
  const eventStore = new InMemorySessionEventStore();
  const registry = new SessionRegistry(
    eventStore,
    new FixedModelRouter(selection),
    [new RejectingModelAdapter()],
  );

  const session = await registry.create({ repositoryPath });
  const errors = captureErrors();

  try {
    // The client was answered the moment the turn was queued, so a rejection
    // here must not escape either — it has to land in the log instead.
    await registry.submitTurn(session, "Do the thing");
  } finally {
    errors.restore();
  }

  const events = eventStore.list(session.id);

  assert.deepEqual(
    events.map((event) => event.type),
    // session.created leads now: opening a session is recorded, which is what
    // makes it findable again after a restart.
    ["session.created", "run.started", "run.progress", "run.failed"],
  );

  const failure = events.at(-1);
  // Found by type rather than by position. The first event is session.created
  // now, and an index was always the wrong way to ask for "the run that started".
  const started = events.find((event) => event.type === "run.started");

  assert.ok(failure && failure.type === "run.failed");
  assert.ok(started && started.type === "run.started");
  assert.match(failure.payload.reason, /the provider refused the call/);

  // It names the run it ended. A run.failed pointing at some other run would
  // be worse than none, and the id only survives the unwind because the runner
  // attaches it to what it throws.
  assert.equal(failure.payload.runId, started.payload.run.id);

  eventStore.close();
});

test("says so on the host when the failure itself cannot be logged", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-registry-"));
  const eventStore = new UnwritableEventStore();
  const registry = new SessionRegistry(
    eventStore,
    new FixedModelRouter(selection),
    [new RejectingModelAdapter()],
  );

  const session = await registry.create({ repositoryPath });
  const errors = captureErrors();

  try {
    // append() is what threw, so the append that would report it throws too.
    // The turn still has to settle rather than take the worker down with it.
    await registry.submitTurn(session, "Do the thing");
  } finally {
    errors.restore();
  }

  assert.match(errors.lines[0] ?? "", /turn failed: .*disk is full/);
  assert.match(errors.lines[1] ?? "", /could not be told: .*disk is full/);

  eventStore.close();
});

test("does not invent a run to fail when none was ever started", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-registry-"));
  const eventStore = new InMemorySessionEventStore();
  // No adapter matches the router's selection, so the runner throws before a
  // run exists. Nothing in the log claims to be in progress, and a run.failed
  // would have to name a run id that never appeared.
  const registry = new SessionRegistry(
    eventStore,
    new FixedModelRouter(selection),
    [],
  );

  const session = await registry.create({ repositoryPath });
  const errors = captureErrors();

  try {
    await registry.submitTurn(session, "Do the thing");
  } finally {
    errors.restore();
  }

  // session.created is there, and nothing else. The point of this test is that
  // no run.failed was invented for a run that never started — not that the log
  // is empty, which it no longer is now that opening a session is recorded.
  assert.deepEqual(
    eventStore.list(session.id).map((event) => event.type),
    ["session.created"],
  );
  assert.match(errors.lines[0] ?? "", /No model adapter is configured/);
  assert.equal(errors.lines.length, 1);

  eventStore.close();
});

/** The registry, with a model nothing in these three tests will reach. */
const registryFor = () =>
  new SessionRegistry(
    new InMemorySessionEventStore(),
    new FixedModelRouter(selection),
    [new RejectingModelAdapter()],
  );

test("a session on a plain directory reports the repository as absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novus-plain-"));

  const session = await registryFor().create({ repositoryPath: directory });

  // Reported when the session opens, not discovered when Fork fails. The session
  // is perfectly usable — reading, searching and patching all work — and two
  // features do not, which is a thing to say up front.
  assert.equal(session.repositoryState, "absent");
});

test("a repository with no commits is distinguished from no repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novus-empty-git-"));
  await run("git", ["init", "-q"], { cwd: directory });

  const session = await registryFor().create({ repositoryPath: directory });

  // The remedies differ — one needs `git init`, the other only a commit — so
  // collapsing them into one message would send somebody to the wrong fix.
  assert.equal(session.repositoryState, "no-commits");
});

test("a repository with a commit is ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novus-ready-"));
  await run("git", ["init", "-q"], { cwd: directory });
  await run("git", ["config", "user.email", "t@e.com"], { cwd: directory });
  await run("git", ["config", "user.name", "T"], { cwd: directory });
  await writeFile(join(directory, "a.txt"), "one\n");
  await run("git", ["add", "-A"], { cwd: directory });
  await run("git", ["commit", "-qm", "initial"], { cwd: directory });

  const session = await registryFor().create({ repositoryPath: directory });

  assert.equal(session.repositoryState, "ready");
});

test("opening a session is recorded, so it can be found again later", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-remember-"));
  const eventStore = new InMemorySessionEventStore();
  const registry = new SessionRegistry(
    eventStore,
    new FixedModelRouter(selection),
    [new RejectingModelAdapter()],
  );

  const session = await registry.create({ repositoryPath });

  // The contract defined session.created and the renderers drew it, and nothing
  // ever appended one — so the log held runs belonging to sessions it had no
  // record of, and there was nothing to restore a session from.
  const created = eventStore
    .list(session.id)
    .find((event) => event.type === "session.created");

  assert.ok(created, "opening a session recorded nothing");

  if (created?.type === "session.created") {
    assert.equal(created.payload.session.repositoryPath, session.repositoryPath);
    // Null rather than a placeholder: a session is a repository somebody
    // opened, and goals belong to the runs inside it.
    assert.equal(created.payload.session.goal, null);
  }
});

test("a remembered session can be resumed onto its own timeline", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-resume-"));
  const eventStore = new InMemorySessionEventStore();
  const registry = new SessionRegistry(
    eventStore,
    new FixedModelRouter(selection),
    [new RejectingModelAdapter()],
  );

  const first = await registry.create({ repositoryPath });
  const remembered = registry.remembered();

  assert.equal(remembered.length, 1);
  // Compared against the session's own path, not the one mkdtemp handed back:
  // macOS symlinks /var to /private/var and the registry resolves it, so the
  // two differ by a prefix that has nothing to do with what is being tested.
  assert.equal(remembered[0]?.repositoryPath, first.repositoryPath);

  // A fresh id would start an empty stream beside a history nobody could reach,
  // which is the whole failure this fixes.
  const resumed = await registry.create({ repositoryPath, resume: first.id });

  assert.equal(resumed.id, first.id);
  assert.equal(
    eventStore.list(first.id).filter((event) => event.type === "session.created")
      .length,
    2,
    "resuming should append its own creation event, not overwrite the first",
  );
});

test("permissions are not restored with a resumed session", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "novus-perms-"));
  const registry = new SessionRegistry(
    new InMemorySessionEventStore(),
    new FixedModelRouter(selection),
    [new RejectingModelAdapter()],
    { allowWrites: false, allowCommands: false },
  );

  const permissive = await registry.create({
    repositoryPath,
    allowWrites: true,
    allowCommands: true,
  });
  const resumed = await registry.create({
    repositoryPath,
    resume: permissive.id,
  });

  // A session recorded with writes allowed must not silently regain them a week
  // later. Resuming brings the timeline back, never the authority.
  assert.equal(resumed.allowWrites, false);
  assert.equal(resumed.allowCommands, false);
});
