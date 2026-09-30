/**
 * M12-T01 · Room topology, tilemap parsing and static scene assembly.
 * See specs/19_room_topology_and_tilemaps_spec.md §5 (AC-01 .. AC-08) and §6.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * Before M12 a room was a wave table and nothing else: no shape, no walls, no spawn
 * tile, and every enemy landed on the centre-line formation `formWaveRoster`
 * derives. M12 makes the terrain DATA — a 2D integer grid in `assets/data/rooms.json`
 * — and puts `LevelLoader` in charge of turning it into world entities. Four things
 * can therefore go wrong, and the suite is organised around exactly them:
 *
 *   G0 · the grid contract   — the two legal grid spellings normalise to one shape,
 *                              and a malformed grid / missing player spawn / dangling
 *                              `roomId` fails at LOAD time, not mid-tick (AC-01).
 *   G1 · physical topology   — a 3x3 closed room really blocks a body: it stops at
 *                              the face and its coordinate stops changing (AC-02).
 *   G2 · transition          — descending a room tears the old geometry and this
 *                              fight's leftovers down, builds the new room exactly,
 *                              and re-places the player on the new spawn tile, all
 *                              inside ONE tick (AC-02 / AC-03 / AC-04).
 *   G3 · deterministic spawn — every enemy of a wave lands ON a spawn tile, three
 *                              enemies take three DISTINCT tiles, and the same seed
 *                              reproduces the distribution byte for byte (AC-03).
 *   G4 · contract guards     — the pipeline is still 17 segments, a descent clears
 *                              the spawn pool, and a room with no topology consumes
 *                              no randomness at all (AC-06 / AC-07).
 *
 * The rig drives the REAL `GameSimulator`, the REAL 17-segment pipeline, the REAL
 * `DataManager` and the REAL `LevelLoader`, against a MOCK room + encounter table
 * whose numbers (8 / 11 / 12 / 3 walls, 5 spawn tiles, 3 enemies) appear nowhere else
 * in the codebase — so "the value came from the table" cannot be confused with "the
 * value came from a default". Nothing is mocked, and ticks are advanced one at a time.
 *
 * TICK NUMBERING (`sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`).
 *
 * WORLD COORDINATE CONVENTION (spec 19 I4): tile `(col, row)` OCCUPIES
 * `[col, col+1] x [row, row+1]`, so its centre is `(col + 0.5, row + 0.5)` and the
 * room's top-left tile corner is the world origin. Every expected coordinate below is
 * written out as a LITERAL from that rule, never read back off a component.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';
import { GameRenderer, PX_PER_UNIT } from '../../client/GameRenderer';
import {
  DataManager,
  EncounterFactory,
  EncounterState,
  EncounterStateComponent,
  Faction,
  FactionComponent,
  GameSimulator,
  GameStateFactory,
  HazardComponent,
  HealthComponent,
  HitboxComponent,
  LevelLoader,
  PickupComponent,
  PlayerFactory,
  PlayerInputComponent,
  PreviousTransformComponent,
  ProjectileComponent,
  Random,
  SchemaError,
  TransformComponent,
  VelocityComponent,
  WallComponent,
  World,
  applyDamage,
  bootstrapData,
  bundledConfigTables,
  createDefaultSystems,
  currentRoomId,
  descendEncounterRoom,
  isDead,
  isRoomConfig,
  parseRoomConfig,
  parseRoomTable,
  spawnHazard,
  spawnPickup,
  spawnProjectile,
  vec2,
} from '../../src';
import type { EntityId, RawConfigTables, SpawnPoint } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;

/*
 * The shipped tuning the rigs depend on, restated as LITERALS.
 *
 * `DEFAULT_MAX_HP` builds the player's health, so comparing `hp` against the imported
 * constant would be a tautology; the numbers below ARE the contract, so they are
 * written out (spec 19 §6, the tautological-assertion trap).
 */
const PLAYER_MAX_HP = 100;
/** `DEFAULT_HURTBOX_RADIUS`: one half of a 1x1 tile, which is why a body born on a
 * tile centre rests exactly tangent to the tile's edges instead of being pushed. */
const PLAYER_RADIUS = 0.5;

/** The seed every deterministic assertion below pins. */
const SEED = 0x5eed;

/*
 * Every test here may replace the process-wide table, so every test puts the
 * SHIPPED one back — the same call the harness setup made, so the restore path is
 * the production path rather than a special case.
 */
afterEach(async () => {
  await bootstrapData();
});

/* ========================================================================== *
 * Fixtures                                                                    *
 * ========================================================================== */

/*
 * Four rooms, each chosen for ONE number the suite asserts:
 *
 *  - `box_3x3`    · 8 wall tiles, the `2` tile dead centre — the physics rig.
 *  - `room_a`     · 11 wall tiles, `2` at (1,3), `3` at (2,1) — the run's room 0.
 *  - `room_b`     · 12 wall tiles, `2` at (1,2), `3` at (1,1) — the run's room 1.
 *  - `spawn_five` · 5 `3` tiles, 3 wall tiles — the distribution rig.
 *
 * They are written as 2D row arrays (the human-editable spelling) precisely so that
 * the 2D path is exercised by every integration test, not only by G0.
 */
