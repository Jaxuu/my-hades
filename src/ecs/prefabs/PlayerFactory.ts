/**
 * Player entity assembly. See specs/01_character_controller_spec.md §6,
 * specs/02_dash_and_state_spec.md §6 and specs/03_combat_hitbox_spec.md §6.
 *
 * As of M2-T01 the player is a full combatant: alongside the locomotion / dash /
 * action-state set it also owns `FactionComponent` (Player), `HealthComponent` and
 * `HurtboxComponent`, so it can deal damage AND take it. The assembly itself lives
 * in `spawn-helpers.ts` and is shared with `EnemyFactory`.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { Faction } from '../components/FactionComponent';
import {
  DEFAULT_COMBATANT_MAX_SPEED,
  spawnCombatant,
} from './spawn-helpers';
import type { CombatantSpawnOptions, DashTuningOptions } from './spawn-helpers';

/** Default player speed in world units per second. */
export const DEFAULT_PLAYER_MAX_SPEED = DEFAULT_COMBATANT_MAX_SPEED;

/** Optional dash tuning overrides; every field defaults to the DashStatsComponent default. */
export type PlayerDashOptions = DashTuningOptions;

export interface PlayerSpawnOptions extends CombatantSpawnOptions {}

export class PlayerFactory {
  /**
   * Create a player entity owning Transform + Velocity + Intent + PlayerInput +
   * State + DashStats + Tag + Faction(Player) + Health + Hurtbox.
   *
   * The player is the ONLY combatant that carries the hardware input component
   * (`hardwareInput = true`); its intent is derived from the device by
   * PlayerControllerSystem.
   *
   * @throws RangeError if `maxSpeed` is not a positive finite number, or if any dash
   *   override is invalid (speed multiplier must be positive finite; tick counts must
   *   be positive integers; `invulnerableTicks` must not exceed `durationTicks`).
   */
  public static spawn(world: World, options: PlayerSpawnOptions = {}): EntityId {
    return spawnCombatant(world, Faction.Player, options, true);
  }
}
