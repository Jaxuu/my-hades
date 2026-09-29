/**
 * Hazard-caster capability (M8-T01).
 * See specs/14_aoe_and_run_lifecycle_spec.md §3.2 / §4.2.
 *
 * POD component: data only, no behaviour. It is the tuning a combatant needs in
 * order to PLANT a hazard, exactly the way `AIControllerComponent` is the tuning
 * it needs in order to chase and swing.
 *
 * OPT-IN, and the shape is deliberate: `spawnCombatant` mounts it ONLY when the
 * caller passes `hazard` in the spawn options (spec 14 §3.2). Omit it and no
 * component is mounted at all, so every pre-M8 enemy is assembled exactly as
 * before — the same capability-switch discipline `ai` (spec 07 §3.5) and `armor`
 * (spec 12 §3.2) already established, and the reason the player and enemy
 * prefabs still cannot drift apart.
 *
 * The component carries NO cooldown and NO target. Both would be second clocks /
 * second sources of truth for facts the engine already owns:
 *
 *   - the RATE at which hazards are planted is the enemy's attack cycle
 *     (`windupTicks + cooldownTicks + 1`, spec 07 §6.1), because the pulse is
 *     raised on the tick a windup ends. A separate cooldown would have to be kept
 *     in sync with that cycle for no behavioural gain.
 *   - the TARGET is `AIControllerComponent.targetEntityId`, which is the engine's
 *     only notion of "what an enemy is aiming at" (spec 14 §4.2).
 */

import { ComponentBase } from '../Component';
import {
  DEFAULT_HAZARD_DAMAGE,
  DEFAULT_HAZARD_DELAY_TICKS,
  DEFAULT_HAZARD_RADIUS,
} from './HazardComponent';

export class HazardCasterComponent extends ComponentBase {
  /** Blast radius of every hazard this entity plants, in world units. Must be > 0. */
  public radius: number;

  /** Blast damage of every hazard this entity plants. Must be >= 0 and finite. */
  public damage: number;

  /** Telegraph length of every hazard this entity plants, in ticks. Must be >= 0. */
  public delayTicks: number;

  constructor(
    radius = DEFAULT_HAZARD_RADIUS,
    damage = DEFAULT_HAZARD_DAMAGE,
    delayTicks = DEFAULT_HAZARD_DELAY_TICKS,
  ) {
    super();
    this.radius = radius;
    this.damage = damage;
    this.delayTicks = delayTicks;
  }
}
