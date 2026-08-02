import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * A contiguous port range per workstream, persisted so a relaunch keeps the
 * same one (ARCHITECTURE.md#workspace-configuration-environments-and-processes).
 *
 * Two workstreams of the same repository will run the same dev server, so
 * "whatever is free right now" is not good enough: the range has to be *stable*
 * for a workstream and *disjoint* from every other, or a person restarting one
 * project silently steals the other's port and reads the wrong preview.
 *
 * The allocation starts above 3000 because that is where the default of nearly
 * every framework sits, and skips a range that anything is already listening
 * on, whether Novus knows about it or not.
 */

const RANGE_SIZE = 10;
const FIRST_PORT = 3100;
const LAST_PORT = 65_000;

export interface PortRange {
  start: number;
  end: number;
}

const PortFileSchema = z.record(
  z.object({ start: z.number().int().positive(), end: z.number().int().positive() })
);

export interface PortAllocatorOptions {
  /** Where the allocation survives a relaunch. */
  filePath: string;
  rangeSize?: number;
  firstPort?: number;
  /** Whether a port is available on this machine; injectable so the
   *  skip-what-is-busy rule is testable without racing a real listener. */
  isFree?: (port: number) => Promise<boolean>;
}

export interface PortAllocator {
  /** The workstream's range, allocated on first ask and stable afterwards. */
  rangeFor(workstreamId: string): Promise<PortRange>;
  /** The range this workstream already has, without allocating one. */
  existingRange(workstreamId: string): PortRange | null;
  release(workstreamId: string): void;
}

export function createPortAllocator(options: PortAllocatorOptions): PortAllocator {
  const size = options.rangeSize ?? RANGE_SIZE;
  const first = options.firstPort ?? FIRST_PORT;
  const isFree = options.isFree ?? portIsFree;
  let allocations = load();

  function load(): Record<string, PortRange> {
    try {
      if (!existsSync(options.filePath)) return {};
      const parsed = PortFileSchema.safeParse(JSON.parse(readFileSync(options.filePath, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  function persist(): void {
    try {
      mkdirSync(dirname(options.filePath), { recursive: true });
      writeFileSync(options.filePath, JSON.stringify(allocations, null, 2), { mode: 0o600 });
    } catch (error) {
      // A range that cannot be persisted still works for this run; the honest
      // cost is that a relaunch may hand out a different one.
      console.warn("[workspace] could not persist the port allocation:", messageOf(error));
    }
  }

  return {
    existingRange: (workstreamId) => allocations[workstreamId] ?? null,

    rangeFor: async (workstreamId) => {
      // Re-read: another window of this app may have allocated since we loaded.
      allocations = { ...load(), ...allocations };
      const held = allocations[workstreamId];
      if (held) return held;

      const taken = Object.entries(allocations)
        .filter(([id]) => id !== workstreamId)
        .map(([, range]) => range);

      for (let start = first; start + size - 1 <= LAST_PORT; start += size) {
        const end = start + size - 1;
        if (taken.some((range) => range.start <= end && start <= range.end)) continue;
        if (!(await rangeIsFree(start, end, isFree))) continue;
        const range: PortRange = { start, end };
        allocations[workstreamId] = range;
        persist();
        return range;
      }
      throw new Error("This machine has no free port range left for another workstream.");
    },

    release: (workstreamId) => {
      if (allocations[workstreamId] === undefined) return;
      delete allocations[workstreamId];
      persist();
    }
  };
}

async function rangeIsFree(
  start: number,
  end: number,
  isFree: (port: number) => Promise<boolean>
): Promise<boolean> {
  for (let port = start; port <= end; port += 1) {
    if (!(await isFree(port))) return false;
  }
  return true;
}

/** Free means nothing accepts a bind on the loopback interface right now. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
