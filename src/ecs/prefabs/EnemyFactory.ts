/**
 * Enemy entity assembly. See specs/03_combat_hitbox_spec.md §6 and
 * specs/04_combat_feedback_spec.md §6.
 *
 * An enemy is assembled from exactly the same component set as the player
 * (`spawn-helpers.ts`); only the faction differs. That is deliberate: the dash /
 * i-frame machinery and the combat machinery are entity-agnostic, which is why the
 * same `DashSystem` that grants the player i-frames also protects a dashing enemy
 * (spec 03 §4.4 — the AC-04 acceptance tests rely on this).
 *
 * An enemy owns an `IntentComponent` but NOT a `PlayerInputComponent`: its intent
 * is written directly by AI / scripts (or by the test harness), which is exactly
 * how the old "enemies must carry an InputComponent to be able to dash" limitation
 * was root-fixed. Intent and hardware input are now fully decoupled — spec 03 §10
 * trade-off 4 is resolved by M2-T02 (spec 04 §10).
 *
 * M4-T01 adds the AI writer as an OPT-IN: pass `ai` in the spawn options and an
 * `AIControllerComponent` is mounted, making the enemy drive itself through the
 * FSM (spec 07). Omit it and the enemy behaves exactly as it did before M4 —
 * script-driven through its `IntentComponent`.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { Faction } from '../components/FactionComponent';
import { DEFAULT_COMBATANT_MAX_SPEED, spawnCombatant } from './spawn-helpers';
import type { DashTuningOptions, EnemySpawnOptions } from './spawn-helpers';

/** Default enemy speed in world units per second. */
export const DEFAULT_ENEMY_MAX_SPEED = DEFAULT_COMBATANT_MAX_SPEED;

/**
 * Default armor pool of an ELITE (M6-T02, spec 12 §3.2).
 *
 * A fixed value rather than a fraction of HP on purpose: a fixed pool means a
 * high-damage or multi-hit attack breaks it quickly, so every fight is guaranteed
 * to reach a "staggerable" phase instead of degenerating into a standing trade.
 */
export const DEFAULT_ELITE_ARMOR = 60;

/** Default hit-point ceiling of an elite — 3x a regular enemy's `100`. */
export const DEFAULT_ELITE_MAX_HP = 300;

/**
 * Default hurtbox radius of an elite (vs `0.5` for a regular enemy). This is what
 * "bigger body" means in this engine: the elite is easier to hit, which is the
 * price it pays for being harder to stagger.
 */
export const DEFAULT_ELITE_HURTBOX_RADIUS = 0.8;

/** Optional dash tuning overrides; every field defaults to the DashStatsComponent default. */
export type EnemyDashOptions = DashTuningOptions;

/**
 * An enemy spec. Re-exported from `spawn-helpers.ts`, where it is declared, so the
 * encounter layer can describe a wave roster without importing this factory
 * (spec 08 §3.2). Same declaration — not a copy, so the two can never drift.
 */
export type { EnemySpawnOptions };

export class EnemyFactory {
  /**
   * Create an enemy entity owning Transform + Velocity + Intent + State + DashStats
   * + Tag + Faction(Enemy) + Health + Hurtbox. The enemy does NOT own
   * `PlayerInputComponent`; drive it through its `IntentComponent`.
   * @throws RangeError under the same conditions as `PlayerFactory.spawn`.
   */
  public static spawn(world: World, options: EnemySpawnOptions = {}): EntityId {
    return spawnCombatant(world, Faction.Enemy, options, false);
  }

  /**
   * Create an ELITE enemy (M6-T02, spec 12 §3.2): exactly the component set of
   * {@link spawn}, PLUS a standing `ArmorComponent`, a LARGER hurtbox and a LARGER
   * HP pool.
   *
   * An elite is assembled by FILLING DEFAULTS and delegating to `spawn` — never by
   * re-listing components here. That keeps "assembly lives in exactly one place"
   * true (the player and enemy prefabs cannot drift), and it means every validation
   * rule `spawnCombatant` applies is applied to an elite too, for free.
   *
   * Every default is overridable through `options`, so a caller can tune a specific
   * elite (a boss with `armor: 200`, a light elite with a normal-sized body) without
   * this factory growing a second configuration surface. Passing `armor` explicitly
   * replaces the elite default; there is deliberately no way to spawn an elite with
   * NO armor — that is just `spawn`.
   *
   * @throws RangeError under the same conditions as {@link spawn} (including a
   *   non-positive-finite `armor`).
   */
  public static spawnElite(world: World, options: EnemySpawnOptions = {}): EntityId {
    const maxHp = options.maxHp ?? DEFAULT_ELITE_MAX_HP;
    return EnemyFactory.spawn(world, {
      ...options,
      maxHp,
      hp: options.hp ?? maxHp,
      hurtboxRadius: options.hurtboxRadius ?? DEFAULT_ELITE_HURTBOX_RADIUS,
      armor: options.armor ?? DEFAULT_ELITE_ARMOR,
    });
  }
}
