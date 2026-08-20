import { defineConfig } from "vitest/config";

// Deterministic tests for the desktop main process. Most of it is pure logic —
// the harness stream parser, the event outbox, git evidence extraction — but a
// good part of it is deliberately not: real PTYs, real process groups, real git
// remotes, and real child processes, because a mocked one of any of those would
// happily pretend not to have the fault being tested for. Modules under test
// must not import `electron` at module scope — anything that needs the app
// object takes it as an argument — so this suite runs in plain Node. The
// Electron end-to-end suite lives in e2e/ and runs separately (`pnpm run e2e`).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // One file at a time. Several of these suites spawn real shells, real
    // servers, and real worktrees; run in parallel they contend for CPU and for
    // temporary directories, and a suite that fails on a busy machine and
    // passes on an idle one is not evidence of anything.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // The runner publishes the machine's own user-level skills (D-186) by
      // reading the CLI's config dir. Under test that must never be the
      // developer's real ~/.claude — a fixture's events would carry whatever
      // this machine happens to have installed. Suites that want global
      // skills pass their own dir explicitly (skills.test.ts does).
      CLAUDE_CONFIG_DIR: "/nonexistent-novus-test-config"
    }
  }
});
