/**
 * Config fixtures for the data-driven pipeline (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §6.2.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before M10 a test could spawn a bespoke enemy by passing balance numbers inline:
 *
 *     EnemyFactory.spawn(sim.world, { x: 5, maxHp: 10, hp: 10 })
 *
 * M10 removed that channel on purpose (spec 16 AC-01): `spawn` takes a TYPE id and
 * a placement, and every number comes from the config table. That is the right
 * production API, but it would force ~115 test call sites to hand-roll a JSON
 * entry each — and a test that has to restate `maxHp: 100, maxSpeed: 5,
 * hurtboxRadius: 0.5` in order to say "an enemy that dies in one hit" is a test
 * that no longer reads as its own intent.
 *
 * So the harness keeps the OLD, flat, readable call shape and does the split for
 * the test:
 *
 *  - balance fields (`maxHp`, `maxSpeed`, `hurtboxRadius`, `hp`, `armor`, `dash`,
 *    `ai` tuning, `hazard`, `loot`) become a schema-validated `EnemyConfig`,
 *    registered under a generated id;
 *  - `x` / `y` / `facingRadians` / `ai.targetEntityId` stay placement.
 *
 * The returned tuple spreads straight into the real factory:
 *
 *     EnemyFactory.spawn(sim.world, ...enemy({ x: 5, maxHp: 10, hp: 10 }))
 *
 * This is a TEST-ONLY adapter. It registers through the same `DataManager` and the
 * same validators production uses, so a fixture that is malformed fails the same
 * way a shipped config would — nothing here bypasses the schema.
 *
 * `eliteEnemy` reproduces the pre-M10 `spawnElite` defaults (300 HP / 0.8 body /
 * 60 armour) by filling the config's `elite` block, which is now where an elite is
 * described.
 */

import {
  DataManager,
  DEFAULT_AI_ATTACK_RADIUS,
  DEFAULT_AI_COOLDOWN_TICKS,
  DEFAULT_AI_SIGHT_RADIUS,
  DEFAULT_AI_WINDUP_TICKS,
  DEFAULT_DASH_COOLDOWN_TICKS,
  DEFAULT_DASH_DURATION_TICKS,
  DEFAULT_DASH_INVULNERABLE_TICKS,
  DEFAULT_DASH_SPEED_MULTIPLIER,
  DEFAULT_HAZARD_DAMAGE,
  DEFAULT_HAZARD_DELAY_TICKS,
  DEFAULT_HAZARD_RADIUS,
  PickupKind,
} from '../../src';
import type {
  AIConfig,
  DashConfig,
  EnemyPlacement,
  EnemySpawnSpec,
  EntityId,
  HazardConfig,
  LootDropConfig,
  LootDropOptions,
} from '../../src';

/** The shipped reference enemy every fixture is derived from. */
const BASE_ENEMY_ID = 'grunt';

/** Pre-M10 `spawnElite` defaults, kept here so the harness can reproduce them. */
const ELITE_MAX_HP = 300;
const ELITE_HURTBOX_RADIUS = 0.8;
const ELITE_ARMOR = 60;

/**
 * What a fixture's `ai: {}` / `hazard: {}` / `dash: {}` expands to.
 *
 * Before M10 the assembly seam (`resolveAITuning` / `resolveHazardCasting` /
 * `resolveDashTuning`) filled these gaps from the component defaults, so a test
 * could write `ai: {}` and get a fully-tuned controller. Now that every value must
 * be present in the config, the fixture does the filling — sourced from the very
 * same constants, so a fixture and the pre-M10 behaviour cannot disagree.
 */
const DEFAULT_AI_PROFILE: AIConfig = {
  sightRadius: DEFAULT_AI_SIGHT_RADIUS,
  attackRadius: DEFAULT_AI_ATTACK_RADIUS,
  windupTicks: DEFAULT_AI_WINDUP_TICKS,
  cooldownTicks: DEFAULT_AI_COOLDOWN_TICKS,
};

const DEFAULT_HAZARD_PROFILE: HazardConfig = {
  radius: DEFAULT_HAZARD_RADIUS,
  damage: DEFAULT_HAZARD_DAMAGE,
  delayTicks: DEFAULT_HAZARD_DELAY_TICKS,
};

const DEFAULT_DASH_PROFILE: DashConfig = {
  speedMultiplier: DEFAULT_DASH_SPEED_MULTIPLIER,
  durationTicks: DEFAULT_DASH_DURATION_TICKS,
  invulnerableTicks: DEFAULT_DASH_INVULNERABLE_TICKS,
  cooldownTicks: DEFAULT_DASH_COOLDOWN_TICKS,
};

/**
 * The pre-M10 flat enemy option bag.
 *
 * Kept verbatim (including `ai.targetEntityId` nested inside `ai`) so the existing
 * test bodies did not have to be rewritten field by field; the split into
 * config-vs-placement happens below, once.
 *
 * `ai` / `hazard` / `dash` are `Partial` because a test saying `ai: {}` used to
 * mean "an AI-driven enemy with the default tuning", and it still does — the
 * defaults are folded in by {@link configFrom}.
 */
export interface LegacyEnemyOptions {
  readonly x?: number;
  readonly y?: number;
  readonly facingRadians?: number;
  readonly maxSpeed?: number;
  readonly maxHp?: number;
  readonly hp?: number;
  readonly hurtboxRadius?: number;
  readonly armor?: number;
  readonly dash?: Partial<DashConfig>;
  readonly ai?: Partial<AIConfig> & { readonly targetEntityId?: EntityId | null };
  readonly hazard?: Partial<HazardConfig>;
  readonly loot?: readonly LootDropOptions[];
}

