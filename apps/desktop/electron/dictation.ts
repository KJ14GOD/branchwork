import { randomBytes } from "node:crypto";
import type {
  DictationEngines,
  DictationEvent,
  DictationSettings,
  DictationStartInput,
  DictationState,
  MicrophoneAccess
} from "@novus/contracts";
import { concatInt16, FRAME_MS, LIVE_SAMPLE_RATE, rms, speechMillis } from "./dictation-audio";
import { buildVocabulary, type Vocabulary } from "./dictation-vocabulary";
import { guardRefinement, refineSystemPrompt, refineUserPrompt } from "./dictation-refine";
import type { DictationStore } from "./dictation-store";

/**
 * Dictation (D-240, D-241, D-242): the main process listens, so the renderer
 * never holds the microphone, and nothing anywhere holds a key.
 *
 * One take is two stages that overlap. **Live**: frames from the capture
 * page go to the system's own on-device recognizer through Novus's helper,
 * with the vocabulary as its contextual strings; the words come back as an
 * interim tail and, at the person's own pauses — where this module commits
 * the open segment — as settled finals. **Refine, as it goes**: the moment a
 * segment settles, the machine's own coding agent CLI, on the person's
 * existing login, edits that segment against the vocabulary and the words
 * already edited before it, and a mechanical guard decides whether the edit
 * may stand — in the background, while the person keeps speaking, one
 * segment after another. Stop waits only for the last segment. The raw
 * words and the refined words both reach the box; the person chooses.
 *
 * Electron-free by construction — the capture page, the permissions, the
 * recognizer, the editor, and the sources are injected — so the whole state
 * machine runs in plain Node under test.
 */

export interface LiveHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(error: Error): void;
}

export interface LiveTranscription {
  push(pcm: Int16Array): void;
  /** Ends the open segment where the audio stands; its final follows. */
  commit(): void;
  /** Ends the take and resolves once the last words have arrived (or a
   *  short wait has passed). */
  stop(): Promise<void>;
  cancel(): void;
  /** False once the recognizer itself is gone — as opposed to a request
   *  of its own that failed, which it reopens and the take rides through. */
  readonly alive: boolean;
}

/** A warm editor for one take (D-242): asks answered in order, without the
 *  CLI's start on each. */
export interface Refiner {
  ask(user: string): Promise<string>;
  close(): void;
  readonly alive: boolean;
}

export interface DictationVendor {
  /** What this machine holds for hearing and editing, probed now. */
  probe(): Promise<DictationEngines>;
  /** The system's own speech-recognition prompt, the first time. */
  authorizeSpeech(): Promise<DictationEngines>;
  live(args: { vocabulary: Vocabulary; sampleRate: number }, handlers: LiveHandlers): Promise<LiveTranscription>;
  /** One edit, one process: the road when no warm session exists or it died. */
  refine(args: { system: string; user: string }): Promise<string>;
  /** A warm session for the take, when the engine has one; null otherwise. */
  openRefiner?(): Promise<Refiner | null>;
}

export interface CaptureHost {
  /** Opens the microphone on the capture page; resolves once frames flow,
   *  rejects with the reason in words. */
  start(sampleRate: number, frameMs: number): Promise<void>;
  stop(): Promise<void>;
  onFrame(listener: (pcm: Int16Array) => void): () => void;
  /** The device going away mid-take. */
  onEnded(listener: (reason: string) => void): () => void;
}

export interface MicrophoneHost {
  status(): MicrophoneAccess;
  /** The system's own prompt, the first time; the current answer after. */
  ask(): Promise<MicrophoneAccess>;
  openSettings(): Promise<void>;
}

/** What the vocabulary and the refinement are built from, read by the
 *  caller from git and the mission's record. Everything may be empty. */
export interface DictationSources {
  files: string[];
  changed: string[];
  words: string[];
  goal: string | null;
  recent: string[];
}

export interface DictationDeps {
  store: DictationStore;
  vendor: DictationVendor;
  capture: CaptureHost;
  microphone: MicrophoneHost;
  /** Opens the system's speech-recognition privacy pane, for a refusal. */
  openSpeechSettings: () => Promise<void>;
  sources: (input: DictationStartInput) => Promise<DictationSources>;
  emit: (event: DictationEvent) => void;
  /** A diagnostic line for the machine's own log, never the room. */
  log?: (line: string) => void;
  now?: () => number;
}

