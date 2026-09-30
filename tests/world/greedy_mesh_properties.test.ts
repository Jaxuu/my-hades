/**
 * M12-T02 · INDEPENDENT property tests for the greedy wall merge
 * (spec 20 AC-01 / I1 / I2 / I3).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS INDEPENDENT
 * -----------------------------------------------
 * The shipped suite (`tests/world/tilemap_and_topology.test.ts`) pins the merge on
 * FOUR rooms whose walls form a rectangle BORDER — the one shape where "grow right,
 * then down" is obviously correct. A border has no concavity, no hole, no
 * re-entrant corner, so a merge that is subtly wrong on a U-shape / comb / staircase
 * would still pass it.
 *
 * This suite attacks the merge with PROPERTY tests instead of examples: it asserts
 * the structural invariants (union-exact, no-overlap, coverage-complete,
 * non-degenerate) over a battery of hand-built ADVERSARIAL shapes AND a large family
 * of DETERMINISTIC pseudo-random grids, then pins determinism, output order and the
 * documented literals. Every fixture is re-derived here — nothing is shared with the
 * engineering suite — so a passing run is INDEPENDENT evidence, not a re-run of the
 * author's own net.
 *
 * THE PROPERTIES (spec 20 I1 + §3.1)
 * ----------------------------------
 *  P1 union-exact       every cell of every rect is a `1` tile
 *  P2 no-overlap        no two rects share a cell (checked by counting covers)
 *  P3 coverage-complete every `1` tile is covered EXACTLY once
 *                       ⇒ Σ(w×h) === collectWallTiles(config).length
 *  P4 non-degenerate    rect count ≤ tile count, and STRICTLY less whenever the grid
 *                       contains at least one orthogonally adjacent wall pair
 *  P5 determinism       mergeWallRects(config) is bit-identical across calls
 *  P6 total             feeding every rect to `createWall` never throws
 *
 * DETERMINISM OF THE GENERATOR ITSELF: the random grids come from a hand-written
 * xorshift32 seeded with a LITERAL, NOT `Math.random` — so a failing case is
 * reproducible from the seed alone and the suite can never flake.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DataManager,
  GameSimulator,
  LevelLoader,
  TILE_WALL,
  WallComponent,
  World,
  bootstrapData,
  bundledConfigTables,
  createWall,
} from '../../src';
import type { RoomConfig, WallSpawnOptions } from '../../src';

/* ========================================================================== *
 * Fixtures                                                                    *
 * ========================================================================== */

/**
 * G4 replaces the process-wide config table, so every test puts the SHIPPED one
 * back — the same call the harness setup made, so the restore path is the
 * production path rather than a special case (the convention the tilemap suite
 * follows).
 */
afterEach(async () => {
  await bootstrapData();
});

/** The wall tile code, pinned as a LITERAL (spec 20 §3.1). */
const WALL = 1;

/**
 * Build a `RoomConfig` from an array of rows.
 *
 * The grids below are written as rows because that is the only spelling a human can
 * verify at a glance; `mergeWallRects` reads the flat, row-major form, so the
 * flattening happens once, here.
 */
function roomOf(rows: readonly (readonly number[])[]): RoomConfig {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  return { id: 'probe', width, height, grid: rows.flat() };
}

/** The same, from an already-flat grid (the degenerate width=1 / height=1 cases). */
function roomFlat(width: number, height: number, grid: readonly number[]): RoomConfig {
  return { id: 'probe', width, height, grid };
}

/**
 * A seeded xorshift32 — the ONLY source of "random" grids in this file.
 *
 * Hand-rolled and seeded with a literal so the whole family is reproducible: a
 * counterexample found here can be replayed from `(seed, gridIndex)` alone. Using
 * `Math.random` would make the suite non-reproducible AND would be the one thing the
 * engine's own determinism doctrine forbids (ADR-004).
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x1a2b3c4d; // xorshift32 is degenerate at 0
  return (): number => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
}

/** One deterministic random grid: `width`, `height` in `[1, maxSide]`, walls at `p`. */
function randomRoom(rng: () => number, maxSide: number, wallPercent: number): RoomConfig {
  const width = 1 + (rng() % maxSide);
  const height = 1 + (rng() % maxSide);
  const grid: number[] = [];
  for (let i = 0; i < width * height; i += 1) {
    grid.push(rng() % 100 < wallPercent ? WALL : 0);
  }
  return roomFlat(width, height, grid);
}

