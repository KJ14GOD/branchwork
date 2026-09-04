import { describe, expect, it } from "vitest";
import {
  concatInt16,
  durationMs,
  float32ToInt16,
  pcm16FromBytes,
  rms,
  speechMillis,
  splitForUpload,
  wavFromPcm16
} from "../electron/dictation-audio";

/**
 * The audio arithmetic under dictation (D-240): sample conversion that
 * survives odd byte offsets, a WAV the vendor can read, a speech measure that
 * keeps silence away from a model that would invent words for it, and a
 * split that never cuts through speech.
 */

const tone = (samples: number, amplitude: number, period = 50): Int16Array => {
  const out = new Int16Array(samples);
  for (let at = 0; at < samples; at += 1) {
    out[at] = Math.round(Math.sin((2 * Math.PI * at) / period) * amplitude * 0x7fff);
  }
  return out;
};

describe("samples", () => {
  it("converts floats to 16-bit with clamping", () => {
    const out = float32ToInt16(new Float32Array([0, 0.5, -0.5, 1.5, -1.5]));
    expect([...out]).toEqual([0, 16384, -16384, 32767, -32768]);
  });

  it("reads little-endian bytes at an odd offset", () => {
    const backing = new Uint8Array(5);
    // One leading byte, then 0x0102 and 0xfffe (-2) little-endian.
    backing.set([0x00, 0x02, 0x01, 0xfe, 0xff]);
    const view = backing.subarray(1);
    expect([...pcm16FromBytes(view)]).toEqual([0x0102, -2]);
  });

  it("concatenates and measures", () => {
    const joined = concatInt16([new Int16Array([1, 2]), new Int16Array([3])]);
    expect([...joined]).toEqual([1, 2, 3]);
    expect(durationMs(new Int16Array(24_000), 24_000)).toBe(1000);
  });
});

describe("speech measure", () => {
  it("hears a tone and not silence", () => {
    const rate = 24_000;
    const loud = tone(rate, 0.3);
    const quiet = new Int16Array(rate);
    expect(rms(loud)).toBeGreaterThan(0.2);
    expect(speechMillis(loud, rate)).toBe(1000);
    expect(speechMillis(quiet, rate)).toBe(0);
    // A room's hum sits under the floor.
    const hum = tone(rate, 0.003);
    expect(speechMillis(hum, rate)).toBe(0);
  });

  it("counts only the loud part of a mixed take", () => {
    const rate = 24_000;
    const mixed = concatInt16([new Int16Array(rate), tone(rate / 2, 0.3), new Int16Array(rate)]);
    expect(speechMillis(mixed, rate)).toBe(500);
  });
});

describe("wav", () => {
  it("wraps the samples in a valid 16-bit mono header", () => {
    const pcm = new Int16Array([1, -1, 300]);
    const wav = wavFromPcm16(pcm, 24_000);
    const text = (from: number, to: number) => String.fromCharCode(...wav.subarray(from, to));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 12)).toBe("WAVE");
    expect(text(36, 40)).toBe("data");
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(1);
    expect(view.getInt16(48, true)).toBe(300);
    expect(wav.byteLength).toBe(50);
  });
});

describe("splitting for a vendor's ceiling", () => {
  it("keeps a take that fits whole", () => {
    const pcm = tone(24_000, 0.3);
    const pieces = splitForUpload(pcm, 24_000, 25_000_000);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toBe(pcm);
  });

  it("cuts at the quietest point before the limit, and loses nothing", () => {
    const rate = 1000; // small numbers keep the test readable
    // Three seconds loud, one second silent, three seconds loud: 7000 samples.
    const pcm = concatInt16([tone(3000, 0.3), new Int16Array(1000), tone(3000, 0.3)]);
    // A ceiling of ~5000 samples of WAV: the cut must land inside the silence.
    const pieces = splitForUpload(pcm, rate, 44 + 5000 * 2);
    expect(pieces).toHaveLength(2);
    const first = pieces[0]!;
    expect(first.length).toBeGreaterThanOrEqual(3000);
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(rms(first, first.length - 20, first.length)).toBe(0);
    expect(concatInt16(pieces).length).toBe(pcm.length);
  });
});
