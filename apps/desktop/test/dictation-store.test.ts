import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationStore } from "../electron/dictation-store";
import { FAKE_ENGINES } from "../electron/dictation-fake";

/**
 * The dictation preferences (D-240, D-241): the final pass, the person's
 * dictionary, and the engines the last probe found — surviving a relaunch,
 * tidied rather than refused, and read as the defaults when torn. Nothing
 * here is a credential, because nothing on this road needs one.
 */

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "novus-dictation-"));
});
afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("the preferences", () => {
  it("default to refining with an empty dictionary and no engines yet, and remember changes", () => {
    const store = new DictationStore({ userDataPath: userData });
    expect(store.prefs()).toEqual({ refine: true, dictionary: [], engines: null });
    store.setPrefs({ refine: false, dictionary: [" Kartik ", "Novus", "novus", "", "zod"] });
    store.setEngines(FAKE_ENGINES);
    const again = new DictationStore({ userDataPath: userData });
    expect(again.prefs()).toEqual({ refine: false, dictionary: ["Kartik", "Novus", "zod"], engines: FAKE_ENGINES });
    again.setEngines(null);
    expect(again.prefs().engines).toBeNull();
    expect(again.prefs().dictionary).toEqual(["Kartik", "Novus", "zod"]);
  });

  it("reads a torn or missing file as the defaults", () => {
    const store = new DictationStore({ userDataPath: userData });
    store.setPrefs({ refine: false });
    rmSync(join(userData, "dictation.json"));
    expect(store.prefs().refine).toBe(true);
  });
});