const MOCK_ROOMS = {
  box_3x3: {
    width: 3,
    height: 3,
    grid: [
      [1, 1, 1],
      [1, 2, 1],
      [1, 1, 1],
    ],
  },
  room_a: {
    width: 4,
    height: 4,
    grid: [
      [1, 1, 1, 1],
      [1, 0, 3, 1],
      [1, 0, 0, 1],
      [1, 2, 1, 1],
    ],
  },
  room_b: {
    width: 4,
    height: 4,
    grid: [
      [1, 1, 1, 1],
      [1, 3, 0, 1],
      [1, 2, 0, 1],
      [1, 1, 1, 1],
    ],
  },
  spawn_five: {
    width: 3,
    height: 3,
    grid: [
      [3, 3, 3],
      [3, 2, 3],
      [1, 1, 1],
    ],
  },
} as const;

/** The two-room run: room 0 is `room_a`, room 1 (the final room) is `room_b`. */
const MOCK_ENCOUNTERS = [
  { depth: 0, roomId: 'room_a', waves: [{ delayTicks: 0, enemies: ['raider'] }] },
  { depth: 1, roomId: 'room_b', waves: [{ delayTicks: 0, enemies: ['raider'] }] },
];

/** One room, five spawn tiles, one three-enemy wave — the distribution rig. */
const FIVE_SPAWN_ENCOUNTERS = [
  {
    depth: 0,
    roomId: 'spawn_five',
    waves: [{ delayTicks: 0, enemies: ['raider', 'raider', 'raider'] }],
  },
];

/** One room that declares NO `roomId` at all — the "no topology" shape. */
const NO_TOPOLOGY_ENCOUNTERS = [
  { depth: 0, waves: [{ delayTicks: 0, enemies: ['raider'] }] },
];

/**
 * A bundle with the SHIPPED enemy + modifier tables and a MOCK room + encounter
 * table.
 *
 * The shipped enemy table is reused deliberately: the fixtures reference the real
 * `raider` type, and `createDefaultSystems()` reads `zeus_strike` / `poseidon_dash`
 * out of the modifier table at construction time, so a bundle that blanked either
 * would make the pipeline un-constructible and the test would measure the wrong
 * failure.
 */
function bundle(
  encounters: readonly unknown[] = MOCK_ENCOUNTERS,
  rooms: Readonly<Record<string, unknown>> = MOCK_ROOMS,
): RawConfigTables {
  const shipped = bundledConfigTables();
  return {
    enemies: shipped.enemies,
    modifiers: shipped.modifiers,
    encounters,
    rooms,
  };
}

/* ========================================================================== *
 * Helpers                                                                     *
 * ========================================================================== */

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`QA: no sample at index ${String(index)}`);
  return value;
}

function transformOf(sim: GameSimulator, id: EntityId): TransformComponent {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return transform;
}

/** A world-space pose, as a plain object so `toEqual` compares by value. */
function poseOf(sim: GameSimulator, id: EntityId): SpawnPoint {
  const transform = transformOf(sim, id);
  return { x: transform.x, y: transform.y };
}

/** The render-interpolation anchor, i.e. where the previous tick left the entity. */
function previousPoseOf(sim: GameSimulator, id: EntityId): SpawnPoint {
  const previous = sim.world.getComponent(id, PreviousTransformComponent);
  if (previous === undefined) throw new Error('QA: entity is missing PreviousTransformComponent');
  return { x: previous.prevX, y: previous.prevY };
}

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

/** Every wall entity, ascending — the assertion subject for AC-02 / AC-04. */
function wallIds(sim: GameSimulator): EntityId[] {
  return sim.world.query(WallComponent);
}

/**
 * Every LIVING ENEMY, ascending.
 *
 * Two filters, both load-bearing:
 *  - `Faction.Enemy` excludes the PLAYER, who also owns a Transform and a Health —
 *    without it "the wave spawned one enemy" reads as two (the player is entity 0);
 *  - `!isDead` excludes corpses, which stay in the world forever (spec 08 §4.4).
 */
function liveEnemyIds(sim: GameSimulator): EntityId[] {
  return sim.world
    .query(TransformComponent, HealthComponent, FactionComponent)
    .filter((id) => sim.world.getComponent(id, FactionComponent)?.faction === Faction.Enemy)
    .filter((id) => !isDead(sim.world, id));
}

function onlyLiveEnemy(sim: GameSimulator): EntityId {
  const ids = liveEnemyIds(sim);
  if (ids.length !== 1) {
    throw new Error(`QA: expected exactly one living enemy, found ${String(ids.length)}`);
  }
  return at(ids, 0);
}

/** The device-driven entity, i.e. the player (spec 01 §3.3). */
function playerOf(sim: GameSimulator): EntityId {
  const id = sim.world.query(PlayerInputComponent)[0];
  if (id === undefined) throw new Error('QA: the run has no player');
  return id;
}

function roomOf(sim: GameSimulator): EncounterStateComponent {
  const id = sim.world.query(EncounterStateComponent)[0];
  if (id === undefined) throw new Error('QA: the run has no room singleton');
  const room = sim.world.getComponent(id, EncounterStateComponent);
  if (room === undefined) throw new Error('QA: the room singleton has no state component');
  return room;
}

/**
 * A simulator whose whole run is "player + data-backed rooms + the state singleton",
 * declared ONCE so the very first run and every `restartRun` go through the same
 * code — which is what makes "restart == fresh start" true (spec 19 §4.3).
 */
function buildMockRun(world: World): void {
  const player = PlayerFactory.spawn(world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });

  const roomEntity = EncounterFactory.spawnFromData(world);
  const encounter = world.getComponent(roomEntity, EncounterStateComponent);
  const openingRoomId = encounter === undefined ? undefined : currentRoomId(encounter);
  if (encounter !== undefined && openingRoomId !== undefined) {
    LevelLoader.enterRoom(world, { roomId: openingRoomId, playerId: player, encounter });
  }

  GameStateFactory.spawn(world);
}

