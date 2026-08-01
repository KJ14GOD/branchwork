import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProviderStatus } from "@novus/contracts/protocol";

const run = promisify(execFile);

/**
 * What this machine can actually run, and on whose account.
 *
 * Novus does not hold accounts and does not run a sign-in flow. It does not
 * need to: the coding harnesses a team already uses have each done their own
 * OAuth, and the credential lives with them. `claude auth status` reports a
 * Max plan; `codex login status` reports a ChatGPT login; `gh auth status`
 * reports the GitHub account and its scopes. Novus reads those and says what
 * it found.
 *
 * That is the whole answer to "can I use my subscription instead of API
 * credit" — the subscription is already connected, to the CLI, and driving the
 * CLI is what spends it. A Novus-branded sign-in button would be a second
 * login for an account that does not exist.
 *
 * Every probe fails soft. A CLI that is not installed is an ordinary fact
 * about a machine, not an error, and the setup screen has to be able to say so
 * calmly next to the ones that are.
 */

const TIMEOUT_MS = 8_000;

const tryRun = async (
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string } | null> => {
  try {
    return await run(command, args, { timeout: TIMEOUT_MS });
  } catch (cause) {
    // A non-zero exit is a normal answer here — `gh auth status` uses it for
    // "not logged in" — so the streams are still worth reading.
    const failure = cause as { stdout?: string; stderr?: string } | null;

    if (failure && (failure.stdout !== undefined || failure.stderr !== undefined)) {
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }

    return null;
  }
};

/**
 * The version number out of whatever shape a CLI prints.
 *
 * Not the first token: the three tools here print three different layouts —
 * `2.1.220 (Claude Code)`, `codex-cli 0.145.0`, `gh version 2.62.0 (…)` — and
 * taking the first word reported the version of `codex` as "codex-cli". A
 * version string nobody can read is worse than none, because it looks like an
 * answer.
 */
const version = async (command: string, args = ["--version"]): Promise<string | null> => {
  const result = await tryRun(command, args);
  const found = /\b\d+\.\d+(?:\.\d+)?\b/.exec(result?.stdout ?? "");

  return found?.[0] ?? null;
};

/**
 * Claude Code: installed, signed in, and on what.
 *
 * `claude auth status` prints JSON carrying `authMethod` and
 * `subscriptionType`. "Max plan" is a materially different fact from "API key"
 * — one is already paid for and the other bills per token — so the screen says
 * which, rather than a generic tick.
 */
export const detectClaudeCode = async (): Promise<ProviderStatus> => {
  const found = await version("claude");

  if (!found) {
    return {
      id: "claude-code",
      name: "Claude Code",
      kind: "harness",
      installed: false,
      connected: false,
      version: null,
      detail: "Not installed",
      account: null,
    };
  }

  const status = await tryRun("claude", ["auth", "status"]);
  let connected = false;
  let detail = "Installed, not signed in";
  let account: string | null = null;

  try {
    const parsed = JSON.parse(status?.stdout ?? "") as {
      loggedIn?: boolean;
      authMethod?: string;
      apiKeySource?: string;
      subscriptionType?: string;
      email?: string;
    };

    connected = parsed.loggedIn === true;

    if (connected) {
      const plan = parsed.subscriptionType;
      const key =
        parsed.apiKeySource && parsed.apiKeySource !== "none"
          ? parsed.apiKeySource
          : null;

      /**
       * An API key in the environment SHADOWS the subscription.
       *
       * Verified, because it is the one fact somebody paying for a plan most
       * needs and would never think to check: with `ANTHROPIC_API_KEY` set,
       * `claude auth status` reports `apiKeySource: "ANTHROPIC_API_KEY"` and
       * blanks `subscriptionType` and `email` — the plan is still there, the
       * CLI is simply not using it, and every run bills the key instead. A
       * screen that said "Max plan" here would be quietly wrong in the
       * direction that costs money.
       */
      detail = key
        ? `${key} is set — billed per token, not to your plan`
        : plan
          ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`
          : (parsed.authMethod ?? "Signed in");
      account = parsed.email ?? null;
    }
  } catch {
    // An older CLI, or a shape this build does not know. Installed is still a
    // fact worth reporting; the sign-in state is not guessed.
    detail = "Installed — sign-in state unknown";
  }

  return {
    id: "claude-code",
    name: "Claude Code",
    kind: "harness",
    installed: true,
    connected,
    version: found,
    detail,
    account,
  };
};

/** Codex: installed, and whether it holds a ChatGPT login. */
export const detectCodex = async (): Promise<ProviderStatus> => {
  const found = await version("codex");

  if (!found) {
    return {
      id: "codex",
      name: "Codex",
      kind: "harness",
      installed: false,
      connected: false,
      version: null,
      detail: "Not installed",
      account: null,
    };
  }

  const status = await tryRun("codex", ["login", "status"]);
  const said = `${status?.stdout ?? ""}${status?.stderr ?? ""}`.trim();
  const connected = /logged in/i.test(said);

  return {
    id: "codex",
    name: "Codex",
    kind: "harness",
    installed: true,
    connected,
    version: found,
    // The CLI's own words — "Logged in using ChatGPT" — rather than a
    // paraphrase that could drift from what it actually reports.
    detail: connected ? said.split("\n")[0]! : "Installed, not signed in",
    account: null,
  };
};

/** GitHub: cloning, pushing, and reading required checks. */
export const detectGithub = async (): Promise<ProviderStatus> => {
  const found = await version("gh", ["--version"]);

  if (!found) {
    return {
      id: "github",
      name: "GitHub",
      kind: "service",
      installed: false,
      connected: false,
      version: null,
      detail: "Not installed",
      account: null,
    };
  }

  const status = await tryRun("gh", ["auth", "status"]);
  const said = `${status?.stdout ?? ""}${status?.stderr ?? ""}`;
  const connected = /Logged in to/i.test(said);
  const account = /account (\S+)/i.exec(said)?.[1] ?? null;

  return {
    id: "github",
    name: "GitHub",
    kind: "service",
    installed: true,
    connected,
    version: found,
    detail: connected ? "Connected" : "Installed, not signed in",
    account,
  };
};

/**
 * The built-in loop, reported as a provider so the screen can be honest that
 * it exists and what it costs.
 *
 * It is deliberately last and deliberately plain: it is the fallback for
 * models with no mature harness of their own, and it is the only one here that
 * bills per token against an API key.
 */
export const detectBuiltin = (env: NodeJS.ProcessEnv): ProviderStatus => {
  const key = env["ANTHROPIC_API_KEY"] ?? env["OPENAI_API_KEY"] ?? null;

  return {
    id: "novus-builtin",
    name: "Novus agent",
    kind: "harness",
    installed: true,
    connected: Boolean(key),
    version: null,
    detail: key
      ? "API key — billed per token"
      : "No API key set",
    account: null,
  };
};

/** Everything, probed in parallel. Slow CLIs must not add up. */
export const detectProviders = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderStatus[]> => {
  const [claude, codex, github] = await Promise.all([
    detectClaudeCode(),
    detectCodex(),
    detectGithub(),
  ]);

  return [claude, codex, github, detectBuiltin(env)];
};
