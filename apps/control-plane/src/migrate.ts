import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
await pool.end();
console.warn("schema applied");