function makeRunSim(seed: number = SEED): GameSimulator {
  return new GameSimulator({
    fps: FPS,
    systems: createDefaultSystems(),
    seed,
    runSetup: buildMockRun,
  });
}

/** A simulator + a player + one loaded room, with no room singleton involved. */
function makePhysicsRig(roomId: string): { readonly sim: GameSimulator; readonly player: EntityId } {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  LevelLoader.enterRoom(sim.world, { roomId, playerId: player });
  return { sim, player };
}

/* ========================================================================== *
 * G0 · the grid contract (AC-01)                                              *
 * ========================================================================== */
describe('G0 · the grid contract: two spellings, one shape (AC-01)', () => {
  it('normalises a 2D grid and a flat grid to the SAME row-major array', () => {
    const twoD = parseRoomConfig('probe', {
      width: 3,
      height: 2,
      grid: [
        [1, 0, 3],
        [2, 0, 1],
      ],
    });
    const oneD = parseRoomConfig('probe', { width: 3, height: 2, grid: [1, 0, 3, 2, 0, 1] });

    // Both forms collapse to one shape, so no downstream consumer ever has to ask
    // "which spelling was this?".
    expect(twoD.grid).toEqual([1, 0, 3, 2, 0, 1]);
    expect(oneD.grid).toEqual(twoD.grid);
    expect([twoD.width, twoD.height, twoD.id]).toEqual([3, 2, 'probe']);

    // Row-major, index = row * width + col — pinned as LITERALS so a flipped
    // convention (column-major) cannot slip through.
    expect(twoD.grid[2]).toBe(3); // (col 2, row 0)
    expect(twoD.grid[3]).toBe(2); // (col 0, row 1)
    expect(twoD.grid[5]).toBe(1); // (col 2, row 1)
  });

  it('rejects a grid whose shape disagrees with width / height', () => {
    // Flat: 5 tiles for a 3 x 2 room.
    expect(() => parseRoomConfig('r', { width: 3, height: 2, grid: [1, 0, 3, 2, 0] })).toThrow(
      /needs exactly 6/,
    );
    // 2D: three rows for a two-row room.
    expect(() =>
      parseRoomConfig('r', {
        width: 3,
        height: 2,
        grid: [
          [1, 0, 3],
          [2, 0, 1],
          [1, 1, 1],
        ],
      }),
    ).toThrow(/declares 3 row\(s\)/);
    // 2D: one row is the wrong width.
    expect(() =>
      parseRoomConfig('r', {
        width: 3,
        height: 2,
        grid: [
          [1, 0],
          [2, 0, 1],
        ],
      }),
    ).toThrow(/an array of 3 tiles/);
    expect(() => parseRoomConfig('r', { width: 3, height: 2, grid: 'nope' })).toThrow(SchemaError);
  });

  it('rejects a tile outside the four codes, including a fractional one', () => {
    expect(() => parseRoomConfig('r', { width: 2, height: 1, grid: [1, 4] })).toThrow(
      /an integer tile code \(0 \/ 1 \/ 2 \/ 3\)/,
    );
    expect(() => parseRoomConfig('r', { width: 2, height: 1, grid: [1, 1.5] })).toThrow(
      /integer tile code/,
    );
    expect(() => parseRoomConfig('r', { width: 2, height: 1, grid: [1, -1] })).toThrow(SchemaError);
    expect(() => parseRoomConfig('r', { width: 2, height: 1, grid: [1, '2'] })).toThrow(SchemaError);
    expect(() => parseRoomConfig('r', { width: 2, height: 1, grid: [1, null] })).toThrow(SchemaError);
  });

  it('rejects a room with no player spawn tile — AC-03 would be unsatisfiable', () => {
    expect(() => parseRoomConfig('r', { width: 2, height: 1, grid: [1, 0] })).toThrow(
      /no player spawn tile \(2\)/,
    );
  });

  it('rejects a non-positive or fractional size', () => {
    expect(() => parseRoomConfig('r', { width: 0, height: 1, grid: [] })).toThrow(SchemaError);
    expect(() => parseRoomConfig('r', { width: 2.5, height: 1, grid: [1, 2] })).toThrow(SchemaError);
    expect(() => parseRoomConfig('r', { width: 2, height: -1, grid: [1, 2] })).toThrow(SchemaError);
  });

  it('exposes a non-throwing predicate that agrees with the parser', () => {
    expect(isRoomConfig(MOCK_ROOMS.room_a)).toBe(true);
    expect(isRoomConfig({ width: 2, height: 1, grid: [1, 2] })).toBe(true);
    expect(isRoomConfig({ width: 2, height: 1, grid: [1, 1] })).toBe(false); // no spawn
    expect(isRoomConfig({ width: 2, height: 1, grid: [1, 9] })).toBe(false);
    expect(isRoomConfig('nope')).toBe(false);
  });

  it('parses an id-keyed room table and rejects a non-object', () => {
    const table = parseRoomTable(MOCK_ROOMS, 'rooms');
    expect(table.size).toBe(4);
    expect(table.get('room_a')?.id).toBe('room_a');
    expect(table.get('spawn_five')?.grid).toEqual([3, 3, 3, 3, 2, 3, 1, 1, 1]);
    expect(() => parseRoomTable([], 'rooms')).toThrow(/must be an object keyed by room id/);
    expect(() => parseRoomTable(null, 'rooms')).toThrow(SchemaError);
  });

  it('maps tiles to world boxes and centres on the documented convention', () => {
    // spec 19 I4, as LITERALS: tile (col,row) occupies [col,col+1] x [row,row+1].
    expect(LevelLoader.tileToWorldCentre(0, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(LevelLoader.tileToWorldCentre(3, 2)).toEqual({ x: 3.5, y: 2.5 });
    expect(LevelLoader.wallBoxForTile(3, 2)).toEqual({ x: 3, y: 2, width: 1, height: 1 });
    expect(LevelLoader.collectWallTiles(parseRoomConfig('probe', MOCK_ROOMS.box_3x3))).toHaveLength(
      8,
    );
    expect(LevelLoader.findPlayerSpawn(parseRoomConfig('probe', MOCK_ROOMS.box_3x3))).toEqual({
      x: 1.5,
      y: 1.5,
    });
    expect(
      LevelLoader.collectEnemySpawnPoints(parseRoomConfig('probe', MOCK_ROOMS.spawn_five)),
    ).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0.5 },
      { x: 0.5, y: 1.5 },
      { x: 2.5, y: 1.5 },
    ]);
  });
});

