/**
 * The audio arithmetic of dictation (D-240), pure so it is testable in plain
 * Node: sample conversion, a WAV wrapper for the whole-utterance pass, how
 * much of a take was speech-like, and where long audio splits for a vendor's
 * per-request ceiling. Nothing here touches a device or a socket.
 */

/** The live transcription hears pcm16 mono at this rate; the capture page
 *  runs its AudioContext at it so Chromium resamples the device's own rate
 *  once, at the source, and every stage downstream sees one format. */
export const LIVE_SAMPLE_RATE = 24_000;

/** How much audio one frame over the IPC carries. Short enough that the live
 *  words never sit behind a buffer, long enough that the bridge is not busy
 *  with a message per render quantum. */
export const FRAME_MS = 100;

export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let at = 0; at < samples.length; at += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[at] ?? 0));
    out[at] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}

/** Bytes off the wire as samples. The bridge hands the main process a byte
 *  view that may sit at an odd offset in a shared buffer, which an
 *  `Int16Array` over it would refuse, so the samples are copied out. */
export function pcm16FromBytes(bytes: ArrayBuffer | Uint8Array): Int16Array {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const count = Math.floor(view.byteLength / 2);
  const out = new Int16Array(count);
  const data = new DataView(view.buffer, view.byteOffset, view.byteLength);
  for (let at = 0; at < count; at += 1) out[at] = data.getInt16(at * 2, true);
  return out;
}

export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function durationMs(pcm: Int16Array, sampleRate: number): number {
  return Math.round((pcm.length / sampleRate) * 1000);
}

/** Root mean square of a span, as a fraction of full scale. */
export function rms(pcm: Int16Array, start = 0, end = pcm.length): number {
  const from = Math.max(0, start);
  const to = Math.min(pcm.length, end);
  if (to <= from) return 0;
  let sum = 0;
  for (let at = from; at < to; at += 1) {
    const sample = (pcm[at] ?? 0) / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / (to - from));
}

/**
 * Milliseconds of frames whose level clears the floor — how much of a take
 * was speech-like. A vendor asked to hear silence invents words for it
 * ("thank you" is the famous one), so a take with too little of this never
 * reaches one. The floor is about −38 dBFS: quiet speech clears it, a room's
 * hum and a fan do not.
 */
export function speechMillis(
  pcm: Int16Array,
  sampleRate: number,
  options: { frameMs?: number; floor?: number } = {}
): number {
  const frameMs = options.frameMs ?? 20;
  const floor = options.floor ?? 0.012;
  const frame = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  let loud = 0;
  for (let start = 0; start < pcm.length; start += frame) {
    if (rms(pcm, start, start + frame) >= floor) loud += 1;
  }
  return loud * frameMs;
}

/** A 16-bit mono WAV around the samples: the form the whole-utterance pass
 *  uploads, because a vendor reads a container and not bare samples. */
export function wavFromPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let at = 0; at < text.length; at += 1) out[offset + at] = text.charCodeAt(at);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let at = 0; at < pcm.length; at += 1) view.setInt16(44 + at * 2, pcm[at] ?? 0, true);
  return out;
}

/**
 * Long audio in pieces that each fit a vendor's per-request ceiling, cut at
 * the quietest frame of the last ten seconds before the limit so a word is
 * never sliced in half. One piece when the whole take fits.
 */
export function splitForUpload(pcm: Int16Array, sampleRate: number, maxBytes: number): Int16Array[] {
  const maxSamples = Math.max(sampleRate, Math.floor((maxBytes - 44) / 2));
  if (pcm.length <= maxSamples) return [pcm];
  const frame = Math.max(1, Math.floor(sampleRate / 50)); // 20 ms
  const window = sampleRate * 10;
  const pieces: Int16Array[] = [];
  let start = 0;
  while (pcm.length - start > maxSamples) {
    const limit = start + maxSamples;
    let cut = limit;
    let quietest = Number.POSITIVE_INFINITY;
    for (let at = Math.max(start + sampleRate, limit - window); at + frame <= limit; at += frame) {
      const level = rms(pcm, at, at + frame);
      if (level < quietest) {
        quietest = level;
        cut = at + frame;
      }
    }
    pieces.push(pcm.subarray(start, cut));
    start = cut;
  }
  pieces.push(pcm.subarray(start));
  return pieces;
}
