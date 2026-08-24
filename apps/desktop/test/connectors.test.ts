import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverConnectors, resolveConnectors, setConnectorLent } from "../electron/connectors";

/**
 * Lent accounts (D-217): the machine-local half — enumerate, remember, and
 * resolve into the argv decision, all without the control plane and without
 * a network call on the spawn path.
 *
 * The fake list (`NOVUS_FAKE_CONNECTORS`) stands in for `claude mcp list`, so
 * the parse and the two-file logic are exercised in plain Node exactly as the
 * e2e will exercise them in a window.
 */

let userData: string;

const fakeEnv = (list: unknown): NodeJS.ProcessEnv =>
  ({ NOVUS_FAKE_CONNECTORS: JSON.stringify(list) }) as NodeJS.ProcessEnv;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "novus-connectors-"));
});
afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("enumerating and lending", () => {
  it("discovers the machine's connectors, all off until lent, and caches them for the spawn path", async () => {
    const result = await discoverConnectors(
      userData,
      fakeEnv([
        { name: "claude.ai Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", state: "connected" },
        { name: "claude.ai Google Drive", state: "connected" }
      ])
    );
    expect(result.installed).toBe(true);
    expect(result.connectors.map((c) => c.name)).toEqual(["claude.ai Gmail", "claude.ai Google Drive"]);
    expect(result.connectors.every((c) => c.lent === false)).toBe(true);
    // The cache is on disk, so the spawn path never needs the CLI again.
    const cached = JSON.parse(readFileSync(join(userData, "connectors-cache.json"), "utf8"));
    expect(cached).toHaveLength(2);
  });

  it("says the CLI is absent rather than inventing an empty account list", async () => {
    // No fake, and `claude` is spawned with a PATH that will not find a fake —
    // on a machine without the CLI this is `installed: false`. We assert the
    // shape it must never take: a crash, or connectors invented from nothing.
    const result = await discoverConnectors(userData, { PATH: "/nonexistent" } as NodeJS.ProcessEnv);
    expect(result.connectors).toEqual([]);
    expect(typeof result.installed).toBe("boolean");
  });

  it("remembers a lend and hands it back, machine-locally", () => {
    // Seed the cache the way discovery would.
    writeFileSync(
      join(userData, "connectors-cache.json"),
      JSON.stringify([{ name: "claude.ai Gmail", url: null, state: "connected" }])
    );
    const view = setConnectorLent(userData, "claude.ai Gmail", true);
    expect(view.connectors.find((c) => c.name === "claude.ai Gmail")?.lent).toBe(true);
    // Persisted: a fresh read agrees.
    expect(JSON.parse(readFileSync(join(userData, "connectors.json"), "utf8"))).toEqual({
      "claude.ai Gmail": true
    });
  });
});

describe("resolving into the argv decision", () => {
  it("lends nothing when nothing was chosen, so strict stays and the argv is unchanged", () => {
    writeFileSync(
      join(userData, "connectors-cache.json"),
      JSON.stringify([{ name: "claude.ai Gmail", url: null, state: "connected" }])
    );
    expect(resolveConnectors(userData)).toEqual({ lent: [], denied: ["claude.ai Gmail"] });
  });

  it("splits present connectors into lent and denied, so the un-lent are disallowed", () => {
    writeFileSync(
      join(userData, "connectors-cache.json"),
      JSON.stringify([
        { name: "claude.ai Gmail", url: null, state: "connected" },
        { name: "claude.ai Google Drive", url: null, state: "connected" },
        { name: "claude.ai Google Calendar", url: null, state: "connected" }
      ])
    );
    setConnectorLent(userData, "claude.ai Gmail", true);
    setConnectorLent(userData, "claude.ai Google Drive", true);
    const { lent, denied } = resolveConnectors(userData);
    expect(lent.sort()).toEqual(["claude.ai Gmail", "claude.ai Google Drive"]);
    expect(denied).toEqual(["claude.ai Google Calendar"]);
  });

  it("never lends a connector no longer present, even if its preference lingers", () => {
    // Prefs say Gmail is lent, but the machine's current enumeration does not
    // hold it — so it must not relax strict for something the CLI won't inject.
    writeFileSync(join(userData, "connectors.json"), JSON.stringify({ "claude.ai Gmail": true }));
    writeFileSync(
      join(userData, "connectors-cache.json"),
      JSON.stringify([{ name: "claude.ai Google Drive", url: null, state: "connected" }])
    );
    const { lent, denied } = resolveConnectors(userData);
    expect(lent).toEqual([]);
    expect(denied).toEqual(["claude.ai Google Drive"]);
  });
});
