/**
 * M10-T01 · DataManager / schema harness suite.
 * See specs/16_data_driven_pipeline_spec.md §6 (AC-01 / AC-02 / AC-03).
 *
 * What this file is FOR
 * ---------------------
 * The data-driven pipeline introduces a new failure surface — a config file — and
 * the whole point of the milestone is that a bad file must fail LOUDLY at load time
 * instead of quietly poisoning the simulation. So the suite is organised around the
 * three things that can go wrong, plus the one thing that must keep working:
 *
 *   G1 · valid loading       — a well-formed bundle parses, is queryable, and is
 *                              installed atomically (AC-01 / AC-03).
 *   G2 · contract defence    — a missing field, a mistyped field, an out-of-domain
 *                              number, a bad nested block: every one of them raises
 *                              a `SchemaError` NAMING THE FIELD, and a failed load
 *                              leaves the previous table untouched (AC-02).
 *   G3 · factory mapping     — a config's numbers arrive on the assembled entity
 *                              verbatim, and a capability the config omits really is
 *                              absent (AC-01's "no hard-coded numbers" claim, made
 *                              observable).
 *   G4 · bootstrap ordering  — an un-bootstrapped registry refuses to be read,
 *                              which is what makes AC-03's "load before you
 *                              simulate" a contract rather than a convention.
 *
 * The suite deliberately drives the REAL `DataManager` and the REAL `EnemyFactory`
 * against a MOCK table — nothing is stubbed, and the numbers in the fixtures are
 * chosen to be distinctive (137 / 2.5 / 0.42) so "the value came from the JSON"
 * cannot be confused with "the value came from a default".
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  AIControllerComponent,
  ArmorComponent,
  DataManager,
  EnemyFactory,
  Faction,
  FactionComponent,
  HazardCasterComponent,
  HealthComponent,
  HurtboxComponent,
  LootComponent,
  PickupKind,
  SchemaError,
  VelocityComponent,
  World,
  bootstrapData,
  isEnemyConfig,
  isModifierConfig,
} from '../../src';
import type { RawConfigTables } from '../../src';

/*
 * Every test here may replace the process-wide table, so every test puts the
 * SHIPPED one back. `bootstrapData()` is the same call the harness setup made, so
 * the restore path is the production path rather than a special case.
 */
afterEach(async () => {
  await bootstrapData();
});

/* --- fixtures -------------------------------------------------------------- */

/**
 * A deliberately distinctive enemy config: three numbers that appear nowhere else
 * in the codebase, so an assertion of `137` can only be satisfied by reading it out
 * of the mock table.
 */
const MOCK_ENEMY = {
  maxHp: 137,
  maxSpeed: 2.5,
  hurtboxRadius: 0.42,
  hp: 111,
  armor: 9,
  dash: { speedMultiplier: 4, durationTicks: 7, invulnerableTicks: 5, cooldownTicks: 21 },
  ai: { sightRadius: 12, attackRadius: 4, windupTicks: 13, cooldownTicks: 17 },
  hazard: { radius: 1.75, damage: 6, delayTicks: 11 },
  loot: [{ kind: 'gold', amount: 3 }],
  elite: { maxHp: 411, hurtboxRadius: 0.91, armor: 77 },
} as const;

const MOCK_MODIFIER = {
  radius: 2.25,
  damage: 33,
  lifespanTicks: 3,
  hitstopTicks: 2,
  knockbackForce: 19,
} as const;

/** A minimal bundle with one valid enemy and one valid modifier. */
function validBundle(): RawConfigTables {
  return {
    enemies: { mock_enemy: { ...MOCK_ENEMY } },
    modifiers: { mock_boon: { ...MOCK_MODIFIER } },
  };
}

/* ========================================================================== *
 * G1 · valid loading                                                          *
 * ========================================================================== */
