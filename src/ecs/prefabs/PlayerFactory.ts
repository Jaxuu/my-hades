/**
 * Player entity assembly. See specs/01_character_controller_spec.md §6,
 * specs/02_dash_and_state_spec.md §6, specs/03_combat_hitbox_spec.md §6 and
 * specs/21_hub_and_meta_progression_spec.md §4.4 (M13-T01 AC-04).
 *
 * As of M2-T01 the player is a full combatant: alongside the locomotion / dash /
 * action-state set it also owns `FactionComponent` (Player), `HealthComponent` and
 * `HurtboxComponent`, so it can deal damage AND take it. The assembly itself lives
 * in `spawn-helpers.ts` and is shared with `EnemyFactory`.
 *
 * M13-T01 adds the second entry point, {@link PlayerFactory.spawnWithMeta}, which
 * is what a RUN uses: it folds the save's unlocked upgrades into the assembly, so
 * "the player is built differently because of what they bought" happens in exactly
 * one place and needs no caller to know what an upgrade does.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import type { SaveState } from '../../core/SaveState';
import { Faction } from '../components/FactionComponent';
import {
  DEFAULT_COMBATANT_MAX_SPEED,
  spawnCombatant,
} from './spawn-helpers';
import type { CombatantSpawnOptions, DashTuningOptions } from './spawn-helpers';
import { resolveMetaBonuses } from './meta-bonuses';

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
   * This is the META-BLIND entry point: it assembles exactly what it is asked for.
   * A run should call {@link spawnWithMeta} instead — see its docstring for why.
   *
   * @throws RangeError if `maxSpeed` is not a positive finite number, or if any dash
   *   override is invalid (speed multiplier must be positive finite; tick counts must
   *   be positive integers; `invulnerableTicks` must not exceed `durationTicks`).
   */
  public static spawn(world: World, options: PlayerSpawnOptions = {}): EntityId {
    return spawnCombatant(world, Faction.Player, options, true);
  }

  /**
   * Create the player a RUN starts with: {@link spawn} plus the permanent bonuses
   * the save has unlocked (M13-T01, spec 21 AC-04).
   *
   * WHY THIS EXISTS AS A SEPARATE ENTRY POINT rather than a flag on `spawn`. A run
   * assembles its player inside `runSetup`, which the simulator hands the save to;
   * an ad-hoc fixture (a combat test, a physics test) has no save and must keep
   * assembling exactly the body it asked for. Splitting the two keeps "this call
   * knows about meta progression" a property of the CALL SITE rather than of every
   * player ever built — and it means the 100+ existing `spawn` call sites are
   * provably unaffected by this milestone.
   *
   * The bonuses are resolved from the save ONCE, here, outside any tick: ids become
   * numbers before `spawnCombatant` sees them, so nothing in the assembly can do a
   * config lookup that might throw mid-simulation (spec 21 I7).
   *
   * The save is the AUTHORITY on bonuses: an explicit `options.metaBonuses` is
   * overwritten, because "spawn with meta" cannot mean "spawn with meta, unless the
   * caller disagrees".
   *
   * @throws RangeError under the conditions listed on {@link spawn}.
   * @throws SchemaError only for a malformed meta-upgrade config table — never for
   *   an unknown id in the save (those are skipped; see `resolveMetaBonuses`).
   */
  public static spawnWithMeta(
    world: World,
    saveState: SaveState,
    options: PlayerSpawnOptions = {},
  ): EntityId {
    return spawnCombatant(
      world,
      Faction.Player,
      { ...options, metaBonuses: resolveMetaBonuses(saveState.unlockedUpgrades) },
      true,
    );
  }
}