export class DictationRefused extends Error {
  constructor(
    readonly code: "no_helper" | "no_speech" | "microphone" | "busy" | "engine",
    message: string
  ) {
    super(message);
  }
}

/** A take ends itself here: a twenty-minute direction is a document a
 *  person should be typing. */
const MAX_TAKE_MS = 20 * 60_000;
/** Below this much speech-like audio a take is answered "nothing heard". */
const MIN_SPEECH_MS = 400;
/** Where a segment is committed: after this much quiet, once enough was
 *  said, and not so often that the recognizer answers for two words at a
 *  time. A segment never outgrows a minute, the recognizer's own comfort. */
const PAUSE_MS = 700;
const MIN_SEGMENT_SPEECH_MS = 1_500;
const MIN_SEGMENT_MS = 8_000;
const MAX_SEGMENT_MS = 55_000;
/** A pause this long makes the on-device recognizer close the utterance
 *  and start its transcript over (measured: 1.1 s does not, 2.5 s does), so
 *  the segment is committed first, however young it is, and the words
 *  before the pause settle by the ordinary road (D-244). */
const LONG_PAUSE_MS = 1_500;
const LONG_PAUSE_SPEECH_MS = 400;
/** Quiet is judged against the room, not a fixed level (owner-hit: a laptop
 *  microphone without gain control sits well below a synthesized voice):
 *  the floor is the softest of the last three seconds, and a frame is quiet
 *  under three times that, never under this much. */
const QUIET_LEVEL_MIN = 0.004;
/** A frame this loud is speech whatever the room has been doing — a
 *  window that holds nothing but speech must not raise the floor over it. */
const SPEECH_LEVEL_SURE = 0.02;
const NOISE_WINDOW_FRAMES = 30;

interface Segment {
  raw: string;
  text: string;
  note: string | null;
  /** Whether the editor was told this was the last stretch. */
  last: boolean;
  /** Whether an edit stood for it — even one that changed nothing. */
  edited: boolean;
}

interface Take {
  sessionId: string;
  startedAtMs: number;
  input: DictationStartInput;
  vocabulary: Vocabulary;
  sources: DictationSources;
  engines: DictationEngines;
  /** Whether segments are refined at all: the preference and an editor. */
  refining: boolean;
  frames: Int16Array[];
  live: LiveTranscription | null;
  segments: Segment[];
  /** The refinements, one after another: each segment's edit reads the
   *  edited words before it, so they run in order. */
  chain: Promise<void>;
  refiner: Promise<Refiner | null>;
  interim: string;
  quietMs: number;
  speechSinceCommitMs: number;
  sinceCommitMs: number;
  /** The softest recent frames, for the room's own quiet level. */
  levels: number[];
  liveFailed: string | null;
  stopping: boolean;
  unsubscribe: (() => void)[];
  capTimer: NodeJS.Timeout | null;
}

export interface Dictation {
  settings(): Promise<DictationSettings>;
  setPrefs(partial: { refine?: boolean; dictionary?: string[] }): Promise<DictationSettings>;
  requestAccess(kind: "microphone" | "speech"): Promise<DictationSettings>;
  start(input: DictationStartInput): Promise<{ sessionId: string }>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  /** For the app's own shutdown: nothing left listening. */
  dispose(): Promise<void>;
}

const joinWords = (parts: readonly string[]): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** An edited take may end without its full stop; the stop supplies it, and
 *  nothing else. */