/* ========================================================================== *
 * The property checker                                                        *
 * ========================================================================== */

/** A structural description of one rect, so failures name the exact shape. */
function show(rect: WallSpawnOptions): string {
  return `(${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)})`;
}

/**
 * Whether the grid contains at least one orthogonally adjacent pair of `1` tiles —
 * the precondition for the "rects strictly fewer than tiles" half of P4.
 */
function hasAdjacentWalls(config: RoomConfig): boolean {
  const { width, height, grid } = config;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (grid[row * width + col] !== WALL) continue;
      if (col + 1 < width && grid[row * width + (col + 1)] === WALL) return true;
      if (row + 1 < height && grid[(row + 1) * width + col] === WALL) return true;
    }
  }
  return false;
}

/** A stable string for one rect list, for the determinism comparison. */
function serialize(rects: readonly WallSpawnOptions[]): string {
  return rects.map(show).join('|');
}

/** Guarded lookup for the shape table (the repo runs `noUncheckedIndexedAccess`). */
function shape(record: Readonly<Record<string, RoomConfig>>, key: string): RoomConfig {
  const value = record[key];
  if (value === undefined) throw new Error(`QA: no shape named '${key}'`);
  return value;
}

/**
 * Run every structural property against `config` and return the list of violations
 * (empty ⇒ all hold). Returning a list rather than asserting inside the loops keeps
 * a failure readable: the message names the offending rect / cell, not just "false".
 */
function violations(config: RoomConfig): string[] {
  const problems: string[] = [];
  const { width, height, grid } = config;
  const rects = LevelLoader.mergeWallRects(config);
  const tiles = LevelLoader.collectWallTiles(config);

  // --- P1: every rect cell is in bounds and a `1` tile -----------------------
  for (const rect of rects) {
    if (
      !Number.isInteger(rect.x) ||
      !Number.isInteger(rect.y) ||
      !Number.isInteger(rect.width) ||
      !Number.isInteger(rect.height)
    ) {
      problems.push(`non-integer rect ${show(rect)}`);
    }
    if (rect.width <= 0 || rect.height <= 0) {
      problems.push(`non-positive extent ${show(rect)}`);
    }
    for (let row = rect.y; row < rect.y + rect.height; row += 1) {
      for (let col = rect.x; col < rect.x + rect.width; col += 1) {
        if (col < 0 || col >= width || row < 0 || row >= height) {
          problems.push(`rect ${show(rect)} escapes the ${String(width)}x${String(height)} grid`);
          continue;
        }
        if (grid[row * width + col] !== WALL) {
          problems.push(`rect ${show(rect)} covers non-wall cell (${String(col)},${String(row)})`);
        }
      }
    }
  }

  // --- P2 + P3: each cell covered exactly once, and exactly the wall cells ----
  const covers = new Map<number, number>();
  for (const rect of rects) {
    for (let row = rect.y; row < rect.y + rect.height; row += 1) {
      for (let col = rect.x; col < rect.x + rect.width; col += 1) {
        const key = row * width + col;
        covers.set(key, (covers.get(key) ?? 0) + 1);
      }
    }
  }
  const wallCells = new Set(tiles.map((tile) => tile.row * width + tile.col));
  for (const cell of wallCells) {
    const count = covers.get(cell) ?? 0;
    if (count !== 1) problems.push(`wall cell ${String(cell)} covered ${String(count)} time(s)`);
  }
  for (const [cell, count] of covers) {
    if (!wallCells.has(cell)) {
      problems.push(`non-wall cell ${String(cell)} covered ${String(count)} time(s)`);
    } else if (count > 1) {
      problems.push(`cell ${String(cell)} overlapped ${String(count)} times`);
    }
  }

  // --- P3': area conservation (the spec's own assertable form, I1) ------------
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  if (area !== tiles.length) {
    problems.push(`Σ(w×h)=${String(area)} but tile count is ${String(tiles.length)}`);
  }

  // --- P4: non-degenerate -----------------------------------------------------
  if (rects.length > tiles.length) {
    problems.push(`rect count ${String(rects.length)} exceeds tile count ${String(tiles.length)}`);
  }
  if (hasAdjacentWalls(config) && rects.length >= tiles.length) {
    problems.push(
      `grid has adjacent walls but rect count ${String(rects.length)} is not < tile count ${String(tiles.length)}`,
    );
  }

  // --- P5: determinism --------------------------------------------------------
  const again = LevelLoader.mergeWallRects(config);
  if (serialize(again) !== serialize(rects)) {
    problems.push(`non-deterministic: ${serialize(rects)} vs ${serialize(again)}`);
  }

  // --- P6: total (feeding every rect to the ONE assembly seam never throws) ---
  const world = new World();
  for (const rect of rects) {
    try {
      createWall(world, rect);
    } catch (error) {
      problems.push(`createWall(${show(rect)}) threw: ${String(error)}`);
    }
  }
  const built = world.query(WallComponent).length;
  if (built !== rects.length) {
    problems.push(`createWall built ${String(built)} walls for ${String(rects.length)} rects`);
  }

  return problems;
}