/* ========================================================================== *
 * G0b · the registry + the cross-table rule (AC-01)                           *
 * ========================================================================== */
describe('G0 · the room table is registered and cross-checked (AC-01)', () => {
  it('registers the rooms and exposes them in a stable order', () => {
    DataManager.loadAll(bundle());

    expect(DataManager.roomCount).toBe(4);
    // UTF-16 code-unit order, never `localeCompare` (ADR-001 R6).
    expect(DataManager.roomIds).toEqual(['box_3x3', 'room_a', 'room_b', 'spawn_five']);
    expect(DataManager.hasRoom('room_b')).toBe(true);
    expect(DataManager.hasRoom('nope')).toBe(false);
    expect(DataManager.getRoomConfig('room_b').grid).toEqual([
      1, 1, 1, 1, 1, 3, 0, 1, 1, 2, 0, 1, 1, 1, 1, 1,
    ]);
    expect(DataManager.getRoomConfig('room_b').width).toBe(4);
  });

  it('reads the room id BY DEPTH, cycling past the end like the wave table', () => {
    DataManager.loadAll(bundle());

    expect(DataManager.getEncounterRoomId(0)).toBe('room_a');
    expect(DataManager.getEncounterRoomId(1)).toBe('room_b');
    // Cycling, not clamping — the two depth lookups must agree on which room a depth
    // names, or a run would fight one room's waves on another room's terrain.
    expect(DataManager.getEncounterRoomId(2)).toBe('room_a');
    expect(DataManager.getEncounterRoomId(7)).toBe('room_b');
    expect(() => DataManager.getEncounterRoomId(-1)).toThrow(/non-negative integer/);
    expect(() => DataManager.getEncounterRoomId(1.5)).toThrow(/non-negative integer/);
  });

  it('rejects a roomId that names no loaded room, naming the exact path', () => {
    expect(() =>
      DataManager.loadAll(
        bundle([
          { depth: 0, roomId: 'ghost_room', waves: [{ delayTicks: 0, enemies: ['raider'] }] },
        ]),
      ),
    ).toThrow(
      /encounters\[0\]\.roomId references unknown room id 'ghost_room'\. Loaded room ids: box_3x3, room_a, room_b, spawn_five\./,
    );
  });

  it('rejects an empty-string roomId, but ACCEPTS an omitted one', () => {
    // An empty string is a reference to an id that cannot exist — omit the field for
    // "no topology" (the same rule `onExplodeConfigId` records).
    expect(() =>
      DataManager.loadAll(
        bundle([{ depth: 0, roomId: '', waves: [{ delayTicks: 0, enemies: ['raider'] }] }]),
      ),
    ).toThrow(/encounters\[0\]\.roomId must be a non-empty string/);

    // The pre-M12 shape: a room table with no `roomId` is legitimate.
    expect(() => DataManager.loadAll(bundle(NO_TOPOLOGY_ENCOUNTERS))).not.toThrow();
    expect(DataManager.getEncounterRoomId(0)).toBeUndefined();
  });

  it('reports a missing room registry as such, rather than as an empty room', () => {
    const shipped = bundledConfigTables();
    DataManager.loadAll({ enemies: shipped.enemies, modifiers: shipped.modifiers });

    expect(DataManager.roomCount).toBe(0);
    expect(() => DataManager.getRoomConfig('room_a')).toThrow(/room 'room_a' cannot be resolved/);
    // The loader runs from inside `step()`, so it must fail at the seam, not later.
    expect(() => LevelLoader.enterRoom(new World(), { roomId: 'room_a' })).toThrow(SchemaError);
  });

  it('leaves the previous terrain INTACT when a reload fails (atomic install)', () => {
    DataManager.loadAll(bundle());
    expect(DataManager.roomCount).toBe(4);

    expect(() =>
      DataManager.loadAll(
        bundle(MOCK_ENCOUNTERS, { broken: { width: 2, height: 1, grid: [1, 1] } }),
      ),
    ).toThrow(SchemaError);

    // This is what makes a bad `rooms.json` edit survivable: the running run keeps
    // the terrain it was built against rather than half-swapping to the broken one.
    expect(DataManager.roomCount).toBe(4);
    expect(DataManager.getRoomConfig('room_a').width).toBe(4);
  });
});

/* ========================================================================== *
 * G1 · physical topology (AC-02 / AC-05)                                      *
 * ========================================================================== */
