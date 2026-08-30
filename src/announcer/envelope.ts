// Lip-sync data, computed from the finished WAV rather than guessed at.
//
// The whole reason this is cheap: tts.ts runs Piper to a COMPLETE file before a
// single byte is played, so the audio is fully known before the first frame is
// drawn. No real-time analysis, no streaming model, and no drift, because the
// browser drives the mouth off its own <audio> element's clock and the frame
// table is just a lookup.
//
// Two numbers per frame, which is one more than the obvious approach and is what
// stops it looking like a hinged jaw:
//   openness — RMS energy. Loud sound, open mouth.
//   wideness — zero-crossing rate. Fricatives and front vowels ("s", "ee") sit
//              high in frequency and are made with a wide flat mouth; open back
//              vowels ("aah", "oh") are low and round. ZCR separates them for
//              free, so the mouth changes SHAPE and not just height.

const FRAME_MS = 20;

export interface Frame {
  openness: number; // 0..1
  wideness: number; // 0..1
}

export interface Envelope {
  frameMs: number;
  durationMs: number;
  frames: Frame[];
}

interface Pcm {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

// Minimal RIFF reader. Chunks are walked rather than assumed at fixed offsets:
// Piper's header layout is stable today but a `LIST`/`fact` chunk appearing
// later would silently shift everything and produce garbage instead of an error.
function readWav(buf: Uint8Array): Pcm {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (off: number): string => String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let data: Int16Array | null = null;

  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      const len = Math.min(size, buf.byteLength - body);
      if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit`);
      // byteOffset may be odd, so copy rather than aliasing into an Int16Array.
      const copy = new Uint8Array(buf.subarray(body, body + (len - (len % 2))));
      data = new Int16Array(copy.buffer);
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!data || !sampleRate) throw new Error("WAV had no fmt/data chunk");
  return { samples: data, sampleRate, channels };
}

// Normalise against a high percentile, not the peak. One plosive or a click sets
// the maximum and would squash every real syllable into the bottom of the range.
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i]!;
}

export function envelopeFromWav(buf: Uint8Array): Envelope {
  const { samples, sampleRate, channels } = readWav(buf);
  const frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000)) * channels;
  const count = Math.max(1, Math.floor(samples.length / frameLen));

  const rms: number[] = [];
  const zcr: number[] = [];
  for (let f = 0; f < count; f++) {
    const start = f * frameLen;
    const end = Math.min(samples.length, start + frameLen);
    let sum = 0;
    let crossings = 0;
    let prev = 0;
    let n = 0;
    for (let i = start; i < end; i += channels) {
      const v = samples[i]! / 32768;
      sum += v * v;
      if (n > 0 && ((v >= 0 && prev < 0) || (v < 0 && prev >= 0))) crossings++;
      prev = v;
      n++;
    }
    rms.push(n ? Math.sqrt(sum / n) : 0);
    zcr.push(n > 1 ? crossings / (n - 1) : 0);
  }

  const rmsRef = percentile(rms.slice().sort((a, b) => a - b), 0.95) || 1;
  // ZCR is only meaningful where there is actually sound, so calibrate the
  // wideness range over voiced frames. Silence has an arbitrary ZCR and would
  // otherwise drag the reference around.
  const voiced = zcr.filter((_, i) => rms[i]! > rmsRef * 0.15).sort((a, b) => a - b);
  const zLo = percentile(voiced, 0.1);
  const zHi = percentile(voiced, 0.9) || zLo + 0.01;

  const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
  const frames: Frame[] = rms.map((r, i) => ({
    // sqrt because loudness is perceived, and jaw movement tracks perception
    // rather than energy: linear RMS leaves the mouth shut through quiet speech.
    openness: Math.round(clamp01(Math.sqrt(r / rmsRef)) * 1000) / 1000,
    wideness: Math.round(clamp01((zcr[i]! - zLo) / (zHi - zLo)) * 1000) / 1000,
  }));

  return {
    frameMs: FRAME_MS,
    durationMs: Math.round((samples.length / channels / sampleRate) * 1000),
    frames,
  };
}
