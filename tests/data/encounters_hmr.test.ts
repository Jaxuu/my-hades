/**
 * M10-T02 · Encounter table + data hot-reload harness suite.
 * See specs/17_encounters_hmr_spec.md §6 (AC-01 / AC-02 / AC-03).
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * M10-T02 makes the SHAPE of a run data: which rooms exist, what each room's waves
 * are, how long each wave waits, and which enemy types it holds — all read from
 * `assets/data/encounters.json` BY DEPTH. Two failure modes follow from that, and
 * the suite is organised around exactly them:
 *
 *   G1 · wave configuration    — the table is read by depth, the past-the-end cycle
 *                                works, and a wave template becomes a placeable
 *                                roster deterministically (AC-01 / AC-02).
 *   G2 · contract defence      — a malformed table, and above all a wave that names
 *                                an enemy type that does not exist, fails at LOAD
 *                                time rather than from inside `step()`.
 *   G3 · depth-driven assembly — the room a run starts with, and the room it
 *                                descends INTO, are the table's entry for that
 *                                depth — asserted against a real `GameSimulator`,
 *                                tick by tick for the `delayTicks` contract.
 *   G4 · atomic refresh        — replacing the whole table and restarting the run
 *                                makes a NEW entity read the NEW numbers (the
 *                                "cache invalidation + singleton update" the HMR
 *                                contract rests on), and a failed reload leaves the
 *                                live table untouched.
 *
 * The suite drives the REAL `DataManager`, the REAL `EncounterFactory` and the REAL
 * system pipeline against a MOCK enemy/room table. Nothing is stubbed, and the
 * numbers in the fixtures are chosen to be distinctive (7 / 11 / 137 / 500) so "the
 * value came from the table" cannot be confused with "the value came from a default".
 *
 * HMR itself is NOT unit-tested here, and that is deliberate: the hot-reload seam is
 * `import.meta.hot`, which exists only inside a Vite dev server and only in `client/`
 * (spec 17 AC-04 forbids it in `src/`). What IS testable in Node — and what this file
 * therefore pins — is the entire DATA half of a reload: re-feeding
 * `DataManager.loadAll` and observing that a restarted run picks the new values up.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DataManager,
  EncounterFactory,
  EncounterState,
  EncounterStateComponent,
  GameSimulator,
  GameStateFactory,
  HealthComponent,
  HurtboxComponent,
  SchemaError,
  World,
  bootstrapData,
  bundledConfigTables,
  createDefaultSystems,
  descendEncounterRoom,
  formWaveRoster,
  isDead,
  isEncounterTable,
  parseEncounterTable,
  resolveEncounterWaves,
} from '../../src';
import type { RawConfigTables } from '../../src';

/*
 * Every test here may replace the process-wide table, so every test puts the
 * SHIPPED one back. `bootstrapData()` is the same call the harness setup made, so
 * the restore path is the production path rather than a special case — and it is
 * what makes the shipped `encounters.json` part of every other suite's baseline.
 */
afterEach(async () => {
  await bootstrapData();
});

/* --- fixtures -------------------------------------------------------------- */

const MOCK_GRUNT = { maxHp: 137, maxSpeed: 5, hurtboxRadius: 0.5 } as const;

/**
 * The SHIPPED modifier table, reused verbatim.
 *
 * Not a convenience: `createDefaultSystems()` builds the modifier registry at
 * construction time and reads `zeus_strike` / `poseidon_dash` out of `DataManager`.
 * A mock bundle that blanked the modifier table would make the pipeline
 * un-constructible, and the test would be measuring the wrong failure. Reusing the
 * shipped entries keeps the rig a real pipeline while the ENEMY and ROOM tables stay
 * fully mocked.
 */
const SHIPPED_MODIFIERS = bundledConfigTables().modifiers;

/**
 * A two-room table whose delays (7 / 11 / 3) and roster sizes (1 / 2 / 1) appear
 * nowhere else in the codebase, so every assertion below can only be satisfied by
 * reading them out of this table.
 */
const ENCOUNTERS = [
  { depth: 0, waves: [{ delayTicks: 7, enemies: ['mock_grunt'] }] },
  {
    depth: 1,
    waves: [
      { delayTicks: 11, enemies: ['mock_grunt', 'mock_grunt'] },
      { delayTicks: 3, enemies: ['mock_grunt'] },
    ],
  },
];