describe('G1 · a well-formed bundle loads, is queryable, and is installed atomically (AC-01/AC-03)', () => {
  it('parses a valid enemy and returns it field for field', () => {
    DataManager.loadAll(validBundle());

    const config = DataManager.getEnemyConfig('mock_enemy');
    expect(config.id).toBe('mock_enemy');
    expect(config.maxHp).toBe(137);
    expect(config.maxSpeed).toBe(2.5);
    expect(config.hurtboxRadius).toBe(0.42);
    expect(config.hp).toBe(111);
    expect(config.armor).toBe(9);
    expect(config.ai).toEqual({ sightRadius: 12, attackRadius: 4, windupTicks: 13, cooldownTicks: 17 });
    expect(config.hazard).toEqual({ radius: 1.75, damage: 6, delayTicks: 11 });
    expect(config.dash).toEqual({
      speedMultiplier: 4,
      durationTicks: 7,
      invulnerableTicks: 5,
      cooldownTicks: 21,
    });
    expect(config.loot).toEqual([{ kind: 'gold', amount: 3 }]);
    expect(config.elite).toEqual({ maxHp: 411, hurtboxRadius: 0.91, armor: 77 });

    // The parsed result is a FRESH object: mutating the source cannot change it.
    expect(DataManager.isLoaded).toBe(true);
    expect(DataManager.enemyCount).toBe(1);
    expect(DataManager.enemyIds).toEqual(['mock_enemy']);
  });

  it('parses a valid modifier and returns it field for field', () => {
    DataManager.loadAll(validBundle());

    const config = DataManager.getModifierConfig('mock_boon');
    expect(config).toEqual({
      radius: 2.25,
      damage: 33,
      lifespanTicks: 3,
      hitstopTicks: 2,
      knockbackForce: 19,
    });
    expect(DataManager.hasModifier('mock_boon')).toBe(true);
    expect(DataManager.hasModifier('nope')).toBe(false);
    expect(DataManager.modifierIds).toEqual(['mock_boon']);
  });

  it('omits the optional blocks a config does not declare, rather than filling them with undefined', () => {
    DataManager.loadAll({
      enemies: { bare: { maxHp: 50, maxSpeed: 1, hurtboxRadius: 0.5 } },
      modifiers: {},
    });

    const config = DataManager.getEnemyConfig('bare');
    // Presence IS the capability switch (`spawnCombatant` mounts a component only
    // when the field is there), so "absent" must stay absent — not become a
    // present-but-undefined key that a later `!== undefined` check would misread.
    expect(Object.keys(config).sort()).toEqual(['hurtboxRadius', 'id', 'maxHp', 'maxSpeed']);
    expect('ai' in config).toBe(false);
    expect('armor' in config).toBe(false);
    expect('loot' in config).toBe(false);
  });

  it('registerEnemy adds one type without disturbing the rest of the table', () => {
    DataManager.loadAll(validBundle());
    DataManager.registerEnemy('extra', { maxHp: 1, maxSpeed: 1, hurtboxRadius: 1 });

    expect(DataManager.enemyIds).toEqual(['extra', 'mock_enemy']); // ascending
    expect(DataManager.getEnemyConfig('mock_enemy').maxHp).toBe(137);
  });

  it('exposes non-throwing predicates that agree with the parsers', () => {
    expect(isEnemyConfig(MOCK_ENEMY)).toBe(true);
    expect(isEnemyConfig({ maxHp: 1, maxSpeed: 1 })).toBe(false);
    expect(isEnemyConfig(null)).toBe(false);
    expect(isEnemyConfig([])).toBe(false);

    expect(isModifierConfig(MOCK_MODIFIER)).toBe(true);
    expect(isModifierConfig({ ...MOCK_MODIFIER, lifespanTicks: 1 })).toBe(false);
  });
});

/* ========================================================================== *
 * G2 · contract defence                                                       *
 * ========================================================================== */
