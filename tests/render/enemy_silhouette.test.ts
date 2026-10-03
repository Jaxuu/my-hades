/**
 * Enemy silhouette distinctness (specs/026-hd-2d-art-assets T024, FR-004 / SC-002).
 *
 * WHY THIS SUITE IS SEPARATE FROM `enemy_art.test.ts`
 * ---------------------------------------------------
 * `enemy_art.test.ts` proves the renderer PICKS a different sprite id per type. It
 * cannot prove the picked sprites LOOK different — that is an art claim, and it is
 * the one the user actually asked for ("关闭颜色线索仍可区分"). SC-002 puts a number
 * on it (>= 90% correct identification with colour removed), which is a human
 * judgement; what a machine CAN check is the necessary condition underneath it:
 * **the silhouettes are pairwise different**.
 *
 * ⚠️ WHY THE PIXELS ARE DECODED, NOT JUST THE METADATA
 * ---------------------------------------------------
 * The obvious implementation reads `meta.silhouettes` and compares the strings. That
 * is NOT enough, and the independent review flagged it: `meta.silhouettes` is written
 * by the atlas GENERATOR, so if the generator wrote stale or hand-written metadata the
 * distinctness assertions would pass while the shipped art was identical. So every
 * declared silhouette is first **recomputed from the PNG's real alpha channel** and
 * asserted EQUAL to the declaration; only then do the distinctness claims run — and
 * they run on the PIXEL-DERIVED values, which are ground truth.
 *
 * Two claims are asserted SEPARATELY (the `/speckit.analyze` finding I2 — "5
 * categories" vs "6 ids"):
 *
 *   1. the five types the data table DECLARES are pairwise distinguishable;
 *   2. the sixth, catch-all `unknown` sprite is distinguishable from all five.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHEET_DATA } from '../../client/assets/manifest';
import { decodePng, silhouetteOf, type Silhouette } from '../harness/png';

const REPO_ROOT = process.cwd();

/** The categories the data table declares (`assets/data/enemies.json`). */
const DECLARED_TYPES = ['grunt', 'elite', 'raider', 'bomber', 'gunner'] as const;

/** The sixth, catch-all sprite: never `undefined`, never invisible. */
const FALLBACK_TYPE = 'unknown';

const ALL_TYPES: readonly string[] = [...DECLARED_TYPES, FALLBACK_TYPE];

/** The silhouette the atlas DECLARES for a type. */
function declaredSilhouette(type: string): Silhouette {
  const meta = SHEET_DATA[`enemy.${type}`]?.meta as
    | { silhouettes?: Record<string, Silhouette> }
    | undefined;
  const entry = meta?.silhouettes?.[`enemy.${type}`];
  expect(entry, `enemy.${type} declares no silhouette`).toBeDefined();
  if (entry === undefined) throw new Error(`enemy.${type} declares no silhouette`);
  return entry;
}

/** The silhouette RECOMPUTED from the shipped PNG's alpha channel. */
function pixelSilhouette(type: string): Silhouette {
  const sheet = SHEET_DATA[`enemy.${type}`];
  const frame = sheet?.frames[`enemy.${type}.idle.down.0`]?.frame;
  expect(frame, `enemy.${type} has no idle.down.0 frame`).toBeDefined();
  if (frame === undefined) throw new Error(`enemy.${type} has no idle.down.0 frame`);
  const png = decodePng(resolve(REPO_ROOT, `assets/art/hd/enemy-${type}.png`));
  return silhouetteOf(png, frame.x, frame.y, frame.w, frame.h);
}

describe('the declared silhouettes ARE the shipped pixels', () => {
  it('recomputes every enemy silhouette from the PNG and matches the declaration', () => {
    // This is the load-bearing check: it makes `meta.silhouettes` evidence rather
    // than a claim, so the distinctness assertions below cannot pass on stale data.
    for (const type of ALL_TYPES) {
      const declared = declaredSilhouette(type);
      const measured = pixelSilhouette(type);
      expect(measured.grid, `${type} grid`).toBe(declared.grid);
      expect([...measured.rows], `${type} rows`).toEqual([...declared.rows]);
      expect(measured.opaque, `${type} opaque total`).toBe(declared.opaque);
    }
  });

  it('gives every enemy a real, non-degenerate shape', () => {
    for (const type of ALL_TYPES) {
      const silhouette = pixelSilhouette(type);
      expect(silhouette.grid, type).toHaveLength(64);
      expect(silhouette.rows, type).toHaveLength(8);
      expect(silhouette.opaque, type).toBeGreaterThan(0);
      // Guard against a vacuous "shape": a fully-filled rectangle is not a
      // silhouette, and would trivially satisfy any distinctness rule.
      expect(silhouette.grid.includes('0'), `${type} covers its whole box`).toBe(true);
      expect(silhouette.grid.includes('1'), `${type} is empty`).toBe(true);
      // The two structures are derived in the same pass, so they must agree.
      expect(silhouette.rows.reduce((a, b) => a + b, 0), `${type} rows vs opaque`).toBe(
        silhouette.opaque,
      );
    }
  });
});

describe('① the five DECLARED types are pairwise distinguishable (FR-004 / SC-002)', () => {
  it('has five distinct coverage grids', () => {
    const grids = DECLARED_TYPES.map((type) => pixelSilhouette(type).grid);
    expect(new Set(grids).size).toBe(DECLARED_TYPES.length);
  });

  it('has five distinct row profiles (the finer claim)', () => {
    const profiles = DECLARED_TYPES.map((type) => ({
      type,
      profile: pixelSilhouette(type).rows.join(','),
    }));
    for (const [i, a] of profiles.entries()) {
      for (const b of profiles.slice(i + 1)) {
        expect(a.profile, `${a.type} vs ${b.type} share a row profile`).not.toBe(b.profile);
      }
    }
  });
});

describe('② the catch-all `unknown` is distinguishable from all five (I2)', () => {
  it('has a grid that matches none of the declared types', () => {
    const fallback = pixelSilhouette(FALLBACK_TYPE).grid;
    for (const type of DECLARED_TYPES) {
      expect(pixelSilhouette(type).grid, `unknown looks like ${type}`).not.toBe(fallback);
    }
  });

  it('has a row profile that matches none of the declared types', () => {
    const fallback = pixelSilhouette(FALLBACK_TYPE).rows.join(',');
    for (const type of DECLARED_TYPES) {
      expect(pixelSilhouette(type).rows.join(','), `unknown matches ${type}`).not.toBe(fallback);
    }
  });
});
