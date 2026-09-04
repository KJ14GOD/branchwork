import type { Readable, Writable } from "node:stream";
import type { SpeechAuthorization } from "@novus/contracts";
import type { Vocabulary } from "./dictation-vocabulary";
import type { LiveHandlers, LiveTranscription } from "./dictation";

/**
 * Apple's speech recognizer as the hearing behind dictation (D-241), through
 * Novus's own helper (`native/speech/main.swift`, built beside the app as
 * `novus-speech`). The helper runs the system's on-device recognizer — never
 * Apple's servers — with the vocabulary as its contextual strings, and
 * speaks NDJSON over stdout while it takes framed audio over stdin. Nothing
 * here opens a socket or writes a file; a take never touches the disk.
 *
 * The framing and the event reader are pure so the dialect is testable; the
 * process is injected so a test can drive a fake helper.
 */

export const HELPER_NAME = "novus-speech";

/** The helper's stdin framing: one byte of kind, four of little-endian
 *  length, then the payload. Audio is PCM16 mono at the rate the helper was
 *  started with; commit and stop carry nothing. */
export const FRAME_AUDIO = 0;
export const FRAME_COMMIT = 1;
export const FRAME_STOP = 2;

export function frame(kind: number, payload?: Uint8Array): Buffer {
  const length = payload?.byteLength ?? 0;
  const out = Buffer.alloc(5 + length);
  out[0] = kind;
  out.writeUInt32LE(length, 1);
  if (payload && length > 0) out.set(payload, 5);
  return out;
}

/** Whole lines out of a stream's chunks, with the unfinished tail carried. */
export function readLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const joined = carry + chunk;
  const parts = joined.split("\n");
  const tail = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), carry: tail };
}

export interface SpeechProbe {
  helper: boolean;
  available: boolean;
  onDevice: boolean;
  authorization: SpeechAuthorization;
  locale: string | null;
}

export type HelperEvent =
  | { kind: "ready" }
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string }
  | { kind: "error"; message: string }
  | { kind: "probe"; probe: SpeechProbe };

const AUTHORIZATIONS = new Set<SpeechAuthorization>(["authorized", "denied", "not_determined", "restricted", "unknown"]);

export function readHelperEvent(line: string): HelperEvent | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (event.kind) {
    case "ready":
      return { kind: "ready" };
    case "interim":
      return { kind: "interim", text: typeof event.text === "string" ? event.text : "" };
    case "final":
      return { kind: "final", text: typeof event.text === "string" ? event.text : "" };
    case "error":
      return { kind: "error", message: typeof event.message === "string" ? event.message : "The recognizer reported an error." };
    case "probe": {
      const authorization = event.authorization;
      return {
        kind: "probe",
        probe: {
          helper: true,
          available: event.available === true,
          onDevice: event.onDevice === true,
          authorization:
            typeof authorization === "string" && AUTHORIZATIONS.has(authorization as SpeechAuthorization)
              ? (authorization as SpeechAuthorization)
              : "unknown",
          locale: typeof event.locale === "string" ? event.locale : null
        }
      };
    }
    default:
      return null;
  }
}

/** The vocabulary as the helper takes it: at most a hundred terms, the
 *  recognizer's own ceiling for contextual strings. */
export function termsArgument(vocabulary: Vocabulary): string {
  return JSON.stringify(vocabulary.terms.slice(0, 100));
}

