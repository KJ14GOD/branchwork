import assert from "node:assert/strict";
import test from "node:test";

import { detectBuiltin, detectProviders } from "./providers.ts";

/**
 * What this machine can run, reported honestly.
 *
 * These run against whatever is actually installed, so they assert *shape and
 * honesty* rather than specific versions — a test that demanded Claude Code be
 * present would fail on a machine that simply does not have it, which is a
 * state this code exists to describe rather than to reject.
 */

test("every provider reports installed and connected separately", () => {
  // They fail differently and are fixed differently: one is an install, the
  // other is a sign-in. A single tick would tell somebody nothing about which
  // of the two they have to go and do.
  const builtin = detectBuiltin({});

  assert.equal(typeof builtin.installed, "boolean");
  assert.equal(typeof builtin.connected, "boolean");
});

test("the built-in agent is honest about billing per token", () => {
  const withKey = detectBuiltin({ ANTHROPIC_API_KEY: "sk-ant-x" });
  const without = detectBuiltin({});

  assert.equal(withKey.connected, true);
  assert.match(withKey.detail, /per token/);
  // The distinction the whole screen exists for: a subscription is already
  // paid for, an API key is not.
  assert.equal(without.connected, false);
});

test("a provider never claims connected while reporting not installed", async () => {
  // The one combination that is always a bug: nothing that is absent can be
  // signed in.
  for (const provider of await detectProviders({})) {
    assert.ok(
      provider.installed || !provider.connected,
      `${provider.id} claimed a connection while reporting not installed`,
    );
  }
});

test("a version, when reported, looks like a version", async () => {
  // Not the first token of the output. Three CLIs print three layouts, and
  // taking word one reported codex's version as "codex-cli" — a string that
  // reads like an answer and is not one.
  for (const provider of await detectProviders({})) {
    if (provider.version !== null) {
      assert.match(
        provider.version,
        /^\d+\.\d+/,
        `${provider.id} reported a version that is not one: ${provider.version}`,
      );
    }
  }
});

test("every provider states something a person could act on", async () => {
  for (const provider of await detectProviders({})) {
    assert.ok(provider.detail.length > 0);
    assert.ok(provider.name.length > 0);
  }
});

test("an API key in the environment is reported as shadowing the plan", async () => {
  // The fact somebody paying for a subscription most needs and would never
  // think to check. With ANTHROPIC_API_KEY set, `claude auth status` reports
  // apiKeySource and blanks subscriptionType — the plan is still there, the
  // CLI is simply not using it, and every run bills the key. Saying "Max plan"
  // here would be quietly wrong in the direction that costs money.
  const { detectClaudeCode } = await import("./providers.ts");
  const before = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-placeholder-for-this-test";

  try {
    const provider = await detectClaudeCode();

    if (provider.installed && provider.connected) {
      assert.match(
        provider.detail,
        /billed per token|API key|ANTHROPIC_API_KEY/i,
        "a shadowed subscription must not be reported as a plan",
      );
    }
  } finally {
    if (before === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = before;
    }
  }
});
