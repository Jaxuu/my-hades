/**
 * Damage-receiving circle. See specs/03_combat_hitbox_spec.md §3.3.
 *
 * POD component: data only, no behaviour. A hurtbox is a pure circle in world
 * space, centred on the entity's `TransformComponent`. Whether it is *currently*
 * vulnerable is NOT stored here — that is the job of the `Invulnerable` tag
 * (specs/02_dash_and_state_spec.md §3.3), which CollisionSystem consults.
 */

import { ComponentBase } from '../Component';

/** Default hurtbox radius for a humanoid-sized combatant. */
export const DEFAULT_HURTBOX_RADIUS = 0.5;

export class HurtboxComponent extends ComponentBase {
  /** Damage-receiving radius in world units. Must be > 0. */
  public radius: number;

  constructor(radius = DEFAULT_HURTBOX_RADIUS) {
    super();
    this.radius = radius;
  }
}