/** A bundle with the mock enemy, the shipped boons, and the two-room table. */
function bundle(gruntMaxHp: number = MOCK_GRUNT.maxHp): RawConfigTables {
  return {
    enemies: { mock_grunt: { ...MOCK_GRUNT, maxHp: gruntMaxHp } },
    modifiers: SHIPPED_MODIFIERS,
    encounters: ENCOUNTERS,
  };
}

/** A bundle with one mock enemy and no rooms at all (the "no table" shape). */
function enemyOnlyBundle(): RawConfigTables {
  return { enemies: { mock_grunt: { ...MOCK_GRUNT } }, modifiers: SHIPPED_MODIFIERS };
}

/** The component of the data-backed room in `world`. */
function roomIn(world: World): EncounterStateComponent {
  const id = EncounterFactory.spawnFromData(world);
  const room = world.getComponent(id, EncounterStateComponent);
  if (room === undefined) {
    throw new Error('QA: EncounterFactory.spawnFromData mounted no EncounterStateComponent');
  }
  return room;
}

/**
 * A simulator whose whole run is "the data-backed room plus the state singleton".
 *
 * No player is spawned: the encounter scheduler never needs one (it only watches the
 * ids it spawned), and leaving the player out keeps "the enemies" an unambiguous
 * read. Construct it AFTER `DataManager.loadAll`, because `createDefaultSystems()`
 * reads the modifier table.
 */
function makeSim(seed: number): GameSimulator {
  return new GameSimulator({
    systems: createDefaultSystems(),
    seed,
    runSetup: (world) => {
      EncounterFactory.spawnFromData(world);
      GameStateFactory.spawn(world);
    },
  });
}

/**
 * Ids of every LIVING enemy — corpses included in the world but excluded here.
 *
 * The filter is load-bearing: a corpse is never destroyed (spec 08 §4.4), so a raw
 * `query(HealthComponent)` keeps counting it forever and "the wave spawned two
 * enemies" would read as three.
 */
function liveEnemyIds(sim: GameSimulator): readonly number[] {
  return sim.world.query(HealthComponent).filter((id) => !isDead(sim.world, id));
}

/** The one living enemy's health, or a loud failure — never a silent `undefined`. */
function onlyEnemyHealth(sim: GameSimulator): HealthComponent {
  const ids = liveEnemyIds(sim);
  if (ids.length !== 1) {
    throw new Error(`QA: expected exactly one living enemy, found ${String(ids.length)}`);
  }
  const id = ids[0];
  const health = id === undefined ? undefined : sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: the enemy is missing its HealthComponent');
  return health;
}

/* ========================================================================== *
 * G1 · wave configuration (AC-01 / AC-02)                                     *
 * ========================================================================== */
