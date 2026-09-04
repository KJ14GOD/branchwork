import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DictationEngines, DictationEvent, MicrophoneAccess } from "@novus/contracts";
import { closeSentence, createDictation, DictationRefused, type CaptureHost, type DictationVendor, type Refiner } from "../electron/dictation";
import { FAKE_ENGINES, FAKE_RAW, FAKE_REFINED, fakeCapture, fakeVendor } from "../electron/dictation-fake";
import { DictationStore } from "../electron/dictation-store";
import { LIVE_SAMPLE_RATE } from "../electron/dictation-audio";

/**
 * The take's state machine (D-240, D-241) in plain Node: what refuses a
 * start, the two permissions, the events a listening take emits, what stop
 * does with the words, and how the guard and the editor's failures land as
 * words rather than as a silent swap. The recognizer, the editor, and the
 * microphone are the deterministic fakes; no key exists anywhere.
 */

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "novus-dictation-"));
});
afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

function harness(
  overrides: {
    microphone?: MicrophoneAccess;
    engines?: DictationEngines;
    vendor?: Partial<DictationVendor>;
    capture?: CaptureHost;
    sources?: { files: string[]; changed: string[]; words: string[]; goal: string | null; recent: string[] };
  } = {}
) {
  const events: DictationEvent[] = [];
  const store = new DictationStore({ userDataPath: userData });
  let mic: MicrophoneAccess = overrides.microphone ?? "granted";
  let asked = 0;
  let speechAsked = 0;
  let speechSettingsOpened = 0;
  const engines = overrides.engines ?? FAKE_ENGINES;
  const base = fakeVendor();
  const vendor: DictationVendor = {
    ...base,
    probe: async () => engines,
    authorizeSpeech: async () => {
      speechAsked += 1;
      return { ...engines, speech: { ...engines.speech, authorization: "authorized" } };
    },
    ...overrides.vendor
  };
  const dictation = createDictation({
    store,
    vendor,
    capture: overrides.capture ?? fakeCapture(),
    microphone: {
      status: () => mic,
      ask: async () => {
        asked += 1;
        mic = "granted";
        return mic;
      },
      openSettings: async () => undefined
    },
    openSpeechSettings: async () => {
      speechSettingsOpened += 1;
    },
    sources: async () => overrides.sources ?? { files: ["src/composer.tsx"], changed: [], words: [], goal: "Add a microphone", recent: [] },
    emit: (event) => events.push(event)
  });
  return { dictation, events, store, asked: () => asked, speechAsked: () => speechAsked, speechSettingsOpened: () => speechSettingsOpened };
}

const refinedOf = (events: DictationEvent[]) =>
  events.find((event) => event.kind === "refined") as { raw: string; text: string; note: string | null } | undefined;

describe("what a start needs", () => {
  it("refuses without the helper, without the on-device model, and under restriction — each in words", async () => {
    const noHelper = harness({ engines: { ...FAKE_ENGINES, speech: { ...FAKE_ENGINES.speech, helper: false } } });
    await expect(noHelper.dictation.start({})).rejects.toMatchObject({ code: "no_helper" });
    const noModel = harness({ engines: { ...FAKE_ENGINES, speech: { ...FAKE_ENGINES.speech, onDevice: false } } });
    await expect(noModel.dictation.start({})).rejects.toMatchObject({ code: "no_speech", message: /System Settings/ });
    const restricted = harness({ engines: { ...FAKE_ENGINES, speech: { ...FAKE_ENGINES.speech, authorization: "restricted" } } });
    await expect(restricted.dictation.start({})).rejects.toMatchObject({ code: "no_speech" });
  });

  it("asks the system for speech recognition once when undetermined, and still listens", async () => {
    const h = harness({ engines: { ...FAKE_ENGINES, speech: { ...FAKE_ENGINES.speech, authorization: "not_determined" } } });
    await h.dictation.start({});
    expect(h.speechAsked()).toBe(1);
    expect(h.store.prefs().engines?.speech.authorization).toBe("authorized");
    await h.dictation.cancel();
  });

  it("asks the system for the microphone once, and refuses when it is denied", async () => {
    const h = harness({ microphone: "not_determined" });
    const { sessionId } = await h.dictation.start({});
    expect(sessionId.startsWith("dct_")).toBe(true);
    expect(h.asked()).toBe(1);
    await h.dictation.cancel();

    const denied = harness({ microphone: "denied" });
    await expect(denied.dictation.start({})).rejects.toMatchObject({ code: "microphone" });
    expect(denied.events.map((event) => event.kind)).toEqual([]);
  });

  it("remembers what the probe found", async () => {
    const h = harness();
    expect(h.store.prefs().engines).toBeNull();
    await h.dictation.start({});
    expect(h.store.prefs().engines).toEqual(FAKE_ENGINES);
    await h.dictation.cancel();
  });

  it("is one take at a time", async () => {
    const h = harness();
    await h.dictation.start({});
    await expect(h.dictation.start({})).rejects.toBeInstanceOf(DictationRefused);
    await h.dictation.cancel();
  });
});

