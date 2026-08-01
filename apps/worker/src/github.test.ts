import assert from "node:assert/strict";
import test from "node:test";

import { GithubStatusSchema } from "@novus/contracts/protocol";

import { readGithubStatus, type CommandRunner } from "./github.ts";

/**
 * What GitHub is asked, and what is done with the answer.
 *
 * The runner is injected, so these are deterministic and reach no network. One
 * test at the bottom does call the real `gh` — see the note on it.
 */

const scripted =
  (responses: Record<string, unknown>): CommandRunner =>
  (command, args) => {
    if (command === "git") {
      return Promise.resolve({ stdout: "feature-branch\n" });
    }

    const key = args.join(" ");
    const match = Object.keys(responses).find((prefix) => key.startsWith(prefix));

    if (match === undefined) {
      // Mirrors gh's own behaviour: a command with nothing to report exits
      // non-zero rather than printing an empty result.
      return Promise.reject(new Error(`no scripted response for: ${key}`));
    }

    return Promise.resolve({ stdout: JSON.stringify(responses[match]) });
  };

test("a repository with no GitHub remote is not connected, and says why", async () => {
  const status = await readGithubStatus("/tmp/repo", scripted({}));

  assert.equal(status.connected, false);
  assert.match(
    status.connected === false ? status.reason : "",
    /gh auth login/,
  );
});

test("a branch with a pull request reports its checks", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({
      "repo view": { nameWithOwner: "acme/widget" },
      "pr view": {
        number: 42,
        title: "Fix the reconnect backoff",
        url: "https://github.com/acme/widget/pull/42",
        state: "OPEN",
        isDraft: false,
      },
      "pr checks": [
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "SUCCESS" },
      ],
    }),
  );

  assert.equal(status.connected, true);

  if (status.connected) {
    assert.equal(status.pullRequest?.number, 42);
    assert.equal(status.verdict, "passing");
    assert.equal(status.checks.length, 2);
  }
});

test("a branch with no checks configured is not passing", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({ "repo view": { nameWithOwner: "acme/widget" } }),
  );

  // The rule this whole product turns on, applied to CI: a branch nobody
  // configured checks for has been verified by nothing. Reporting that as
  // green would be the same lie as a tick on a run that skipped its tests.
  assert.equal(status.connected && status.verdict, "none");
});

test("one failing check fails the verdict, however many passed", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({
      "repo view": { nameWithOwner: "acme/widget" },
      "pr view": {
        number: 1,
        title: "x",
        url: "u",
        state: "OPEN",
        isDraft: false,
      },
      "pr checks": [
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "FAILURE" },
        { name: "lint", state: "SUCCESS" },
      ],
    }),
  );

  assert.equal(status.connected && status.verdict, "failing");
});

test("a check still running is not yet a pass", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({
      "repo view": { nameWithOwner: "acme/widget" },
      "pr view": { number: 1, title: "x", url: "u", state: "OPEN", isDraft: false },
      "pr checks": [
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "IN_PROGRESS" },
      ],
    }),
  );

  assert.equal(status.connected && status.verdict, "running");
});

test("a state nobody recognises is treated as failing, never as passing", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({
      "repo view": { nameWithOwner: "acme/widget" },
      "pr view": { number: 1, title: "x", url: "u", state: "OPEN", isDraft: false },
      "pr checks": [{ name: "build", state: "SOMETHING_NEW" }],
    }),
  );

  // Guessing optimistically is how a screen ends up claiming something was
  // verified by a check nobody has read.
  assert.equal(status.connected && status.verdict, "failing");
});

test("without a pull request it falls back to the branch's own workflow runs", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({
      "repo view": { nameWithOwner: "acme/widget" },
      "run list": [
        {
          displayTitle: "a commit",
          status: "completed",
          conclusion: "success",
          workflowName: "CI",
          url: "https://github.com/acme/widget/actions/runs/1",
        },
      ],
    }),
  );

  assert.equal(status.connected, true);

  if (status.connected) {
    assert.equal(status.pullRequest, null);
    assert.equal(status.checks[0]?.name, "CI");
    assert.equal(status.verdict, "passing");
  }
});