describe('G1 · the room sequence is read from the table BY DEPTH (AC-01/AC-02)', () => {
  it('exposes the configured depths and the exact wave templates per depth', () => {
    DataManager.loadAll(bundle());

    expect(DataManager.getEncounterRoomCount()).toBe(2);
    expect(DataManager.encounterDepths).toEqual([0, 1]);

    // Field for field, so "the number came from the JSON" cannot be confused with
    // "the number came from a default".
    expect(DataManager.getEncounterWaves(0)).toEqual([{ delayTicks: 7, enemies: ['mock_grunt'] }]);
    expect(DataManager.getEncounterWaves(1)).toEqual([
      { delayTicks: 11, enemies: ['mock_grunt', 'mock_grunt'] },
      { delayTicks: 3, enemies: ['mock_grunt'] },
    ]);
  });

  it('CYCLES past the end of the table instead of clamping (AC-02 循环复用)', () => {
    DataManager.loadAll(bundle());

    // Cycling, not clamping: a clamped lookup would replay the last room forever,
    // while a cycle keeps producing a DIFFERENT room as the depth dial rises.
    expect(DataManager.getEncounterWaves(2)).toEqual(DataManager.getEncounterWaves(0));
    expect(DataManager.getEncounterWaves(3)).toEqual(DataManager.getEncounterWaves(1));
    expect(DataManager.getEncounterWaves(7)).toEqual(DataManager.getEncounterWaves(1));
  });

  it('rejects a depth that is not a non-negative integer', () => {
    DataManager.loadAll(bundle());
    expect(() => DataManager.getEncounterWaves(-1)).toThrow(
      /encounter depth must be a non-negative integer/,
    );
    expect(() => DataManager.getEncounterWaves(1.5)).toThrow(
      /encounter depth must be a non-negative integer/,
    );
  });

  it('reports a missing table as such, rather than as an empty result', () => {
    DataManager.loadAll(enemyOnlyBundle());
    // An omitted table is a legitimate bundle (a tool, a focused test) — the failure
    // is reported when someone asks for rooms, and it names the CAUSE.
    expect(DataManager.getEncounterRoomCount()).toBe(0);
    expect(() => DataManager.getEncounterWaves(0)).toThrow(/no encounter config is loaded/);
    expect(() => EncounterFactory.spawnFromData(new World())).toThrow(/no encounter config is loaded/);
  });

  it('lays a wave out deterministically, centred on the room origin', () => {
    expect(formWaveRoster(['a'])).toEqual([{ enemyId: 'a', x: 0, y: 0 }]);
    expect(formWaveRoster(['a', 'b'])).toEqual([
      { enemyId: 'a', x: -1, y: 0 },
      { enemyId: 'b', x: 1, y: 0 },
    ]);
    expect(formWaveRoster(['a', 'b', 'c'])).toEqual([
      { enemyId: 'a', x: -2, y: 0 },
      { enemyId: 'b', x: 0, y: 0 },
      { enemyId: 'c', x: 2, y: 0 },
    ]);
    // Same template => same roster, always (spec 00 §6.2).
    expect(formWaveRoster(['a', 'b'])).toEqual(formWaveRoster(['a', 'b']));
  });

  it('converts a depth template into the scheduler vocabulary, delays and all', () => {
    DataManager.loadAll(bundle());

    expect(resolveEncounterWaves(0)).toEqual([
      { delayTicks: 7, enemies: [{ enemyId: 'mock_grunt', x: 0, y: 0 }] },
    ]);
    expect(resolveEncounterWaves(1)).toEqual([
      {
        delayTicks: 11,
        enemies: [
          { enemyId: 'mock_grunt', x: -1, y: 0 },
          { enemyId: 'mock_grunt', x: 1, y: 0 },
        ],
      },
      { delayTicks: 3, enemies: [{ enemyId: 'mock_grunt', x: 0, y: 0 }] },
    ]);
  });
});

/* ========================================================================== *
 * G2 · contract defence                                                       *
 * ========================================================================== */
