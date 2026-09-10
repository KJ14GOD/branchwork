import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetSeen, markSeen, seenAt, unseenSince } from "../src/components/seen";

/** The unread mark's one fact (D-252): finished after you last looked. */
describe("what this person has looked at (D-252)", () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key)
    };
  });
  afterEach(() => {
    forgetSeen();
    storage.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("marks unseen only what finished after the last look, and never what has not finished", () => {
    expect(unseenSince("csn_1", null)).toBe(false);
    expect(unseenSince("csn_1", "2026-09-10T10:00:00.000Z")).toBe(true);
    markSeen("csn_1", "2026-09-10T10:00:00.000Z");
    expect(seenAt("csn_1")).toBe("2026-09-10T10:00:00.000Z");
    expect(unseenSince("csn_1", "2026-09-10T10:00:00.000Z")).toBe(false);
    expect(unseenSince("csn_1", "2026-09-10T10:05:00.000Z")).toBe(true);
  });

  it("keeps the later look, whatever order the looks arrive in", () => {
    markSeen("msn_1", "2026-09-10T10:05:00.000Z");
    markSeen("msn_1", "2026-09-10T10:00:00.000Z");
    expect(seenAt("msn_1")).toBe("2026-09-10T10:05:00.000Z");
    forgetSeen();
    expect(seenAt("msn_1")).toBeNull();
  });

  it("treats a storage that refuses as a machine that never looked", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error("refused");
      },
      setItem: () => {
        throw new Error("refused");
      },
      removeItem: () => undefined
    };
    expect(() => markSeen("x", "2026-09-10T10:00:00.000Z")).not.toThrow();
    expect(unseenSince("x", "2026-09-10T10:00:00.000Z")).toBe(true);
  });
});
