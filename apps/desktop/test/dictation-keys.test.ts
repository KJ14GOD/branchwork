import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DictationEvent } from "@novus/contracts";

/**
 * The dictate chord's two ways (D-243): a tap starts a take that runs until
 * the next tap; a hold is push-to-talk and the take ends when the key
 * lifts; key repeat — a held key firing many times a second, which used to
 * stop and restart the take until nothing was heard — is the shell's to
 * ignore, and a press while listening stops. The bridge is a stub; the
 * store under test is the renderer's own.
 */

type Bridge = {
  start: (input: unknown) => Promise<{ ok: true; value: { sessionId: string } }>;
  stop: () => Promise<{ ok: true; value: null }>;
  cancel: () => Promise<{ ok: true; value: null }>;
  settings: () => Promise<unknown>;
  setPrefs: () => Promise<unknown>;
  requestAccess: () => Promise<unknown>;
  onEvent: (listener: (event: DictationEvent) => void) => () => void;
};

let calls: string[];
// The store wires itself to the bridge once, at first use; the listener it
// registered then is the one every test speaks through.
let deliver: ((event: DictationEvent) => void) | null = null;

beforeEach(() => {
  calls = [];
  const dictation: Bridge = {
    start: async () => {
      calls.push("start");
      return { ok: true, value: { sessionId: "dct_1" } };
    },
    stop: async () => {
      calls.push("stop");
      return { ok: true, value: null };
    },
    cancel: async () => {
      calls.push("cancel");
      return { ok: true, value: null };
    },
    settings: async () => ({ ok: true }),
    setPrefs: async () => ({ ok: true }),
    requestAccess: async () => ({ ok: true }),
    onEvent: (listener) => {
      deliver ??= listener;
      return () => undefined;
    }
  };
  (globalThis as { window?: unknown }).window = { novus: { dictation } };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the dictate chord (D-243)", () => {
  it("a tap starts a take and leaves it running; a second press stops it", async () => {
    const store = await import("../src/components/dictation");
    const off = store.registerComposer({
      id: "box",
      toggle: () => {
        void store.startDictation("box", {});
      },
      enabled: () => true,
      hasFocus: () => true
    });
    expect(store.pressDictationKey()).toBe(true);
    await settle();
    expect(calls).toEqual(["start"]);
    deliver?.({ kind: "state", sessionId: "dct_1", state: "listening", startedAtMs: 1 });
    // A quick tap: the release changes nothing.
    store.releaseDictationKey();
    await settle();
    expect(calls).toEqual(["start"]);
    // The next press, while listening, stops.
    expect(store.pressDictationKey()).toBe(true);
    await settle();
    expect(calls).toEqual(["start", "stop"]);
    off();
    deliver?.({ kind: "state", sessionId: "dct_1", state: "idle", startedAtMs: null });
  });

  it("a held press is push-to-talk: the take ends when the key lifts", async () => {
    const store = await import("../src/components/dictation");
    const off = store.registerComposer({
      id: "box2",
      toggle: () => {
        void store.startDictation("box2", {});
      },
      enabled: () => true,
      hasFocus: () => true
    });
    expect(store.pressDictationKey()).toBe(true);
    await settle();
    deliver?.({ kind: "state", sessionId: "dct_1", state: "listening", startedAtMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, store.HOLD_TO_TALK_MS + 20));
    store.releaseDictationKey();
    await settle();
    expect(calls).toEqual(["start", "stop"]);
    off();
    deliver?.({ kind: "state", sessionId: "dct_1", state: "idle", startedAtMs: null });
  });

  it("does nothing where no box is", async () => {
    const store = await import("../src/components/dictation");
    expect(store.pressDictationKey()).toBe(false);
    store.releaseDictationKey();
    await settle();
    expect(calls).toEqual([]);
  });
});