describe('G1 · a 3x3 closed room blocks a body at its face (AC-02)', () => {
  it('builds exactly one wall per `1` tile, at the documented world boxes', () => {
    DataManager.loadAll(bundle());
    const sim = new GameSimulator({ fps: FPS, systems: [] });

    const result = LevelLoader.enterRoom(sim.world, { roomId: 'box_3x3' });

    // 3 x 3 = 9 tiles, 8 of them walls — the count is a LITERAL, not the constant
    // that built it (the tautology trap).
    expect(result.wallCount).toBe(8);
    expect(result.clearedEntityCount).toBe(0); // a fresh world has nothing to clear
    expect(wallIds(sim)).toHaveLength(8);
    expect(sim.world.entityCount).toBe(8);

    // Field for field, in ROW-MAJOR order, so "the geometry came from the grid" is
    // checkable against the JSON without knowing anything about the loader.
    const boxes = wallIds(sim).map((id) => {
      const wall = sim.world.getComponent(id, WallComponent);
      return wall === undefined ? null : [wall.x, wall.y, wall.width, wall.height];
    });
    expect(boxes).toEqual([
      [0, 0, 1, 1],
      [1, 0, 1, 1],
      [2, 0, 1, 1],
      [0, 1, 1, 1],
      [2, 1, 1, 1],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
      [2, 2, 1, 1],
    ]);
  });

  it('gives a wall NO Transform, NO Velocity and NO other component (AC-05)', () => {
    DataManager.loadAll(bundle());
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    LevelLoader.enterRoom(sim.world, { roomId: 'box_3x3' });

    for (const id of wallIds(sim)) {
      // A wall is geometry, not a mover: no Transform means no system can displace it
      // and the snapshot never carries a position that cannot change (spec 13 §3.2).
      // No Velocity means `resolveWalls` never de-penetrates it either.
      expect(sim.world.hasComponent(id, TransformComponent)).toBe(false);
      expect(sim.world.hasComponent(id, VelocityComponent)).toBe(false);
      // Exactly one component: nothing with a per-tick frequency rides on a static
      // body (spec 19 I3).
      expect(sim.world.listComponents(id)).toHaveLength(1);
    }
  });

  it('stops an upward-walking body at the top face, and its coordinate stops changing', () => {
    DataManager.loadAll(bundle());
    const rig = makePhysicsRig('box_3x3');

    // The `2` tile is the CENTRE of the 3x3 box: (col 1, row 1) => (1.5, 1.5). The
    // body is one radius (0.5) from each of the four neighbouring faces, i.e. born
    // exactly tangent to them — which is why a spawn never gets pushed out.
    expect(PLAYER_RADIUS).toBe(0.5);
    expect(poseOf(rig.sim, rig.player)).toEqual({ x: 1.5, y: 1.5 });

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(0, -1) });
    rig.sim.step(1); // tick 0 — walked 5/60 = 0.0833 units up, then pushed back out

    const settled = poseOf(rig.sim, rig.player);
    // The wall pushed it back to exactly where it started: the body rests ONE radius
    // out from the face at y = 1, i.e. y = 1.5.
    expect(settled.x).toBeCloseTo(1.5, 9);
    expect(settled.y).toBeCloseTo(1.5, 9);

    // THE anti-tunnelling assertion: 29 more ticks of sustained upward input change
    // NOTHING. The body is pinned at the face rather than drifting into the wall.
    for (let i = 0; i < 29; i += 1) {
      rig.sim.step(1);
      const pose = poseOf(rig.sim, rig.player);
      expect(pose.x).toBeCloseTo(settled.x, 9);
      expect(pose.y).toBeCloseTo(settled.y, 9);
    }

    // Walking into a wall is NOT a wall-slam (that needs HITSTUN + knockback), so no
    // damage was settled. `100` is the literal ceiling, not the constant that built it.
    expect(hpOf(rig.sim, rig.player)).toBe(PLAYER_MAX_HP);
  });

  it('blocks rightward motion symmetrically, against the box`s right face', () => {
    DataManager.loadAll(bundle());
    const rig = makePhysicsRig('box_3x3');

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    rig.sim.step(30);

    // The right face is at x = 2, so the body rests at 2 - 0.5 = 1.5.
    expect(poseOf(rig.sim, rig.player)).toEqual({ x: 1.5, y: 1.5 });
    expect(hpOf(rig.sim, rig.player)).toBe(PLAYER_MAX_HP);
  });

  it('hard-resets the caller`s pose onto the `2` tile, not merely offsets it', () => {
    DataManager.loadAll(bundle());
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: -7, y: 9, maxSpeed: MAX_SPEED });

    const result = LevelLoader.enterRoom(sim.world, { roomId: 'room_b', playerId: player });

    // The caller's pose is thrown away entirely: `room_b`'s `2` tile is at (1,2).
    expect(result.playerSpawn).toEqual({ x: 1.5, y: 2.5 });
    expect(poseOf(sim, player)).toEqual({ x: 1.5, y: 2.5 });
  });

  it('tolerates a room with no player to place, and one with no room singleton', () => {
    DataManager.loadAll(bundle());
    const sim = new GameSimulator({ fps: FPS, systems: [] });

    // Both optional arguments omitted: the geometry is still built, and nothing
    // throws — `enterRoom` runs inside `step()`, where a throw is unrecoverable.
    const result = LevelLoader.enterRoom(sim.world, { roomId: 'room_b' });
    expect(result.wallCount).toBe(12);
    expect(result.enemySpawnPoints).toEqual([{ x: 1.5, y: 1.5 }]);
    expect(sim.world.query(TransformComponent)).toHaveLength(0);
  });
});

/* ========================================================================== *
 * G2 · the transition: teardown + rebuild in ONE tick (AC-02/03/04)           *
 * ========================================================================== */
