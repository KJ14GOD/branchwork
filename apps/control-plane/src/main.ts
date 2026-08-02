import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { buildServer } from "./server.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = buildServer(pool, config);
await app.listen({ port: config.port, host: "127.0.0.1" });
console.warn(`novus control plane listening on ${config.publicBaseUrl}`);
