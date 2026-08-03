import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { buildServer } from "./server.ts";
import { startReliabilitySweep } from "./reliability.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = buildServer(pool, config);

// A host that disappears and a controller who disappears are both defined by an
// absence, so they are swept rather than triggered. Started here rather than in
// buildServer: a server constructed for a test should not acquire a background
// timer against a database that test is about to drop.
const stopSweep = startReliabilitySweep(pool);
app.addHook("onClose", async () => stopSweep());

await app.listen({ port: config.port, host: "127.0.0.1" });
console.warn(`novus control plane listening on ${config.publicBaseUrl}`);