let sequence = 0;

/**
 * Canonical config -> id, so the SAME fixture resolves to the SAME id every time.
 *
 * This is not an optimisation: a wave roster lives on `EncounterStateComponent`,
 * which is part of the snapshot, so the `enemyId` strings are observable state. A
 * fixture that minted a fresh id per call would make two runs of the same script
 * produce different snapshots and break every determinism test — for a reason that
 * has nothing to do with the simulation.
 *
 * Keyed on the CONFIG only: placement (`x`/`y`/`facing`/`targetEntityId`) is
 * per-instance and may legitimately differ between two spawns of one type.
 */
const idByConfig = new Map<string, string>();

/** Register `config` under a stable id (memoised) and return that id. */
function idFor(prefix: string, config: Record<string, unknown>): string {
  const key = `${prefix}\u0000${JSON.stringify(config)}`;
  const existing = idByConfig.get(key);
  if (existing !== undefined) return existing;

  sequence += 1;
  const id = `${prefix}_${String(sequence)}`;
  DataManager.registerEnemy(id, config);
  idByConfig.set(key, id);
  return id;
}

/** The data-layer spelling of a drop: lowercase kind, no enum. */
function toJsonLoot(drop: LootDropOptions): LootDropConfig {
  return {
    kind: drop.kind === PickupKind.HEAL ? 'heal' : 'gold',
    ...(drop.amount === undefined ? {} : { amount: drop.amount }),
    ...(drop.radius === undefined ? {} : { radius: drop.radius }),
    ...(drop.lifespanTicks === undefined ? {} : { lifespanTicks: drop.lifespanTicks }),
  };
}

/** The per-instance half: position, facing and (for an AI enemy) its target. */
function placementFrom(options: LegacyEnemyOptions): EnemyPlacement {
  const targetEntityId = options.ai?.targetEntityId;
  return {
    ...(options.x === undefined ? {} : { x: options.x }),
    ...(options.y === undefined ? {} : { y: options.y }),
    ...(options.facingRadians === undefined ? {} : { facingRadians: options.facingRadians }),
    ...(targetEntityId === undefined ? {} : { targetEntityId }),
  };
}

/**
 * The per-TYPE half: the shipped base config with the caller's balance fields
 * folded over it.
 *
 * `ai.targetEntityId` is stripped — it is an `EntityId`, so it can never be part
 * of a type, and leaving it in would make the fixture fail validation (the schema
 * does not know the field).
 */
function configFrom(options: LegacyEnemyOptions): Record<string, unknown> {
  const { x: _x, y: _y, facingRadians: _facing, ai, hazard, dash, loot, ...balance } = options;
  const config: Record<string, unknown> = { ...DataManager.getEnemyConfig(BASE_ENEMY_ID), ...balance };
  if (ai !== undefined) {
    const { targetEntityId: _target, ...tuning } = ai;
    config.ai = { ...DEFAULT_AI_PROFILE, ...tuning };
  }
  if (hazard !== undefined) {
    config.hazard = { ...DEFAULT_HAZARD_PROFILE, ...hazard };
  }
  if (dash !== undefined) {
    config.dash = { ...DEFAULT_DASH_PROFILE, ...dash };
  }
  if (loot !== undefined) {
    config.loot = loot.map(toJsonLoot);
  }
  return config;
}

/**
 * Register a derived enemy type and return `[enemyId, placement]`.
 *
 * Spread it into the real factory:
 * `EnemyFactory.spawn(world, ...testEnemy({ x: 5, maxHp: 10 }))`.
 *
 * @throws SchemaError when the derived config is invalid — which is exactly how the
 *   old "assembly rejects a bad number" tests now read (the rejection simply moved
 *   from spawn time to load time, per AC-02).
 */
export function testEnemy(options: LegacyEnemyOptions = {}): readonly [string, EnemyPlacement] {
  return [idFor('test_enemy', configFrom(options)), placementFrom(options)];
}

/**
 * Register a derived ELITE type and return `[enemyId, placement]`.
 *
 * Fills the config's `elite` block with the pre-M10 defaults for anything the
 * caller did not specify, so `testElite({})` reproduces
 * `spawnElite(world, {})` exactly: 300 HP, 0.8 body, 60 armour.
 */
export function testElite(options: LegacyEnemyOptions = {}): readonly [string, EnemyPlacement] {
  return [
    idFor('test_elite', {
      ...configFrom(options),
      elite: {
        maxHp: options.maxHp ?? ELITE_MAX_HP,
        hurtboxRadius: options.hurtboxRadius ?? ELITE_HURTBOX_RADIUS,
        armor: options.armor ?? ELITE_ARMOR,
      },
    }),
    placementFrom(options),
  ];
}

/**
 * Register a derived enemy type and return a WAVE-ROSTER entry.
 *
 * The encounter layer takes specs (`{ enemyId, x, y, … }`) rather than argument
 * tuples, so a room fixture reads as data:
 * `{ delayTicks: 0, enemies: [testEnemyRef({ x: 5, maxHp: 100 })] }`.
 */
export function testEnemyRef(options: LegacyEnemyOptions = {}): EnemySpawnSpec {
  const [enemyId, placement] = testEnemy(options);
  return { enemyId, ...placement };
}
