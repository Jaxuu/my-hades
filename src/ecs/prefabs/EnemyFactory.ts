/**
 * Enemy entity assembly — now fully data-driven (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §4.1 (AC-01) and §4.2 (AC-03).
 *
 * WHAT CHANGED IN M10
 * -------------------
 * Before M10 this factory carried the balance numbers itself
 * (`DEFAULT_ENEMY_MAX_SPEED`, `DEFAULT_ELITE_ARMOR = 60`, `DEFAULT_ELITE_MAX_HP =
 * 300`, …) and accepted a flat `EnemySpawnOptions` bag in which ANY of them could
 * be overridden per call site. Two problems followed:
 *
 *  1. Re-tuning an enemy type meant editing engine source, and the shipped values
 *     were scattered across the factory, the component defaults and the demo
 *     entry point — there was no single answer to "how much HP does a grunt have".
 *  2. A call site could pass `{ maxHp: Number.NaN }` and nothing rejected it; the
 *     NaN surfaced several ticks later as a health bar that never moved.
 *
 * M10 splits the two halves and gives each a home:
 *
 *  - **Type** (`enemyId`): resolved through `DataManager` from
 *    `assets/data/enemies.json`. Health, speed, body size, armour, dash tuning, AI
 *    tuning, hazard tuning and loot ALL come from there. This factory contains no
 *    balance literal at all.
 *  - **Instance** (`EnemyPlacement`): where the enemy stands and what it hunts.
 *    Genuinely per-entity, and therefore not data.
 *
 * The result is that `spawn` can no longer be handed a number, so it can no
 * longer be handed a WRONG number: every value it writes has already passed the
 * schema (AC-02) before the process started simulating.
 *
 * WHAT DID NOT CHANGE
 * -------------------
 * The component set. An enemy is still assembled by `spawnCombatant` — the same
 * single assembly point the player uses — so the two prefabs still cannot drift,
 * and every validation rule that seam applies (hp within `[0, maxHp]`, an
 * i-frame window no longer than the dash, an attack reach no longer than sight)
 * is still applied, now to values the schema has already checked once.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { DataManager } from '../../data/DataManager';
import { SchemaError } from '../../data/schemas';
import type { EnemyConfig, LootDropConfig } from '../../data/schemas';
import { Faction } from '../components/FactionComponent';
import { PickupKind } from '../components/PickupComponent';
import type { LootDropOptions } from '../components/LootComponent';
import { spawnCombatant } from './spawn-helpers';
import type { CombatantSpawnOptions, EnemyPlacement } from './spawn-helpers';

/**
 * Re-exported from `spawn-helpers.ts`, where it is declared, so the encounter
 * layer can describe a wave roster without importing this factory (spec 08 §3.2).
 * Same declaration — not a copy, so the two can never drift.
 */
export type { EnemyPlacement, EnemySpawnOptions, EnemySpawnSpec } from './spawn-helpers';

/**
 * Map one JSON loot entry onto the assembly vocabulary.
 *
 * The ONLY place the data layer's lowercase `'gold' | 'heal' | 'darkness'` meets
 * the `PickupKind` enum. Doing it here — at the single assembly seam — means the
 * engine keeps using the enum everywhere else and the JSON keeps using plain
 * strings, with exactly one translation rather than one per consumer.
 *
 * M13-T01 adds the `'darkness'` arm; the fallback stays `GOLD` so the mapping
 * remains total for any value the schema has already accepted.
 */
function toPickupKind(kind: LootDropConfig['kind']): PickupKind {
  if (kind === 'heal') return PickupKind.HEAL;
  if (kind === 'darkness') return PickupKind.DARKNESS;
  return PickupKind.GOLD;
}

function toLootOptions(drop: LootDropConfig): LootDropOptions {
  return {
    kind: toPickupKind(drop.kind),
    ...(drop.amount === undefined ? {} : { amount: drop.amount }),
    ...(drop.radius === undefined ? {} : { radius: drop.radius }),
    ...(drop.lifespanTicks === undefined ? {} : { lifespanTicks: drop.lifespanTicks }),
  };
}

/**
 * Fold an elite variant over its base config.
 *
 * A pure override of the three fields the variant declares; everything else
 * (speed, dash, AI, hazard, loot) is inherited, so an elite is the SAME enemy
 * with a bigger body, a bigger pool and standing armour — not a second config
 * that has to be kept in step by hand.
 */
