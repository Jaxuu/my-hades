/**
 * Tilemap art tests (specs/026-hd-2d-art-assets US3, T029).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * US3 turns the room into a tiled scene WITHOUT adding a single scene-graph node.
 * That is the whole design (research.md D10): the six frozen contracts F1–F6 are
 * re-asserted here, in the presence of art, so a future "let me just add a
 * tilemapLayer" refactor fails loudly instead of quietly breaking the suites that
 * live in `tests/render/`.
 *
 * The room also has to keep its SHAPE: one wall node per wall entity, positioned at
 * that wall's world origin, with the art TILED (never stretched) across a meshed
 * AABB — FR-009.
 *
 * M18 NOTE (T030): the F1–F6 block below is a FROZEN CONTRACT and is reproduced
 * UNCHANGED from M16. Only the structural, asset-coupled assertions elsewhere in
 * this file were re-pinned — the tile scale moved from the 16px base to the HD
 * 128px base, and a pillar room was added as a paving acceptance scene (C7). The
 * M18 depth work is asserted in `tilemap_autotile.test.ts` (completeness,
 * pixel containment, non-occlusion, floor determinism), which is a separate suite
 * precisely so this file's frozen block stays easy to eyeball against M16.
 */

import { describe, expect, it } from 'vitest';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameRenderer, PX_PER_UNIT, TILE_NATURAL_PX } from '../../client/GameRenderer';
import { NULL_SPRITE_PROVIDER } from '../../client/assets/AssetCatalog';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { LevelLoader } from '../../src/core/LevelLoader';
import { WallComponent } from '../../src/ecs/components/WallComponent';
import { loadedCatalog } from '../harness/art-fixtures';