describe('G2 · descending a room tears the old scene down and builds the new one', () => {
  it('rebuilds geometry, clears this fight`s leftovers and re-places the player', () => {
    DataManager.loadAll(bundle());
    const sim = makeRunSim();
    sim.restartRun(SEED);

    const room = roomOf(sim);
    const player = playerOf(sim);

    // ---- room 0: `room_a` (11 wall tiles), player on its `2` tile ------------
    expect(currentRoomId(room)).toBe('room_a');
    expect(room.currentRoomIndex).toBe(0);
    expect(room.maxRooms).toBe(2);
    const oldWalls = wallIds(sim);
    expect(oldWalls).toHaveLength(11);
    expect(poseOf(sim, player)).toEqual({ x: 1.5, y: 3.5 });
    expect(room.enemySpawnPoints).toEqual([{ x: 2.5, y: 1.5 }]);

    // ---- clear the wave -----------------------------------------------------
    sim.step(1); // tick 0 — the opening wave spawns
    const enemy = onlyLiveEnemy(sim);
    // AC-03: the enemy landed ON the room's `3` tile, not on the centre-line.
    expect(poseOf(sim, enemy)).toEqual({ x: 2.5, y: 1.5 });

    applyDamage(sim.world, enemy, 999);
    sim.step(1); // tick 1 — DeathSystem tags it; EncounterSystem clears the room
    expect(liveEnemyIds(sim)).toHaveLength(0);
    expect(room.state).toBe(EncounterState.ROOM_CLEARED);
    expect(room.pendingRewards).not.toBeNull();

    // ---- plant one of each TRANSIENT entity, so the teardown is exact -------
    spawnProjectile(sim.world, {
      x: 1.5,
      y: 3.5,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: player,
    });
    spawnHazard(sim.world, { x: 0.5, y: 0.5 });
    spawnPickup(sim.world, { x: 1.5, y: 0.5 });
    expect(sim.world.query(ProjectileComponent)).toHaveLength(1);
    expect(sim.world.query(HazardComponent)).toHaveLength(1);
    // The dead raider's own loot is here too, so this is "at least the planted one".
    expect(sim.world.query(PickupComponent).length).toBeGreaterThanOrEqual(1);

    // ---- settle the draft: descend + rebuild, all inside THIS tick ----------
    const pending = room.pendingRewards ?? [];
    sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId: at(pending, 0) });
    sim.step(1); // tick 2

    // AC-04: every old wall is GONE (checked by id, so a recycled id could not hide
    // it), and the new count is exactly the new room's `1` count.
    for (const id of oldWalls) {
      expect(sim.world.isAlive(id)).toBe(false);
    }
    expect(wallIds(sim)).toHaveLength(12);
    expect(sim.world.query(ProjectileComponent)).toHaveLength(0);
    expect(sim.world.query(HazardComponent)).toHaveLength(0);
    expect(sim.world.query(PickupComponent)).toHaveLength(0);
    expect(sim.world.query(HitboxComponent)).toHaveLength(0);

    // AC-03: the player is on the NEW room's `2` tile, and the landing pool is the
    // NEW room's `3` tiles.
    expect(currentRoomId(room)).toBe('room_b');
    expect(room.currentRoomIndex).toBe(1);
    expect(poseOf(sim, player)).toEqual({ x: 1.5, y: 2.5 });
    expect(room.enemySpawnPoints).toEqual([{ x: 1.5, y: 1.5 }]);

    // The render anchor moved with the body. `TransformSnapshotSystem` (pipeline
    // index 0) recorded the OLD room's position earlier this tick, so without the
    // explicit sync in `resetPlayerPose` the renderer would blend from (1.5, 3.5) to
    // (1.5, 2.5) — a visible slide across the map.
    expect(previousPoseOf(sim, player)).toEqual({ x: 1.5, y: 2.5 });

    // The 1-tick phase is unchanged: `EncounterSystem` already ran for tick 2, so
    // the new room's opening wave appears on tick 3 — not on the transition tick.
    sim.step(1); // tick 3
    const next = liveEnemyIds(sim);
    // TWO enemies, not one: room 1 is depth 1, so its configured one-enemy wave
    // carries one depth copy (spec 11 AC-04). The room declares a single `3` tile, so
    // both copies land on it — the documented degradation when the pool is smaller
    // than the roster (spec 19 R4), asserted rather than glossed over.
    expect(next).toHaveLength(2);
    for (const id of next) {
      expect(poseOf(sim, id)).toEqual({ x: 1.5, y: 1.5 });
    }
  });

  it('restartRun rebuilds room 0`s terrain and re-places the player exactly', () => {
    DataManager.loadAll(bundle());
    const sim = makeRunSim();
    sim.restartRun(SEED);

    // Let the run get properly under way first: the wave spawns, enemies move.
    sim.step(30);

    sim.restartRun(SEED);

    // Room 0 again: 11 walls, the player on its `2` tile, and the pool republished.
    // This is AC-02 on the RESTART path — `restartRun` reaches `runSetup`, which is
    // where the opening room's topology is assembled (spec 19 §4.3).
    expect(wallIds(sim)).toHaveLength(11);
    expect(poseOf(sim, playerOf(sim))).toEqual({ x: 1.5, y: 3.5 });
    const room = roomOf(sim);
    expect(currentRoomId(room)).toBe('room_a');
    expect(room.currentRoomIndex).toBe(0);
    expect(room.depth).toBe(0);
    expect(room.enemySpawnPoints).toEqual([{ x: 2.5, y: 1.5 }]);
    expect(liveEnemyIds(sim)).toHaveLength(0); // no wave has been scheduled yet
  });

  it('is deterministic: the same seed rebuilds the same scene', () => {
    DataManager.loadAll(bundle());

    const run = (): unknown => {
      const sim = makeRunSim();
      sim.restartRun(SEED);
      sim.step(45);
      return sim.snapshot();
    };

    expect(run()).toEqual(run());
  });
});

