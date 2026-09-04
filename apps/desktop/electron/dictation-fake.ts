import type { DictationEngines } from "@novus/contracts";
import type { CaptureHost, DictationVendor, LiveHandlers, LiveTranscription } from "./dictation";

/**
 * The deterministic stand-ins (D-240, D-241) for a window driven without a
 * microphone, a recognizer, or an editor: `NOVUS_FAKE_DICTATION=1`. The
 * recognizer speaks a fixed script whatever it hears, the capture page is a
 * tone generator, and the editor makes one fixed edit — so an end-to-end run
 * can prove the product a person touches (the button, the live tail, the
 * settled words, the refined swap and its undo) while the real microphone,
 * the real recognizer, and the real CLI are proven only by a live run, and
 * PROGRESS says so.
 */

export const FAKE_SCRIPT: { at: number; interim?: string; final?: string }[] = [
  { at: 250, interim: "refactor the" },
  { at: 500, interim: "refactor the composer dot" },
  { at: 800, final: "Refactor the composer dot T S X" },
  { at: 1_200, interim: "so it uses" },
  { at: 1_500, interim: "so it uses the dictation" },
  { at: 1_800, final: "so it uses the dictation bridge" }
];

export const FAKE_RAW = "Refactor the composer dot T S X so it uses the dictation bridge";
export const FAKE_REFINED = "Refactor the composer.tsx so it uses the dictation bridge.";

export const FAKE_ENGINES: DictationEngines = {
  speech: { kind: "apple", helper: true, available: true, onDevice: true, authorization: "authorized", locale: "en_US" },
  editor: { kind: "claude", model: "fake-editor" }
};

export function fakeVendor(script: typeof FAKE_SCRIPT = FAKE_SCRIPT): DictationVendor {
  return {
    probe: async () => FAKE_ENGINES,
    authorizeSpeech: async () => FAKE_ENGINES,
    live: async (_args, handlers: LiveHandlers) => {
      const said = new Set<number>();
      const speak = (index: number) => {
        const line = script[index];
        if (!line || said.has(index)) return;
        said.add(index);
        if (line.interim !== undefined) handlers.onInterim(line.interim);
        if (line.final !== undefined) {
          handlers.onFinal(line.final);
          handlers.onInterim("");
        }
      };
      const timers = script.map((line, index) => setTimeout(() => speak(index), line.at));
      let alive = true;
      const close = () => {
        alive = false;
        for (const timer of timers) clearTimeout(timer);
      };
      const session: LiveTranscription = {
        push: () => undefined,
        commit: () => undefined,
        stop: async () => {
          // Whatever the script has not said yet is said now, as a recognizer
          // answers the last commit before it exits.
          close();
          script.forEach((line, index) => {
            if (line.final !== undefined) speak(index);
          });
        },
        cancel: close,
        get alive() {
          return alive;
        }
      };
      return session;
    },
    refine: async ({ user }) => {
      // One segment at a time (D-242): the sentence closes only where the
      // ask says the dictation ends, so joined segments read as one.
      const raw = user.split("RAW TRANSCRIPT: ").pop() ?? "";
      const edited = raw.replace(/composer dot T S X/i, "composer.tsx").trim().replace(/[.]+$/, "");
      const last = user.includes("Position: this is the last segment");
      return last ? `${edited}.` : edited;
    }
  };
}

/** A microphone that hears a steady tone: loud enough to count as speech,
 *  so the fake take is never answered "nothing heard". */
export function fakeCapture(): CaptureHost {
  const frameListeners = new Set<(pcm: Int16Array) => void>();
  let timer: NodeJS.Timeout | null = null;
  return {
    start: async (sampleRate, frameMs) => {
      const samples = Math.floor((sampleRate * frameMs) / 1000);
      const frame = new Int16Array(samples);
      for (let at = 0; at < samples; at += 1) frame[at] = Math.round(Math.sin(at / 8) * 0.3 * 0x7fff);
      timer = setInterval(() => {
        for (const listener of frameListeners) listener(frame);
      }, frameMs);
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onEnded: () => () => undefined
  };
}
