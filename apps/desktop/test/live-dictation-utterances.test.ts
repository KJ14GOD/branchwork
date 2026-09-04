import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LIVE_SAMPLE_RATE, pcm16FromBytes } from "../electron/dictation-audio";
import { createAppleSpeech, HELPER_NAME } from "../electron/dictation-apple";

/**
 * The helper alone, one recognition request, no commit from anyone (D-244,
 * owner-hit: "it takes over the words already there"): after a pause of a
 * couple of seconds Apple's on-device recognizer closes the utterance and
 * starts its transcript over, and the request's own final carries only the
 * words after the last pause. The helper must deliver every utterance the
 * recognizer closed as a final of its own, never twice, so nothing said
 * before a pause is lost. Opt-in, a minute of wall clock:
 *
 *   pnpm --filter @novus/desktop build
 *   NOVUS_LIVE_DICTATION_LONG=1 pnpm --filter @novus/desktop exec vitest run test/live-dictation-utterances.test.ts
 */

const LIVE = process.env.NOVUS_LIVE_DICTATION_LONG === "1";
const helperPath = resolve(__dirname, "..", "dist-electron", HELPER_NAME);

const UTTERANCES = [
  "Refactor the composer so the dictation bridge uses the renderer send.",
  "Then run the build in apps slash desktop and re-run the connectors spec.",
  "Also check that the zod schema validates the new dictation event, and after that look at the preload file and make sure the bridge exposes request access, and the settings page should say which engines this Mac has and the microphone state, and finally write a short note in progress about what was measured and what was not.",
  "That is the end of the take."
];
const PAUSES = ["[[slnc 3500]]", "[[slnc 4500]]", "[[slnc 2500]]"];
const SPOKEN = UTTERANCES.map((utterance, index) => `${utterance} ${PAUSES[index] ?? ""}`).join(" ");

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/\[\[slnc \d+\]\]/g, " ")
    .replace(/[^a-z0-9./_\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);

describe.skipIf(!LIVE)("the helper delivers every utterance the recognizer closes on its own (D-244)", () => {
  it("loses nothing before a long pause, and repeats nothing after it", async () => {
    expect(existsSync(helperPath), "build the desktop first: the helper lives in dist-electron").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "novus-live-utterances-"));
    const wav = join(dir, "spoken.wav");
    execFileSync("say", ["-v", "Samantha", "--file-format=WAVE", `--data-format=LEI16@${LIVE_SAMPLE_RATE}`, "-o", wav, SPOKEN]);
    const pcm = pcm16FromBytes(readFileSync(wav).subarray(44));
    rmSync(dir, { recursive: true, force: true });
    const speech = createAppleSpeech({
      helperPath,
      helperPresent: () => existsSync(helperPath),
      spawn: (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }),
      log: (line) => console.warn(`[live-utterances] ${line}`)
    });
    const finals: string[] = [];
    const errors: string[] = [];
    let interim = "";
    let resets = 0;
    const live = await speech.live({ terms: [], prompt: "" }, LIVE_SAMPLE_RATE, {
      onInterim: (text) => {
        // The tail starting over with the earlier words undelivered is the fault.
        if (interim.length > 20 && text.length > 0 && text.length < interim.length * 0.6) resets += 1;
        interim = text;
      },
      onFinal: (text) => {
        finals.push(text);
        interim = "";
      },
      onError: (error) => errors.push(error.message)
    });
    // The microphone at real time, a frame every 100 ms, and never a commit.
    const step = Math.floor((LIVE_SAMPLE_RATE * 100) / 1000);
    let at = 0;
    await new Promise<void>((settle) => {
      const timer = setInterval(() => {
        if (at >= pcm.length) {
          clearInterval(timer);
          settle();
          return;
        }
        live.push(pcm.subarray(at, Math.min(pcm.length, at + step)));
        at += step;
      }, 100);
    });
    await new Promise((settle) => setTimeout(settle, 1_500));
    await live.stop();

    const heard = words(finals.join(" "));
    const spoken = words(SPOKEN);
    console.warn(`[live-utterances] finals ${finals.length}, heard ${heard.length} of ${spoken.length} words, resets ${resets}, errors ${JSON.stringify(errors)}`);
    expect(errors).toEqual([]);
    // Every utterance came back as a final of its own, the long one included.
    expect(finals.length).toBe(UTTERANCES.length);
    expect(resets).toBe(0);
    expect(heard.length).toBeGreaterThan(spoken.length * 0.85);
    // Nothing twice: no final begins with the words of the final before it.
    for (let index = 1; index < finals.length; index += 1) {
      const previous = words(finals[index - 1] ?? "").slice(0, 4).join(" ");
      expect(words(finals[index] ?? "").slice(0, 4).join(" ")).not.toBe(previous);
    }
  }, 240_000);
});
