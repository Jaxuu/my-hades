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
}