function applyEliteVariant(config: EnemyConfig): EnemyConfig {
  const elite = config.elite;
  if (elite === undefined) {
    throw new SchemaError(
      `enemy '${config.id}' declares no 'elite' variant, so it cannot be spawned as an elite. Add an 'elite' block to assets/data/enemies.json, or spawn it with EnemyFactory.spawn.`,
    );
  }
  return {
    ...config,
    maxHp: elite.maxHp,
    hurtboxRadius: elite.hurtboxRadius,
    armor: elite.armor,
  };
}

/**
 * Turn a validated config + a placement into the flat options `spawnCombatant`
 * expects.
 *
 * The conditional spreads are not style: `exactOptionalPropertyTypes` forbids
 * writing an explicit `undefined` into an optional field, and — more
 * importantly — the presence/absence of `armor`, `ai` and `hazard` IS the
 * capability switch (`spawnCombatant` mounts a component only when the field is
 * present). Collapsing "absent" into "present but undefined" would mount
 * components the config never asked for.
 */
function toCombatantOptions(
  config: EnemyConfig,
  placement: EnemyPlacement,
): CombatantSpawnOptions {
  const target = placement.targetEntityId ?? null;
  return {
    ...(placement.x === undefined ? {} : { x: placement.x }),
    ...(placement.y === undefined ? {} : { y: placement.y }),
    ...(placement.facingRadians === undefined ? {} : { facingRadians: placement.facingRadians }),
    maxSpeed: config.maxSpeed,
    maxHp: config.maxHp,
    ...(config.hp === undefined ? {} : { hp: config.hp }),
    hurtboxRadius: config.hurtboxRadius,
    ...(config.armor === undefined ? {} : { armor: config.armor }),
    ...(config.dash === undefined ? {} : { dash: config.dash }),
    // `targetEntityId` is placement, not config: it is an EntityId, so it can
    // never be a property of the TYPE (see `EnemyPlacement`).
    ...(config.ai === undefined ? {} : { ai: { ...config.ai, targetEntityId: target } }),
    ...(config.hazard === undefined ? {} : { hazard: config.hazard }),
    ...(config.loot === undefined ? {} : { loot: config.loot.map(toLootOptions) }),
  };
}

export class EnemyFactory {
  /**
   * Create an enemy of type `enemyId`, placed at `placement`.
   *
   * The entity owns Transform + Velocity + Intent + State + DashStats + Tag +
   * Modifier + StatusEffect + Faction(Enemy) + Health + Hurtbox, PLUS whichever
   * opt-in capabilities its config declares: `armor` mounts an `ArmorComponent`,
   * `ai` mounts an `AIControllerComponent`, `hazard` mounts a
   * `HazardCasterComponent`, `loot` mounts a `LootComponent`. An enemy never
   * carries `PlayerInputComponent` (it is intent-driven by AI or by a script).
   *
   * @throws SchemaError when `enemyId` is not in the loaded config table — which
   *   includes the case where Bootstrap never ran (spec 16 AC-03).
   * @throws RangeError from `spawnCombatant` if a parsed value violates an
   *   assembly-level rule (these are cross-field rules the schema cannot state on
   *   its own, e.g. an i-frame window longer than the dash).
   */
  public static spawn(world: World, enemyId: string, placement: EnemyPlacement = {}): EntityId {
    const config = DataManager.getEnemyConfig(enemyId);
    return spawnCombatant(world, Faction.Enemy, toCombatantOptions(config, placement), false);
  }

  /**
   * Create the ELITE form of enemy type `enemyId` (M6-T02, spec 12 §3.2).
   *
   * Exactly the component set of {@link spawn}, with the config's `elite` block
   * folded over it: a larger HP pool, a larger hurtbox and a standing armour
   * pool. Assembly is still delegated to `spawn` — never re-listed here — so
   * "assembly lives in exactly one place" stays true and every validation rule
   * applies to an elite for free.
   *
   * @throws SchemaError when the type declares no `elite` variant. There is
   *   deliberately no fallback: silently spawning a plain enemy under the elite's
   *   name is the failure the pre-M10 `armor: 0` rejection existed to prevent.
   */
  public static spawnElite(world: World, enemyId: string, placement: EnemyPlacement = {}): EntityId {
    const config = DataManager.getEnemyConfig(enemyId);
    return spawnCombatant(world, Faction.Enemy, toCombatantOptions(applyEliteVariant(config), placement), false);
  }
}
