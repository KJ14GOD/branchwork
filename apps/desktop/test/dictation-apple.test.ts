import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createAppleSpeech,
  frame,
  FRAME_AUDIO,
  FRAME_COMMIT,
  FRAME_STOP,
  readHelperEvent,
  readLines,
  termsArgument,
  type ChildLike
} from "../electron/dictation-apple";

/**
 * The helper's dialect (D-241), without the helper: the stdin framing, the
 * NDJSON reader, the probe, and a live session driven over a fake child —
 * what is written to it, what its lines become. The recognizer itself is
 * stamped only by the opt-in live test.
 */

describe("the framing and the reader", () => {
  it("frames audio, commit, and stop", () => {
    const audio = frame(FRAME_AUDIO, new Uint8Array([1, 2, 3]));
    expect([...audio]).toEqual([0, 3, 0, 0, 0, 1, 2, 3]);
    expect([...frame(FRAME_COMMIT)]).toEqual([1, 0, 0, 0, 0]);
    expect([...frame(FRAME_STOP)]).toEqual([2, 0, 0, 0, 0]);
  });

  it("reads whole lines and carries the tail", () => {
    const first = readLines("", '{"kind":"ready"}\n{"kind":"inte');
    expect(first.lines).toEqual(['{"kind":"ready"}']);
    expect(first.carry).toBe('{"kind":"inte');
    const second = readLines(first.carry, 'rim","text":"hi"}\n');
    expect(second.lines).toEqual(['{"kind":"interim","text":"hi"}']);
    expect(second.carry).toBe("");
  });

  it("reads the helper's events and ignores noise", () => {
    expect(readHelperEvent('{"kind":"ready"}')).toEqual({ kind: "ready" });
    expect(readHelperEvent('{"kind":"interim","text":"hel"}')).toEqual({ kind: "interim", text: "hel" });
    expect(readHelperEvent('{"kind":"final","text":"hello"}')).toEqual({ kind: "final", text: "hello" });
    expect(readHelperEvent('{"kind":"error","message":"no"}')).toEqual({ kind: "error", message: "no" });
    expect(readHelperEvent('{"kind":"probe","available":true,"onDevice":true,"authorization":"not_determined","locale":"en_US"}')).toEqual({
      kind: "probe",
      probe: { helper: true, available: true, onDevice: true, authorization: "not_determined", locale: "en_US" }
    });
    expect(readHelperEvent("garbage")).toBeNull();
    expect(readHelperEvent('{"kind":"other"}')).toBeNull();
  });

  it("hands the recognizer at most a hundred terms", () => {
    const terms = Array.from({ length: 140 }, (_, at) => `t${at}`);
    expect(JSON.parse(termsArgument({ terms, prompt: "" }))).toHaveLength(100);
  });
});

/** A child the test drives: what was written to it, and a way to speak. */
class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Buffer[] = [];
  killed = false;
  constructor(
    readonly command: string,
    readonly args: string[]
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(Buffer.from(chunk)));
  }
  say(event: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  kill() {
    this.killed = true;
    this.emit("exit", null);
    return true;
  }
}

const tick = () => new Promise((settle) => setTimeout(settle, 5));

describe("the speech helper over a fake child", () => {
  it("says the helper is absent without spawning anything", async () => {
    const speech = createAppleSpeech({ helperPath: "/nowhere/novus-speech", helperPresent: () => false, spawn: () => { throw new Error("must not spawn"); } });
    expect(await speech.probe()).toEqual({ helper: false, available: false, onDevice: false, authorization: "unknown", locale: null });
    await expect(speech.live({ terms: [], prompt: "" }, 24_000, { onInterim: () => undefined, onFinal: () => undefined, onError: () => undefined })).rejects.toThrow(/not beside this build/);
  });

  it("probes and authorizes through the helper's own modes", async () => {
    const spawned: FakeChild[] = [];
    const speech = createAppleSpeech({
      helperPath: "/app/novus-speech",
      helperPresent: () => true,
      spawn: (command, args) => {
        const child = new FakeChild(command, args);
        spawned.push(child);
        return child;
      },
      locale: "en-US"
    });
    const probing = speech.probe();
    await tick();
    expect(spawned[0]?.args).toEqual(["probe", "--locale", "en-US"]);
    spawned[0]?.say({ kind: "probe", available: true, onDevice: true, authorization: "authorized", locale: "en_US" });
    expect(await probing).toEqual({ helper: true, available: true, onDevice: true, authorization: "authorized", locale: "en_US" });

    const authorizing = speech.authorize();
    await tick();
    expect(spawned[1]?.args[0]).toBe("authorize");
    spawned[1]?.emit("exit", 0);
    expect((await authorizing).helper).toBe(true);
  });

  it("streams framed audio, commits, relays the words, and stops on the helper's exit", async () => {
    let child!: FakeChild;
    const heard = { interim: [] as string[], finals: [] as string[], errors: [] as string[] };
    const speech = createAppleSpeech({
      helperPath: "/app/novus-speech",
      helperPresent: () => true,
      spawn: (command, args) => {
        child = new FakeChild(command, args);
        return child;
      }
    });
    const opening = speech.live({ terms: ["composer.tsx"], prompt: "" }, 24_000, {
      onInterim: (text) => heard.interim.push(text),
      onFinal: (text) => heard.finals.push(text),
      onError: (error) => heard.errors.push(error.message)
    });
    await tick();
    expect(child.args).toEqual(["live", "--rate", "24000", "--terms", '["composer.tsx"]']);
    child.say({ kind: "ready" });
    const session = await opening;

    session.push(new Int16Array([1, -2]));
    session.commit();
    await tick();
    const written = Buffer.concat(child.written);
    expect([...written]).toEqual([0, 4, 0, 0, 0, 1, 0, 0xfe, 0xff, 1, 0, 0, 0, 0]);

    child.say({ kind: "interim", text: "refactor" });
    child.say({ kind: "final", text: "Refactor the composer.tsx" });
    child.say({ kind: "error", message: "hiccup" });
    await tick();
    expect(heard).toEqual({ interim: ["refactor"], finals: ["Refactor the composer.tsx"], errors: ["hiccup"] });

    const stopping = session.stop();
    await tick();
    expect(Buffer.concat(child.written).subarray(-5)[0]).toBe(FRAME_STOP);
    child.emit("exit", 0);
    await stopping;
    expect(child.killed).toBe(false);
  });

  it("refuses a helper that fails before it is ready, and kills one on cancel", async () => {
    let child!: FakeChild;
    const speech = createAppleSpeech({
      helperPath: "/app/novus-speech",
      helperPresent: () => true,
      spawn: (command, args) => {
        child = new FakeChild(command, args);
        return child;
      }
    });
    const handlers = { onInterim: () => undefined, onFinal: () => undefined, onError: () => undefined };
    const opening = speech.live({ terms: [], prompt: "" }, 24_000, handlers);
    await tick();
    child.say({ kind: "error", message: "On-device recognition is not available." });
    await expect(opening).rejects.toThrow(/not available/);

    const second = speech.live({ terms: [], prompt: "" }, 24_000, handlers);
    await tick();
    child.say({ kind: "ready" });
    const session = await second;
    session.cancel();
    expect(child.killed).toBe(true);
  });
});