/* ========================================================================== *
 * G3 · deterministic spawn (AC-03)                                            *
 * ========================================================================== */
describe('G3 · enemies land on the room`s spawn tiles, reproducibly (AC-03)', () => {
  /** The five `3` tiles of `spawn_five`, as world centres — LITERALS. */
  const SPAWN_TILES: readonly SpawnPoint[] = [
    { x: 0.5, y: 0.5 },
    { x: 1.5, y: 0.5 },
    { x: 2.5, y: 0.5 },
    { x: 0.5, y: 1.5 },
    { x: 2.5, y: 1.5 },
  ];

  /** Spawn one wave of three and read their landing spots on the spawn tick. */
  function spawnThree(seed: number): readonly SpawnPoint[] {
    const sim = makeRunSim(seed);
    sim.restartRun(seed);
    sim.step(1); // tick 0 — the wave spawns; no per-entity system has run since
    return liveEnemyIds(sim).map((id) => poseOf(sim, id));
  }

  it('places all three enemies exactly ON spawn tiles, on three DISTINCT tiles', () => {
    DataManager.loadAll(bundle(FIVE_SPAWN_ENCOUNTERS));

    const poses = spawnThree(SEED);
    expect(poses).toHaveLength(3);

    for (const pose of poses) {
      // Membership, not "close to": the coordinate IS a tile centre, with no offset
      // (spec 19 I6).
      expect(SPAWN_TILES).toContainEqual(pose);
    }

    // The rotation never stacks two enemies on one spot: overlapping hurtboxes would
    // read as ONE enemy to the player and to a collision assertion.
    const distinct = new Set(poses.map((pose) => `${String(pose.x)},${String(pose.y)}`));
    expect(distinct.size).toBe(3);
  });

  it('reproduces the distribution byte for byte for the same seed', () => {
    DataManager.loadAll(bundle(FIVE_SPAWN_ENCOUNTERS));

    const first = spawnThree(SEED);
    const second = spawnThree(SEED);

    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
  });

  it('can start the rotation on a different tile for a different seed', () => {
    DataManager.loadAll(bundle(FIVE_SPAWN_ENCOUNTERS));

    // A PRNG-sampled start, proven BEHAVIOURALLY: sweeping seeds must produce more
    // than one distinct first landing spot. (Asserting "different seeds differ" on a
    // single pair would be flaky; asserting one fixed spot would be a lie.)
    const starts = new Set<string>();
    for (let seed = 0; seed < 40; seed += 1) {
      const first = spawnThree(seed)[0];
      if (first !== undefined) starts.add(`${String(first.x)},${String(first.y)}`);
    }

    expect(starts.size).toBeGreaterThan(1);
    // ... and every observed start is still a legal tile.
    for (const key of starts) {
      const parts = key.split(',');
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      expect(SPAWN_TILES).toContainEqual({ x, y });
    }
  });
});

/* ========================================================================== *
 * G4 · contract guards (AC-06 / AC-07)                                        *
 * ========================================================================== */
