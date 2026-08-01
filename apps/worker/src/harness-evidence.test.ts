import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { SessionEvent } from "@novus/contracts";
import { InMemorySessionEventStore } from "@novus/session-service";

import { ClaudeCodeHarness } from "./claude-code-harness.ts";
import { CodexHarness } from "./codex-harness.ts";
import { startEventServer } from "./event-server.ts";
import { FixedModelRouter } from "./model.ts";
import { projectSession } from "./projection.ts";
import { SessionRegistry } from "./session-registry.ts";

/**
 * What a run Novus did not execute leaves behind.
 *
 * A session on `ClaudeCodeHarness` or `CodexHarness` used to end with a
 * summary string and nothing else: no file list, no receipt, no usage, no
 * cost, and a cancel button that appended an event nothing on the machine ever
 * read. Every test here drives a real adapter — over a fake CLI, against a
 * real Git repository — and then asks the surfaces a person actually looks at.
 *
 * Two claims are load-bearing and deliberately pinned rather than assumed:
 *
 *  - `attributable` is **false**. An external harness works in the session's
 *    own tree, so the diff is what differs from the base commit and not what
 *    the agent did. Crediting an agent with a human's uncommitted edits is a
 *    fabricated citation with a file list instead of a line number.
 *  - `verification` is **unverified** unless a check crossed Novus. A harness
 *    that says it ran the tests has said something, not shown something, and
 *    this repository has shipped completion-as-verification twice.
 */

const run = promisify(execFile);
const git = (cwd: string, args: string[]) => run("git", args, { cwd });
const TOKEN = "harness-evidence-token-abcdefghijkl";
const SESSION = "s1";

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "novus-harness-evidence-"));

  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "checkout.ts"), "one\ntwo\nthree\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  return root;
};

/**
 * A `claude` on the PATH that behaves like the real one for a single turn, and
 * optionally edits the repository on its way through.
 *
 * `shell` runs before the stream lines are emitted and with the harness's own
 * cwd, which is what makes this a real test of the observation: the files it
 * writes are files nothing told Novus about.
 */
const fakeClaude = (options: { lines: string[]; shell?: string }): string => {
  const dir = mkdtempSync(join(tmpdir(), "novus-fake-claude-"));
  const path = join(dir, "claude");
  const body = options.lines
    .map((line) => `echo '${line.replace(/'/g, "'\\''")}'`)
    .join("\n");

  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude Code)"; exit 0; fi
# The real CLI stays silent until it has been given something to work on.
head -n 1 > /dev/null
${options.shell ?? ""}
${body}
# exec, so a signal reaches this process rather than a shell waiting on a
# child. Without it a cancellation would be queued behind a blocked \`cat\`.
exec cat > /dev/null
`,
  );
  chmodSync(path, 0o755);

  return path;
};

const fakeCodex = (lines: string[], shell = ""): string => {
  const dir = mkdtempSync(join(tmpdir(), "novus-fake-codex-"));
  const path = join(dir, "codex");
  const body = lines.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join("\n");

  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
${shell}
${body}
exit 0
`,
  );
  chmodSync(path, 0o755);

  return path;
};

const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  model: "claude-opus-5",
  tools: ["Bash", "Edit"],
  session_id: "cc-1",
});

const RESULT_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Fixed the failing checkout test.",
  total_cost_usd: 0.0125,
});

/** The harness saying it ran the suite. A claim, not a check. */
const CLAIMS_TESTS_RAN = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "pnpm test", description: "run the suite" },
      },
    ],
  },
});

const TESTS_PASSED = JSON.stringify({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        is_error: false,
        content: "Tests: 12 passed, 12 total",
      },
    ],
  },
});

const claudeOver = (command: string, cwd: string, store: InMemorySessionEventStore) =>
  new ClaudeCodeHarness({
    eventStore: store,
    cwd,
    permissions: { allowWrites: true, allowCommands: true },
    command,
  });

const observedIn = (events: readonly SessionEvent[]) => {
  const event = events.find((candidate) => candidate.type === "harness.changes_observed");

  return event?.type === "harness.changes_observed" ? event.payload : null;
};

const receiptIn = (events: readonly SessionEvent[]) => {
  const event = events.find((candidate) => candidate.type === "receipt.created");

  return event?.type === "receipt.created" ? event.payload.receipt : null;
};

const waitFor = async (
  ready: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (ready()) {
      return;
    }

    await new Promise((settle) => setTimeout(settle, 25));
  }

  throw new Error(`timed out waiting for ${label}`);
};

