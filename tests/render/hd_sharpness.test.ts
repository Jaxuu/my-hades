/**
 * M18 · US6 — HD world art is sampled `linear` WITH mipmaps, while the global
 * default stays `nearest` (T055 / FR-025 / research.md D7).
 *
 * THE TWO HALVES OF THE DECISION, AND WHY THEY CANNOT BE MERGED
 * ------------------------------------------------------------
 * M17 set `TextureSource.defaultOptions.scaleMode = 'nearest'` GLOBALLY, because the
 * atlas was 16x16 pixel art magnified by up to 16x — and
 * `tests/render/camera_zoom_sharpness.test.ts` pins that literal. That file is NOT in
 * this feature's authorised update set (FR-028), so the global default MUST stay.
 *
 * HD art needs the opposite treatment: it is not pixel art, so at a non-integer
 * magnification `nearest` produces hard aliasing, and the 30x30 stress room at
 * `z = 2.88` minifies 128px to 29px — a 4.4x reduction that MOIRES without mipmaps
 * (SC-009). The resolution is a PER-TEXTURE override for the world art only, which
 * satisfies both: M17's assertion keeps passing untouched, and the HD art gets the
 * sampling it needs.
 *
 * WHY THIS TEST BUILDS ITS OWN LOADER
 * -----------------------------------
 * The shared `WHITE_LOADER` fixture resolves every source to the SAME `Texture.WHITE`
 * instance, so all ids would share one `TextureSource` and "is this id linear?" would
 * have no answer. The loader below returns a DISTINCT source per URL, which is what
 * the browser does and what makes the per-id claim observable. `WHITE_LOADER` itself
 * is left alone (`tests/harness/art-fixtures.ts`, T011).
 */

import { describe, expect, it } from 'vitest';
import { Texture, TextureSource } from 'pixi.js';

import { AssetCatalog } from '../../client/assets/AssetCatalog';
import type { AssetLoader } from '../../client/assets/AssetCatalog';
import { HD_WORLD_ART_IDS, MANIFEST, MANIFEST_IDS } from '../../client/assets/manifest';

/** A loader that hands out a fresh 1x1 source per URL, so filtering is per-id. */
const DISTINCT_LOADER: AssetLoader = {
  loadTexture: async (): Promise<Texture> => {
    const source = new TextureSource({ width: 1, height: 1 });
    return new Texture({ source });
  },
};

async function loadedCatalog(): Promise<AssetCatalog> {
  const catalog = new AssetCatalog(DISTINCT_LOADER);
  await catalog.load();
  return catalog;
}

/** The source behind an id's texture: its `idle.down` clip, its same-name clip, or its image. */
function sourceOf(catalog: AssetCatalog, id: string): TextureSource | undefined {
  for (const key of [`${id}.idle.down`, id]) {
    const frames = catalog.animation(key);
    if (frames !== undefined && frames[0] !== undefined) return frames[0].source;
  }
  return catalog.texture(id)?.source;
}

describe('T055 · HD world art is linear + mipmapped, per texture (FR-025)', () => {
  it('keeps the GLOBAL default at "nearest" — the M17 contract is untouched', async () => {
    await loadedCatalog();
    expect(TextureSource.defaultOptions.scaleMode).toBe('nearest');
  });

  it('names exactly the player / enemy / tile / fx namespaces as HD world art', () => {
    expect(HD_WORLD_ART_IDS.length).toBeGreaterThan(0);
    for (const id of HD_WORLD_ART_IDS) {
      const namespaced =
        id.startsWith('player.') ||
        id.startsWith('enemy.') ||
        id.startsWith('tile.') ||
        id.startsWith('fx.');
      expect(namespaced, `${id} is not world art`).toBe(true);
      expect(id.startsWith('ui.') || id.startsWith('sfx.'), `${id} must not be HD art`).toBe(false);
    }
    // ...and every world-art id in the manifest is covered, so a new one cannot be
    // added without being filtered.
    const worldArt = MANIFEST_IDS.filter(
      (id) =>
        MANIFEST[id]?.kind !== 'audio' &&
        (id.startsWith('player.') || id.startsWith('enemy.') || id.startsWith('tile.') || id.startsWith('fx.')),
    );
    expect([...HD_WORLD_ART_IDS].sort()).toEqual([...worldArt].sort());
  });

  it('samples every HD world-art texture with linear + autoGenerateMipmaps', async () => {
    const catalog = await loadedCatalog();
    for (const id of HD_WORLD_ART_IDS) {
      const source = sourceOf(catalog, id);
      expect(source, `${id} resolved to no texture`).toBeDefined();
      if (source === undefined) continue;
      expect(source.scaleMode, `${id} scaleMode`).toBe('linear');
      expect(source.autoGenerateMipmaps, `${id} autoGenerateMipmaps`).toBe(true);
    }
    // Guard against a vacuous pass: the set really covers the four namespaces.
    for (const prefix of ['player.', 'enemy.', 'tile.', 'fx.']) {
      expect(HD_WORLD_ART_IDS.some((id) => id.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('leaves the RETAINED interface textures at "nearest" (FR-030 is not collateral)', async () => {
    const catalog = await loadedCatalog();
    const uiSheets = MANIFEST_IDS.filter((id) => id.startsWith('ui.') && MANIFEST[id]?.kind === 'spritesheet');
    const uiImages = MANIFEST_IDS.filter((id) => id.startsWith('ui.') && MANIFEST[id]?.kind === 'image');
    expect(uiSheets.length).toBeGreaterThan(0);
    expect(uiImages.length).toBeGreaterThan(0);
    for (const id of [...uiSheets, ...uiImages]) {
      const source = sourceOf(catalog, id);
      expect(source, `${id} resolved to no texture`).toBeDefined();
      if (source === undefined) continue;
      expect(source.scaleMode, `${id} must stay pixel-crisp`).toBe('nearest');
    }
  });

  it('applies the override BEFORE the sheet is parsed, so frames inherit it', async () => {
    // The frame sub-textures PixiJS derives from a source share that source. If the
    // override ran after `sheet.parse()`, the frames would still report the old
    // source — so asserting on a FRAME (not on the sheet object) is what proves the
    // ordering, and ordering is the entire M17 lesson.
    const catalog = await loadedCatalog();
    const frames = catalog.animation('player.base.idle.down');
    expect(frames).toBeDefined();
    expect((frames ?? []).length).toBeGreaterThan(0);
    expect(frames?.[0]?.source.scaleMode).toBe('linear');
    expect(frames?.[0]?.source.autoGenerateMipmaps).toBe(true);
  });

  it('degrades gracefully: a broken HD atlas still leaves the global default set', async () => {
    const catalog = new AssetCatalog({
      loadTexture: async () => {
        throw new Error('QA: simulated decode failure');
      },
    });
    await catalog.load();
    expect(catalog.degradedIds().length).toBeGreaterThan(0);
    expect(TextureSource.defaultOptions.scaleMode).toBe('nearest');
  });
});
