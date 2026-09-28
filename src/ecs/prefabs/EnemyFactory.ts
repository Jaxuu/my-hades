/**
 * Enemy entity assembly. See specs/03_combat_hitbox_spec.md §6.
 *
 * An enemy is assembled from exactly the same component set as the player
 * (`spawn-helpers.ts`); only the faction differs. That is deliberate: the dash /
 * i-frame machinery and the combat machinery are entity-agnostic, which is why the
 * same `DashSystem` that grants the player i-frames also protects a dashing enemy
 * (spec 03 §4.4 — the AC-04 acceptance tests rely on this).
 *
 * Note that enemies own an `InputComponent` because this milestone's input model is
 * a single global frame: a dash is triggered by the dash button regardless of which
 * entity owns the component. See specs/03 §10 trade-off 4.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { Faction } from '../components/FactionComponent';
import { DEFAULT_COMBATANT_MAX_SPEED, spawnCombatant } from './spawn-helpers';
import type { CombatantSpawnOptions, DashTuningOptions } from './spawn-helpers';

/** Default enemy speed in world units per second. */
export const DEFAULT_ENEMY_MAX_SPEED = DEFAULT_COMBATANT_MAX_SPEED;

/** Optional dash tuning overrides; every field defaults to the DashStatsComponent default. */
export type EnemyDashOptions = DashTuningOptions;

export interface EnemySpawnOptions extends CombatantSpawnOptions {}

export class EnemyFactory {
  /**
   * Create an enemy entity owning Transform + Velocity + Input + State + DashStats
   * + Tag + Faction(Enemy) + Health + Hurtbox.
   * @throws RangeError under the same conditions as `PlayerFactory.spawn`.
   */
  public static spawn(world: World, options: EnemySpawnOptions = {}): EntityId {
    return spawnCombatant(world, Faction.Enemy, options);
  }
}
