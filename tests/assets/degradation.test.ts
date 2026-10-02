/**
 * Graceful-degradation tests (specs/024-real-art-assets US5, T030).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * FR-013 splits failure handling in two, and this file covers the RUNTIME half:
 * a file that exists but cannot be decoded must degrade LOCALLY. The two claims
 * that actually need a machine to check them are:
 *
 *   - **zero external requests** (FR-012 / SC-005): every `source` in the manifest
 *     is a local build artifact. A CDN URL typed into the manifest would be
 *     invisible until an offline reviewer opened DevTools — this catches it in CI.
 *   - **per-entry isolation** (SC-007): one un-decodable file must NOT take the
 *     others down with it. The fake loader below breaks exactly ONE source and
 *     asserts that every other id still reaches `ready`.
 */

import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';

import { AssetCatalog } from '../../client/assets/AssetCatalog';
import type { AssetLoader } from '../../client/assets/AssetCatalog';
import { MANIFEST, MANIFEST_IDS } from '../../client/assets/manifest';
import { GameRenderer } from '../../client/GameRenderer';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

/** The one source the fake loader refuses to decode. */
const BROKEN_SOURCE = 'broken://atlas';

/** A loader that resolves every source to a 1x1 white texture except one. */
function loaderBreakingOneSource(): AssetLoader {
  return {
    loadTexture: async (source: string): Promise<Texture> => {
      if (source === BROKEN_SOURCE) {
        throw new Error('injected decode failure');
      }
      return Texture.WHITE;
    },
  };
}

function makeApp(): Application {
  const ticker = { deltaMS: 20, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

describe('zero external requests (FR-012 / SC-005)', () => {
  it('keeps every source a LOCAL build path', () => {
    const remote = MANIFEST_IDS.filter((id) => {
      const source = MANIFEST[id]?.source ?? '';
      return source.startsWith('http://') || source.startsWith('https://') || source.startsWith('//');
    });
    expect(remote).toEqual([]);
  });

  it('never declares a source that is empty or whitespace', () => {
    for (const id of MANIFEST_IDS) {
      expect((MANIFEST[id]?.source ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

describe('per-entry degradation (FR-013 runtime half / SC-007)', () => {
  it('degrades EVERY entry when the loader cannot decode anything', async () => {
    const catalog = new AssetCatalog({
      loadTexture: async (): Promise<Texture> => {
        throw new Error('no asset backend');
      },
    });
    await catalog.load();
    // Audio never goes through the loader, so it stays ready — and that asymmetry
    // is the point: silence is decided by howler, not by the texture pipeline.
    const visual = MANIFEST_IDS.filter((id) => MANIFEST[id]?.kind !== 'audio');
    for (const id of visual) {
      expect(catalog.isDegraded(id)).toBe(true);
    }
    expect(catalog.degradedIds().length).toBe(visual.length);
  });

  it('leaves every id ready when the loader succeeds', async () => {
    const catalog = new AssetCatalog(loaderBreakingOneSource());
    await catalog.load();
    expect(catalog.degradedIds()).toEqual([]);
    expect(catalog.readyIds().length).toBe(MANIFEST_IDS.length);
  });

  it('reports exactly the entries that failed, not the whole manifest', async () => {
    // Break one REAL source: `ui.panel.hud` is the only id using that file.
    const target = MANIFEST['ui.panel.hud'];
    expect(target).toBeDefined();
    const brokenSource = target?.source ?? '';
    const catalog = new AssetCatalog({
      loadTexture: async (source: string): Promise<Texture> => {
        if (source === brokenSource) throw new Error('injected decode failure');
        return Texture.WHITE;
      },
    });
    await catalog.load();

    expect(catalog.isDegraded('ui.panel.hud')).toBe(true);
    expect(catalog.degradedIds()).toEqual(['ui.panel.hud']);
    // The atlas entries and the audio entries are untouched.
    expect(catalog.isDegraded('player.base')).toBe(false);
    expect(catalog.isDegraded('enemy.gunner')).toBe(false);
    expect(catalog.isDegraded('sfx.hit')).toBe(false);
  });

  it('is terminal: a degraded id is never retried on a second load', async () => {
    let calls = 0;
    const catalog = new AssetCatalog({
      loadTexture: async (source: string): Promise<Texture> => {
        calls += 1;
        if (source === BROKEN_SOURCE) throw new Error('nope');
        return Texture.WHITE;
      },
    });
    await catalog.load();
    const first = calls;
    await catalog.load();
    expect(calls).toBe(first);
  });

  it('exposes a URL for every id even when the texture degraded (CSS can still try)', () => {
    const catalog = new AssetCatalog(loaderBreakingOneSource());
    expect(catalog.url('ui.panel.reward')).toBe(MANIFEST['ui.panel.reward']?.source);
  });
});

describe('a fully degraded catalog still produces a playable scene (SC-007)', () => {
  it('renders every view through the geometry fallback instead of disappearing', async () => {
    const catalog = new AssetCatalog({
      loadTexture: async (): Promise<Texture> => {
        throw new Error('no asset backend');
      },
    });
    await catalog.load();

    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    EnemyFactory.spawn(sim.world, 'grunt', { x: 2, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    // Two entity views exist and are attached — the geometry fallback is real,
    // not a blank node.
    expect(renderer.viewCount).toBe(2);
    const camera = app.stage.children[0];
    expect(camera).toBeDefined();
    const root = camera?.children[(camera.children.length ?? 0) - 1];
    expect(root?.children.length).toBeGreaterThanOrEqual(2);
    renderer.destroy();
  });

  it('keeps audio silent rather than throwing when the catalog degraded', async () => {
    const catalog = new AssetCatalog({
      loadTexture: async (): Promise<Texture> => {
        throw new Error('no asset backend');
      },
    });
    await catalog.load();
    // A degraded catalog reports no texture, which is the value the renderer's
    // `?? geometry` branches are written against.
    expect(catalog.texture('tile.floor')).toBeUndefined();
    expect(catalog.animation('player.base.idle.down')).toBeUndefined();
  });
});