describe('G4 · the pipeline, the descent and the no-topology fallback are unchanged', () => {
  it('keeps the canonical 17-segment order — M12-T01 adds NO segment', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names).toHaveLength(17);
    expect(names[0]).toBe('TransformSnapshotSystem');
    expect(names[names.length - 1]).toBe('LifespanSystem');
    // The transition happens INSIDE `RewardSystem`, so the two slots it depends on
    // must still bracket it: after EncounterSystem (this tick's clear is settled) and
    // before LifespanSystem (which stays LAST).
    expect(names.indexOf('RewardSystem')).toBeGreaterThan(names.indexOf('EncounterSystem'));
    expect(names.indexOf('RewardSystem')).toBeLessThan(names.indexOf('LifespanSystem'));
  });

  it('clears the spawn pool on descent, so a gridless room cannot inherit one', () => {
    DataManager.loadAll(bundle());
    const world = new World();
    const id = EncounterFactory.spawn(world, {
      waves: [{ delayTicks: 0, enemies: [{ enemyId: 'raider' }] }],
      roomIds: ['room_a', 'room_b'],
    });
    const room = world.getComponent(id, EncounterStateComponent);
    if (room === undefined) throw new Error('QA: no EncounterStateComponent');

    expect(room.roomIds).toEqual(['room_a', 'room_b']);
    room.enemySpawnPoints = [{ x: 9, y: 9 }];

    descendEncounterRoom(room);

    // Load-bearing rather than tidy: the pool describes "the room being fought", and
    // the instant the index moves it describes a room that no longer exists. Without
    // this, a `with-grid -> without-grid` descent would inherit the old landing spots.
    expect(room.enemySpawnPoints).toEqual([]);
    expect(currentRoomId(room)).toBe('room_b');
  });

  it('falls back to the centre-line formation when the room declares no `3` tile', () => {
    DataManager.loadAll(bundle());

    const boxSim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const roomEntity = EncounterFactory.spawn(boxSim.world, {
      waves: [{ delayTicks: 0, enemies: [{ enemyId: 'raider' }] }],
      roomIds: ['box_3x3'],
    });
    const boxRoom = boxSim.world.getComponent(roomEntity, EncounterStateComponent);
    if (boxRoom === undefined) throw new Error('QA: no EncounterStateComponent');

    LevelLoader.enterRoom(boxSim.world, { roomId: 'box_3x3', encounter: boxRoom });
    // The box room has no `3` tile, so its landing pool is EMPTY — the "no topology
    // for spawning" answer, not an error.
    expect(boxRoom.enemySpawnPoints).toEqual([]);

    boxSim.step(1); // tick 0
    // `formWaveRoster(['raider'])` => `{ x: 0, y: 0 }` — the pre-M12 landing spot,
    // unchanged (spec 19 I10).
    expect(liveEnemyIds(boxSim)).toHaveLength(1);
    expect(poseOf(boxSim, onlyLiveEnemy(boxSim))).toEqual({ x: 0, y: 0 });
  });

  it('consumes NO randomness at all when the room has no spawn pool', () => {
    DataManager.loadAll(bundle(NO_TOPOLOGY_ENCOUNTERS));

    const sim = makeRunSim(SEED);
    sim.restartRun(SEED);
    sim.step(1); // tick 0 — the wave spawns with no topology

    expect(liveEnemyIds(sim)).toHaveLength(1);
    // "Does not consume randomness" cannot be asserted by looking at a result — the
    // generator itself has to be observed. A fresh generator on the same seed holds
    // the FIRST value; if this run drew anything, the two would differ.
    expect(sim.world.rng.nextUint32()).toBe(new Random(SEED).nextUint32());
  });

  it('consumes EXACTLY ONE draw when the room has a spawn pool', () => {
    DataManager.loadAll(bundle(FIVE_SPAWN_ENCOUNTERS));

    const sim = makeRunSim(SEED);
    sim.restartRun(SEED);
    sim.step(1); // tick 0 — one wave, three enemies

    expect(liveEnemyIds(sim)).toHaveLength(3);

    // One draw per WAVE, not one per enemy: the stream perturbation is a constant
    // rather than a function of the roster size, so "how much randomness a wave
    // costs" is a fact one can reason about — and it is what keeps the reward draft
    // (drawn from the same single stream, ADR-004) predictable.
    const probe = new Random(SEED);
    probe.nextUint32(); // the ONE draw the landing spots cost
    expect(sim.world.rng.nextUint32()).toBe(probe.nextUint32());
  });

  it('leaves a hand-built room with no topology exactly as it was', () => {
    DataManager.loadAll(bundle());
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 2, y: -3, maxSpeed: MAX_SPEED });
    EncounterFactory.spawn(sim.world, {
      waves: [{ delayTicks: 0, enemies: [{ enemyId: 'raider' }] }],
    });

    // No `LevelLoader` call at all: nothing is cleared, no wall exists, and the
    // caller's pose survives. This is the M1–M11 contract, untouched.
    sim.step(1);

    expect(wallIds(sim)).toHaveLength(0);
    expect(poseOf(sim, player)).toEqual({ x: 2, y: -3 });
    expect(liveEnemyIds(sim)).toHaveLength(1);
  });
});

/* ========================================================================== *
 * G5 · the room's shape is VISIBLE (AC-08)                                    *
 * ========================================================================== */
describe('G5 · the renderer draws the room — and only while there is one (AC-08)', () => {
  /**
   * A duck-typed `Application`: a real PixiJS `Container` stage plus a controllable
   * ticker. Same stand-in the M5 render suites use — PixiJS v8 cannot be driven from
   * plain Node (`document is not defined`), and the renderer only ever needs these
   * two members.
   */
  function makeApp(): { readonly app: Application } {
    const ticker = { deltaMS: 16, add: () => {}, remove: () => {} };
    return { app: { stage: new Container(), ticker } as unknown as Application };
  }

  it('draws one block per wall, keeps them BELOW every entity, and drops them with the room', () => {
    DataManager.loadAll(bundle());

    const { app } = makeApp();
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5, maxSpeed: MAX_SPEED });

    const renderer = new GameRenderer(app);
    renderer.init();

    // 1. NO WALLS: the stage holds exactly the render root and no static layer, so a
    //    pre-M12 world sees the M5 scene graph byte for byte — including
    //    `stage.children[0] === root`, which the frozen render suites assert.
    renderer.syncWorld(sim.world);
    expect(renderer.wallViewCount).toBe(0);
    expect(app.stage.children).toHaveLength(1);
    const root = app.stage.children[0];
    if (root === undefined) throw new Error('QA: renderer.init() attached no root');
    expect(renderer.viewCount).toBe(1); // the player
    expect(root.children).toHaveLength(2); // the player view + the FX layer

    // 2. THE ROOM ARRIVES: one block per `1` tile, and the layer is inserted at stage
    //    index 0 — i.e. behind the root, and therefore behind every entity and FX.
    const result = LevelLoader.enterRoom(sim.world, { roomId: 'box_3x3' });
    expect(result.wallCount).toBe(8);
    renderer.syncWorld(sim.world);

    expect(renderer.wallViewCount).toBe(8);
    expect(app.stage.children).toHaveLength(2);
    expect(app.stage.children[1]).toBe(root);
    expect(app.stage.children[0]).not.toBe(root);
    // The blocks are drawn in the ONE render unit the logic layer never knows about.
    expect(PX_PER_UNIT).toBe(10);

    // 3. THE ROOM IS TORN DOWN: the layer goes with it, and the scene graph returns
    //    to exactly the pre-M12 shape rather than leaving stale blocks behind.
    LevelLoader.clearRoomEntities(sim.world);
    renderer.syncWorld(sim.world);

    expect(renderer.wallViewCount).toBe(0);
    expect(app.stage.children).toHaveLength(1);
    expect(app.stage.children[0]).toBe(root);
  });
});
