/**
 * Art fixtures for the render suites (specs/024-real-art-assets T013/T017/T021/T034).
 *
 * WHY A SHARED FIXTURE RATHER THAN A MOCK PROVIDER
 * ------------------------------------------------
 * The render suites must exercise the REAL atlas wiring: the real manifest ids, the
 * real animation names, the real frame labels. Writing a hand-rolled stub with
 * invented keys would let the renderer and the sheets drift apart while every test
 * stayed green.
 *
 * So the fixture builds a real {@link AssetCatalog} and swaps only its LOADER: every
 * source resolves to `Texture.WHITE`, and `Spritesheet.parse()` then slices that one
 * source into the real frame rectangles and labels each one with its frame name.
 * `sprite.texture.label` is therefore the exact frame the renderer chose — a
 * readable, exact assertion that needs no DOM and no image decoding.
 */

import { Texture } from 'pixi.js';

import { AssetCatalog } from '../../client/assets/AssetCatalog';
import type { AssetLoader } from '../../client/assets/AssetCatalog';
import { SHEET_DATA } from '../../client/assets/manifest';

/** A loader that resolves every source to a 1x1 white texture. */
export const WHITE_LOADER: AssetLoader = {
  loadTexture: async (): Promise<Texture> => Texture.WHITE,
};

/** A catalog whose atlas structure is REAL and whose pixels are irrelevant. */
export async function loadedCatalog(): Promise<AssetCatalog> {
  const catalog = new AssetCatalog(WHITE_LOADER);
  await catalog.load();
  return catalog;
}

/** The frame name the sheet declares at `index` for `animation` (e.g. its frame 0). */
export function frameName(animation: string, index = 0): string | undefined {
  for (const data of Object.values(SHEET_DATA)) {
    const frames = data.animations?.[animation];
    if (frames !== undefined) return frames[index];
  }
  return undefined;
}

/** The frame LABEL of a sprite's currently displayed texture (its frame name). */
export function displayedFrame(sprite: { texture: Texture }): string | undefined {
  return sprite.texture.label;
}
