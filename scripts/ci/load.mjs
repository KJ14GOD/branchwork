// The control plane under concurrency (owner-asked, 2026-09-10: "test it on
// scalable stuff"): one node, a real PostgreSQL, the fake GitHub host, and
// the read routes a desktop client hits every few seconds — health, the
// mission list, one mission's detail — driven at N connections for S
// seconds each. Honest about what it measures: one process on one machine,
// latency and throughput, no cloud. Fails when p95 crosses the bar.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

const CONNECTIONS = Number(process.env.NOVUS_LOAD_CONNECTIONS ?? "50");
const SECONDS = Number(process.env.NOVUS_LOAD_SECONDS ?? "20");
const P95_BAR_MS = Number(process.env.NOVUS_LOAD_P95_MS ?? "250");
const CP_PORT = 4470;
const CP_URL = `http://127.0.0.1:${CP_PORT}`;
const DB_URL = process.env.NOVUS_DATABASE_URL ?? "postgres://novus:novus@127.0.0.1:5433/novus";

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms));

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${CP_URL}/health`)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("control plane never became healthy");
}

async function mintToken() {
  const started = await fetch(`${CP_URL}/auth/github/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const { state, authorizeUrl } = await started.json();
  await fetch(authorizeUrl, { redirect: "follow" });
  const claimed = await fetch(`${CP_URL}/auth/github/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state }) });
  const { token } = await claimed.json();
  if (!token) throw new Error("no token");
  return token;
}

/** N connections, each a loop of requests, for S seconds; latencies kept. */
async function hammer(name, url, headers) {
  const latencies = [];
  let errors = 0;
  const end = Date.now() + SECONDS * 1000;
  const worker = async () => {
    while (Date.now() < end) {
      const t0 = performance.now();
      try {
        const response = await fetch(url, { headers });
        if (!response.ok) errors += 1;
        await response.arrayBuffer();
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  latencies.sort((a, b) => a - b);
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
  const report = {
    name,
    requests: latencies.length,
    errors,
    rps: Math.round(latencies.length / SECONDS),
    p50_ms: Math.round(at(0.5)),
    p95_ms: Math.round(at(0.95)),
    p99_ms: Math.round(at(0.99)),
    max_ms: Math.round(latencies[latencies.length - 1] ?? 0)
  };
  console.log(JSON.stringify(report));
  return report;
}

const controlPlane = spawn(process.execPath, ["--experimental-strip-types", "apps/control-plane/src/main.ts"], {
  env: { ...process.env, NOVUS_FAKE_GITHUB: "1", NOVUS_CP_PORT: String(CP_PORT), NOVUS_DATABASE_URL: DB_URL },
  stdio: ["ignore", "inherit", "inherit"]
});
try {
  await waitForHealth();
  const token = await mintToken();
  const headers = { authorization: `Bearer ${token}` };
  // One mission to read, on the fake provider's repository.
  const created = await fetch(`${CP_URL}/missions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      goal: "Load",
      successCriteria: "Reads stay fast",
      provider: "github",
      providerRepoId: "9001",
      baseRef: "main",
      baseSha: createHash("sha1").update("demo-app@main").digest("hex"),
      creationKey: randomUUID()
    })
  });
  if (!created.ok) throw new Error(`mission creation ${created.status}: ${await created.text()}`);
  const { mission } = await created.json();
  const reports = [];
  reports.push(await hammer("health", `${CP_URL}/health`, {}));
  reports.push(await hammer("missions.list", `${CP_URL}/missions`, headers));
  reports.push(await hammer("missions.detail", `${CP_URL}/missions/${mission.missionId}`, headers));
  writeFileSync("load-report.json", JSON.stringify({ connections: CONNECTIONS, seconds: SECONDS, p95BarMs: P95_BAR_MS, reports }, null, 2));
  const slow = reports.filter((report) => report.p95_ms > P95_BAR_MS || report.errors > 0);
  if (slow.length > 0) {
    console.error(`over the bar: ${slow.map((report) => `${report.name} p95 ${report.p95_ms}ms errors ${report.errors}`).join("; ")}`);
    process.exitCode = 1;
  }
} finally {
  controlPlane.kill("SIGTERM");
}
