/**
 * M17 · US1 — pixel art stays SHARP when magnified (specs/025-camera-zoom-viewport,
 * FR-008).
 *
 * WHY THIS IS A REAL DEFECT FIX AND NOT A NICETY
 * ----------------------------------------------
 * PixiJS defaults to `linear` sampling. That is the right default for a smooth
 * photograph and the wrong one for pixel art: at M17's zoom factors (8.64 for a
 * 10x10 room on 1080p) every source texel becomes an 8-9 pixel block, and linear
 * filtering smears each block into its neighbours — the "渗色 / 糊" FR-008 forbids.
 *
 * The setting has to be GLOBAL and it has to be applied BEFORE any texture is
 * created, because `TextureSource` copies `defaultOptions` at construction time
 * (`options = { ...TextureSource.defaultOptions, ...options }`). Setting it after
 * the atlas has loaded would change nothing for the textures already built — which
 * is exactly the failure mode this test catches, since it asserts the option AND
 * that loading did not undo it.
 *
 * The assertion is a literal string (`'nearest'`), not a comparison against the
 * constant the implementation used.
 */

import { describe, expect, it } from 'vitest';
import { TextureSource } from 'pixi.js';

import { AssetCatalog } from '../../client/assets/AssetCatalog';
import { WHITE_LOADER } from '../harness/art-fixtures';

describe('T010 · the atlas is sampled with nearest-neighbour filtering (FR-008)', () => {
  it('AssetCatalog.load() leaves TextureSource.defaultOptions.scaleMode at "nearest"', async () => {
    const catalog = new AssetCatalog(WHITE_LOADER);
    await catalog.load();

    expect(TextureSource.defaultOptions.scaleMode).toBe('nearest');
  });

  it('the option is set BEFORE any texture is created, not after', async () => {
    // The load path is the only place textures come from, so the option must already
    // be `nearest` by the time the FIRST entry resolves. This probe records the value
    // seen by the loader itself — if the implementation set the option at the END of
    // `load()`, every texture in the run would already have been built with `linear`.
    const seen: (string | undefined)[] = [];
    const catalog = new AssetCatalog({
      loadTexture: async () => {
        seen.push(TextureSource.defaultOptions.scaleMode);
        const { Texture } = await import('pixi.js');
        return Texture.WHITE;
      },
    });
    await catalog.load();

    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) expect(value).toBe('nearest');
  });

  it('a degraded catalog still leaves the option set (the game must stay sharp)', async () => {
    const catalog = new AssetCatalog({
      loadTexture: async () => {
        throw new Error('QA: simulated decode failure');
      },
    });
    await catalog.load();

    // Every id degraded, yet the sampling mode is a global setting that outlives a
    // failed load — a broken file must not also make the fallback art blurry.
    expect(catalog.degradedIds().length).toBeGreaterThan(0);
    expect(TextureSource.defaultOptions.scaleMode).toBe('nearest');
  });
});
