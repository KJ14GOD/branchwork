import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crossSpawn from "cross-spawn";
import { LIVE_SAMPLE_RATE, pcm16FromBytes, speechMillis } from "../electron/dictation-audio";
import { createAppleSpeech, HELPER_NAME } from "../electron/dictation-apple";
import { CLAUDE_EDITOR_MODEL, openEditorSession, runEditor } from "../electron/dictation-editor";
import { guardRefinement, refineSystemPrompt, refineUserPrompt } from "../electron/dictation-refine";
import { buildVocabulary } from "../electron/dictation-vocabulary";

/**
 * The engines, in anger (D-241): the system's own on-device recognizer
 * through the real helper, and Claude Code's print mode on this machine's
 * own login, hearing and editing a synthesized technical utterance through
 * the exact production pieces. Opt-in, because the editor spends the
 * account's usage and the helper must have been built:
 *
 *   pnpm --filter @novus/desktop build
 *   NOVUS_LIVE_DICTATION=1 pnpm --filter @novus/desktop exec vitest run test/live-dictation.test.ts
 *
 * The utterance is macOS's own `say` voice, so the run needs no person at a
 * microphone; a real voice through the capture page is the owner's proof.
 * What this stamps: the helper's dialect as the recognizer speaks it today,
 * the CLI's print mode as this version answers, and how well the names
 * survive — word error rate against the sentence that was spoken, printed.
 */

const LIVE = process.env.NOVUS_LIVE_DICTATION === "1";
const helperPath = resolve(__dirname, "..", "dist-electron", HELPER_NAME);

const SPOKEN =
  "Refactor composer dot T S X so the dictation bridge uses I P C renderer dot send. Then run pnpm build in apps slash desktop, and re-run the connectors spec with vitest.";
const WANTED = "Refactor composer.tsx so the dictation bridge uses ipcRenderer.send. Then run pnpm build in apps/desktop, and re-run the connectors spec with vitest.";

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9./_\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);

/** Word error rate by Levenshtein over words: the measure every board uses. */
function wer(reference: string, hypothesis: string): number {
  const a = words(reference);
  const b = words(hypothesis);
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
    }
  }
  return a.length === 0 ? 0 : rows[a.length]![b.length]! / a.length;
}

function synthesize(): Int16Array {
  const dir = mkdtempSync(join(tmpdir(), "novus-live-dictation-"));
  const wav = join(dir, "spoken.wav");
  execFileSync("say", ["-v", "Samantha", "--file-format=WAVE", `--data-format=LEI16@${LIVE_SAMPLE_RATE}`, "-o", wav, SPOKEN]);
  const bytes = readFileSync(wav);
  rmSync(dir, { recursive: true, force: true });
  return pcm16FromBytes(bytes.subarray(44));
}

describe.skipIf(!LIVE)("a live dictation through this Mac's own engines (D-241)", () => {
  const vocabulary = buildVocabulary({
    dictionary: [],
    changed: ["apps/desktop/src/components/composer.tsx"],
    files: ["apps/desktop/electron/preload.ts", "apps/desktop/e2e/connectors.spec.ts", "packages/contracts/src/index.ts"],
    words: ["use ipcRenderer.send for the frames"]
  });

  it("hears the take live through the helper, then refines it under the guard through Claude Code", async () => {
    expect(existsSync(helperPath), "build the desktop first: the helper lives in dist-electron").toBe(true);
    const speech = createAppleSpeech({
      helperPath,
      helperPresent: () => existsSync(helperPath),
      spawn: (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    });
    const probe = await speech.probe();
    console.warn("[live-dictation] probe:", JSON.stringify(probe));
    expect(probe.available).toBe(true);
    expect(probe.onDevice).toBe(true);

    const pcm = synthesize();
    expect(speechMillis(pcm, LIVE_SAMPLE_RATE)).toBeGreaterThan(5_000);

    // Live: frames at four times real time, a commit mid-way, the finals joined.
    const finals: string[] = [];
    const session = await speech.live(vocabulary, LIVE_SAMPLE_RATE, {
      onInterim: () => undefined,
      onFinal: (text) => finals.push(text),
      onError: (error) => console.warn("[live-dictation] recognizer error:", error.message)
    });
    const frame = Math.floor(LIVE_SAMPLE_RATE / 10);
    const half = Math.floor(pcm.length / 2 / frame) * frame;
    for (let at = 0; at < pcm.length; at += frame) {
      session.push(pcm.subarray(at, Math.min(pcm.length, at + frame)));
      if (at + frame === half) session.commit();
      await new Promise((settle) => setTimeout(settle, 25));
    }
    await session.stop();
    const heard = finals.join(" ");
    console.warn("[live-dictation] heard:", heard, "| WER", wer(WANTED, heard).toFixed(3));
    expect(heard.length).toBeGreaterThan(0);

    // The editor, on this machine's own login, held to the guard.
    const refined = await runEditor({
      kind: "claude",
      model: CLAUDE_EDITOR_MODEL,
      system: refineSystemPrompt(),
      user: refineUserPrompt({ raw: heard, vocabulary: vocabulary.terms, context: { goal: "Add a microphone to the composer" } }),
      // The unit config points CLAUDE_CONFIG_DIR at a fake directory so no
      // suite reads this machine's real ~/.claude; this opt-in run wants
      // exactly that login, so the sentinel is dropped for the editor alone.
      spawn: (command, args, extra) => {
        const env = { ...process.env, ...extra };
        delete env.CLAUDE_CONFIG_DIR;
        return crossSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
      }
    });
    const verdict = guardRefinement(heard, refined, vocabulary.terms);
    console.warn("[live-dictation] refined:", refined, "| WER", wer(WANTED, refined).toFixed(3), "| guard:", JSON.stringify(verdict));
    expect(verdict.accepted).toBe(true);
    expect(refined).toContain("composer.tsx");
    expect(wer(WANTED, refined)).toBeLessThan(wer(WANTED, heard) + 0.001);

    // The warm session (D-242): two segments through one process, timed
    // from the ask to the answer — the wait the stop actually pays.
    const editor = openEditorSession({
      model: CLAUDE_EDITOR_MODEL,
      system: refineSystemPrompt(),
      spawn: (command, args, extra) => {
        const env = { ...process.env, ...extra };
        delete env.CLAUDE_CONFIG_DIR;
        return crossSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
      }
    });
    const halves = finals.length >= 2 ? finals : [heard.slice(0, Math.floor(heard.length / 2)), heard.slice(Math.floor(heard.length / 2))];
    const timings: number[] = [];
    let previous = "";
    for (const [index, half] of halves.entries()) {
      const at = Date.now();
      const answer = await editor.ask(
        refineUserPrompt({
          raw: half,
          vocabulary: vocabulary.terms,
          context: { goal: "Add a microphone to the composer", before: previous, position: index === halves.length - 1 ? "last" : "continues" }
        })
      );
      timings.push(Date.now() - at);
      previous = `${previous} ${answer}`.trim();
    }
    editor.close();
    console.warn("[live-dictation] warm session:", previous, "| ms per ask", JSON.stringify(timings));
    expect(previous.length).toBeGreaterThan(0);
  }, 180_000);
});