export function closeSentence(text: string): string {
  return /[A-Za-z0-9)\]`'"]$/.test(text) ? `${text}.` : text;
}

export function createDictation(deps: DictationDeps): Dictation {
  const now = deps.now ?? (() => Date.now());
  let active: Take | null = null;

  const probe = async (): Promise<DictationEngines> => {
    const engines = await deps.vendor.probe();
    deps.store.setEngines(engines);
    return engines;
  };

  const settings = async (): Promise<DictationSettings> => {
    let engines: DictationEngines | null;
    try {
      engines = await probe();
    } catch {
      engines = deps.store.prefs().engines;
    }
    const prefs = deps.store.prefs();
    return {
      engines,
      microphone: deps.microphone.status(),
      refine: prefs.refine,
      dictionary: prefs.dictionary
    };
  };

  const emitState = (take: Take, state: DictationState) => {
    deps.emit({
      kind: "state",
      sessionId: take.sessionId,
      state,
      startedAtMs: state === "idle" ? null : take.startedAtMs
    });
  };

  const teardown = async (take: Take): Promise<void> => {
    for (const off of take.unsubscribe) off();
    take.unsubscribe = [];
    if (take.capTimer) clearTimeout(take.capTimer);
    take.capTimer = null;
    try {
      await deps.capture.stop();
    } catch {
      /* the page is gone or was never up */
    }
  };

  const closeRefiner = (take: Take): void => {
    void take.refiner.then((refiner) => refiner?.close()).catch(() => undefined);
  };

  /** A frame from the microphone: kept, streamed, and measured for pauses. */
  const onFrame = (take: Take, pcm: Int16Array): void => {
    if (take.stopping) return;
    take.frames.push(pcm);
    const frameMs = Math.round((pcm.length / LIVE_SAMPLE_RATE) * 1000);
    take.sinceCommitMs += frameMs;
    const level = rms(pcm);
    take.levels.push(level);
    if (take.levels.length > NOISE_WINDOW_FRAMES) take.levels.shift();
    const floor = Math.min(...take.levels);
    if (level >= Math.max(QUIET_LEVEL_MIN, Math.min(floor * 3, SPEECH_LEVEL_SURE))) {
      take.quietMs = 0;
      take.speechSinceCommitMs += frameMs;
    } else {
      take.quietMs += frameMs;
    }
    take.live?.push(pcm);
    const atPause =
      take.quietMs >= PAUSE_MS &&
      take.speechSinceCommitMs >= MIN_SEGMENT_SPEECH_MS &&
      take.sinceCommitMs >= MIN_SEGMENT_MS;
    const atLongPause = take.quietMs >= LONG_PAUSE_MS && take.speechSinceCommitMs >= LONG_PAUSE_SPEECH_MS;
    const overlong = take.sinceCommitMs >= MAX_SEGMENT_MS && take.speechSinceCommitMs > 0;
    if (take.live && (atPause || atLongPause || overlong)) {
      take.live.commit();
      take.speechSinceCommitMs = 0;
      take.sinceCommitMs = 0;
    }
  };

  /** One segment's edit, in the background: the words edited before it are
   *  its context, the warm session answers when there is one, and a refusal
   *  or a failure leaves the words as heard with the reason kept. */
  const refineSegment = async (take: Take, index: number): Promise<void> => {
    const segment = take.segments[index];
    if (!segment) return;
    const before = joinWords([take.input.draft?.before ?? "", ...take.segments.slice(0, index).map((earlier) => earlier.text)]);
    const user = refineUserPrompt({
      raw: segment.raw,
      vocabulary: take.vocabulary.terms,
      context: {
        goal: take.sources.goal,
        recent: take.sources.recent,
        before,
        after: take.input.draft?.after,
        position: segment.last ? "last" : "continues"
      }
    });
    let candidate: string;
    try {
      const refiner = await take.refiner;
      if (refiner !== null && refiner.alive) {
        try {
          candidate = await refiner.ask(user);
        } catch {
          // The warm session failed this ask: one run of its own, then.
          candidate = await deps.vendor.refine({ system: refineSystemPrompt(), user });
        }
      } else {
        candidate = await deps.vendor.refine({ system: refineSystemPrompt(), user });
      }
    } catch (error) {
      segment.note = `Kept the transcript as heard: ${describe(error)}`;
      return;
    }
    const verdict = guardRefinement(segment.raw, candidate, take.vocabulary.terms);
    if (verdict.accepted) {
      segment.text = candidate.trim();
      segment.edited = true;
    } else {
      segment.note = `Kept the transcript as heard: ${verdict.reason}.`;
    }
    if (active === take) {
      deps.emit({ kind: "segment", sessionId: take.sessionId, index, raw: segment.raw, text: segment.text });
    }
  };

  /** A settled stretch of speech: said to the box as heard at once, and
   *  queued for its edit behind the segments before it. */
  const settleSegment = (take: Take, raw: string, last: boolean): void => {
    const text = raw.trim();
    if (text.length === 0) return;
    const index = take.segments.length;
    take.segments.push({ raw: text, text, note: null, last, edited: false });
    deps.emit({ kind: "final", sessionId: take.sessionId, text });
    if (!take.refining) return;
    take.chain = take.chain.then(() => refineSegment(take, index));
  };

  const finish = async (take: Take): Promise<void> => {
    // The recognizer's last words, waited for but never for ever.
    if (take.live) {
      try {
        await take.live.stop();
      } catch {
        /* its own failure was already reported */
      }
    }
    if (take.interim.trim().length > 0) settleSegment(take, take.interim, true);
    take.interim = "";
    // Only the segments not yet edited are waited for — usually the last.
    await take.chain;
    closeRefiner(take);
    const raw = joinWords(take.segments.map((segment) => segment.raw));
    const finishWith = (text: string, note: string | null) => {
      deps.emit({ kind: "refined", sessionId: take.sessionId, raw, text, note });
      active = null;
      emitState(take, "idle");
    };
    // Words heard are words heard, whatever the level meter thought; the
    // meter only decides what to say when nothing came back.
    if (raw.length === 0) {
      const speech = speechMillis(concatInt16(take.frames), LIVE_SAMPLE_RATE, { floor: QUIET_LEVEL_MIN });
      finishWith(
        "",
        speech < MIN_SPEECH_MS
          ? "Nothing was heard."
          : take.liveFailed ?? "The recognizer heard sound but made out no words."
      );
      return;
    }
    if (!take.refining) {
      finishWith(
        raw,
        take.engines.editor.kind === "none" && deps.store.prefs().refine
          ? "Kept the transcript as heard: no coding agent CLI is installed on this Mac to refine with."
          : take.liveFailed
      );
      return;
    }
    let text = joinWords(take.segments.map((segment) => segment.text));
    const lastSegment = take.segments[take.segments.length - 1];
    // An edited last segment may end without its full stop — told more would
    // follow, or the editor simply left it off — and the stop supplies it.
    // Words kept as heard stay as heard.
    if (lastSegment && lastSegment.edited) text = closeSentence(text);
    const notes = take.segments.map((segment) => segment.note).filter((note): note is string => note !== null);
    finishWith(text, notes[notes.length - 1] ?? take.liveFailed);
  };

  const stop = async (): Promise<void> => {
    const take = active;
    if (!take || take.stopping) return;
    take.stopping = true;
    emitState(take, "refining");
    await teardown(take);
    await finish(take);
  };

  const cancel = async (): Promise<void> => {
    const take = active;
    if (!take) return;
    take.stopping = true;
    await teardown(take);
    take.live?.cancel();
    closeRefiner(take);
    active = null;
    emitState(take, "idle");
  };

  const start = async (input: DictationStartInput): Promise<{ sessionId: string }> => {
    if (active) throw new DictationRefused("busy", "Novus is already listening.");
    let engines: DictationEngines;
    try {
      engines = await probe();
    } catch (error) {
      throw new DictationRefused("engine", describe(error));
    }
    const speech = engines.speech;
    if (!speech.helper) {
      throw new DictationRefused("no_helper", "This build of Novus has no speech helper beside it, so it cannot listen.");
    }
    if (!speech.available) {
      throw new DictationRefused("no_speech", `Speech recognition is not available for ${speech.locale ?? "this language"} on this Mac.`);
    }
    if (!speech.onDevice) {
      throw new DictationRefused(
        "no_speech",
        `On-device recognition for ${speech.locale ?? "this language"} is not installed. Turn on Dictation for it under System Settings → Keyboard, then try again.`
      );
    }
    if (speech.authorization === "restricted") {
      throw new DictationRefused("no_speech", "This Mac restricts speech recognition, so Novus cannot listen.");
    }
    if (speech.authorization === "not_determined") {
      // The system's own question, asked once; on-device recognition has
      // been observed to run before it is answered, so the answer never
      // blocks a take.
      try {
        engines = await deps.vendor.authorizeSpeech();
        deps.store.setEngines(engines);
      } catch {
        /* the recognizer's own error will say */
      }
    }
    let microphone = deps.microphone.status();
    if (microphone === "not_determined" || microphone === "unknown") microphone = await deps.microphone.ask();
    if (microphone !== "granted") {
      throw new DictationRefused(
        "microphone",
        microphone === "restricted"
          ? "This Mac restricts the microphone, so Novus cannot listen."
          : "macOS has not allowed Novus to use the microphone. Allow it under System Settings → Privacy & Security → Microphone, then relaunch Novus."
      );
    }
    const prefs = deps.store.prefs();
    const refining = prefs.refine && engines.editor.kind !== "none";
    const take: Take = {
      sessionId: `dct_${randomBytes(6).toString("hex")}`,
      startedAtMs: now(),
      input,
      vocabulary: { terms: [], prompt: "" },
      sources: { files: [], changed: [], words: [], goal: null, recent: [] },
      engines,
      refining,
      frames: [],
      live: null,
      segments: [],
      chain: Promise.resolve(),
      // The warm session opens while the person begins to speak; its start
      // is paid before the first segment settles, never after the stop.
      refiner:
        refining && deps.vendor.openRefiner ? deps.vendor.openRefiner().catch(() => null) : Promise.resolve(null),
      interim: "",
      quietMs: 0,
      speechSinceCommitMs: 0,
      sinceCommitMs: 0,
      levels: [],
      liveFailed: null,
      stopping: false,
      unsubscribe: [],
      capTimer: null
    };
    active = take;
    emitState(take, "starting");
    try {
      try {
        take.sources = await deps.sources(input);
      } catch {
        /* a room with nothing to read is still a room to speak in */
      }
      take.vocabulary = buildVocabulary({
        dictionary: prefs.dictionary,
        changed: take.sources.changed,
        files: take.sources.files,
        words: [...(take.sources.goal ? [take.sources.goal] : []), ...take.sources.words, ...take.sources.recent]
      });
      take.live = await deps.vendor.live(
        { vocabulary: take.vocabulary, sampleRate: LIVE_SAMPLE_RATE },
        {
          onInterim: (text) => {
            if (active !== take) return;
            take.interim = text;
            deps.emit({ kind: "interim", sessionId: take.sessionId, text });
          },
          onFinal: (text) => {
            if (active !== take) return;
            take.interim = "";
            // A final that lands after the stop was asked is the take's last.
            settleSegment(take, text, take.stopping);
          },
          onError: (error) => {
            if (active !== take || take.stopping) return;
            // A request of the recognizer's own failing is a segment boundary
            // it reopens on its own: the frames keep flowing and the take
            // rides through (owner-hit: a take that "just stopped"). Only a
            // recognizer that is gone ends the take, and says so.
            if (take.live?.alive) {
              deps.log?.(`[dictation] recognizer hiccup, riding through: ${error.message}`);
              return;
            }
            take.liveFailed = `The recognizer stopped: ${error.message}`;
            take.live = null;
            deps.emit({ kind: "error", sessionId: take.sessionId, message: take.liveFailed });
            void stop();
          }
        }
      );
      take.unsubscribe.push(deps.capture.onFrame((pcm) => onFrame(take, pcm)));
      take.unsubscribe.push(
        deps.capture.onEnded((reason) => {
          if (active !== take || take.stopping) return;
          deps.emit({ kind: "error", sessionId: take.sessionId, message: reason });
          void stop();
        })
      );
      await deps.capture.start(LIVE_SAMPLE_RATE, FRAME_MS);
      take.capTimer = setTimeout(() => {
        if (active === take && !take.stopping) {
          deps.emit({
            kind: "error",
            sessionId: take.sessionId,
            message: "Twenty minutes is the most one take can hold; the words so far are being finished."
          });
          void stop();
        }
      }, MAX_TAKE_MS);
      emitState(take, "listening");
      return { sessionId: take.sessionId };
    } catch (error) {
      await teardown(take);
      take.live?.cancel();
      closeRefiner(take);
      active = null;
      emitState(take, "idle");
      throw error instanceof DictationRefused ? error : new DictationRefused("engine", describe(error));
    }
  };

  return {
    settings,
    setPrefs: async (partial) => {
      deps.store.setPrefs(partial);
      return settings();
    },
    requestAccess: async (kind) => {
      if (kind === "microphone") {
        const status = deps.microphone.status();
        if (status === "not_determined" || status === "unknown") await deps.microphone.ask();
        else if (status === "denied" || status === "restricted") await deps.microphone.openSettings();
        return settings();
      }
      // Probed afresh: the answer can change in System Settings at any time.
      const engines = await probe();
      if (engines.speech.authorization === "not_determined" || engines.speech.authorization === "unknown") {
        try {
          deps.store.setEngines(await deps.vendor.authorizeSpeech());
        } catch {
          /* the settings page shows whatever the probe now says */
        }
      } else if (engines.speech.authorization === "denied" || engines.speech.authorization === "restricted") {
        await deps.openSpeechSettings();
      }
      return settings();
    },
    start,
    stop,
    cancel,
    dispose: cancel
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