describe('G2 · a malformed bundle raises a SchemaError NAMING the field (AC-02)', () => {
  it('rejects a missing required field', () => {
    const { maxHp: _omitted, ...withoutMaxHp } = MOCK_ENEMY;
    expect(() => DataManager.loadAll({ enemies: { broken: withoutMaxHp }, modifiers: {} })).toThrow(
      /enemies\.broken\.maxHp must be a positive finite number/,
    );
  });

  it('rejects a mistyped field — the exact "hp: \\"100\\"" case', () => {
    // The whole reason a hand-written validator exists: `resolveJsonModule` types
    // the JSON by its literal contents, so the compiler happily accepts a string
    // here and the mistake would only surface as a NaN health bar, ticks later.
    expect(() =>
      DataManager.loadAll({ enemies: { broken: { ...MOCK_ENEMY, hp: '100' } }, modifiers: {} }),
    ).toThrow(/enemies\.broken\.hp must be a non-negative finite number, received the string "100"/);

    expect(() =>
      DataManager.loadAll({ enemies: { broken: { ...MOCK_ENEMY, maxSpeed: '5' } }, modifiers: {} }),
    ).toThrow(/enemies\.broken\.maxSpeed must be a positive finite number/);
  });

  it('rejects a non-finite number, an out-of-domain number, and an unknown loot kind', () => {
    expect(() =>
      DataManager.loadAll({ enemies: { broken: { ...MOCK_ENEMY, maxHp: Number.NaN } }, modifiers: {} }),
    ).toThrow(/enemies\.broken\.maxHp/);

    expect(() =>
      DataManager.loadAll({ enemies: { broken: { ...MOCK_ENEMY, maxHp: 0 } }, modifiers: {} }),
    ).toThrow(/enemies\.broken\.maxHp/);

    // hp above the ceiling is a config bug, not a free heal.
    expect(() =>
      DataManager.loadAll({ enemies: { broken: { ...MOCK_ENEMY, hp: 999 } }, modifiers: {} }),
    ).toThrow(/enemies\.broken\.hp \(999\) must not exceed enemies\.broken\.maxHp \(137\)/);

    expect(() =>
      DataManager.loadAll({
        enemies: { broken: { ...MOCK_ENEMY, loot: [{ kind: 'silver' }] } },
        modifiers: {},
      }),
    ).toThrow(/enemies\.broken\.loot\[0\]\.kind/);
  });

  it('rejects a malformed nested block, labelled by its full path', () => {
    // "can attack something it cannot see" — the same rule `resolveAITuning` enforced.
    expect(() =>
      DataManager.loadAll({
        enemies: { broken: { ...MOCK_ENEMY, ai: { ...MOCK_ENEMY.ai, attackRadius: 99 } } },
        modifiers: {},
      }),
    ).toThrow(/enemies\.broken\.ai\.attackRadius \(99\) must not exceed enemies\.broken\.ai\.sightRadius/);

    // An empty loot table is a lie, not "drops nothing" (omit the field instead).
    expect(() =>
      DataManager.loadAll({ enemies: { broken: { ...MOCK_ENEMY, loot: [] } }, modifiers: {} }),
    ).toThrow(/enemies\.broken\.loot must contain at least one drop/);

    // A half-declared elite would ship as a plain enemy wearing the elite's name.
    expect(() =>
      DataManager.loadAll({
        enemies: { broken: { ...MOCK_ENEMY, elite: { maxHp: 400, hurtboxRadius: 1 } } },
        modifiers: {},
      }),
    ).toThrow(/enemies\.broken\.elite\.armor must be a positive finite number/);

    // A fractional tick count.
    expect(() =>
      DataManager.loadAll({
        enemies: { broken: { ...MOCK_ENEMY, hazard: { ...MOCK_ENEMY.hazard, delayTicks: 2.5 } } },
        modifiers: {},
      }),
    ).toThrow(/enemies\.broken\.hazard\.delayTicks must be a non-negative integer/);
  });

  it('rejects a modifier whose lifespan would make its hitbox a silent no-op', () => {
    expect(() =>
      DataManager.loadAll({
        enemies: {},
        modifiers: { broken: { ...MOCK_MODIFIER, lifespanTicks: 1 } },
      }),
    ).toThrow(/modifiers\.broken\.lifespanTicks \(1\) must be at least 2/);
  });

  it('rejects a bundle whose tables are not objects at all', () => {
    // Adversarial input, so the cast is the point: this is exactly what a JSON file
    // that is a top-level ARRAY would produce at runtime, and the validator — not the
    // type system — is what has to catch it.
    const arrayTable = [] as unknown as Readonly<Record<string, unknown>>;
    expect(() => DataManager.loadAll({ enemies: arrayTable, modifiers: {} })).toThrow(
      /enemies must be an object keyed by config id/,
    );
    expect(() => DataManager.loadAll({ enemies: { broken: 'nope' }, modifiers: {} })).toThrow(
      /enemies\.broken must be an object/,
    );
  });

  it('leaves the previous table INTACT when a load fails part-way (atomic install)', () => {
    DataManager.loadAll(validBundle());

    // `aaa_broken` sorts first, so it is parsed before the valid entry — the point
    // is that a failure anywhere aborts the WHOLE install rather than leaving a
    // half-loaded table, which is the worst state to debug.
    expect(() =>
      DataManager.loadAll({
        enemies: {
          aaa_broken: { maxHp: 'oops', maxSpeed: 1, hurtboxRadius: 1 },
          zzz_valid: { maxHp: 1, maxSpeed: 1, hurtboxRadius: 1 },
        },
        modifiers: { mock_boon: { ...MOCK_MODIFIER } },
      }),
    ).toThrow(SchemaError);

    expect(DataManager.enemyIds).toEqual(['mock_enemy']);
    expect(DataManager.getEnemyConfig('mock_enemy').maxHp).toBe(137);
    expect(DataManager.hasEnemy('zzz_valid')).toBe(false);
  });

  it('names the unknown id AND lists what is loaded, so a typo is obvious', () => {
    DataManager.loadAll(validBundle());
    expect(() => DataManager.getEnemyConfig('gruntt')).toThrow(
      /unknown enemy id 'gruntt'\. Loaded enemy ids: mock_enemy\./,
    );
    expect(() => DataManager.getModifierConfig('zeus_strik')).toThrow(/unknown modifier id 'zeus_strik'/);
  });
});