describe('G2 · a malformed encounter table fails at LOAD time, naming the path', () => {
  it('rejects a table that is not a non-empty array', () => {
    expect(() => parseEncounterTable({}, 'encounters')).toThrow(
      /encounters must be a non-empty array of room templates/,
    );
    expect(() => parseEncounterTable([], 'encounters')).toThrow(
      /encounters must be a non-empty array of room templates/,
    );
    expect(() => parseEncounterTable(null, 'encounters')).toThrow(SchemaError);

    // An explicitly EMPTY table is a declared-but-empty run, not "no rooms": the
    // same distinction `loot: []` draws (spec 15 §3.3). Omitting the field is how a
    // bundle says "this build ships no rooms".
    expect(() =>
      DataManager.loadAll({ enemies: {}, modifiers: SHIPPED_MODIFIERS, encounters: [] }),
    ).toThrow(/encounters must be a non-empty array of room templates/);
  });

  it('rejects a depth that disagrees with its position, and an empty room', () => {
    const base = { enemies: { mock_grunt: { ...MOCK_GRUNT } }, modifiers: SHIPPED_MODIFIERS };

    expect(() =>
      DataManager.loadAll({
        ...base,
        encounters: [{ depth: 5, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] }],
      }),
    ).toThrow(/encounters\[0\]\.depth \(5\) must equal its position in the table \(0\)/);

    expect(() => DataManager.loadAll({ ...base, encounters: [{ depth: 0, waves: [] }] })).toThrow(
      /encounters\[0\]\.waves must be a non-empty array of waves/,
    );
  });

  it('rejects a wave with no enemies, a fractional delay, and an empty id', () => {
    const base = { enemies: { mock_grunt: { ...MOCK_GRUNT } }, modifiers: SHIPPED_MODIFIERS };

    expect(() =>
      DataManager.loadAll({
        ...base,
        encounters: [{ depth: 0, waves: [{ delayTicks: 0, enemies: [] }] }],
      }),
    ).toThrow(/encounters\[0\]\.waves\[0\]\.enemies must be a non-empty array of enemy type ids/);

    expect(() =>
      DataManager.loadAll({
        ...base,
        encounters: [{ depth: 0, waves: [{ delayTicks: 2.5, enemies: ['mock_grunt'] }] }],
      }),
    ).toThrow(/encounters\[0\]\.waves\[0\]\.delayTicks must be a non-negative integer/);

    expect(() =>
      DataManager.loadAll({
        ...base,
        encounters: [{ depth: 0, waves: [{ delayTicks: 0, enemies: [''] }] }],
      }),
    ).toThrow(/encounters\[0\]\.waves\[0\]\.enemies\[0\] must be a non-empty enemy type id/);
  });

  it('rejects a wave that references an enemy type which does not exist', () => {
    // THE reason the check lives in `loadAll` rather than in a leaf parser: this is
    // the one rule that needs BOTH tables, and it is what stops a typo'd type from
    // throwing from inside `step()` at the moment the wave comes due.
    expect(() =>
      DataManager.loadAll({
        enemies: { mock_grunt: { ...MOCK_GRUNT } },
        modifiers: SHIPPED_MODIFIERS,
        encounters: [{ depth: 0, waves: [{ delayTicks: 0, enemies: ['mock_grunt', 'gruntt'] }] }],
      }),
    ).toThrow(
      /encounters\[0\]\.waves\[0\]\.enemies\[1\] references unknown enemy id 'gruntt'\. Loaded enemy ids: mock_grunt\./,
    );
  });

  it('exposes a non-throwing predicate that agrees with the parser', () => {
    expect(isEncounterTable(ENCOUNTERS)).toBe(true);
    expect(isEncounterTable([{ depth: 0, waves: [{ delayTicks: 0, enemies: ['a'] }] }])).toBe(true);
    expect(isEncounterTable([])).toBe(false);
    expect(isEncounterTable([{ depth: 1, waves: [{ delayTicks: 0, enemies: ['a'] }] }])).toBe(false);
    expect(isEncounterTable('nope')).toBe(false);
  });

  it('leaves the previous table INTACT when a reload fails part-way (atomic install)', () => {
    DataManager.loadAll(bundle(137));
    expect(DataManager.getEncounterRoomCount()).toBe(2);

    expect(() =>
      DataManager.loadAll({
        enemies: { mock_grunt: { ...MOCK_GRUNT, maxHp: 'oops' } },
        modifiers: SHIPPED_MODIFIERS,
        encounters: [{ depth: 0, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] }],
      }),
    ).toThrow(SchemaError);

    // This is what makes a bad hot-reload edit survivable: the running game keeps
    // the outgoing table rather than half-swapping to the broken one.
    expect(DataManager.getEnemyConfig('mock_grunt').maxHp).toBe(137);
    expect(DataManager.getEncounterRoomCount()).toBe(2);
    expect(DataManager.getEncounterWaves(0)).toEqual([{ delayTicks: 7, enemies: ['mock_grunt'] }]);
  });
});

/* ========================================================================== *
 * G3 · depth-driven assembly (AC-01 / AC-02)                                  *
 * ========================================================================== */
