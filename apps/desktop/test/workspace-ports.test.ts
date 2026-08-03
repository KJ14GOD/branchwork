import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortAllocator, portIsFree } from "../electron/workspace-ports";

/**
 * Port ranges per workstream. Two workstreams of the same repository run the
 * same dev server, so the failure this prevents is quiet and nasty: one
 * workstream's preview silently showing the other's app.
 */

let root: string;
let listeners: Server[] = [];

function allocator(filePath: string, isFree?: (port: number) => Promise<boolean>) {
  return createPortAllocator({ filePath, ...(isFree ? { isFree } : {}) });
}

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      listeners.push(server);
      resolve();
    });
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "novus-ports-"));
});

afterEach(async () => {
  await Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve))));
  listeners = [];
  rmSync(root, { recursive: true, force: true });
});

describe("allocation", () => {
  it("gives two workstreams ranges that cannot overlap", async () => {
    const ports = allocator(join(root, "ports.json"), async () => true);
    const first = await ports.rangeFor("wst_one");
    const second = await ports.rangeFor("wst_two");

    expect(first.start).toBeGreaterThan(3000);
    expect(first.end).toBe(first.start + 9);
    expect(second.start).toBeGreaterThan(first.end);
    expect(first.start <= second.end && second.start <= first.end).toBe(false);
  });

  it("keeps the same range for a workstream across a relaunch", async () => {
    const filePath = join(root, "ports.json");
    const first = await allocator(filePath, async () => true).rangeFor("wst_one");
    // A fresh allocator reading the same file is what a relaunch looks like.
    const relaunched = allocator(filePath, async () => true);
    expect(await relaunched.rangeFor("wst_one")).toEqual(first);
    expect(relaunched.existingRange("wst_one")).toEqual(first);
    expect(relaunched.existingRange("wst_never")).toBeNull();
  });

  it("skips a range something is already listening on", async () => {
    const ports = allocator(join(root, "ports.json"));
    const first = await ports.rangeFor("wst_one");
    // Occupy a port in the middle of what would be the next range.
    await occupy(first.end + 4);
    const second = await ports.rangeFor("wst_two");
    expect(second.start).toBeGreaterThan(first.end + 9);
  });

  it("hands a released range back out", async () => {
    const ports = allocator(join(root, "ports.json"), async () => true);
    const first = await ports.rangeFor("wst_one");
    ports.release("wst_one");
    expect(ports.existingRange("wst_one")).toBeNull();
    expect(await ports.rangeFor("wst_two")).toEqual(first);
  });
});

describe("the availability probe", () => {
  it("says a port in use is not free, and a free one is", async () => {
    const ports = allocator(join(root, "ports.json"));
    const range = await ports.rangeFor("wst_probe");
    await occupy(range.start);
    expect(await portIsFree(range.start)).toBe(false);
    expect(await portIsFree(range.start + 1)).toBe(true);
  });
});