test("a Claude Code run records what changed in the tree, and refuses to claim it", async () => {
  const repo = await repository();
  const store = new InMemorySessionEventStore();
  const harness = claudeOver(
    fakeClaude({
      lines: [INIT, RESULT_OK],
      // An edit to a tracked file and a file that did not exist before. The
      // second is the one that used to disappear entirely: a new file is
      // invisible to `git diff` until something stages it, and an external
      // harness stages nothing.
      shell: `printf 'one\\ntwo\\nthree\\nfour\\n' > checkout.ts\nprintf 'a\\nb\\n' > added.ts`,
    }),
    repo,
    store,
  );

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Fix the test" });

  const observed = observedIn(store.list(SESSION));

  assert.ok(observed, "no harness.changes_observed was emitted");
  assert.deepEqual(
    observed.files.map((file) => file.path).sort(),
    ["added.ts", "checkout.ts"],
  );

  const added = observed.files.find((file) => file.path === "added.ts");
  const edited = observed.files.find((file) => file.path === "checkout.ts");

  assert.equal(added?.additions, 2);
  assert.equal(added?.deletions, 0);
  assert.equal(edited?.additions, 1);
  assert.equal(edited?.deletions, 0);
  assert.equal(observed.truncated, false);

  // The line this whole event turns on. The run shared the session's working
  // tree, so these paths are everything that differs from the base commit —
  // a human's own uncommitted edits included — and Novus does not credit an
  // agent with work it cannot separate out.
  assert.equal(observed.attributable, false);
});

test("the observed diff never names a secret or Novus's own metadata", async () => {
  const repo = await repository();
  const store = new InMemorySessionEventStore();
  // Untracked and not ignored, so git would happily list it. `.env` is the one
  // file the repository boundary refuses, and counting its lines would mean
  // reading it.
  await writeFile(join(repo, ".env"), "ANTHROPIC_API_KEY=sk-not-a-real-key\n");
  await writeFile(join(repo, ".env.local"), "TOKEN=also-not-real\n");

  const harness = claudeOver(
    fakeClaude({ lines: [INIT, RESULT_OK], shell: `printf 'x\\n' >> checkout.ts` }),
    repo,
    store,
  );

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const observed = observedIn(store.list(SESSION));

  assert.ok(observed);
  for (const file of observed.files) {
    assert.ok(!file.path.startsWith(".env"), `${file.path} must not be reported`);
    assert.ok(!file.path.startsWith(".git"), `${file.path} must not be reported`);
    assert.ok(!file.path.startsWith("/"), "no absolute path may be reported");
    assert.ok(!file.path.includes(".."), "no escaping path may be reported");
  }

  // Nothing anywhere on the log went near the contents.
  for (const event of store.list(SESSION)) {
    assert.ok(!JSON.stringify(event).includes("sk-not-a-real-key"));
  }
});

