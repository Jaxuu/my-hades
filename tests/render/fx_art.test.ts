/**
 * In-world FX + pickup art tests (specs/024-real-art-assets US6, T034).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 *  1. **The sparks really come from the fx atlas.** The frozen `juice_m14` suite
 *     asserts every particle is a `Graphics`, so the art arrives as a TEXTURE FILL
 *     rather than as a `Sprite` — which means "did the art get used?" is not
 *     visible in the node type. A recording provider answers it directly.
 *  2. **The hazard telegraph's progress is still the COMPONENT's fuse.** US6 says
 *     the warning's timing must not move; only its appearance may. The assertion is
 *     against `delayTicks / totalDelayTicks`, so a renderer that started keeping its
 *     own clock would fail.
 *  3. **The three pickups stay distinguishable with the colour channel removed.**
 *     Verified against the alpha-channel shape signatures the atlas generator
 *     records (`meta.silhouettes`), not against a hand-written claim.
 */

import { describe, expect, it } from 'vitest';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameRenderer } from '../../client/GameRenderer';
import type { SpriteProvider } from '../../client/assets/AssetCatalog';
import { SHEET_DATA } from '../../client/assets/manifest';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { spawnPickup, PickupKind } from '../../src/ecs/components/PickupComponent';
import { HazardComponent, spawnHazard } from '../../src/ecs/components/HazardComponent';
import { Faction } from '../../src/ecs/components/FactionComponent';
import { World } from '../../src/ecs/World';
import { vec2 } from '../../src/core/math';
import type { DashEvent, HitEvent } from '../../src/ecs/events';
import type { FrameEvents } from '../../client/ClientEventBridge';
import { loadedCatalog } from '../harness/art-fixtures';

/** One synthetic hit / dash frame, the same shape `juice_m14` drives the VFX with. */
function hitEvent(x = 3, y = 0): HitEvent {
  return {
    tick: 0,
    attackerId: 0,
    targetId: 1,
    hitboxEntityId: 2,
    position: vec2(x, y),
    damage: 10,
    sourceModifier: null,
  };
}

function dashEvent(): DashEvent {
  return { tick: 0, entityId: 0, position: vec2(2, 2), direction: vec2(1, 0) };
}

function frameWith(partial: Partial<FrameEvents>): FrameEvents {
  return {
    hits: partial.hits ?? [],
    deaths: partial.deaths ?? [],
    dashes: partial.dashes ?? [],
  };
}

function makeApp(deltaMs = 16): Application {
  const ticker = { deltaMS: deltaMs, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/** The render root's children, minus the FX layer (which is always last). */
function entityViews(app: Application): readonly Container[] {
  const camera = app.stage.children[0];
  if (camera === undefined) throw new Error('no camera');
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('no render root');
  return root.children.slice(0, Math.max(0, root.children.length - 1)) as readonly Container[];
}

/** A provider that records which ids/animations the renderer asked for. */
function recordingProvider(base: SpriteProvider): {
  readonly provider: SpriteProvider;
  readonly askedAnimations: string[];
  readonly askedTextures: string[];
} {
  const askedAnimations: string[] = [];
  const askedTextures: string[] = [];
  return {
    askedAnimations,
    askedTextures,
    provider: {
      animation: (key: string): ReturnType<SpriteProvider['animation']> => {
        askedAnimations.push(key);
        return base.animation(key);
      },
      texture: (id: string): ReturnType<SpriteProvider['texture']> => {
        askedTextures.push(id);
        return base.texture(id);
      },
      url: (id: string): string | undefined => base.url(id),
    },
  };
}

describe('US6 · sparks and trails come from the fx atlas (FR-017)', () => {
  it('asks the provider for fx.spark on a hit and fx.dash-trail on a dash', async () => {
    const catalog = await loadedCatalog();
    const { provider, askedTextures } = recordingProvider(catalog);
    const app = makeApp(16);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app, provider);
    renderer.init();
    renderer.syncWorld(sim.world);

    // Drive the sparks through the REAL frame path (the drained event bridge), not
    // through a back door: the point is the art source, and juice_m14 owns the wiring.
    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
    renderer.syncWorld(sim.world, 1, frameWith({ dashes: [dashEvent()] }));

    expect(askedTextures).toContain('fx.spark');
    expect(askedTextures).toContain('fx.dash-trail');
    renderer.destroy();
  });

  it('keeps every spark a Graphics, so the frozen particle contract holds', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp(16);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
    expect(renderer.sparkCount).toBe(6);
    // The layer is mounted lazily just below the root (F2 stays true).
    const root = renderer.camera.children[renderer.camera.children.length - 1];
    expect(root).toBeDefined();
    const particleLayer = renderer.camera.children[0];
    expect(particleLayer).not.toBe(root);
    expect(particleLayer?.children).toHaveLength(6);
    for (const spark of particleLayer?.children ?? []) {
      expect(spark).toBeInstanceOf(Graphics);
    }
    renderer.destroy();
  });

  it('falls back to the pre-feature streak when the atlas is unavailable', () => {
    const app = makeApp(16);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(() => {
      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
      renderer.syncWorld(sim.world, 1, frameWith({ dashes: [dashEvent()] }));
    }).not.toThrow();
    expect(renderer.sparkCount).toBe(11);
    renderer.destroy();
  });
});

