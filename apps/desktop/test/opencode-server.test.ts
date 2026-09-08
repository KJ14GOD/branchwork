import { expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { OpenCodeServer, shutdownOpenCode } from "../electron/opencode-server";

it("app shutdown kills catalogue probes too and prevents a late probe spawning", async () => {
  const root = mkdtempSync(join(tmpdir(), "novus-opencode-shutdown-"));
  const pathBefore = process.env.PATH;
  const servers: OpenCodeServer[] = [];
  try {
    copyFileSync(join(__dirname, "fixtures/opencode.cjs"), join(root, "opencode"));
    chmodSync(join(root, "opencode"), 0o755);
    writeFileSync(join(root, "mode"), "approval");
    process.env.PATH = `${root}${delimiter}${pathBefore ?? ""}`;
    servers.push(new OpenCodeServer(root, {}, {}));
    await servers[0]!.ready;
    const configHome = JSON.parse(readFileSync(join(root, "launch.json"), "utf8")).configHome;
    await shutdownOpenCode();
    expect(() => process.kill(servers[0]!.child.pid!, 0)).toThrow();
    expect(existsSync(configHome)).toBe(false);
    expect(() => new OpenCodeServer(root, {}, {})).toThrow("closing");
  } finally {
    for (const server of servers) server.stop();
    await Promise.all(servers.map((server) => server.closed));
    if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
    rmSync(root, { recursive: true, force: true });
  }
});