test("an external harness's work reaches GET /sessions/:id/files", async () => {
  // The whole point of folding the event into the projection: this route is
  // what the changed-files panel reads, and for an external harness it used to
  // answer with an empty list no matter what the run did.
  const repo = await repository();
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter({ provider: "scripted", model: "scripted-v1" }),
    [],
    { allowWrites: true, allowCommands: true },
  );
  const fake = fakeClaude({
    lines: [INIT, RESULT_OK],
    shell: `printf 'one\\ntwo\\n' > checkout.ts\nprintf 'new\\n' > added.ts`,
  });
  const previousPath = process.env["PATH"];

  process.env["PATH"] = `${dirname(fake)}:${previousPath ?? ""}`;

  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  };

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repositoryPath: repo, allowWrites: true }),
    }).then((response) => response.json())) as { id: string };

    await fetch(`${server.url}/sessions/${created.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "Fix the checkout test", harness: "claude-code" }),
    });

    await waitFor(
      () => store.list(created.id).some((event) => event.type === "receipt.created"),
      "the run to finish and write its receipt",
    );

    const files = (await fetch(`${server.url}/sessions/${created.id}/files`, {
      headers,
    }).then((response) => response.json())) as {
      files: { path: string; additions: number; deletions: number }[];
      additions: number;
      deletions: number;
    };

    assert.deepEqual(files.files.map((file) => file.path).sort(), [
      "added.ts",
      "checkout.ts",
    ]);
    // checkout.ts lost a line and added none; added.ts added one.
    assert.equal(files.additions, 1);
    assert.equal(files.deletions, 1);
  } finally {
    process.env["PATH"] = previousPath;
    await server.close();
  }
});

test("a Claude Code run writes a receipt, and it does not call completion verification", async () => {
  const repo = await repository();
  const store = new InMemorySessionEventStore();
  const harness = claudeOver(
    fakeClaude({
      // The harness says, in its own words, that it ran the suite and that the
      // suite passed. Nothing about that crossed Novus: no run_tests, no exit
      // code, no output Novus parsed.
      lines: [INIT, CLAIMS_TESTS_RAN, TESTS_PASSED, RESULT_OK],
      shell: `printf 'one\\ntwo\\nthree\\nfour\\n' > checkout.ts`,
    }),
    repo,
    store,
  );

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Fix the test" });

  const events = store.list(SESSION);
  const receipt = receiptIn(events);

  assert.ok(receipt, "no receipt.created was written");
  assert.equal(receipt.status, "completed");
  // The claim this repository has shipped wrong twice. A green suite the
  // harness reported is a sentence, not evidence.
  assert.equal(receipt.verification, "unverified");
  assert.equal(receipt.checks.length, 0);
  assert.equal(receipt.tests.length, 0);

  // The file evidence is there, and it came from the diff rather than a patch.
  assert.deepEqual(
    receipt.filesChanged.map((file) => file.path),
    ["checkout.ts"],
  );

  // The base the diff was taken against, cited rather than implied.
  assert.equal(typeof receipt.base.revision, "string");
  assert.equal(receipt.base.dirty, false);

  // Cost is the one figure this harness genuinely reports.
  assert.equal(receipt.usage.costUsd, 0.0125);
  // Tokens are not, so they are a floor and the receipt says so rather than
  // printing a confident zero.
  assert.equal(receipt.usage.inputTokens, 0);
  assert.equal(receipt.usage.outputTokens, 0);
  assert.equal(receipt.usage.modelCalls, 0);
  assert.ok(receipt.usage.callsMissingUsage > 0);

  // And the session total folded from it admits the same thing.
  const projected = projectSession(SESSION, events);

  assert.equal(projected.usage.costIsFloor, true);
  assert.deepEqual(
    projected.runs[0]?.filesChanged.map((file) => file.path),
    ["checkout.ts"],
  );
});

test("Codex reports its tokens and refuses to report a cost", async () => {
  const repo = await repository();
  const store = new InMemorySessionEventStore();
  const harness = new CodexHarness({
    eventStore: store,
    cwd: repo,
    permissions: { allowWrites: true, allowCommands: true },
    command: fakeCodex(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "i1", type: "command_execution", text: "pnpm test" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 16776, output_tokens: 5 },
        }),
      ],
      `printf 'one\\ntwo\\n' > checkout.ts`,
    ),
  });

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Fix the test" });

  const events = store.list(SESSION);
  const receipt = receiptIn(events);
  const observed = observedIn(events);

  assert.ok(receipt);
  assert.ok(observed);
  assert.equal(observed.attributable, false);
  assert.deepEqual(
    observed.files.map((file) => file.path),
    ["checkout.ts"],
  );

  assert.equal(receipt.usage.inputTokens, 16776);
  assert.equal(receipt.usage.outputTokens, 5);
  // `cost: "none"` is Codex's declaration, so this must be null however many
  // tokens the turn reported. Zero would say the run was free.
  assert.equal(receipt.usage.costUsd, null);
  assert.equal(receipt.verification, "unverified");

  // A session whose only run could not be priced reports unknown, not free.
  const projected = projectSession(SESSION, events);

  assert.equal(projected.usage.costUsd, null);
  assert.equal(projected.usage.costIsFloor, true);
  assert.equal(projected.usage.unpricedRuns, 1);
});

test("a directory that is not a repository observes nothing, rather than nothing-changed", async () => {
  // "The diff could not be read" and "nothing changed" are opposite answers,
  // and an empty file list is how the second one looks. The run still gets a
  // receipt: usage and cost are worth recording even where a diff is not
  // available.
  const plain = await mkdtemp(join(tmpdir(), "novus-not-a-repo-"));
  const store = new InMemorySessionEventStore();
  const harness = claudeOver(
    fakeClaude({ lines: [INIT, RESULT_OK], shell: `printf 'x\\n' > wrote.txt` }),
    plain,
    store,
  );

  await harness.run({ sessionId: SESSION, actorId: "host", goal: "Go" });

  const events = store.list(SESSION);

  assert.equal(observedIn(events), null);

  const receipt = receiptIn(events);

  assert.ok(receipt);
  assert.deepEqual(receipt.filesChanged, []);
  assert.equal(receipt.base.revision, null);
});

test("a cancellation reaches the subprocess and ends the run as cancelled", async () => {
  const repo = await repository();
  const store = new InMemorySessionEventStore();
  const sessions = new SessionRegistry(
    store,
    new FixedModelRouter({ provider: "scripted", model: "scripted-v1" }),
    [],
    { allowWrites: true, allowCommands: true },
  );
  // Emits its handshake and then never finishes the turn. Before this slice
  // the harness was constructed per turn and dropped, so nothing held a handle
  // to it: `POST /cancel` appended `run.cancel_requested` and this process ran
  // until the worker died.
  const fake = fakeClaude({ lines: [INIT] });
  const previousPath = process.env["PATH"];

  process.env["PATH"] = `${dirname(fake)}:${previousPath ?? ""}`;

  const server = await startEventServer(store, { port: 0, token: TOKEN, sessions });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  };

  try {
    const created = (await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ repositoryPath: repo, allowWrites: true }),
    }).then((response) => response.json())) as { id: string };

    await fetch(`${server.url}/sessions/${created.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ goal: "Work forever", harness: "claude-code" }),
    });

    await waitFor(
      () => store.list(created.id).some((event) => event.type === "run.started"),
      "the run to start",
    );

    const started = store
      .list(created.id)
      .find((event) => event.type === "run.started");

    assert.ok(started?.type === "run.started");

    const cancel = await fetch(`${server.url}/sessions/${created.id}/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: started.payload.run.id }),
    });

    assert.equal(cancel.status, 202);

    await waitFor(
      () =>
        store
          .list(created.id)
          .some(
            (event) =>
              event.type === "run.cancelled" ||
              event.type === "run.completed" ||
              event.type === "run.failed",
          ),
      "the run to end",
    );

    const terminal = store
      .list(created.id)
      .filter(
        (event) =>
          event.type === "run.cancelled" ||
          event.type === "run.completed" ||
          event.type === "run.failed",
      );

    assert.equal(terminal.length, 1);
    // Cancelled, not failed. A run somebody stopped did not break, and telling
    // a reviewer it did is the wrong half of the two ways to be wrong here.
    assert.equal(terminal[0]?.type, "run.cancelled");

    // A cancelled run is still a finished run: it gets its receipt, and the
    // receipt says what it ended as.
    await waitFor(
      () => store.list(created.id).some((event) => event.type === "receipt.created"),
      "the cancelled run's receipt",
    );

    assert.equal(receiptIn(store.list(created.id))?.status, "cancelled");
  } finally {
    process.env["PATH"] = previousPath;
    await server.close();
  }
});

test("an observed diff replaces a patch's numbers rather than adding to them", () => {
  // The two families do not co-occur today — a run is either Novus's loop or
  // somebody else's. This is what keeps that from becoming a silent double
  // count if a harness ever reports both: a diff against the run's base
  // already contains whatever the patch wrote.
  const events: SessionEvent[] = [
    {
      eventId: crypto.randomUUID(),
      sessionId: SESSION,
      sequence: 0,
      actorId: "agent-1",
      occurredAt: new Date().toISOString(),
      type: "run.started",
      payload: {
        run: {
          id: "run-1",
          sessionId: SESSION,
          goal: "Fix it",
          status: "running",
          startedBy: "agent-1",
          model: { provider: "claude-code", model: "claude-opus-5" },
          createdAt: new Date().toISOString(),
        },
      },
    },
    {
      eventId: crypto.randomUUID(),
      sessionId: SESSION,
      sequence: 1,
      actorId: "agent-1",
      occurredAt: new Date().toISOString(),
      type: "tool.completed",
      payload: {
        runId: "run-1",
        result: {
          toolCallId: "c1",
          name: "apply_patch",
          output: {
            patchId: "p1",
            path: "checkout.ts",
            status: "applied",
            additions: 4,
            deletions: 1,
          },
        },
      },
    },
    {
      eventId: crypto.randomUUID(),
      sessionId: SESSION,
      sequence: 2,
      actorId: "agent-1",
      occurredAt: new Date().toISOString(),
      type: "harness.changes_observed",
      payload: {
        runId: "run-1",
        files: [
          { path: "checkout.ts", additions: 4, deletions: 1 },
          { path: "added.ts", additions: 9, deletions: 0 },
        ],
        truncated: false,
        attributable: false,
      },
    },
  ];

  const projected = projectSession(SESSION, events);

  assert.deepEqual(projected.runs[0]?.filesChanged, [
    { path: "checkout.ts", additions: 4, deletions: 1 },
    { path: "added.ts", additions: 9, deletions: 0 },
  ]);
});
