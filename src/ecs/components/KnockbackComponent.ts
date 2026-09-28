/**
 * Forced displacement velocity during hitstun. See
 * specs/04_combat_feedback_spec.md §3.3 / §4.4.
 *
 * POD component: data only, no behaviour.
 *
 * `velocity` is a world-units-per-second displacement velocity, pointing ALONG the
 * knockback direction (i.e. away from the attacker). While the entity is in
 * `ActionState.HITSTUN`, MovementSystem integrates it directly into the
 * `TransformComponent`:
 *
 *   transform += velocity * ctx.fixedDeltaSeconds
 *
 * Crucially this bypasses `VelocityComponent` entirely: it is NOT clamped by
 * `maxSpeed`, NOT scaled by `speedMultiplier`, and NOT affected by the move intent.
 * That is what makes knockback a "forced" displacement (spec 04 AC-03).
 */

import { ComponentBase } from '../Component';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';

export class KnockbackComponent extends ComponentBase {
  /** Forced displacement velocity, world units / second, along the knockback dir. */
  public velocity: Vec2;

  constructor(velocity: Vec2 = vec2(0, 0)) {
    super();
    this.velocity = velocity;
  }
}
