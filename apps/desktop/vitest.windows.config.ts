import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// Windows CI's portable logic coverage. Unix shell/process fixtures and Apple
// speech tests remain in the full local gate; windows.spec.ts exercises the
// actual Windows application, worktree and PTY instead of pretending Unix is Windows.
const suites = [
  "artifact-policy", "artifact-presentation", "codex-stream", "computer-use",
  "dictation-audio", "dictation-keys", "dictation-refine", "home-presentation",
  "harness-stream", "notifications", "opencode-stream", "outbox", "preview-policy",
  "preview-presentation", "pull-presentation", "pull-threads", "rail-cycle",
  "receipt-export", "room-presentation", "secret-policy", "trace-presentation",
  "working-set", "workspace-config", "workspace-consents",
  "workspace-ports", "opencode-adapter", "opencode-server"
];
const config = mergeConfig(base, defineConfig({}));
// mergeConfig concatenates arrays, which would silently select every Unix fixture.
config.test!.include = suites.map(name => `test/${name}.test.ts`);
export default config;
