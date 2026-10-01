/**
 * AudioManager — the presentation layer's audio channel.
 * See specs/22_audio_and_juice_spec.md §3.3 / §4.4 (AC-01).
 *
 * WHAT IT IS
 * ----------
 * Three short, SYNTHESISED placeholder sounds — a hit thud, a dash sweep and a
 * coin chime — played through howler. The sounds are generated in code as WAV
 * `data:` URIs at construction time, so:
 *
 *   - there is NO asset file to fetch, and therefore NO 404 (spec 22 AC-01); the
 *     whole thing is one self-contained module;
 *   - howler is a REAL dependency of the shipped bundle (it owns loading, the
 *     global mute/volume channel and the playback calls) rather than a wrapper
 *     around raw Web Audio.
 *
 * SILENT DEGRADATION IS THE CONTRACT
 * ----------------------------------
 * Audio is best-effort. In a headless run, under an autoplay policy that blocks
 * the context, or on any environment where `Howl` / `AudioContext` is missing,
 * every method must be a silent no-op — NEVER a throw. `build()` wraps the whole
 * construction in try/catch and reports `available: false`; every play call is
 * guarded by `available` and its own try/catch. A missing sound must never be
 * able to break the game loop.
 *
 * ONE-WAY DEPENDENCY
 * ------------------
 * This is the ONLY client module that imports `howler`. It is imported by
 * `client/main.ts` and NOTHING ELSE — in particular it must stay OUT of
 * `GameRenderer`'s import graph. `GameLoop` talks to audio only through the
 * howler-free `AudioSink` interface (see `client/GameLoop.ts`).
 *
 * WHY the import-graph isolation (and NOT the reason a naive reading suggests):
 * `howler` does NOT "blow up" in node — it was MEASURED to import cleanly with
 * `window === undefined`, and `new Howl(...)` does not throw either (see
 * `tests/audio/audio_manager.test.ts`). The real constraint is that this module
 * referenced a BARE DOM global (`window`), which — pulled into `tests/**`
 * transitively via `GameRenderer` — breaks the DOM-less `npm run typecheck`
 * program (`lib: ["ES2022"]`) with TS2304. The guard below now reads
 * `globalThis.window`, which removes that hazard, but the isolation is kept as a
 * deliberate discipline: `howler` belongs to the audio channel and nothing else.
 */

import { Howl, Howler } from 'howler';

/** Sample rate for every synthesised placeholder. Small keeps the data URIs tiny. */
const SAMPLE_RATE = 22050;

/** Linear 16-bit PCM mono WAV, base64-encoded as a `data:` URI. */
function encodeWavDataUri(samples: Float32Array): string {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true); // block align = channels * bytesPerSample
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return `data:audio/wav;base64,${toBase64(new Uint8Array(buffer))}`;
}

/** Write an ASCII string (chunk tag) into the DataView at `offset`. */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Base64-encode bytes without spreading a huge argument list. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * A short, low, noise-edged thud: a tone falling 220 -> 60 Hz mixed with noise,
 * under an exponential decay (~120ms).
 */
function synthHit(): string {
  const length = Math.floor(SAMPLE_RATE * 0.12);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const progress = i / length;
    const freq = 220 - 160 * progress;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const envelope = Math.exp(-9 * progress);
    const tone = Math.sin(phase);
    const noise = Math.random() * 2 - 1;
    samples[i] = (tone * 0.7 + noise * 0.3) * envelope * 0.8;
  }
  return encodeWavDataUri(samples);
}

/**
 * A quick RISING sweep: a sine sweeping 200 -> 1200 Hz over ~150ms, windowed so
 * it fades in and out (a dash "whoosh").
 */
function synthDash(): string {
  const length = Math.floor(SAMPLE_RATE * 0.15);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const progress = i / length;
    const freq = 200 + 1000 * progress;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const envelope = Math.sin(Math.PI * progress);
    samples[i] = Math.sin(phase) * envelope * 0.5;
  }
  return encodeWavDataUri(samples);
}

/** A 1000 Hz sine for 100ms under a decay — the coin chime. */
function synthCoin(): string {
  const length = Math.floor(SAMPLE_RATE * 0.1);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const progress = i / length;
    phase += (2 * Math.PI * 1000) / SAMPLE_RATE;
    const envelope = Math.exp(-6 * progress);
    samples[i] = Math.sin(phase) * envelope * 0.5;
  }
  return encodeWavDataUri(samples);
}

/** The three howls plus whether construction succeeded. */
interface BuiltSounds {
  readonly hit: Howl | null;
  readonly dash: Howl | null;
  readonly coin: Howl | null;
  readonly available: boolean;
}

/**
 * The audio channel. Construct one at boot; it never throws, and every play
 * method is safe to call unconditionally.
 */
export class AudioManager {
  private readonly hit: Howl | null;
  private readonly dash: Howl | null;
  private readonly coin: Howl | null;
  private readonly available: boolean;
  private muted = false;

  constructor() {
    const built = AudioManager.build();
    this.hit = built.hit;
    this.dash = built.dash;
    this.coin = built.coin;
    this.available = built.available;
  }

  /** True when a real audio backend was constructed (diagnostics / assertions). */
  public get isAvailable(): boolean {
    return this.available;
  }

  /** Play the hit thud. No-op when audio is unavailable or muted. */
  public playHit(): void {
    this.play(this.hit);
  }

  /** Play the dash sweep. No-op when audio is unavailable or muted. */
  public playDash(): void {
    this.play(this.dash);
  }

  /** Play the coin chime. No-op when audio is unavailable or muted. */
  public playCoin(): void {
    this.play(this.coin);
  }

  /** Mute / unmute the whole channel (howler owns the global mute flag). */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.available) return;
    try {
      Howler.mute(muted);
    } catch {
      // A missing audio context must never break the caller.
    }
  }

  /** Release the underlying howls (best-effort; safe to call twice). */
  public dispose(): void {
    for (const sound of [this.hit, this.dash, this.coin]) {
      if (sound === null) continue;
      try {
        sound.unload();
      } catch {
        // Unloading an already-gone sound is not an error worth surfacing.
      }
    }
  }

  private play(sound: Howl | null): void {
    if (!this.available || this.muted || sound === null) return;
    try {
      sound.play();
    } catch {
      // Autoplay policy / no AudioContext: stay silent rather than throw.
    }
  }

  /**
   * Synthesise the three sounds and build their howls. Any failure — no
   * `window`, no `Howl`, a refusing audio backend — degrades to
   * `available: false` with three `null` sounds.
   */
  private static build(): BuiltSounds {
    try {
      // `globalThis.window` rather than a bare `window`: the bare DOM global does not
      // exist in the DOM-free `npm run typecheck` program (`lib: ["ES2022"]`), which
      // made this module un-importable from `tests/**` (TS2304). `globalThis.window`
      // IS `window` in a browser, so the guard is behaviour-identical — and it lets the
      // node audio suite (tests/audio/audio_manager.test.ts) exercise the silent-
      // degradation contract (spec 22 I9) that was otherwise untested.
      const hasWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
      if (!hasWindow || typeof Howl === 'undefined') {
        return { hit: null, dash: null, coin: null, available: false };
      }
      return {
        hit: new Howl({ src: [synthHit()], format: ['wav'], volume: 0.6 }),
        dash: new Howl({ src: [synthDash()], format: ['wav'], volume: 0.4 }),
        coin: new Howl({ src: [synthCoin()], format: ['wav'], volume: 0.4 }),
        available: true,
      };
    } catch {
      return { hit: null, dash: null, coin: null, available: false };
    }
  }
}
