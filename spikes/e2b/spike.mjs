#!/usr/bin/env node

import { Sandbox } from "e2b";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const sendOpenAiKey = process.env.NOVUS_SPIKE_SEND_OPENAI_KEY === "1";
const sendAnthropicKey = process.env.NOVUS_SPIKE_SEND_ANTHROPIC_KEY === "1";
const coldStartSamples = Number.parseInt(process.env.NOVUS_SPIKE_COLD_START_SAMPLES ?? "3", 10);

if (!Number.isInteger(coldStartSamples) || coldStartSamples < 1 || coldStartSamples > 10) {
  throw new Error("NOVUS_SPIKE_COLD_START_SAMPLES must be an integer from 1 to 10");
}

const requiredDestinations = [
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "api.anthropic.com",
  "api.openai.com",
];

const plan = {
  provider: "E2B",
  sdkVersion: "2.14.0",
  template: "base",
  coldStartSamples,
  liveCredentialPolicy: {
    e2bApiKeyPresent: Boolean(process.env.E2B_API_KEY),
    openAiKeyWillBeSent: sendOpenAiKey && Boolean(process.env.OPENAI_API_KEY),
    anthropicKeyWillBeSent: sendAnthropicKey && Boolean(process.env.ANTHROPIC_API_KEY),
  },
  checks: [
    "cold-start distribution",
    "base Linux/tool inventory",
    "filesystem persistence across pause/resume",
    "background-process persistence across pause/resume",
    "resume latency",
    "outbound allowlist and denied destination",
    "Claude Code and Codex installation/version",
    "optional real Codex authentication and structured event stream",
    "optional real Claude Code authentication and structured event stream",
    "terminal cleanup",
  ],
  requiredDestinations,
  providerApiObservations: {
    egressRuleUnit: "IPv4/IPv6 address or CIDR block, not a domain name",
    testStrategy: "Resolve required domains inside an unrestricted E2B sandbox, then create a second default-deny sandbox allowing only those observed IPs.",
    productionCaveat: "Resolved IPs can change. Passing this experiment does not by itself make IP pinning a safe production policy.",
  },
  credentialWarning: "Optional harness keys are injected only for this disposable spike after an explicit NOVUS_SPIKE_SEND_* opt-in. This is not the production supervisor design.",
};

if (dryRun) {
  console.log(JSON.stringify({ mode: "dry-run", plan }, null, 2));
  process.exit(0);
}

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is required for the live spike. No sandbox was created.");
  console.error("Run `npm run dry-run` to inspect the plan without external side effects.");
  process.exit(2);
}

const results = {
  startedAt: new Date().toISOString(),
  plan,
  coldStartsMs: [],
  lifecycle: {},
  baseEnvironment: {},
  persistence: {},
  network: {},
  harnesses: {},
  cleanup: [],
  limitations: [],
};

const liveSandboxes = new Map();

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function timed(operation) {
  const started = nowMs();
  const value = await operation();
  return { value, elapsedMs: nowMs() - started };
}

function compactCommand(result) {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.trim().slice(0, 2_000),
    stderr: result.stderr.trim().slice(0, 2_000),
  };
}

async function createSandbox(label, options = {}) {
  const measured = await timed(() => Sandbox.create("base", {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 10 * 60 * 1_000,
    lifecycle: { onTimeout: "pause", autoResume: false },
    metadata: { purpose: "novus-e2b-feasibility", label },
    ...options,
  }));
  liveSandboxes.set(measured.value.sandboxId, measured.value);
  return measured;
}

async function killSandbox(sandbox, label) {
  try {
    await sandbox.kill();
    results.cleanup.push({ label, sandboxId: sandbox.sandboxId, killed: true });
  } catch (error) {
    results.cleanup.push({ label, sandboxId: sandbox.sandboxId, killed: false, error: String(error) });
  } finally {
    liveSandboxes.delete(sandbox.sandboxId);
  }
}

async function installHarnesses(sandbox) {
  const install = await sandbox.commands.run(
    "npm install --global @anthropic-ai/claude-code @openai/codex",
    { timeoutMs: 8 * 60 * 1_000 },
  );
  const versions = await sandbox.commands.run(
    "claude --version && codex --version",
    { timeoutMs: 60_000 },
  );
  return { install: compactCommand(install), versions: compactCommand(versions) };
}

async function testHarnessAuthentication(sandbox) {
  const auth = {};

  if (sendOpenAiKey && process.env.OPENAI_API_KEY) {
    const codex = await sandbox.commands.run(
      "codex exec --json --skip-git-repo-check 'Reply with exactly NOVUS_CODEX_OK and do not use tools.'",
      {
        timeoutMs: 3 * 60 * 1_000,
        envs: { CODEX_API_KEY: process.env.OPENAI_API_KEY },
      },
    );
    auth.codex = compactCommand(codex);
  } else {
    auth.codex = { skipped: true, reason: "Set NOVUS_SPIKE_SEND_OPENAI_KEY=1 with OPENAI_API_KEY to authorize transmission." };
  }

  if (sendAnthropicKey && process.env.ANTHROPIC_API_KEY) {
    const claude = await sandbox.commands.run(
      "claude -p --output-format stream-json --verbose 'Reply with exactly NOVUS_CLAUDE_OK and do not use tools.'",
      {
        timeoutMs: 3 * 60 * 1_000,
        envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      },
    );
    auth.claude = compactCommand(claude);
  } else {
    auth.claude = { skipped: true, reason: "Set NOVUS_SPIKE_SEND_ANTHROPIC_KEY=1 with ANTHROPIC_API_KEY to authorize transmission." };
  }

  return auth;
}