function makeApp(deltaMs = 16): Application {
  const ticker = { deltaMS: deltaMs, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/** The render root: the camera's LAST child (F2). */
function renderRoot(app: Application): Container {
  const camera = app.stage.children[0];
  if (camera === undefined) throw new Error('F1 broken: no camera on the stage');
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('F2 broken: no render root under the camera');
  return root;
}

/** Enter `roomId` for a fresh player and sync once. */
function enterRoom(sim: GameSimulator, renderer: GameRenderer, roomId: string): number {
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  const result = LevelLoader.enterRoom(sim.world, { roomId, playerId: player });
  renderer.syncWorld(sim.world);
  return result.wallCount;
}

describe('US3 · the static layer keeps its node and gains tiles (FR-007)', () => {
  it('puts the static layer at camera index 0 and fills it with tile sprites', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();

    const wallCount = enterRoom(sim, renderer, 'start_room');
    expect(wallCount).toBeGreaterThan(0);

    const camera = app.stage.children[0];
    const staticLayer = camera?.children[0];
    expect(staticLayer).toBeDefined();
    expect(staticLayer).not.toBe(renderRoot(app));

    // Child 0 is the floor node, children 1..n are the wall nodes — one per wall
    // entity, in wall-entity order.
    expect(staticLayer?.children.length).toBe(1 + wallCount);

    const floorNode = staticLayer?.children[0];
    const wallNode = staticLayer?.children[1];
    expect(floorNode?.children.some((child) => child instanceof Sprite)).toBe(true);
    expect(wallNode?.children.some((child) => child instanceof Sprite)).toBe(true);
    renderer.destroy();
  });

  it('positions each wall node at its own world origin (not at absolute pixels)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'arena_room');

    const staticLayer = app.stage.children[0]?.children[0];
    const wallIds = sim.world.query(WallComponent);
    for (let i = 0; i < wallIds.length; i += 1) {
      const id = wallIds[i];
      if (id === undefined) continue;
      const wall = sim.world.getComponent(id, WallComponent);
      const node = staticLayer?.children[i + 1];
      if (wall === undefined || node === undefined) throw new Error('missing wall node');
      expect(node.x).toBe(wall.x * PX_PER_UNIT);
      expect(node.y).toBe(wall.y * PX_PER_UNIT);
    }
    renderer.destroy();
  });

  it('TILES a meshed wall instead of stretching one tile across it (FR-009)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');

    const staticLayer = app.stage.children[0]?.children[0];
    const wallIds = sim.world.query(WallComponent);
    let sawMeshedWall = false;
    for (let i = 0; i < wallIds.length; i += 1) {
      const id = wallIds[i];
      if (id === undefined) continue;
      const wall = sim.world.getComponent(id, WallComponent);
      const node = staticLayer?.children[i + 1];
      if (wall === undefined || node === undefined) continue;
      const expected = Math.max(1, Math.round(wall.width)) * Math.max(1, Math.round(wall.height));
      expect(node.children.length).toBe(expected);
      if (expected > 1) sawMeshedWall = true;
    }
    // Guard against a vacuous pass: the room must actually contain a meshed wall,
    // otherwise "tiling" was never exercised.
    expect(sawMeshedWall).toBe(true);
    renderer.destroy();
  });

  it('lays a floor tile per cell of the room footprint', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');

    const staticLayer = app.stage.children[0]?.children[0];
    const floorNode = staticLayer?.children[0];
    // start_room is 10x10, so the footprint is 100 tiles.
    expect(floorNode?.children.length).toBe(100);
    renderer.destroy();
  });

  it('draws the scene at the HD tile base, so a cell is exactly one world unit (T029)', async () => {
    // M18 re-pinned this from the 16px pixel base to the 128px HD base. The literal
    // is the point: the conversion base is a CONTRACT (`contracts/tilemap-autotile.md`
    // §1), and `tests/assets/licenses.test.ts` separately cross-checks it against
    // `tiles.json`'s `meta.tilePx`.
    expect(TILE_NATURAL_PX).toBe(128);
    const expected = PX_PER_UNIT / TILE_NATURAL_PX;

    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');

    const staticLayer = app.stage.children[0]?.children[0];
    const floorNode = staticLayer?.children[0];
    const wallNode = staticLayer?.children[1];
    for (const node of [floorNode, wallNode]) {
      for (const sprite of node?.children ?? []) {
        if (!(sprite instanceof Sprite)) continue;
        expect(sprite.scale.x).toBeCloseTo(expected, 9);
        // One cell of art == one world unit of scene, so nothing is stretched.
        expect(sprite.scale.x * TILE_NATURAL_PX).toBeCloseTo(PX_PER_UNIT, 9);
      }
    }
    renderer.destroy();
  });

  it('paves a room with INTERNAL PILLARS without stretching or misplacing (T029 / C7 / SC-005)', async () => {
    // SC-005 names three acceptance rooms: the small start room, an arena with
    // pillars, and the 30x30 stress room. The pillar room is the interesting one —
    // an autotile that only understood the outline would flatten it.
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();

    const wallCount = enterRoom(sim, renderer, 'arena_room');
    const staticLayer = app.stage.children[0]?.children[0];
    expect(staticLayer?.children.length).toBe(1 + wallCount);

    // arena_room is 12x10 -> a 120-cell floor, and every wall node still carries
    // exactly one sprite per cell of its own AABB.
    const floorNode = staticLayer?.children[0];
    expect(floorNode?.children.length).toBe(120);

    const wallIds = sim.world.query(WallComponent);
    let pillarCells = 0;
    for (let i = 0; i < wallIds.length; i += 1) {
      const id = wallIds[i];
      if (id === undefined) continue;
      const wall = sim.world.getComponent(id, WallComponent);
      const node = staticLayer?.children[i + 1] as Container | undefined;
      if (wall === undefined || node === undefined) continue;
      const expected = Math.max(1, Math.round(wall.width)) * Math.max(1, Math.round(wall.height));
      expect(node.children.length).toBe(expected);
      const interior = wall.x > 0 && wall.y > 0 && wall.x + wall.width < 12 && wall.y + wall.height < 10;
      if (interior) pillarCells += expected;
    }
    // Guard against a vacuous pass: the arena really does have internal pillars.
    expect(pillarCells).toBeGreaterThan(0);
    renderer.destroy();
  });
});

