/**
 * AssetCatalog — load the manifest, degrade entry by entry.
 * See specs/024-real-art-assets/contracts/asset-manifest.md §3 and research.md D2/D10.
 *
 * WHAT IT PROMISES
 * ----------------
 *  1. **Per-entry isolation.** Every id is loaded inside its own `try`/`catch`. One
 *     broken file marks THAT id `degraded` and leaves every other id untouched —
 *     a single bad atlas must not blank the screen (FR-013, SC-007).
 *  2. **Terminal degradation.** `degraded` is final; there is no retry. A per-frame
 *     retry would turn one corrupt file into a stutter for the whole session.
 *  3. **De-duplication by source.** Five enemy types share `enemies.png`, so the
 *     texture is fetched and decoded ONCE and the six ids resolve animations out of
 *     the same sheet. Loading it six times would be six decodes of the same bytes.
 *  4. **Audio is a URL, not a buffer.** `kind === 'audio'` never touches pixi.js:
 *     the catalog just hands the built URL to howler. Keeping the decode on
 *     howler's side is what keeps the audio channel's silent-degradation contract
 *     (`AudioManager`) unchanged.
 *
 * WHY THE LOADER IS INJECTABLE
 * ----------------------------
 * PixiJS's asset loader needs an ImageBitmap-capable environment. The test process
 * has none, so `PixiAssetLoader` is the production seam and a fake loader is the
 * test seam. That is what makes "exactly one entry degrades, the rest stay ready"
 * an assertable statement instead of a browser-only hope.
 */

import { Assets, Spritesheet, Texture, TextureSource } from 'pixi.js';

import type { AssetKind } from './manifest';
import { MANIFEST, MANIFEST_IDS, SHEET_DATA } from './manifest';

/** Loading lifecycle (data-model E1). `ready` and `degraded` are both terminal. */
export type AssetState = 'declared' | 'loading' | 'ready' | 'degraded';

/**
 * The narrow seam over "get me a texture for this URL".
 *
 * Production uses {@link PixiAssetLoader}; tests inject a fake so the degradation
 * matrix is deterministic and needs no DOM.
 */
export interface AssetLoader {
  loadTexture(source: string): Promise<Texture>;
}

/** The production loader: PixiJS's own asset pipeline (caching, formats, progress). */
export class PixiAssetLoader implements AssetLoader {
  public async loadTexture(source: string): Promise<Texture> {
    return await Assets.load<Texture>(source);
  }
}

/**
 * The presentation-side view of the loaded assets.
 *
 * Kept structural (rather than "the catalog class") so a render test can pass a
 * three-line stub and assert on the sprite branch without loading a single file.
 */
export interface SpriteProvider {
  /**
   * Frames of ONE animation key (`<spriteId>.<action>.<facing>`), or `undefined`
   * when that key is not on the sheet — which is what makes the renderer's
   * fallback chain meaningful rather than dead code.
   */
  animation(key: string): readonly Texture[] | undefined;
  /** A single texture for a static id (`tile.*` / `fx.*` / `ui.icon.*` / image). */
  texture(id: string): Texture | undefined;
  /** A local URL for a CSS-consumed id (the DOM skin never touches pixi.js). */
  url(id: string): string | undefined;
}

/**
 * The provider used when no catalog was injected. Every lookup misses, so every
 * consumer takes its geometry fallback — which is exactly the pre-feature
 * behaviour, and what keeps the frozen render suites green.
 */
export const NULL_SPRITE_PROVIDER: SpriteProvider = Object.freeze({
  animation: (): undefined => undefined,
  texture: (): undefined => undefined,
  url: (): undefined => undefined,
});

/** One source's shared load result: the sheet (or texture) every id resolves against. */
interface SourceBundle {
  readonly sheet: Spritesheet | null;
  readonly texture: Texture | null;
}

export class AssetCatalog implements SpriteProvider {
  private readonly loader: AssetLoader;
  private readonly states = new Map<string, AssetState>();
  /** Animation key -> frames, flattened across every sheet at load time. */
  private readonly animations = new Map<string, readonly Texture[]>();
  /** `image` id -> its texture. */
  private readonly textures = new Map<string, Texture>();
  /** id -> the URL to hand to CSS / howler. Populated for EVERY id, ready or not. */
  private readonly urls = new Map<string, string>();
  private loaded = false;

  constructor(loader: AssetLoader = new PixiAssetLoader()) {
    this.loader = loader;
    for (const id of MANIFEST_IDS) {
      this.states.set(id, 'declared');
      const entry = MANIFEST[id];
      if (entry !== undefined) this.urls.set(id, entry.source);
    }
  }

