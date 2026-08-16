import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { buildServer } from "./server.ts";
import { startReliabilitySweep } from "./reliability.ts";
import { startPullRequestSweep } from "./publication.ts";
import { selectRepositoryProvider } from "./repo-provider.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
// One provider instance for the routes and the sweep alike: the fake's
// in-memory host state must be the same host both talk to.
const provider = selectRepositoryProvider(config);
const app = buildServer(pool, config, provider);

// A host that disappears and a controller who disappears are both defined by an
// absence, so they are swept rather than triggered. Started here rather than in
// buildServer: a server constructed for a test should not acquire a background
// timer against a database that test is about to drop.
const stopSweep = startReliabilitySweep(pool);
app.addHook("onClose", async () => stopSweep());

// The host's side of an open pull request — state, reviews, mergeability —
// polled on the same shape (D-099): a local-first control plane has no public
// webhook endpoint, so the poll is the transport and webhooks arrive with a
// deployed one. Same rule as above: never started from buildServer.
const pullSweepMs = Number(process.env.NOVUS_PR_SWEEP_MS ?? 15_000);
const stopPullSweep = startPullRequestSweep(
  pool,
  provider,
  Number.isFinite(pullSweepMs) && pullSweepMs >= 1_000 ? pullSweepMs : 15_000
);
app.addHook("onClose", async () => stopPullSweep());

await app.listen({ port: config.port, host: "127.0.0.1" });
console.warn(`novus control plane listening on ${config.publicBaseUrl}`);