/* ========================================================================== *
 * G0 · the tile-code anchor                                                   *
 * ========================================================================== */
describe('G0 · the wall code this whole file reasons about', () => {
  it('TILE_WALL is the literal 1 the grids below are written with', () => {
    // Anchors the literal `1`s used throughout: if the code ever changed, the
    // hand-written grids would silently stop meaning "wall".
    expect(TILE_WALL).toBe(1);
  });
});

/* ========================================================================== *
 * G1 · hand-built ADVERSARIAL shapes                                          *
 * ========================================================================== */
describe('G1 · the invariants hold on concave / holed / degenerate shapes (AC-01)', () => {
  const SHAPES: Readonly<Record<string, RoomConfig>> = {
    /** A single wall tile. */
    single_tile: roomOf([[1]]),
    /** A one-tile-high corridor. */
    single_row: roomOf([[1, 1, 1, 1, 1]]),
    /** A one-tile-wide column. */
    single_column: roomOf([[1], [1], [1], [1]]),
    /** A solid block — one rect, no concavity. */
    solid_block: roomOf([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]),
    /** Checkerboard: no two walls touch ⇒ every rect is 1x1. */
    checkerboard: roomOf([
      [1, 0, 1, 0],
      [0, 1, 0, 1],
      [1, 0, 1, 0],
      [0, 1, 0, 1],
    ]),
    /** A closed ring with a hollow centre — the span test must forbid the middle. */
    ring_with_hole: roomOf([
      [1, 1, 1],
      [1, 0, 1],
      [1, 1, 1],
    ]),
    /**
     * The STAIRCASE that defeats a "only the first cell of the span must be a wall"
     * down-growth: the top row is 2 wide, so a naive merge would emit (0,0,2,2) and
     * cover the floor at (1,1).
     */
    staircase: roomOf([
      [1, 1],
      [1, 0],
    ]),
    /** An L: a long top edge plus a short foot. */
    l_shape: roomOf([
      [1, 1, 1],
      [1, 0, 0],
      [1, 0, 0],
    ]),
    /** A T: a bar with a stem that does NOT share the bar's full width. */
    t_shape: roomOf([
      [1, 1, 1],
      [0, 1, 0],
      [0, 1, 0],
    ]),
    /** A cross / plus. */
    cross: roomOf([
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ]),
    /** A U: two columns joined at the bottom, with a hollow channel between them. */
    u_shape: roomOf([
      [1, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
    ]),
    /** A COMB: teeth of different lengths — the classic greedy-merge stress shape. */
    comb: roomOf([
      [1, 1, 1, 1, 1],
      [1, 0, 1, 0, 1],
      [1, 0, 1, 0, 1],
      [0, 0, 1, 0, 0],
    ]),
    /** A wall-free room: the merge must be the empty list, not a crash. */
    empty_room: roomOf([
      [0, 0],
      [0, 0],
    ]),
  };

  for (const [name, config] of Object.entries(SHAPES)) {
    it(`${name}: union-exact, no-overlap, coverage-complete, non-degenerate`, () => {
      expect(violations(config)).toEqual([]);
    });
  }

  it('checkerboard merges into exactly one rect per wall tile (all 1x1)', () => {
    const rects = LevelLoader.mergeWallRects(shape(SHAPES, 'checkerboard'));
    expect(rects).toHaveLength(8);
    for (const rect of rects) {
      expect([rect.width, rect.height]).toEqual([1, 1]);
    }
  });

  it('empty room yields no rects at all', () => {
    expect(LevelLoader.mergeWallRects(shape(SHAPES, 'empty_room'))).toEqual([]);
  });

  it('the ring emits four rects and never covers the hollow centre', () => {
    const rects = LevelLoader.mergeWallRects(shape(SHAPES, 'ring_with_hole'));
    expect(rects.map(show)).toEqual(['(0,0,3,1)', '(0,1,1,2)', '(2,1,1,2)', '(1,2,1,1)']);
  });
});

/* ========================================================================== *
 * G2 · the documented literals (spec 20 §4.1), re-derived independently        *
 * ========================================================================== */
describe('G2 · the spec §4.1 room table, re-derived here (AC-01)', () => {
  it('box_3x3 (8 tiles) merges to the four documented rects', () => {
    const config = roomOf([
      [1, 1, 1],
      [1, 2, 1],
      [1, 1, 1],
    ]);
    expect(LevelLoader.collectWallTiles(config)).toHaveLength(8);
    expect(LevelLoader.mergeWallRects(config).map(show)).toEqual([
      '(0,0,3,1)',
      '(0,1,1,2)',
      '(2,1,1,2)',
      '(1,2,1,1)',
    ]);
    expect(violations(config)).toEqual([]);
  });

  it('room_a (11 tiles) merges to the four documented rects', () => {
    const config = roomOf([
      [1, 1, 1, 1],
      [1, 0, 3, 1],
      [1, 0, 0, 1],
      [1, 2, 1, 1],
    ]);
    expect(LevelLoader.collectWallTiles(config)).toHaveLength(11);
    expect(LevelLoader.mergeWallRects(config).map(show)).toEqual([
      '(0,0,4,1)',
      '(0,1,1,3)',
      '(3,1,1,3)',
      '(2,3,1,1)',
    ]);
    expect(violations(config)).toEqual([]);
  });

  it('room_b (12 tiles) merges to the four documented rects', () => {
    const config = roomOf([
      [1, 1, 1, 1],
      [1, 3, 0, 1],
      [1, 2, 0, 1],
      [1, 1, 1, 1],
    ]);
    expect(LevelLoader.collectWallTiles(config)).toHaveLength(12);
    expect(LevelLoader.mergeWallRects(config).map(show)).toEqual([
      '(0,0,4,1)',
      '(0,1,1,3)',
      '(3,1,1,3)',
      '(1,3,2,1)',
    ]);
    expect(violations(config)).toEqual([]);
  });

  it('spawn_five (3 tiles) merges to the single documented rect', () => {
    const config = roomOf([
      [3, 3, 3],
      [3, 2, 3],
      [1, 1, 1],
    ]);
    expect(LevelLoader.collectWallTiles(config)).toHaveLength(3);
    expect(LevelLoader.mergeWallRects(config).map(show)).toEqual(['(0,2,3,1)']);
    expect(violations(config)).toEqual([]);
  });

  it('output order is the row-major order of the rects` TOP-LEFT tiles (I3)', () => {
    const config = roomOf([
      [1, 0, 1, 1],
      [1, 0, 1, 0],
      [1, 1, 1, 1],
    ]);
    const rects = LevelLoader.mergeWallRects(config);
    // Sort a copy by (y, x) and compare — the emitted order must already be that.
    const sorted = [...rects].sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
    expect(rects.map(show)).toEqual(sorted.map(show));
  });
});

/* ========================================================================== *
 * G3 · the deterministic pseudo-random family                                 *
 * ========================================================================== */
describe('G3 · the invariants hold across 320 pseudo-random grids (AC-01)', () => {
  it('every grid from every seed satisfies all six properties', () => {
    const seeds: readonly number[] = [0x00000001, 0x5eed, 0xdeadbeef, 0xc0ffee];
    let checked = 0;

    for (const seed of seeds) {
      const rng = makeRng(seed);
      for (let index = 0; index < 80; index += 1) {
        // Sweep the wall density so both sparse and dense grids are covered.
        const wallPercent = 20 + (index % 7) * 10; // 20..80
        const config = randomRoom(rng, 7, wallPercent);
        const problems = violations(config);
        if (problems.length > 0) {
          // Name the seed + grid so the counterexample is reproducible by hand.
          throw new Error(
            `seed=0x${seed.toString(16)} index=${String(index)} grid=${JSON.stringify(config)}: ${problems.join('; ')}`,
          );
        }
        checked += 1;
      }
    }

    expect(checked).toBe(320);
  });

  it('a densely-woven grid still conserves area (100% walls)', () => {
    const config = randomRoom(makeRng(0x1234), 6, 100);
    expect(violations(config)).toEqual([]);
    expect(LevelLoader.mergeWallRects(config)).toHaveLength(1); // a solid rectangle is one rect
  });

  it('an all-floor grid yields no rects and conserves the empty area', () => {
    const config = randomRoom(makeRng(0x5678), 6, 0);
    expect(violations(config)).toEqual([]);
    expect(LevelLoader.mergeWallRects(config)).toEqual([]);
  });
});

/* ========================================================================== *
 * G4 · the real load path (enterRoom) is total on adversarial terrain          *
 * ========================================================================== */
describe('G4 · enterRoom builds the merged geometry without throwing (AC-01 / I4)', () => {
  it('every shape loads, and wallCount === mergeWallRects(config).length', () => {
    // A room table whose grids are adversarial shapes, each carrying a `2` spawn
    // tile so `parseRoomConfig` accepts them.
    const rooms: Record<string, unknown> = {
      staircase: { width: 2, height: 2, grid: [1, 1, 1, 2] },
      ring: { width: 3, height: 3, grid: [1, 1, 1, 1, 2, 1, 1, 1, 1] },
      comb: {
        width: 5,
        height: 4,
        grid: [1, 1, 1, 1, 1, 1, 2, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0],
      },
    };
    const shipped = bundledConfigTables();
    DataManager.loadAll({
      enemies: shipped.enemies,
      modifiers: shipped.modifiers,
      encounters: [{ depth: 0, roomId: 'ring', waves: [{ delayTicks: 0, enemies: ['raider'] }] }],
      rooms,
    });

    for (const roomId of ['staircase', 'ring', 'comb']) {
      const config = DataManager.getRoomConfig(roomId);
      const expected = LevelLoader.mergeWallRects(config);
      const sim = new GameSimulator({ fps: 60, systems: [] });
      const result = LevelLoader.enterRoom(sim.world, { roomId });
      expect(result.wallCount).toBe(expected.length);
      expect(result.wallTileCount).toBe(LevelLoader.collectWallTiles(config).length);
      expect(violations(config)).toEqual([]);
    }
  });

  // Restore the shipped tables so a later suite is unaffected — the same call the
  // harness setup made, so the restore path is the production path.
  it('restores the shipped tables', async () => {
    await bootstrapData();
    expect(DataManager.hasRoom('start_room')).toBe(true);
  });
});