describe("a take, start to finish", () => {
  it("emits the live tail and the settled segments, then the refined words on stop", async () => {
    const h = harness();
    await h.dictation.start({ missionId: "msn_1", draft: { before: "Also ", after: "" } });
    const states = () => h.events.filter((event) => event.kind === "state").map((event) => (event as { state: string }).state);
    expect(states()).toEqual(["starting", "listening"]);
    await wait(2_100);
    const interim = h.events.filter((event) => event.kind === "interim").map((event) => (event as { text: string }).text);
    expect(interim).toContain("refactor the composer dot");
    const finals = h.events.filter((event) => event.kind === "final").map((event) => (event as { text: string }).text);
    expect(finals).toEqual(["Refactor the composer dot T S X", "so it uses the dictation bridge"]);

    await h.dictation.stop();
    expect(states()).toEqual(["starting", "listening", "refining", "idle"]);
    expect(refinedOf(h.events)).toMatchObject({ raw: FAKE_RAW, text: FAKE_REFINED, note: null });
  });

  it("settles what the script had not said yet when stopped early", async () => {
    const h = harness();
    await h.dictation.start({});
    await wait(950);
    await h.dictation.stop();
    expect(refinedOf(h.events)).toMatchObject({ raw: FAKE_RAW, text: FAKE_REFINED });
  });

  it("cancel discards: no refined words, the state back to idle", async () => {
    const h = harness();
    await h.dictation.start({});
    await wait(300);
    await h.dictation.cancel();
    expect(h.events.some((event) => event.kind === "refined")).toBe(false);
    expect((h.events.at(-1) as { state: string }).state).toBe("idle");
    await h.dictation.start({});
    await h.dictation.cancel();
  });

  it("never asks the editor about silence: a quiet take is answered 'nothing heard'", async () => {
    let refined = 0;
    const quietCapture: CaptureHost = {
      start: async () => undefined,
      stop: async () => undefined,
      onFrame: () => () => undefined,
      onEnded: () => () => undefined
    };
    const h = harness({
      vendor: {
        ...fakeVendor([]),
        refine: async () => {
          refined += 1;
          return "should not be asked";
        }
      },
      capture: quietCapture
    });
    await h.dictation.start({});
    await h.dictation.stop();
    expect(refined).toBe(0);
    expect(refinedOf(h.events)).toMatchObject({ raw: "", text: "", note: "Nothing was heard." });
  });

  it("leaves the words as heard when the final pass is off", async () => {
    const h = harness();
    await h.dictation.setPrefs({ refine: false });
    await h.dictation.start({});
    await wait(2_000);
    await h.dictation.stop();
    expect(refinedOf(h.events)).toMatchObject({ text: FAKE_RAW, note: null });
  });

  it("leaves the words as heard, and says why, when no editor CLI is installed", async () => {
    const h = harness({ engines: { ...FAKE_ENGINES, editor: { kind: "none", model: null } } });
    await h.dictation.start({});
    await wait(2_000);
    await h.dictation.stop();
    expect(refinedOf(h.events)).toMatchObject({ text: FAKE_RAW, note: expect.stringMatching(/no coding agent CLI/) });
  });

  it("keeps the transcript as heard when the editor oversteps, and says why", async () => {
    const h = harness({
      vendor: { refine: async () => "Sure! Here is a complete rewrite of your composer with tests and a changelog." }
    });
    await h.dictation.start({});
    await wait(2_000);
    await h.dictation.stop();
    expect(refinedOf(h.events)).toMatchObject({ text: FAKE_RAW, note: expect.stringMatching(/Kept the transcript as heard: the refinement answered/) });
  });

  it("keeps the words when the editor fails, and says so", async () => {
    const h = harness({
      vendor: {
        refine: async () => {
          throw new Error("claude exited 1.");
        }
      }
    });
    await h.dictation.start({});
    await wait(2_000);
    await h.dictation.stop();
    expect(refinedOf(h.events)).toMatchObject({ text: FAKE_RAW, note: "Kept the transcript as heard: claude exited 1." });
  });

  it("hands the vocabulary and the box's context to the editor", async () => {
    const base = fakeVendor();
    let asked = "";
    const h = harness({
      vendor: {
        refine: async ({ system, user }) => {
          asked = user;
          return base.refine({ system, user });
        }
      },
      sources: {
        files: ["apps/desktop/src/components/composer.tsx"],
        changed: ["apps/desktop/electron/preload.ts"],
        words: ["fix ipcRenderer.send"],
        goal: "Add a mic",
        recent: ["make it accurate"]
      }
    });
    await h.dictation.setPrefs({ dictionary: ["Kartik"] });
    await h.dictation.start({ draft: { before: "Please ", after: " thanks" } });
    await wait(2_000);
    await h.dictation.stop();
    expect(asked).toContain("VOCABULARY: Kartik, ipcRenderer.send, preload.ts, apps, composer.tsx");
    expect(asked).toContain("Mission goal: Add a mic");
    expect(asked).toContain("Earlier direction: make it accurate");
    expect(asked).toContain("Text already typed before the dictation: Please ");
    expect(asked).toContain("Text already typed after the dictation:  thanks");
  });
});

