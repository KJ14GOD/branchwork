import { defineConfig } from "vitest/config";

// Deterministic unit tests for the desktop main process's pure logic: the
// harness stream parser, the event outbox, git evidence extraction, and
// verification observation. Modules under test must not import `electron` at
// module scope — anything that needs the app object takes it as an argument —
// so this suite runs in plain Node. The Electron end-to-end suite lives in
// e2e/ and runs separately (`pnpm run e2e`).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
