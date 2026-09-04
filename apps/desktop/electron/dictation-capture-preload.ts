import { contextBridge, ipcRenderer } from "electron";

/**
 * The capture page (D-240): a hidden, Novus-owned window whose only job is
 * to hold the microphone and hand the main process raw frames. The room's
 * renderer never asks for the microphone; it asks the main process to
 * listen, exactly as it asks it to record the preview (D-123).
 *
 * The audio is taken as raw as the platform allows — no echo cancellation,
 * no noise suppression, no automatic gain — because every one of those is a
 * speech-enhancement stage tuned for a human listener, and the published
 * measurements say each of them costs a transcriber accuracy. The
 * AudioContext runs at the vendor's own rate so Chromium resamples the
 * device's rate once, at the source, and an AudioWorklet cuts the stream
 * into frames of a fixed length for the bridge.
 */

let context: AudioContext | null = null;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;

/** The worklet's own code, loaded from a blob so the page needs no file
 *  beside it: collects one frame's worth of samples, writes them as 16-bit
 *  little-endian, and hands the buffer over (transferred, not copied). */
const workletSource = `
class NovusPcmFrames extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = options.processorOptions.frameSamples;
    this.buffer = new Int16Array(this.frame);
    this.fill = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let at = 0; at < channel.length; at += 1) {
      const sample = Math.max(-1, Math.min(1, channel[at]));
      this.buffer[this.fill] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      this.fill += 1;
      if (this.fill === this.frame) {
        const out = this.buffer.buffer.slice(0);
        this.port.postMessage(out, [out]);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor("novus-pcm-frames", NovusPcmFrames);
`;

function teardown(): void {
  try {
    node?.port.close();
    node?.disconnect();
  } catch {
    /* already gone */
  }
  node = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  const closing = context;
  context = null;
  void closing?.close().catch(() => undefined);
}

contextBridge.exposeInMainWorld("__novusDictation", {
  start: async (sampleRate: number, frameMs: number): Promise<void> => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      context = new AudioContext({ sampleRate });
      const url = URL.createObjectURL(new Blob([workletSource], { type: "application/javascript" }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const frameSamples = Math.max(128, Math.floor((context.sampleRate * frameMs) / 1000));
      node = new AudioWorkletNode(context, "novus-pcm-frames", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { frameSamples }
      });
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        ipcRenderer.send("dictation:frame", event.data);
      };
      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      // The device going away — unplugged, taken by the system — ends the
      // track; the main process hears it and settles honestly.
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        ipcRenderer.send("dictation:ended", "The microphone stopped.");
        teardown();
      });
      if (context.state !== "running") await context.resume();
      ipcRenderer.send("dictation:started", { sampleRate: context.sampleRate, frameSamples });
    } catch (error) {
      const named = error instanceof Error ? error : null;
      const reason =
        named?.name === "NotAllowedError"
          ? "macOS has not allowed Novus to use the microphone."
          : named?.name === "NotFoundError"
            ? "No microphone was found on this Mac."
            : named
              ? `${named.name}: ${named.message}`
              : "The microphone could not be opened.";
      ipcRenderer.send("dictation:error", reason);
      teardown();
    }
  },
  stop: (): void => {
    teardown();
    ipcRenderer.send("dictation:stopped");
  }
});