describe("refining as it goes (D-242)", () => {
  it("edits each segment in the background with the edited words before it, and the stop waits only for the last", async () => {
    const asks: { user: string; at: number }[] = [];
    const started = Date.now();
    const base = fakeVendor();
    const h = harness({
      vendor: {
        refine: async ({ user }) => {
          asks.push({ user, at: Date.now() - started });
          return base.refine({ system: "", user });
        }
      }
    });
    await h.dictation.start({ draft: { before: "Please ", after: "" } });
    await wait(2_100);
    // Both segments settled while listening; the first was edited well before the stop.
    const segments = h.events.filter((event) => event.kind === "segment") as { index: number; raw: string; text: string }[];
    expect(segments.map((segment) => [segment.index, segment.text])).toEqual([
      [0, "Refactor the composer.tsx"],
      [1, "so it uses the dictation bridge"]
    ]);
    expect(asks).toHaveLength(2);
    expect(asks[0]!.user).toContain("Text already typed before the dictation: Please");
    expect(asks[0]!.user).toContain("Position: more of the dictation follows this segment.");
    expect(asks[1]!.user).toContain("Text already typed before the dictation: Please Refactor the composer.tsx");
    expect(asks[0]!.at).toBeLessThan(1_500);

    const stopAt = Date.now();
    await h.dictation.stop();
    expect(Date.now() - stopAt).toBeLessThan(400);
    // Nothing was left to edit at the stop; the sentence was closed by the stop itself.
    expect(asks).toHaveLength(2);
    expect(refinedOf(h.events)).toMatchObject({ raw: FAKE_RAW, text: FAKE_REFINED, note: null });
  });

  it("tells the editor which segment is the last when the stop lands mid-segment", async () => {
    const asks: string[] = [];
    const base = fakeVendor();
    const h = harness({
      vendor: {
        refine: async ({ user }) => {
          asks.push(user);
          return base.refine({ system: "", user });
        }
      }
    });
    await h.dictation.start({});
    await wait(950);
    await h.dictation.stop();
    expect(asks).toHaveLength(2);
    expect(asks[1]).toContain("Position: this is the last segment of the dictation.");
    expect(refinedOf(h.events)).toMatchObject({ raw: FAKE_RAW, text: FAKE_REFINED });
  });

  it("asks the warm session when one is open, and falls back to a run when it dies", async () => {
    let sessionAsks = 0;
    let runs = 0;
    let alive = true;
    const base = fakeVendor();
    const refiner: Refiner = {
      ask: async (user) => {
        sessionAsks += 1;
        if (sessionAsks === 2) {
          alive = false;
          throw new Error("session gone");
        }
        return base.refine({ system: "", user });
      },
      close: () => {
        alive = false;
      },
      get alive() {
        return alive;
      }
    };
    const h = harness({
      vendor: {
        openRefiner: async () => refiner,
        refine: async ({ user }) => {
          runs += 1;
          return base.refine({ system: "", user });
        }
      }
    });
    await h.dictation.start({});
    await wait(2_100);
    await h.dictation.stop();
    expect(sessionAsks).toBe(2);
    expect(runs).toBe(1);
    expect(alive).toBe(false);
    expect(refinedOf(h.events)).toMatchObject({ text: FAKE_REFINED });
  });

  it("closes a sentence only when the last edit was told more would follow", () => {
    expect(closeSentence("run pnpm build")).toBe("run pnpm build.");
    expect(closeSentence("run pnpm build.")).toBe("run pnpm build.");
    expect(closeSentence("is it done?")).toBe("is it done?");
    expect(closeSentence("")).toBe("");
  });
});

