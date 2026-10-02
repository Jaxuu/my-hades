/**
 * AudioManager — the presentation layer's audio channel.
 * See specs/22_audio_and_juice_spec.md §3.3 / §4.4 and
 * specs/024-real-art-assets/research.md D8 (M16).
 *
 * WHAT IT IS
 * ----------
 * Nine REAL, locally-bundled CC0 sound effects — hit, dash, coin, enemy death,
 * hazard blast, UI click, reward select, death, win — played through howler. The
 * sources are Vite-resolved URLs handed in by `AssetCatalog`; this module never
 * knows where a file lives, which is what keeps the asset manifest the single
 * source of truth for "does this sound exist".
 *
 * (Before M16 this module SYNTHESISED three placeholder WAV `data:` URIs. Those are
 * gone: the manifest declares `fallback: 'silent'` for every audio entry, so the
 * honest degradation is silence, not a different noise.)
 *
 * SILENT DEGRADATION IS THE CONTRACT
 * ----------------------------------
 * Audio is best-effort. In a headless run, under an autoplay policy that blocks
 * the context, or on any environment where `Howl` / `AudioContext` is missing,
 * every method must be a silent no-op — NEVER a throw. `build()` wraps the whole
 * construction in try/catch and reports `available: false`; every play call is
 * guarded by `available` and its own try/catch. A missing sound must never be able
 * to break the game loop (spec 22 I9).
 *
 * Degradation is PER SOUND as well as per channel: a URL the catalog could not
 * resolve leaves that one `Howl` null while the other eight still play.
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
 * program (`lib: ["ES2022"]`) with TS2304. The guard below reads
 * `globalThis.window`, which removes that hazard, but the isolation is kept as a
 * deliberate discipline: `howler` belongs to the audio channel and nothing else.
 */

import { Howl, Howler } from 'howler';

/**
 * The manifest ids this channel plays, in the vocabulary the SINK uses.
 *
 * Exported and frozen so `tests/audio/audio_assets.test.ts` can pin the mapping
 * literally: a typo in an id would otherwise show up only as a silent game.
 */
export const SFX_IDS = Object.freeze({
  hit: 'sfx.hit',
  dash: 'sfx.dash',
  coin: 'sfx.coin',
  enemyDeath: 'sfx.enemy-death',
  hazardBlast: 'sfx.hazard-blast',
  uiClick: 'sfx.ui-click',
  rewardSelect: 'sfx.reward-select',
  death: 'sfx.death',
  win: 'sfx.win',
});

/** One of the nine playable sounds. */
export type SfxName = keyof typeof SFX_IDS;

/** Every sound name, in manifest order. */
export const SFX_NAMES: readonly SfxName[] = Object.freeze(
  Object.keys(SFX_IDS) as SfxName[],
);

/** Per-sound playback gain. Impacts are loud, ambience-ish cues are quieter. */
const SFX_VOLUME: Readonly<Record<SfxName, number>> = {
  hit: 0.55,
  dash: 0.4,
  coin: 0.45,
  enemyDeath: 0.45,
  hazardBlast: 0.5,
  uiClick: 0.4,
  rewardSelect: 0.5,
  death: 0.6,
  win: 0.6,
};

/**
 * The narrow seam this module needs from the asset layer: "the built URL for this
 * asset id". Structural rather than "the AssetCatalog class" so the audio channel
 * depends on one method instead of a loader.
 */
export interface SfxUrlSource {
  url(id: string): string | undefined;
}

/** The nine howls (any of which may be null) plus whether a backend was built. */
type BuiltSounds = {
  readonly sounds: ReadonlyMap<SfxName, Howl>;
  readonly available: boolean;
};

/**
 * The audio channel. Construct one at boot; it never throws, and every play method
 * is safe to call unconditionally.
 */
export class AudioManager {
  private readonly sounds: ReadonlyMap<SfxName, Howl>;
  private readonly available: boolean;
  private muted = false;