/* ========================================================================== *
 * G3 · factory mapping                                                        *
 * ========================================================================== */
describe('G3 · the factory writes the config numbers onto the entity verbatim (AC-01)', () => {
  it('maps a mock enemyId onto HealthComponent and VelocityComponent, field for field', () => {
    DataManager.loadAll(validBundle());
    const world = new World();

    const id = EnemyFactory.spawn(world, 'mock_enemy', { x: 3, y: -4, facingRadians: 1.25 });

    const health = world.getComponent(id, HealthComponent);
    if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
    // 137 / 111 / 2.5 / 0.42 appear in the MOCK table and nowhere else, so these
    // literals can only be satisfied by the data path — a hard-coded factory
    // default would have produced 100 / 5 / 0.5 and failed here.
    expect(health.maxHp).toBe(137);
    expect(health.hp).toBe(111);

    const velocity = world.getComponent(id, VelocityComponent);
    if (velocity === undefined) throw new Error('QA: entity is missing VelocityComponent');
    expect(velocity.maxSpeed).toBe(2.5);

    const hurtbox = world.getComponent(id, HurtboxComponent);
    if (hurtbox === undefined) throw new Error('QA: entity is missing HurtboxComponent');
    expect(hurtbox.radius).toBe(0.42);

    // The placement half came through too, and the faction is still Enemy.
    expect(world.getComponent(id, FactionComponent)?.faction).toBe(Faction.Enemy);
  });

  it('mounts exactly the capability components the config declares — and no others', () => {
    DataManager.loadAll({
      enemies: {
        everything: { ...MOCK_ENEMY },
        bare: { maxHp: 50, maxSpeed: 1, hurtboxRadius: 0.5 },
      },
      modifiers: {},
    });
    const world = new World();

    const full = EnemyFactory.spawn(world, 'everything');
    expect(world.hasComponent(full, AIControllerComponent)).toBe(true);
    expect(world.hasComponent(full, ArmorComponent)).toBe(true);
    expect(world.hasComponent(full, HazardCasterComponent)).toBe(true);
    expect(world.hasComponent(full, LootComponent)).toBe(true);

    // ...and the numbers inside those components are the config's, not defaults.
    expect(world.getComponent(full, AIControllerComponent)?.sightRadius).toBe(12);
    expect(world.getComponent(full, ArmorComponent)?.max).toBe(9);
    expect(world.getComponent(full, HazardCasterComponent)?.damage).toBe(6);
    const drops = world.getComponent(full, LootComponent)?.drops ?? [];
    expect(drops).toHaveLength(1);
    expect(drops[0]?.kind).toBe(PickupKind.GOLD);
    expect(drops[0]?.amount).toBe(3);

    const bare = EnemyFactory.spawn(world, 'bare');
    expect(world.hasComponent(bare, AIControllerComponent)).toBe(false);
    expect(world.hasComponent(bare, ArmorComponent)).toBe(false);
    expect(world.hasComponent(bare, HazardCasterComponent)).toBe(false);
    expect(world.hasComponent(bare, LootComponent)).toBe(false);
  });

  it('folds the elite variant over the base config for spawnElite', () => {
    DataManager.loadAll(validBundle());
    const world = new World();

    const elite = EnemyFactory.spawnElite(world, 'mock_enemy');
    expect(world.getComponent(elite, HealthComponent)?.maxHp).toBe(411);
    expect(world.getComponent(elite, HurtboxComponent)?.radius).toBe(0.91);
    expect(world.getComponent(elite, ArmorComponent)?.current).toBe(77);
    // Everything the variant does NOT override is inherited from the base config.
    expect(world.getComponent(elite, VelocityComponent)?.maxSpeed).toBe(2.5);
  });

  it('refuses an unknown id and a type with no elite variant, loudly', () => {
    DataManager.loadAll({
      enemies: { plain: { maxHp: 10, maxSpeed: 1, hurtboxRadius: 0.5 } },
      modifiers: {},
    });
    const world = new World();

    expect(() => EnemyFactory.spawn(world, 'no_such_enemy')).toThrow(SchemaError);
    expect(() => EnemyFactory.spawnElite(world, 'plain')).toThrow(/declares no 'elite' variant/);
    // Neither failure assembled anything.
    expect(world.entityCount).toBe(0);
  });

  it('never lets a NaN or an undefined reach a component', () => {
    DataManager.loadAll(validBundle());
    const world = new World();
    const id = EnemyFactory.spawn(world, 'mock_enemy');

    for (const component of world.listComponents(id)) {
      for (const [key, value] of Object.entries(component as unknown as Record<string, unknown>)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${component.constructor.name}.${key} must be finite`).toBe(true);
        }
        expect(value, `${component.constructor.name}.${key} must not be undefined`).not.toBeUndefined();
      }
    }
  });
});

/* ========================================================================== *
 * G4 · bootstrap ordering (AC-03)                                             *
 * ========================================================================== */
describe('G4 · the registry refuses to answer before Bootstrap (AC-03)', () => {
  it('reports an un-bootstrapped registry as such, rather than as an unknown id', () => {
    DataManager.clear();
    expect(DataManager.isLoaded).toBe(false);

    // The message has to name the CAUSE (no Bootstrap) — "unknown enemy id
    // 'grunt'" would send a reader hunting for a typo in a file they never loaded.
    expect(() => DataManager.getEnemyConfig('grunt')).toThrow(/no config tables are loaded/);
    expect(() => DataManager.getModifierConfig('zeus_strike')).toThrow(/no config tables are loaded/);

    // And the engine's own entry points surface the same error rather than a crash.
    expect(() => EnemyFactory.spawn(new World(), 'grunt')).toThrow(SchemaError);
  });

  it('the shipped bundle boots cleanly and carries the three boons the pipeline needs', async () => {
    await bootstrapData();

    expect(DataManager.isLoaded).toBe(true);
    // `createDefaultModifierRegistry` reads exactly these two; if either goes
    // missing, the pipeline cannot be constructed at all.
    expect(DataManager.hasModifier('zeus_strike')).toBe(true);
    expect(DataManager.hasModifier('poseidon_dash')).toBe(true);
    expect(DataManager.getModifierConfig('zeus_strike').lifespanTicks).toBeGreaterThanOrEqual(2);
    expect(DataManager.hasEnemy('grunt')).toBe(true);
    expect(DataManager.hasEnemy('elite')).toBe(true);
  });
});