export interface ChildLike {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (command: string, args: string[]) => ChildLike;

export interface AppleSpeech {
  probe(): Promise<SpeechProbe>;
  /** The system's own prompt, the first time; the answer after. */
  authorize(): Promise<SpeechProbe>;
  live(vocabulary: Vocabulary, sampleRate: number, handlers: LiveHandlers): Promise<LiveTranscription>;
}

const ABSENT: SpeechProbe = { helper: false, available: false, onDevice: false, authorization: "unknown", locale: null };

export function createAppleSpeech(deps: {
  helperPath: string;
  helperPresent: () => boolean;
  spawn: SpawnLike;
  /** The locale to hear in; the system's own when null. */
  locale?: string | null;
  /** The helper's own diagnostics, for the machine's log. */
  log?: (line: string) => void;
}): AppleSpeech {
  const localeArgs = deps.locale ? ["--locale", deps.locale] : [];

  /** One short helper run that answers with a probe line. */
  const ask = (mode: "probe" | "authorize", timeoutMs: number): Promise<SpeechProbe> =>
    new Promise((resolve) => {
      if (!deps.helperPresent()) {
        resolve(ABSENT);
        return;
      }
      let child: ChildLike;
      try {
        child = deps.spawn(deps.helperPath, [mode, ...localeArgs]);
      } catch {
        resolve(ABSENT);
        return;
      }
      let settled = false;
      let carry = "";
      const settle = (probe: SpeechProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(probe);
      };
      const timer = setTimeout(() => {
        child.kill();
        settle({ ...ABSENT, helper: true });
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        const read = readLines(carry, chunk);
        carry = read.carry;
        for (const line of read.lines) {
          const event = readHelperEvent(line);
          if (event?.kind === "probe") settle(event.probe);
        }
      });
      child.on("error", () => settle(ABSENT));
      child.on("exit", () => settle({ ...ABSENT, helper: true }));
    });

  return {
    probe: () => ask("probe", 10_000),
    authorize: () => ask("authorize", 200_000),
    live: (vocabulary, sampleRate, handlers) =>
      new Promise((resolve, reject) => {
        if (!deps.helperPresent()) {
          reject(new Error("The speech helper is not beside this build of Novus."));
          return;
        }
        let child: ChildLike;
        try {
          child = deps.spawn(deps.helperPath, ["live", "--rate", String(sampleRate), "--terms", termsArgument(vocabulary), ...localeArgs]);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        let ready = false;
        let exited = false;
        let carry = "";
        let settleStop: (() => void) | null = null;
        const finish = () => {
          if (settleStop) {
            const settle = settleStop;
            settleStop = null;
            settle();
          }
        };
        const readyTimer = setTimeout(() => {
          if (!ready) {
            child.kill();
            reject(new Error("The speech recognizer did not answer in time."));
          }
        }, 10_000);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          const read = readLines(carry, chunk);
          carry = read.carry;
          for (const line of read.lines) {
            const event = readHelperEvent(line);
            if (!event) continue;
            switch (event.kind) {
              case "ready":
                if (!ready) {
                  ready = true;
                  clearTimeout(readyTimer);
                  resolve(session);
                }
                break;
              case "interim":
                handlers.onInterim(event.text);
                break;
              case "final":
                handlers.onFinal(event.text);
                break;
              case "error":
                if (!ready) {
                  clearTimeout(readyTimer);
                  reject(new Error(event.message));
                } else {
                  handlers.onError(new Error(event.message));
                }
                break;
              default:
                break;
            }
          }
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => deps.log?.(`[speech] ${chunk.trim()}`));
        child.on("error", (error) => {
          exited = true;
          if (!ready) {
            clearTimeout(readyTimer);
            reject(error);
          } else handlers.onError(error);
          finish();
        });
        child.on("exit", (code) => {
          exited = true;
          if (!ready) {
            clearTimeout(readyTimer);
            reject(new Error("The speech recognizer ended before it was ready."));
          } else if (settleStop === null) {
            // Gone mid-take, on its own: the take must hear about it.
            handlers.onError(new Error(`the speech helper exited (${code ?? "no code"})`));
          }
          finish();
        });
        const write = (bytes: Buffer) => {
          if (exited || !child.stdin || child.stdin.destroyed) return;
          try {
            child.stdin.write(bytes);
          } catch {
            /* the helper is gone; its exit reports it */
          }
        };
        const session: LiveTranscription = {
          push: (pcm) => {
            if (pcm.length === 0) return;
            write(frame(FRAME_AUDIO, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
          },
          commit: () => write(frame(FRAME_COMMIT)),
          stop: () =>
            new Promise<void>((settle) => {
              if (exited) {
                settle();
                return;
              }
              // The last final follows the stop; the helper exits after it,
              // and never later than its own eight-second wait.
              const timer = setTimeout(() => {
                settleStop = null;
                child.kill();
                settle();
              }, 10_000);
              settleStop = () => {
                clearTimeout(timer);
                settle();
              };
              write(frame(FRAME_STOP));
            }),
          cancel: () => {
            if (!exited) child.kill();
          },
          get alive() {
            return !exited;
          }
        };
      })
  };
}
