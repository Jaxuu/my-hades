/**
 * Motion state. See specs/01_character_controller_spec.md §3.2.
 *
 * POD component: data only, no behaviour. `maxSpeed` validation belongs to the
 * assembly layer (PlayerFactory), not here.
 */

import { ComponentBase } from '../Component';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';

export class VelocityComponent extends ComponentBase {
  /** Maximum speed in world units per second. Must be > 0. */
  public maxSpeed: number;

  /** Actual speed for the current tick, in world units per second. */
  public currentSpeed: number;

  /** Unit-length direction vector (magnitude 0 when idle, 1 when moving). */
  public directionVector: Vec2;

  constructor(maxSpeed = 5, currentSpeed = 0, directionVector: Vec2 = vec2(0, 0)) {
    super();
    this.maxSpeed = maxSpeed;
    this.currentSpeed = currentSpeed;
    this.directionVector = directionVector;
  }
}