describe('US6 · the hazard telegraph still runs on the COMPONENT fuse (FR-017)', () => {
  it('renders the ring art and grows it from delayTicks / totalDelayTicks', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp(16);
    const world = new World({ seed: 11 });
    const hazardId = spawnHazard(world, {
      x: 0,
      y: 0,
      radius: 2,
      damage: 10,
      delayTicks: 30,
      faction: Faction.Enemy,
    });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(world);

    const view = entityViews(app)[0];
    expect(view).toBeDefined();
    // The ring is the atlas decal, tinted to the hazard colour.
    const ring = view?.children.find((child): child is Sprite => child instanceof Sprite);
    expect(ring?.texture.label).toBe('fx.hazard-ring.0');

    const hazard = world.getComponent(hazardId, HazardComponent);
    if (hazard === undefined) throw new Error('hazard lost its component');

    // Progress is 1 - remaining / total. Walk the fuse down and record the scale.
    const scales: number[] = [];
    for (const remaining of [30, 20, 10, 0]) {
      hazard.delayTicks = remaining;
      renderer.syncWorld(world);
      scales.push(view?.scale.x ?? 0);
    }
    expect(scales[0]).toBeLessThan(scales[1] ?? 0);
    expect(scales[1]).toBeLessThan(scales[2] ?? 0);
    expect(scales[2]).toBeLessThan(scales[3] ?? 0);
    renderer.destroy();
  });

  it('does NOT keep its own clock: the same component state renders the same size', async () => {
    const catalog = await loadedCatalog();
    const world = new World({ seed: 12 });
    const hazardId = spawnHazard(world, {
      x: 0,
      y: 0,
      radius: 2,
      damage: 10,
      delayTicks: 15,
      faction: Faction.Enemy,
    });
    const hazard = world.getComponent(hazardId, HazardComponent);
    if (hazard === undefined) throw new Error('hazard lost its component');
    hazard.delayTicks = 15;

    const sizes: number[] = [];
    for (const deltaMs of [16, 500, 16]) {
      const app = makeApp(deltaMs);
      const renderer = new GameRenderer(app, catalog);
      renderer.init();
      renderer.syncWorld(world);
      sizes.push(entityViews(app)[0]?.scale.x ?? 0);
      renderer.destroy();
    }
    // 500ms of real time between two identical component states must not move the
    // warning: its progress is the FUSE, not the frame clock.
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[1]).toBe(sizes[2]);
  });
});

describe('US6 · pickups use one icon per kind, and stay distinct in greyscale (FR-017)', () => {
  it('draws a different ui.icon.* for each kind', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp(16);
    const world = new World({ seed: 13 });
    spawnPickup(world, { x: 0, y: 0, kind: PickupKind.GOLD });
    spawnPickup(world, { x: 2, y: 0, kind: PickupKind.HEAL });
    spawnPickup(world, { x: 4, y: 0, kind: PickupKind.DARKNESS });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(world);

    const labels = entityViews(app).map((view) => {
      const icon = view.children.find((child): child is Sprite => child instanceof Sprite);
      return icon?.texture.label ?? 'MISSING';
    });
    expect(labels).toEqual(['ui.icon.gold.0', 'ui.icon.heal.0', 'ui.icon.darkness.0']);
    expect(new Set(labels).size).toBe(3);
    renderer.destroy();
  });

  it('keeps the three silhouettes pairwise different with colour removed', () => {
    const ui = SHEET_DATA['ui.icon.gold'];
    expect(ui).toBeDefined();
    const silhouettes = (ui?.meta as { silhouettes?: Record<string, { grid: string; rows: number[] }> })
      .silhouettes;
    expect(silhouettes).toBeDefined();
    if (silhouettes === undefined) return;

    const ids = ['ui.icon.gold', 'ui.icon.heal', 'ui.icon.darkness'];
    for (const id of ids) {
      expect(silhouettes[id]).toBeDefined();
    }
    // Pairwise distinct coarse grids...
    const grids = ids.map((id) => silhouettes[id]?.grid ?? '');
    expect(new Set(grids).size).toBe(3);
    // ...AND pairwise distinct row profiles, which is the finer claim: two shapes
    // can share an 8x8 coverage map and still differ here.
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = silhouettes[ids[i] ?? '']?.rows ?? [];
        const b = silhouettes[ids[j] ?? '']?.rows ?? [];
        expect(a.length).toBeGreaterThan(0);
        expect(a.join(',')).not.toBe(b.join(','));
      }
    }
  });

  it('separates the SHAPE LANGUAGE of "pick up" from "run away"', () => {
    const ui = SHEET_DATA['ui.icon.gold']?.meta as
      | { silhouettes?: Record<string, { grid: string }> }
      | undefined;
    const fx = SHEET_DATA['fx.hazard-ring']?.meta as
      | { silhouettes?: Record<string, { grid: string }> }
      | undefined;
    const coin = ui?.silhouettes?.['ui.icon.gold']?.grid ?? '';
    const ring = fx?.silhouettes?.['fx.hazard-ring']?.grid ?? '';
    expect(coin.length).toBe(64);
    expect(ring.length).toBe(64);
    // The coin is a SOLID blob (its middle is filled); the ring is HOLLOW (its
    // middle is empty). That difference survives desaturation, which is what
    // FR-017's "MUST NOT 混淆" asks for. The centre 2x2 of an 8x8 grid is the four
    // cells at (3,3) (3,4) (4,3) (4,4).
    const centre = (grid: string): string => [27, 28, 35, 36].map((i) => grid[i] ?? '?').join('');
    expect(centre(coin)).toBe('1111');
    expect(centre(ring)).toBe('0000');
  });

  it('falls back to the pre-feature discs when the atlas is unavailable', () => {
    const app = makeApp(16);
    const world = new World({ seed: 14 });
    spawnPickup(world, { x: 0, y: 0, kind: PickupKind.GOLD });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(world);

    const view = entityViews(app)[0];
    expect(view?.children[0]).toBeInstanceOf(Graphics);
    renderer.destroy();
  });
});