  /**
   * @param urls the asset layer's URL resolver. OMITTED is a supported state: it
   *   means "no assets", which degrades to a silent channel rather than to an
   *   error — the same shape `resolveStorage` uses for a missing localStorage.
   */
  constructor(urls?: SfxUrlSource) {
    const built = AudioManager.build(urls);
    this.sounds = built.sounds;
    this.available = built.available;
  }

  /** True when a real audio backend was constructed (diagnostics / assertions). */
  public get isAvailable(): boolean {
    return this.available;
  }

  /** How many of the nine sounds resolved to a playable source. */
  public get loadedSoundCount(): number {
    return this.sounds.size;
  }

  /** Play one named sound. No-op when audio is unavailable, muted, or missing. */
  public play(name: SfxName): void {
    const sound = this.sounds.get(name);
    if (sound === undefined) return;
    this.playHowl(sound);
  }

  /** Play the hit thud. No-op when audio is unavailable or muted. */
  public playHit(): void {
    this.play('hit');
  }

  /** Play the dash sweep. No-op when audio is unavailable or muted. */
  public playDash(): void {
    this.play('dash');
  }

  /** Play the coin chime. No-op when audio is unavailable or muted. */
  public playCoin(): void {
    this.play('coin');
  }

  /** Play the enemy-death crunch. No-op when audio is unavailable or muted. */
  public playEnemyDeath(): void {
    this.play('enemyDeath');
  }

  /** Play the hazard detonation. No-op when audio is unavailable or muted. */
  public playHazardBlast(): void {
    this.play('hazardBlast');
  }

  /** Play the UI button click. No-op when audio is unavailable or muted. */
  public playUiClick(): void {
    this.play('uiClick');
  }

  /** Play the reward-selection chime. No-op when audio is unavailable or muted. */
  public playRewardSelect(): void {
    this.play('rewardSelect');
  }

  /** Play the run-ending death sting. No-op when audio is unavailable or muted. */
  public playDeath(): void {
    this.play('death');
  }

  /** Play the run-ending victory sting. No-op when audio is unavailable or muted. */
  public playWin(): void {
    this.play('win');
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
    for (const sound of this.sounds.values()) {
      try {
        sound.unload();
      } catch {
        // Unloading an already-gone sound is not an error worth surfacing.
      }
    }
  }

  private playHowl(sound: Howl): void {
    if (!this.available || this.muted) return;
    try {
      sound.play();
    } catch {
      // Autoplay policy / no AudioContext: stay silent rather than throw.
    }
  }

  /**
   * Build the nine howls from the catalog's URLs. Any failure — no `window`, no
   * `Howl`, a refusing audio backend, a URL that never resolved — degrades that
   * sound (or the whole channel) to silence, never to a throw.
   */
  private static build(urls: SfxUrlSource | undefined): BuiltSounds {
    const sounds = new Map<SfxName, Howl>();
    try {
      // `globalThis.window` rather than a bare `window`: the bare DOM global does not
      // exist in the DOM-free `npm run typecheck` program (`lib: ["ES2022"]`), which
      // made this module un-importable from `tests/**` (TS2304). `globalThis.window`
      // IS `window` in a browser, so the guard is behaviour-identical — and it lets the
      // node audio suite (tests/audio/audio_manager.test.ts) exercise the silent-
      // degradation contract (spec 22 I9) that was otherwise untested.
      const hasWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
      if (!hasWindow || typeof Howl === 'undefined' || urls === undefined) {
        return { sounds, available: false };
      }
      for (const name of SFX_NAMES) {
        const source = urls.url(SFX_IDS[name]);
        // A single unresolved URL must not cost the other eight sounds.
        if (source === undefined || source.length === 0) continue;
        sounds.set(name, new Howl({ src: [source], volume: SFX_VOLUME[name] }));
      }
      return { sounds, available: sounds.size > 0 };
    } catch {
      return { sounds: new Map<SfxName, Howl>(), available: false };
    }
  }
}
