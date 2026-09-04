import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DictationEvent } from "@novus/contracts";
import { LIVE_SAMPLE_RATE, pcm16FromBytes } from "../electron/dictation-audio";
import { createAppleSpeech, HELPER_NAME } from "../electron/dictation-apple";
import { createDictation, type CaptureHost } from "../electron/dictation";
import { DictationStore } from "../electron/dictation-store";

/**
 * A long take through the whole real hearing path at real-time pace
 * (D-242 and D-244, owner-hit: "it just gets stopped", "it takes over the words already there"): the
 * orchestrator, the capture frames, the helper, and Apple's on-device
 * recognizer, on a synthesized dictation of several sentences with natural
 * pauses between them — the pauses commit segments, the way a person's do.
 * The editor is a stand-in that echoes, so what is measured is hearing
 * alone: every segment settles, nothing is dropped after a pause, no error
 * ends the take. Opt-in, two minutes of wall clock:
 *
 *   pnpm --filter @novus/desktop build
 *   NOVUS_LIVE_DICTATION_LONG=1 pnpm --filter @novus/desktop exec vitest run test/live-dictation-long.test.ts
 */

const LIVE = process.env.NOVUS_LIVE_DICTATION_LONG === "1";
const helperPath = resolve(__dirname, "..", "dist-electron", HELPER_NAME);

const SENTENCES = [
  "Refactor composer dot T S X so the dictation bridge uses I P C renderer dot send.",
  "Then run pnpm build in apps slash desktop, and re-run the connectors spec with vitest.",
  "Also check that the zod schema in packages slash contracts validates the new dictation event.",
  "After that, look at preload dot T S and make sure the bridge exposes request access.",
  "The settings page should say which engines this Mac has, and the microphone state.",
  "Finally write a short note in progress dot M D about what was measured and what was not.",
  "One more thing, the helper must open a new recognition request only after the previous one answered.",
  "And when the take stops, the last segment gets its full stop from the stop itself."
];

/** The sentences with a pause between them, as `say` renders it: a short
 *  one and a long one by turns — the long ones are the pauses after which
 *  the on-device recognizer starts its transcript over (D-244), and the
 *  words before them must still arrive. */
const SPOKEN = SENTENCES.map((sentence, index) => (index % 2 === 0 ? `${sentence} [[slnc 1100]]` : `${sentence} [[slnc 3500]]`)).join(" ");

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/\[\[slnc \d+\]\]/g, " ")
    .replace(/[^a-z0-9./_\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);

function synthesize(): Int16Array {
  const dir = mkdtempSync(join(tmpdir(), "novus-live-long-"));
  const wav = join(dir, "spoken.wav");
  execFileSync("say", ["-v", "Samantha", "--file-format=WAVE", `--data-format=LEI16@${LIVE_SAMPLE_RATE}`, "-o", wav, SPOKEN]);
  const bytes = readFileSync(wav);
  rmSync(dir, { recursive: true, force: true });
  return pcm16FromBytes(bytes.subarray(44));
}

/** A microphone that plays the take at real time, 100 ms a frame. */
function playbackCapture(pcm: Int16Array): CaptureHost & { finished: Promise<void> } {
  const listeners = new Set<(frame: Int16Array) => void>();
  let timer: NodeJS.Timeout | null = null;
  let settleFinished: () => void = () => undefined;
  const finished = new Promise<void>((settle) => {
    settleFinished = settle;
  });
  return {
    finished,
    start: async (sampleRate, frameMs) => {
      const step = Math.floor((sampleRate * frameMs) / 1000);
      let at = 0;
      timer = setInterval(() => {
        if (at >= pcm.length) {
          if (timer) clearInterval(timer);
          timer = null;
          settleFinished();
          return;
        }
        const frame = pcm.subarray(at, Math.min(pcm.length, at + step));
        at += step;
        for (const listener of listeners) listener(frame);
      }, frameMs);
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onEnded: () => () => undefined
  };
}

describe.skipIf(!LIVE)("a long take through the real hearing path at real time (D-242)", () => {
  it("settles every sentence across the pauses, and no error ends the take", async () => {
    expect(existsSync(helperPath), "build the desktop first: the helper lives in dist-electron").toBe(true);
    const pcm = synthesize();
    const capture = playbackCapture(pcm);
    const speech = createAppleSpeech({
      helperPath,
      helperPresent: () => existsSync(helperPath),
      spawn: (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    });
    const userData = mkdtempSync(join(tmpdir(), "novus-live-long-store-"));
    const store = new DictationStore({ userDataPath: userData });
    store.setPrefs({ refine: true });
    const started = Date.now();
    const events: { at: number; event: DictationEvent }[] = [];
    const dictation = createDictation({
      store,
      vendor: {
        probe: async () => ({ speech: { kind: "apple", ...(await speech.probe()) }, editor: { kind: "claude", model: "echo" } }),
        authorizeSpeech: async () => ({ speech: { kind: "apple", ...(await speech.authorize()) }, editor: { kind: "claude", model: "echo" } }),
        live: (args, handlers) => speech.live(args.vocabulary, args.sampleRate, handlers),
        // The editor echoes: hearing alone is under measurement.
        refine: async ({ user }) => user.split("RAW TRANSCRIPT: ").pop() ?? ""
      },
      capture,
      microphone: { status: () => "granted", ask: async () => "granted", openSettings: async () => undefined },
      openSpeechSettings: async () => undefined,
      sources: async () => ({ files: ["apps/desktop/src/components/composer.tsx", "apps/desktop/electron/preload.ts", "PROGRESS.md"], changed: [], words: [], goal: null, recent: [] }),
      emit: (event) => {
        events.push({ at: Date.now() - started, event });
        if (event.kind === "final" || event.kind === "error" || event.kind === "state") {
          console.warn(`[live-long] ${((Date.now() - started) / 1000).toFixed(1)}s ${JSON.stringify(event).slice(0, 220)}`);
        }
      }
    });
    await dictation.start({});
    await capture.finished;
    // A person waits a beat after their last word before stopping.
    await new Promise((settle) => setTimeout(settle, 1_500));
    await dictation.stop();
    rmSync(userData, { recursive: true, force: true });

    const finals = events.filter((entry) => entry.event.kind === "final").map((entry) => (entry.event as { text: string }).text);
    const errors = events.filter((entry) => entry.event.kind === "error").map((entry) => (entry.event as { message: string }).message);
    const refined = events.find((entry) => entry.event.kind === "refined")?.event as { raw: string; text: string; note: string | null } | undefined;
    const heard = words(refined?.raw ?? "");
    const spoken = words(SPOKEN);
    console.warn(`[live-long] segments ${finals.length}, heard ${heard.length} of ${spoken.length} words, errors ${JSON.stringify(errors)}, note ${refined?.note}`);
    console.warn(`[live-long] raw: ${refined?.raw}`);
    expect(errors).toEqual([]);
    expect(refined?.note ?? null).toBeNull();
    // The pauses committed segments — one per eight seconds or so, two
    // sentences each — and none of the sentences vanished.
    expect(finals.length).toBeGreaterThanOrEqual(Math.floor(SENTENCES.length / 2));
    // Before D-244 the sentences before each long pause were lost outright.
    expect(heard.length).toBeGreaterThan(spoken.length * 0.85);
  }, 240_000);
});