describe('G3 · a run is assembled, and descends, by depth', () => {
  it('builds the room table from every configured depth', () => {
    DataManager.loadAll(bundle());
    const room = roomIn(new World());

    expect(room.maxRooms).toBe(2);
    expect(room.currentRoomIndex).toBe(0);
    expect(room.depth).toBe(0);
    expect(room.state).toBe(EncounterState.IN_PROGRESS);
    expect(room.waves).toEqual(resolveEncounterWaves(0));
    expect(room.roomWaves).toHaveLength(2);
    expect(room.roomWaves[1]).toEqual(resolveEncounterWaves(1));
  });

  it('follows the table when the table changes — the layout is not hard-coded', () => {
    const enemy = { mock_grunt: { ...MOCK_GRUNT } };
    DataManager.loadAll({
      enemies: enemy,
      modifiers: SHIPPED_MODIFIERS,
      encounters: [
        { depth: 0, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
        { depth: 1, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
        { depth: 2, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
      ],
    });

    expect(roomIn(new World()).maxRooms).toBe(3);
  });

  it('spawns the opening wave exactly `delayTicks` ticks after the room is observed', () => {
    DataManager.loadAll(bundle());
    const sim = makeSim(0x5eed);
    sim.restartRun(0x5eed);

    // `EncounterFactory` never spawns the opening wave; the scheduler does, on the
    // first tick it observes the room, with the deadline `now + delayTicks` (7 here).
    expect(liveEnemyIds(sim)).toHaveLength(0);

    sim.step(7); // processes ticks 0..6
    expect(liveEnemyIds(sim)).toHaveLength(0);

    sim.step(1); // tick 7 — the deadline
    // The wave's count came from the table, which declares exactly one enemy.
    expect(DataManager.getEncounterWaves(0)[0]?.enemies).toHaveLength(1);
    expect(liveEnemyIds(sim)).toHaveLength(1);
  });

  it("descends into the NEXT depth's waves, not into a re-assembled copy", () => {
    DataManager.loadAll(bundle());
    const room = roomIn(new World());

    descendEncounterRoom(room);

    expect(room.currentRoomIndex).toBe(1);
    expect(room.depth).toBe(1);
    expect(room.state).toBe(EncounterState.IN_PROGRESS);
    expect(room.currentWaveIndex).toBe(0);
    expect(room.trackedEntityIds).toEqual([]);
    // Depth 1's FIRST wave: `delayTicks` 11 and TWO enemies — both from the table.
    expect(room.waves).toEqual(resolveEncounterWaves(1));
    expect(room.waves[0]?.delayTicks).toBe(11);
    expect(room.waves[0]?.enemies).toHaveLength(2);
  });

  it('falls back to the table BY DEPTH when a hand-built room outlives its own list (AC-02 兜底)', () => {
    DataManager.loadAll(bundle());
    const world = new World();

    // A room whose declared run length exceeds the room list it carries: the only
    // shape that can reach the past-the-end path. Descending twice must produce
    // depth 1's waves and then CYCLE back to depth 0's — never `undefined`.
    const id = EncounterFactory.spawn(world, { waves: resolveEncounterWaves(0) });
    const room = world.getComponent(id, EncounterStateComponent);
    if (room === undefined) {
      throw new Error('QA: EncounterFactory.spawn mounted no EncounterStateComponent');
    }
    room.maxRooms = 4;

    descendEncounterRoom(room);
    expect(room.depth).toBe(1);
    expect(room.waves).toEqual(resolveEncounterWaves(1));

    descendEncounterRoom(room);
    expect(room.depth).toBe(2);
    expect(room.waves).toEqual(resolveEncounterWaves(0));
  });

  it('is reproducible: the same table assembles the same room twice', () => {
    DataManager.loadAll(bundle());
    const first = roomIn(new World());
    const second = roomIn(new World());
    expect(second.roomWaves).toEqual(first.roomWaves);
  });
});

/* ========================================================================== *
 * G4 · atomic refresh (the data half of AC-03)                                *
 * ========================================================================== */
describe('G4 · replacing the table and restarting makes a NEW entity read the NEW numbers', () => {
  it('re-reads a re-tuned enemy on the next run — cache invalidation, not a stale singleton', () => {
    const SIM_SEED = 0x0badf00d;
    DataManager.loadAll(bundle(137));

    const sim = makeSim(SIM_SEED);
    sim.restartRun(SIM_SEED);
    sim.step(8); // the opening wave (delayTicks 7) is live

    expect(onlyEnemyHealth(sim).maxHp).toBe(137);
    expect(onlyEnemyHealth(sim).hp).toBe(137);
    const beforeId = liveEnemyIds(sim)[0];
    expect(sim.currentSeed).toBe(SIM_SEED);

    // THE RELOAD: a brand-new table, installed atomically through the same
    // `DataManager.loadAll` the dev-mode hot reload calls.
    DataManager.loadAll(bundle(500));
    expect(DataManager.getEnemyConfig('mock_grunt').maxHp).toBe(500);

    // `sim.currentSeed` keeps the reload a pure CONFIG change: the same run, the
    // same stream, new numbers. A data edit must not quietly become a free re-roll.
    sim.restartRun(sim.currentSeed);
    expect(sim.currentSeed).toBe(SIM_SEED);
    sim.step(8);

    const after = onlyEnemyHealth(sim);
    expect(after.maxHp).toBe(500);
    expect(after.hp).toBe(500);
    // And it really is a NEW entity: `clearEntities` never resets `World.nextId`
    // (spec 14 §4.5, P0 — the render layer's `retired` set depends on it).
    const afterId = liveEnemyIds(sim)[0];
    expect(afterId).not.toBe(beforeId);
  });

  it('rebuilds the ROOMS from the new table too, so a room edit is a data edit', () => {
    DataManager.loadAll(bundle());
    const sim = makeSim(1);
    sim.restartRun(1);

    const beforeId = sim.world.query(EncounterStateComponent)[0];
    const before =
      beforeId === undefined ? undefined : sim.world.getComponent(beforeId, EncounterStateComponent);
    expect(before?.maxRooms).toBe(2);

    DataManager.loadAll({
      enemies: { mock_grunt: { ...MOCK_GRUNT } },
      modifiers: SHIPPED_MODIFIERS,
      encounters: [
        { depth: 0, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
        { depth: 1, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
        { depth: 2, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
        { depth: 3, waves: [{ delayTicks: 0, enemies: ['mock_grunt'] }] },
      ],
    });

    sim.restartRun(sim.currentSeed);

    const roomId = sim.world.query(EncounterStateComponent)[0];
    const room = roomId === undefined ? undefined : sim.world.getComponent(roomId, EncounterStateComponent);
    expect(room?.maxRooms).toBe(4);
    expect(room?.waves).toEqual(resolveEncounterWaves(0));
  });

  it('keeps the live table when a reload is rejected', () => {
    DataManager.loadAll(bundle(137));
    const sim = makeSim(2);
    sim.restartRun(2);
    sim.step(8);
    expect(onlyEnemyHealth(sim).maxHp).toBe(137);

    // A broken edit must not take the session with it (see `loadAll`'s atomicity).
    expect(() =>
      DataManager.loadAll({
        enemies: { mock_grunt: { maxHp: -1, maxSpeed: 5, hurtboxRadius: 0.5 } },
        modifiers: SHIPPED_MODIFIERS,
        encounters: ENCOUNTERS,
      }),
    ).toThrow(SchemaError);

    // The run in flight is untouched, and so is the table the next restart will read.
    sim.step(1);
    expect(onlyEnemyHealth(sim).maxHp).toBe(137);
    expect(DataManager.getEnemyConfig('mock_grunt').maxHp).toBe(137);
  });
});

/* ========================================================================== *
 * Guard rail: the wave a room spawns really is the table's wave               *
 * ========================================================================== */
describe('the spawn contract is unchanged by data-driving the table', () => {
  it('spawns the configured COUNT of enemies for each wave, in table order', () => {
    DataManager.loadAll({
      enemies: { mock_grunt: { ...MOCK_GRUNT } },
      modifiers: SHIPPED_MODIFIERS,
      encounters: [
        {
          depth: 0,
          waves: [
            { delayTicks: 7, enemies: ['mock_grunt'] },
            { delayTicks: 5, enemies: ['mock_grunt', 'mock_grunt'] },
          ],
        },
      ],
    });

    const sim = makeSim(3);
    sim.restartRun(3);

    sim.step(8); // tick 7: wave 0 -> one enemy
    expect(liveEnemyIds(sim)).toHaveLength(1);

    // Kill wave 0's only enemy by hand, then let the real pipeline promote wave 1
    // and honour ITS OWN `delayTicks` (5).
    const first = liveEnemyIds(sim)[0];
    if (first !== undefined) {
      const health = sim.world.getComponent(first, HealthComponent);
      if (health !== undefined) health.hp = 0;
    }
    sim.step(1); // tick 8: DeathSystem tags it, EncounterSystem promotes wave 1 (deadline 13)
    expect(liveEnemyIds(sim)).toHaveLength(0);
    sim.step(5); // ticks 9..13: wave 1 spawns on tick 13
    expect(liveEnemyIds(sim)).toHaveLength(2);

    // Every spawned entity is a real, fully-assembled enemy (the factory path, not
    // a bare Transform): the living ones all own a hurtbox.
    for (const id of liveEnemyIds(sim)) {
      expect(sim.world.hasComponent(id, HurtboxComponent)).toBe(true);
    }
  });
});
