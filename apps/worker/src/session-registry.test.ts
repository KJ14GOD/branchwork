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

/** A log that refuses every append, the way a full disk does. */
class UnwritableEventStore extends InMemorySessionEventStore {
  override append(): never {
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
    ["run.started", "run.progress", "run.failed"],
  );

  const failure = events.at(-1);
  const started = events.at(0);

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

  assert.deepEqual(eventStore.list(session.id), []);
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