describe("the settings and the two permissions", () => {
  it("reports the engines, the microphone, and the preferences", async () => {
    const h = harness({ microphone: "not_determined" });
    const settings = await h.dictation.settings();
    expect(settings).toEqual({ engines: FAKE_ENGINES, microphone: "not_determined", refine: true, dictionary: [] });
    expect((await h.dictation.setPrefs({ dictionary: ["Novus", "Kartik"] })).dictionary).toEqual(["Novus", "Kartik"]);
  });

  it("asks for the microphone, and asks for or opens speech recognition as its answer stands", async () => {
    const h = harness({ microphone: "not_determined", engines: { ...FAKE_ENGINES, speech: { ...FAKE_ENGINES.speech, authorization: "not_determined" } } });
    expect((await h.dictation.requestAccess("microphone")).microphone).toBe("granted");
    expect(h.asked()).toBe(1);
    await h.dictation.requestAccess("speech");
    expect(h.speechAsked()).toBe(1);
    expect(h.speechSettingsOpened()).toBe(0);

    const denied = harness({ engines: { ...FAKE_ENGINES, speech: { ...FAKE_ENGINES.speech, authorization: "denied" } } });
    await denied.dictation.requestAccess("speech");
    expect(denied.speechAsked()).toBe(0);
    expect(denied.speechSettingsOpened()).toBe(1);
  });
});

describe("the frame arithmetic", () => {
  it("commits a segment at a pause, once enough was said", async () => {
    let commits = 0;
    const listeners = new Set<(pcm: Int16Array) => void>();
    const base = fakeVendor([]);
    const h = harness({
      vendor: {
        live: async (args, handlers) => {
          const session = await base.live(args, handlers);
          return { ...session, commit: () => (commits += 1) };
        }
      },
      capture: {
        start: async () => undefined,
        stop: async () => undefined,
        onFrame: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onEnded: () => () => undefined
      }
    });
    await h.dictation.start({});
    const frame = (loud: boolean) => {
      const samples = LIVE_SAMPLE_RATE / 10;
      const pcm = new Int16Array(samples);
      if (loud) for (let at = 0; at < samples; at += 1) pcm[at] = Math.round(Math.sin(at / 8) * 0.3 * 0x7fff);
      for (const listener of listeners) listener(pcm);
    };
    // Eight seconds of speech, then a pause: one commit, at the pause.
    for (let at = 0; at < 80; at += 1) frame(true);
    expect(commits).toBe(0);
    for (let at = 0; at < 8; at += 1) frame(false);
    expect(commits).toBe(1);
    for (let at = 0; at < 5; at += 1) frame(true);
    for (let at = 0; at < 10; at += 1) frame(false);
    expect(commits).toBe(1);
    await h.dictation.cancel();
  });

  it("commits a young segment at a long pause, before the recognizer starts its transcript over (D-244)", async () => {
    let commits = 0;
    const listeners = new Set<(pcm: Int16Array) => void>();
    const base = fakeVendor([]);
    const h = harness({
      vendor: {
        live: async (args, handlers) => {
          const session = await base.live(args, handlers);
          return { ...session, commit: () => (commits += 1) };
        }
      },
      capture: {
        start: async () => undefined,
        stop: async () => undefined,
        onFrame: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onEnded: () => () => undefined
      }
    });
    await h.dictation.start({});
    const frame = (loud: boolean) => {
      const samples = LIVE_SAMPLE_RATE / 10;
      const pcm = new Int16Array(samples);
      if (loud) for (let at = 0; at < samples; at += 1) pcm[at] = Math.round(Math.sin(at / 8) * 0.3 * 0x7fff);
      for (const listener of listeners) listener(pcm);
    };
    // Two seconds of speech and a pause of a second and a half: the segment
    // is far younger than the eight seconds a short pause needs, and commits.
    for (let at = 0; at < 20; at += 1) frame(true);
    for (let at = 0; at < 14; at += 1) frame(false);
    expect(commits).toBe(0);
    frame(false);
    expect(commits).toBe(1);
    // A cough and a silence is not a segment.
    for (let at = 0; at < 3; at += 1) frame(true);
    for (let at = 0; at < 20; at += 1) frame(false);
    expect(commits).toBe(1);
    await h.dictation.cancel();
  });
});