async function resolveRequiredDestinationIps(sandbox) {
  const hosts = requiredDestinations.map((host) => `'${host}'`).join(" ");
  const resolution = await sandbox.commands.run(
    `for host in ${hosts}; do getent ahostsv4 "$host" | awk -v host="$host" '{print host " " $1}'; done`,
    { timeoutMs: 60_000 },
  );

  const entries = resolution.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/, 2))
    .filter(([host, ip]) => requiredDestinations.includes(host) && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip));

  const byHost = Object.fromEntries(requiredDestinations.map((host) => [host, []]));
  for (const [host, ip] of entries) {
    if (!byHost[host].includes(ip)) byHost[host].push(ip);
  }

  const unresolved = requiredDestinations.filter((host) => byHost[host].length === 0);
  if (unresolved.length > 0) {
    throw new Error(`Could not resolve required destinations inside E2B: ${unresolved.join(", ")}`);
  }

  return {
    command: compactCommand(resolution),
    byHost,
    allowOut: [...new Set(Object.values(byHost).flat())],
  };
}

async function run() {
  for (let sample = 1; sample <= coldStartSamples; sample += 1) {
    const measured = await createSandbox(`cold-start-${sample}`);
    results.coldStartsMs.push(measured.elapsedMs);
    await killSandbox(measured.value, `cold-start-${sample}`);
  }

  const primaryMeasured = await createSandbox("lifecycle");
  const primary = primaryMeasured.value;
  results.lifecycle.createMs = primaryMeasured.elapsedMs;

  const inventory = await primary.commands.run(
    "uname -a; printf '\\nnode='; node --version 2>/dev/null || true; printf '\\nnpm='; npm --version 2>/dev/null || true; printf '\\ngit='; git --version 2>/dev/null || true",
  );
  results.baseEnvironment = compactCommand(inventory);

  await primary.files.write("/home/user/novus-persistence-marker.txt", `created=${Date.now()}\n`);
  await primary.commands.run(
    "nohup sh -c 'while true; do date +%s >> /home/user/novus-heartbeat.txt; sleep 1; done' >/home/user/novus-heartbeat.log 2>&1 & echo $! > /home/user/novus-heartbeat.pid",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  const beforePause = await primary.commands.run(
    "test -f /home/user/novus-persistence-marker.txt && test -s /home/user/novus-heartbeat.txt && kill -0 $(cat /home/user/novus-heartbeat.pid)",
  );
  results.persistence.beforePause = compactCommand(beforePause);

  const pause = await timed(() => primary.pause());
  results.lifecycle.pauseMs = pause.elapsedMs;

  const reconnect = await timed(() => Sandbox.connect(primary.sandboxId, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 10 * 60 * 1_000,
  }));
  const resumed = reconnect.value;
  liveSandboxes.set(resumed.sandboxId, resumed);
  results.lifecycle.resumeMs = reconnect.elapsedMs;

  const afterResume = await resumed.commands.run(
    "test -f /home/user/novus-persistence-marker.txt && test -s /home/user/novus-heartbeat.txt && kill -0 $(cat /home/user/novus-heartbeat.pid); printf 'heartbeat_lines='; wc -l < /home/user/novus-heartbeat.txt",
  );
  results.persistence.afterResume = compactCommand(afterResume);

  results.harnesses.installation = await installHarnesses(resumed);
  results.harnesses.authentication = await testHarnessAuthentication(resumed);

  const resolvedDestinations = await resolveRequiredDestinationIps(resumed);
  results.network.resolution = resolvedDestinations;

  await killSandbox(resumed, "lifecycle");

  const networkMeasured = await createSandbox("network-policy", {
    allowInternetAccess: true,
    network: {
      allowOut: resolvedDestinations.allowOut,
      // E2B rejects IPv6 CIDRs in denyOut ("400: invalid denied CIDR ::/0", observed 2026-08-01);
      // IPv4 default-deny only — IPv6 reachability is asserted separately by deniedDefaultRoute.
      denyOut: ["0.0.0.0/0"],
    },
  });
  const networkSandbox = networkMeasured.value;
  results.network.createMs = networkMeasured.elapsedMs;

  const allowed = await networkSandbox.commands.run(
    `for host in ${requiredDestinations.map((host) => `'${host}'`).join(" ")}; do code=$(curl -4 -LIsS --max-time 10 -o /dev/null -w '%{http_code}' "https://$host/" || true); printf '%s=%s\\n' "$host" "$code"; done`,
    { timeoutMs: 90_000 },
  );
  const deniedIpv4 = await networkSandbox.commands.run(
    "if curl -4 -LIsS --max-time 10 https://example.com/ >/dev/null 2>&1; then echo UNEXPECTEDLY_ALLOWED_IPV4; exit 1; else echo DENIED_AS_EXPECTED_IPV4; fi",
    { timeoutMs: 30_000 },
  );
  const deniedDefaultRoute = await networkSandbox.commands.run(
    "if curl -LIsS --max-time 10 https://example.com/ >/dev/null 2>&1; then echo UNEXPECTEDLY_ALLOWED_DEFAULT_ROUTE; exit 1; else echo DENIED_AS_EXPECTED_DEFAULT_ROUTE; fi",
    { timeoutMs: 30_000 },
  );
  results.network.allowed = compactCommand(allowed);
  results.network.deniedIpv4 = compactCommand(deniedIpv4);
  results.network.deniedDefaultRoute = compactCommand(deniedDefaultRoute);

  await killSandbox(networkSandbox, "network-policy");
}

async function cleanupRemaining() {
  for (const [sandboxId, sandbox] of [...liveSandboxes]) {
    await killSandbox(sandbox, `emergency-${sandboxId}`);
  }
}

try {
  await run();
  results.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  results.finishedAt = new Date().toISOString();
  results.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  await cleanupRemaining();
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  await cleanupRemaining();
}