/**
 * The one test that touches the network.
 *
 * Everything above proves the logic against a scripted runner, which is
 * worth exactly nothing if the real `gh` answers a different shape than the
 * script assumes — and that is the failure mode a mocked integration always
 * has. This calls the real binary against this very repository and asserts
 * only that what comes back satisfies the contract.
 *
 * Skips rather than fails when `gh` is absent or signed out, because CI and
 * a fresh clone are both legitimately in that state.
 */
test("the real gh returns something this build can read", async (t) => {
  const status = await readGithubStatus(process.cwd()).catch(() => null);

  if (status === null || status.connected === false) {
    t.skip("gh is not available or not signed in");

    return;
  }

  const parsed = GithubStatusSchema.safeParse(status);

  assert.equal(
    parsed.success,
    true,
    parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2),
  );
  assert.match(status.repository, /\//);
});

test("only the newest run of each workflow counts", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    scripted({
      "repo view": { nameWithOwner: "acme/widget" },
      // gh returns newest first. The older failure is history, not the
      // branch's current state — folding it in made a green branch read as
      // red for as long as it stayed in the window.
      "run list": [
        {
          displayTitle: "latest",
          status: "completed",
          conclusion: "success",
          workflowName: "CI",
          url: "u1",
        },
        {
          displayTitle: "older",
          status: "completed",
          conclusion: "failure",
          workflowName: "CI",
          url: "u2",
        },
      ],
    }),
  );

  assert.equal(status.connected && status.verdict, "passing");
  assert.equal(status.connected && status.checks.length, 1);
});

test("a run against a different commit is stale, not the branch's verdict", async () => {
  const status = await readGithubStatus(
    "/tmp/repo",
    // git rev-parse answers "current-head"; the run tested something else.
    // This is the real shape found on this very repository: the workflow was
    // deleted weeks ago and its last runs lingered, so the panel reported
    // "CI failing" for code nothing had ever tested.
    (command, args) => {
      if (command === "git") {
        return Promise.resolve({
          stdout: args.includes("--abbrev-ref") ? "main\n" : "current-head\n",
        });
      }

      const key = args.join(" ");

      if (key.startsWith("repo view")) {
        return Promise.resolve({ stdout: JSON.stringify({ nameWithOwner: "acme/widget" }) });
      }

      if (key.startsWith("run list")) {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              displayTitle: "two weeks ago",
              status: "completed",
              conclusion: "failure",
              workflowName: "CI",
              url: "u",
              headSha: "an-old-commit",
            },
          ]),
        });
      }

      return Promise.reject(new Error("no pr"));
    },
  );

  // Not "failing". That verdict belongs to a commit nobody is looking at.
  assert.equal(status.connected && status.verdict, "stale");
});

test("a run against the current commit is not stale", async () => {
  const status = await readGithubStatus("/tmp/repo", (command, args) => {
    if (command === "git") {
      return Promise.resolve({
        stdout: args.includes("--abbrev-ref") ? "main\n" : "current-head\n",
      });
    }

    const key = args.join(" ");

    if (key.startsWith("repo view")) {
      return Promise.resolve({ stdout: JSON.stringify({ nameWithOwner: "acme/widget" }) });
    }

    if (key.startsWith("run list")) {
      return Promise.resolve({
        stdout: JSON.stringify([
          {
            displayTitle: "just now",
            status: "completed",
            conclusion: "success",
            workflowName: "CI",
            url: "u",
            headSha: "current-head",
          },
        ]),
      });
    }

    return Promise.reject(new Error("no pr"));
  });

  assert.equal(status.connected && status.verdict, "passing");
});