  /** True once {@link load} has settled (successfully or not). */
  public get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Load every entry, one `try`/`catch` per id. NEVER throws: a caller can
   * `await catalog.load()` on the boot path without a guard, because "no assets"
   * is a supported state (the game falls back to geometry), not an error.
   */
  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    // M17 (specs/025-camera-zoom-viewport FR-008): the atlas is PIXEL ART and M17
    // magnifies it by up to 16x, so it must be sampled nearest-neighbour. PixiJS's
    // default is `linear`, which smears every source texel into its neighbours —
    // at 8.64x that turns crisp 16x16 tiles into mush.
    //
    // THIS LINE'S POSITION IS THE WHOLE POINT: `TextureSource` copies
    // `defaultOptions` at CONSTRUCTION time, so a texture built before this runs is
    // already committed to `linear` and would stay blurry for the whole session.
    // It is therefore set before the first `loadTexture` call below, not after the
    // loop — and it is a global default rather than a per-texture patch so a new
    // atlas entry cannot forget it.
    TextureSource.defaultOptions.scaleMode = 'nearest';

    // Load each distinct SOURCE once; each id then adopts the result inside its
    // own try/catch. The promise is cached BEFORE awaiting so a shared source is
    // not fetched N times while the first fetch is still in flight.
    const inFlight = new Map<string, Promise<SourceBundle>>();

    for (const id of MANIFEST_IDS) {
      const entry = MANIFEST[id];
      if (entry === undefined) continue;
      this.states.set(id, 'loading');

      if (entry.kind === 'audio') {
        // Nothing to decode here: howler owns audio loading, and the URL is
        // already registered by the constructor.
        this.states.set(id, 'ready');
        continue;
      }

      try {
        let pending = inFlight.get(entry.source);
        if (pending === undefined) {
          pending = this.resolveSource(entry.source, entry.kind, id);
          inFlight.set(entry.source, pending);
        }
        const bundle = await pending;
        this.adopt(id, entry.kind, bundle);
        this.states.set(id, 'ready');
      } catch {
        // Terminal: the id falls back to its geometry/silence path and is never
        // retried. Other ids sharing this source fail with it — they ARE the same
        // bytes, so pretending otherwise would be a lie the screen could not keep.
        this.states.set(id, 'degraded');
      }
    }
  }

  /** The lifecycle state of one id (`declared` before `load`). */
  public state(id: string): AssetState {
    return this.states.get(id) ?? 'degraded';
  }

  /** True when the id could not be loaded, i.e. its consumer MUST use its fallback. */
  public isDegraded(id: string): boolean {
    return this.state(id) === 'degraded';
  }

  /** Every degraded id, in registry order (diagnostics / boot logging). */
  public degradedIds(): readonly string[] {
    return MANIFEST_IDS.filter((id) => this.isDegraded(id));
  }

  /** Every ready id, in registry order (diagnostics / assertions). */
  public readyIds(): readonly string[] {
    return MANIFEST_IDS.filter((id) => this.state(id) === 'ready');
  }

  public animation(key: string): readonly Texture[] | undefined {
    return this.animations.get(key);
  }

  /**
   * A single texture for a static id.
   *
   * For a spritesheet the animation named exactly after the id is used
   * (`tile.floor`, `fx.spark`, `ui.icon.gold` are all single-frame animations named
   * after their id), so the tiles atlas can hold two unrelated tiles without
   * ambiguity. Falls back to the sheet's first frame if that name is absent, so a
   * renamed animation degrades to "some texture" rather than to nothing.
   */
  public texture(id: string): Texture | undefined {
    const direct = this.textures.get(id);
    if (direct !== undefined) return direct;
    const named = this.animations.get(id);
    if (named !== undefined && named.length > 0) return named[0];
    return undefined;
  }

  public url(id: string): string | undefined {
    return this.urls.get(id);
  }

  /** Fetch + decode one distinct source into the shape its ids need. */
  private async resolveSource(
    source: string,
    kind: AssetKind,
    sampleId: string,
  ): Promise<SourceBundle> {
    const texture = await this.loader.loadTexture(source);
    if (kind !== 'spritesheet') {
      return { sheet: null, texture };
    }
    const data = SHEET_DATA[sampleId];
    if (data === undefined) {
      throw new Error(`no spritesheet data declared for '${sampleId}'`);
    }
    const sheet = new Spritesheet(texture, data);
    await sheet.parse();
    return { sheet, texture };
  }

  /** Register one id's resolved bundle into the lookup tables. */
  private adopt(id: string, kind: AssetKind, bundle: SourceBundle): void {
    if (kind === 'spritesheet') {
      const sheet = bundle.sheet;
      if (sheet === null) throw new Error(`spritesheet '${id}' resolved without a sheet`);
      for (const [key, frames] of Object.entries(sheet.animations)) {
        if (frames.length > 0) this.animations.set(key, frames);
      }
      return;
    }
    if (bundle.texture !== null) this.textures.set(id, bundle.texture);
  }
}