describe('US3 · the six frozen scene-graph contracts still hold WITH art (F1–F6)', () => {
  it('F1: the stage has exactly one child, and it is the camera', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');

    expect(app.stage.children).toHaveLength(1);
    expect(app.stage.children[0]).toBe(renderer.camera);
    renderer.destroy();
  });

  it('F2 + F3 + F4: camera→root→fxLayer, and the first entity view leads the root', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');

    const root = renderRoot(app);
    const fxLayer = root.children[root.children.length - 1];
    expect(fxLayer).toBeDefined();
    // F4: the FIRST child of the root is an entity view, not the FX layer.
    expect(root.children[0]).not.toBe(fxLayer);
    // F3: the FX layer is empty at rest — no spark borrows it.
    expect(fxLayer?.children).toHaveLength(0);
    renderer.destroy();
  });

  it('F5: with NO walls the camera holds exactly the render root', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(renderer.camera.children).toHaveLength(1);
    expect(renderer.camera.children[0]).toBe(renderRoot(app));
    renderer.destroy();
  });

  it('F6: the FX layer is empty while idle, art or not', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'stress_room');

    const root = renderRoot(app);
    const fxLayer = root.children[root.children.length - 1];
    expect(fxLayer?.children).toHaveLength(0);
    // And the camera is [static?, root] — the layer sits at index 0, never after.
    expect(renderer.camera.children[renderer.camera.children.length - 1]).toBe(root);
    renderer.destroy();
  });
});

describe('US3 · room transitions rebuild the tiles exactly once (FR-009, D9)', () => {
  it('rebuilds the static layer for the new room with no leftovers', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();

    const startWalls = enterRoom(sim, renderer, 'start_room');
    const startLayer = app.stage.children[0]?.children[0];
    expect(startLayer?.children.length).toBe(1 + startWalls);

    // A room transition destroys the old walls and creates new ones; the layer must
    // be torn down and rebuilt, never appended to.
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const arena = LevelLoader.enterRoom(sim.world, { roomId: 'arena_room', playerId: player });
    renderer.syncWorld(sim.world);

    const arenaLayer = app.stage.children[0]?.children[0];
    expect(arenaLayer?.children.length).toBe(1 + arena.wallCount);
    expect(arena.wallCount).not.toBe(startWalls);
    // The floor node is 12x10 = 120 tiles, i.e. genuinely the NEW room.
    expect(arenaLayer?.children[0]?.children.length).toBe(120);
    renderer.destroy();
  });

  it('does NOT rebuild the tiles on a frame where the room did not change', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');

    const layer = app.stage.children[0]?.children[0];
    const wallNodeBefore = layer?.children[1];
    for (let i = 0; i < 30; i += 1) renderer.syncWorld(sim.world);
    // The SAME node instances survive: the signature guard prevented a per-frame
    // rebuild (which would be ~1000 destroyed/recreated sprites per second).
    expect(layer?.children[1]).toBe(wallNodeBefore);
    renderer.destroy();
  });

  it('tears the layer down completely when the last wall disappears (F5 again)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    enterRoom(sim, renderer, 'start_room');
    expect(renderer.camera.children.length).toBe(2);

    for (const id of [...sim.world.query(WallComponent)]) {
      sim.world.destroyEntity(id);
    }
    renderer.syncWorld(sim.world);

    expect(renderer.wallViewCount).toBe(0);
    expect(renderer.camera.children).toHaveLength(1);
    renderer.destroy();
  });
});

describe('US3 · a missing tiles atlas degrades to the pre-feature blocks (FR-013)', () => {
  it('draws the old floor rectangle and wall blocks', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const renderer = new GameRenderer(app, NULL_SPRITE_PROVIDER);
    renderer.init();
    const wallCount = enterRoom(sim, renderer, 'start_room');

    const layer = app.stage.children[0]?.children[0];
    expect(layer?.children.length).toBe(1 + wallCount);
    const floorNode = layer?.children[0];
    const wallNode = layer?.children[1];
    expect(floorNode?.children[0]).toBeInstanceOf(Graphics);
    expect(wallNode?.children[0]).toBeInstanceOf(Graphics);
    expect(wallNode?.children.some((child) => child instanceof Sprite)).toBe(false);
    renderer.destroy();
  });
});
