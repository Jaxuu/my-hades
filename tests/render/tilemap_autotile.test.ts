/**
 * HD dungeon autotile + floor tests (specs/026-hd-2d-art-assets US3, T031-T034).
 *
 * FOUR INDEPENDENT PROPERTIES, FOUR DESCRIBE BLOCKS
 * -------------------------------------------------
 * The room upgrade rests on four claims that fail for different reasons, so they are
 * asserted separately rather than folded into one "the tilemap works" test:
 *
 *   T031 **completeness** (contract §3.2 / VR-13) — EVERY one of the 256 neighbour
 *        masks resolves to a part. A missing combination is a HOLE in the wall, which
 *        is the single most visible way a tileset can be wrong.
 *   T032 **containment** (FR-008 / research.md D9) — a wall part's pixels never leave
 *        its own cell. This is what makes "the visible wall boundary IS the collision
 *        boundary" constructive rather than a hope: if the pixels cannot leave the
 *        cell, they cannot disagree with the collision geometry.
 *   T033 **non-occlusion** (FR-010) — a wall's face never projects onto a walkable
 *        cell. T032 and T033 are NOT the same claim (a part could stay inside its cell
 *        and the cell could still be walkable), so neither may stand in for the other.
 *   T034 **determinism** (contract §4) — the floor variant choice is a hash of the
 *        cell coordinate: identical across rebuilds, and it never draws from
 *        `World.rng`.
 *
 * T032/T033 are PIXEL assertions, so they decode the atlas with the dependency-free
 * decoder in `tests/harness/png.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Container, Sprite } from 'pixi.js';
import type { Application } from 'pixi.js';

import {
  GameRenderer,
  PX_PER_UNIT,
  TILE_NATURAL_PX,
  WALL_PART_COUNT,
  WALL_PART_MASKS,
  floorVariantIndex,
  wallPartAnimationKey,
  wallPartIndex,
} from '../../client/GameRenderer';
import { SHEET_DATA } from '../../client/assets/manifest';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { LevelLoader } from '../../src/core/LevelLoader';
import { WallComponent } from '../../src/ecs/components/WallComponent';
import { loadedCatalog } from '../harness/art-fixtures';
import { decodePng, isTransparent, meanLuminance } from '../harness/png';

const REPO_ROOT = process.cwd();
const TILES_PNG = resolve(REPO_ROOT, 'assets/art/hd/tiles.png');
const GUTTER = 4;

interface RoomData {
  readonly width: number;
  readonly height: number;
  readonly grid: readonly (readonly number[])[];
}

function rooms(): Readonly<Record<string, RoomData>> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'assets/data/rooms.json'), 'utf8')) as Record<
    string,
    RoomData
  >;
}

function makeApp(): Application {
  const ticker = { deltaMS: 16, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

describe('T031 · the autotile part set is COMPLETE (contract §3.2 / VR-13)', () => {
  it('reduces the 256 neighbour masks to exactly 47 canonical parts', () => {
    expect(WALL_PART_COUNT).toBe(47);
    expect(WALL_PART_MASKS).toHaveLength(47);
    expect(new Set(WALL_PART_MASKS).size).toBe(47);
    // Ascending, so the part index is a stable, reproducible name.
    expect([...WALL_PART_MASKS].sort((a, b) => a - b)).toEqual([...WALL_PART_MASKS]);
  });

  it('resolves EVERY mask to a part in range, with no hole', () => {
    const seen = new Set<number>();
    for (let mask = 0; mask < 256; mask += 1) {
      const index = wallPartIndex(mask);
      expect(Number.isInteger(index), `mask ${String(mask)}`).toBe(true);
      expect(index, `mask ${String(mask)}`).toBeGreaterThanOrEqual(0);
      expect(index, `mask ${String(mask)}`).toBeLessThan(WALL_PART_COUNT);
      seen.add(index);
    }
    // Surjective: every part is actually reachable, so the atlas carries no dead art.
    expect(seen.size).toBe(WALL_PART_COUNT);
  });

  it('sends the isolated wall and the fully-surrounded wall to opposite ends', () => {
    expect(wallPartIndex(0)).toBe(0);
    expect(wallPartIndex(255)).toBe(WALL_PART_COUNT - 1);
  });

  it('ignores a diagonal that has no supporting edges (the 47-way reduction)', () => {
    // Up-right alone (bit 1) with no wall above and none to the right is
    // indistinguishable from an isolated wall.
    expect(wallPartIndex(0b00000010)).toBe(wallPartIndex(0));
    // ...but with BOTH edges present it becomes a real corner.
    expect(wallPartIndex(0b00000111)).not.toBe(wallPartIndex(0));
  });

  it('declares a real atlas animation for all 47 parts, each with frames', () => {
    const animations = SHEET_DATA['tile.wall']?.animations ?? {};
    const frames = SHEET_DATA['tile.wall']?.frames ?? {};
    for (let mask = 0; mask < 256; mask += 1) {
      const key = wallPartAnimationKey(mask);
      const list = animations[key];
      expect(list, `${key} is missing from tiles.json`).toBeDefined();
      expect((list ?? []).length).toBeGreaterThan(0);
      for (const frame of list ?? []) expect(frames[frame], `${key} -> ${frame}`).toBeDefined();
    }
    // The id-level `tile.wall` animation survives as the generic fallback part.
    expect(animations['tile.wall']).toBeDefined();
  });
});

describe('T032 · wall pixels never leave their cell (FR-008 / research.md D9)', () => {
  const png = decodePng(TILES_PNG);
  const sheet = SHEET_DATA['tile.wall'];
  const wallFrames = Object.entries(sheet?.frames ?? {}).filter(([name]) =>
    name.startsWith('tile.wall'),
  );

  it('sizes every wall part to exactly one tile cell', () => {
    // If a part were drawn larger than a cell it WOULD project beyond the wall's
    // collision footprint. Pinning the frame to the cell is what makes the
    // containment property constructive.
    expect(wallFrames.length).toBeGreaterThanOrEqual(WALL_PART_COUNT);
    for (const [name, frame] of wallFrames) {
      expect(frame.frame.w, name).toBe(TILE_NATURAL_PX);
      expect(frame.frame.h, name).toBe(TILE_NATURAL_PX);
    }
  });

  it('leaves the gutter between cells fully transparent (no bleed into a neighbour)', () => {
    // Bleeding is the mechanism by which a part's pixels could APPEAR inside the
    // neighbouring cell; an opaque gutter would defeat the containment claim even
    // though every frame rectangle was the right size.
    for (const [name, frame] of wallFrames) {
      const right = frame.frame.x + frame.frame.w;
      const below = frame.frame.y + frame.frame.h;
      expect(isTransparent(png, right, frame.frame.y, GUTTER, frame.frame.h), `${name} right gutter`).toBe(true);
      expect(isTransparent(png, frame.frame.x, below, frame.frame.w, GUTTER), `${name} bottom gutter`).toBe(true);
    }
  });

  it('builds each part from three depth bands, brightest at the top (research.md D9)', () => {
    const capH = Math.round(TILE_NATURAL_PX * 0.55);
    const faceH = Math.round(TILE_NATURAL_PX * 0.43);
    for (const [name, frame] of wallFrames) {
      const { x, y } = frame.frame;
      const cap = meanLuminance(png, x, y, TILE_NATURAL_PX, capH);
      const face = meanLuminance(png, x, y + capH, TILE_NATURAL_PX, faceH);
      const shadow = meanLuminance(png, x, y + capH + faceH, TILE_NATURAL_PX, TILE_NATURAL_PX - capH - faceH);
      expect(cap, `${name} cap`).toBeDefined();
      expect(face, `${name} face`).toBeDefined();
      expect(shadow, `${name} shadow`).toBeDefined();
      if (cap === undefined || face === undefined || shadow === undefined) continue;
      // 受光面 / 背光面 / 接地阴影: a strictly decreasing ramp is what reads as depth.
      expect(cap, `${name}: cap must be brighter than the face`).toBeGreaterThan(face + 5);
      expect(face, `${name}: face must be brighter than the contact shadow`).toBeGreaterThan(shadow + 5);
    }
  });

  it('keeps every part non-empty (no blank tile in the set)', () => {
    for (const [name, frame] of wallFrames) {
      const opaque = !isTransparent(png, frame.frame.x, frame.frame.y, frame.frame.w, frame.frame.h);
      expect(opaque, `${name} is fully transparent`).toBe(true);
    }
  });
});

describe('T033 · the wall face never covers a walkable cell (FR-010)', () => {
  it('draws every wall cell sprite exactly one cell wide, at a cell origin', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const staticLayer = app.stage.children[0]?.children[0];
    const scale = PX_PER_UNIT / TILE_NATURAL_PX;
    let cells = 0;
    for (const child of staticLayer?.children ?? []) {
      for (const sprite of (child as Container).children) {
        if (!(sprite instanceof Sprite)) continue;
        cells += 1;
        expect(sprite.scale.x).toBeCloseTo(scale, 9);
        expect(sprite.scale.y).toBeCloseTo(scale, 9);
        // Cell-aligned: an offset would push the art off its own collision cell.
        expect(Math.abs(sprite.x / PX_PER_UNIT - Math.round(sprite.x / PX_PER_UNIT))).toBeLessThan(1e-9);
        expect(Math.abs(sprite.y / PX_PER_UNIT - Math.round(sprite.y / PX_PER_UNIT))).toBeLessThan(1e-9);
        // Drawn extent == one cell (in pixels).
        expect(sprite.scale.x * TILE_NATURAL_PX).toBeCloseTo(PX_PER_UNIT, 9);
      }
    }
    expect(cells).toBeGreaterThan(0);
    renderer.destroy();
  });

  it('puts every wall sprite on a cell the ROOM GRID calls a wall', async () => {
    // The strong form of FR-010: cross-check the renderer's cell choice against the
    // authoritative room data, so "no wall art on a walkable cell" is verified
    // against the same source the collision geometry comes from.
    const room = rooms()['arena_room'];
    expect(room).toBeDefined();
    if (room === undefined) return;

    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    LevelLoader.enterRoom(sim.world, { roomId: 'arena_room', playerId: player });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const staticLayer = app.stage.children[0]?.children[0];
    const wallIds = sim.world.query(WallComponent);
    let checked = 0;
    for (let i = 0; i < wallIds.length; i += 1) {
      const id = wallIds[i];
      if (id === undefined) continue;
      const wall = sim.world.getComponent(id, WallComponent);
      const node = staticLayer?.children[i + 1] as Container | undefined;
      if (wall === undefined || node === undefined) continue;
      for (const sprite of node.children) {
        if (!(sprite instanceof Sprite)) continue;
        const cellX = Math.round(wall.x) + Math.round(sprite.x / PX_PER_UNIT);
        const cellY = Math.round(wall.y) + Math.round(sprite.y / PX_PER_UNIT);
        const row = room.grid[cellY];
        expect(row, `cell (${String(cellX)}, ${String(cellY)}) is outside the room`).toBeDefined();
        expect(row?.[cellX], `wall art drawn on walkable cell (${String(cellX)}, ${String(cellY)})`).not.toBe(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
    renderer.destroy();
  });

  it('covers a room with INTERNAL PILLARS, not only a rectangular outline (C7 / SC-005)', async () => {
    const room = rooms()['arena_room'];
    if (room === undefined) throw new Error('arena_room missing');
    // The arena has free-standing 2x2 blocks strictly inside its bounds; if the
    // autotile only understood the outline they would render as flat floor.
    let pillars = 0;
    for (let y = 1; y < room.height - 1; y += 1) {
      for (let x = 1; x < room.width - 1; x += 1) {
        if (room.grid[y]?.[x] === 1) pillars += 1;
      }
    }
    expect(pillars).toBeGreaterThan(0);

    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    LevelLoader.enterRoom(sim.world, { roomId: 'arena_room', playerId: player });
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    // A pillar is a wall entity whose AABB is strictly inside the room footprint.
    const staticLayer = app.stage.children[0]?.children[0];
    const wallIds = sim.world.query(WallComponent);
    let pillarNodes = 0;
    for (let i = 0; i < wallIds.length; i += 1) {
      const id = wallIds[i];
      if (id === undefined) continue;
      const wall = sim.world.getComponent(id, WallComponent);
      const node = staticLayer?.children[i + 1] as Container | undefined;
      if (wall === undefined || node === undefined) continue;
      const interior =
        wall.x > 0 && wall.y > 0 && wall.x + wall.width < room.width && wall.y + wall.height < room.height;
      if (!interior) continue;
      pillarNodes += 1;
      const sprites = node.children.filter((child) => child instanceof Sprite);
      expect(sprites.length, 'pillar cells must each render a part').toBe(
        Math.max(1, Math.round(wall.width)) * Math.max(1, Math.round(wall.height)),
      );
    }
    expect(pillarNodes).toBeGreaterThan(0);
    renderer.destroy();
  });
});

describe('T034 · the floor variant choice is deterministic (contract §4)', () => {
  it('hashes the cell coordinate, stays in range, and needs no randomness', () => {
    for (let col = 0; col < 40; col += 1) {
      for (let row = 0; row < 40; row += 1) {
        const index = floorVariantIndex(col, row, 8);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(8);
        expect(floorVariantIndex(col, row, 8)).toBe(index);
      }
    }
    // A single-variant atlas must not divide by zero.
    expect(floorVariantIndex(3, 7, 1)).toBe(0);
    expect(floorVariantIndex(3, 7, 0)).toBe(0);
    // Neighbouring cells are not forced onto the same variant (otherwise the floor
    // would read as one repeated stamp, which is the point of having variants).
    const distinct = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((col) => floorVariantIndex(col, 0, 8)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('produces the SAME per-cell variants on two independent builds of one room', async () => {
    const labelsFor = async (): Promise<string[]> => {
      const catalog = await loadedCatalog();
      const app = makeApp();
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
      LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
      const renderer = new GameRenderer(app, catalog);
      renderer.init();
      renderer.syncWorld(sim.world);
      const floor = app.stage.children[0]?.children[0]?.children[0];
      const labels = (floor?.children ?? []).map((child) =>
        child instanceof Sprite ? (child.texture.label ?? '?') : '?',
      );
      renderer.destroy();
      return labels;
    };

    const first = await labelsFor();
    const second = await labelsFor();
    expect(first.length).toBe(100);
    expect(second).toEqual(first);
    // ...and the floor really does use more than one variant.
    expect(new Set(first).size).toBeGreaterThan(1);
  });

  it('does not consume the world PRNG while building the room', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });

    const twin = new GameSimulator({ systems: createDefaultSystems() });
    const twinPlayer = PlayerFactory.spawn(twin.world, { x: 0, y: 0 });
    LevelLoader.enterRoom(twin.world, { roomId: 'start_room', playerId: twinPlayer });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    for (let i = 0; i < 5; i += 1) renderer.syncWorld(sim.world);

    // The honest form of "the renderer drew no randomness": the generator's NEXT
    // value must match an untouched twin's.
    expect(sim.world.rng.nextUint32()).toBe(twin.world.rng.nextUint32());
    renderer.destroy();
  });
});
