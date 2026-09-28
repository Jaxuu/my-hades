/**
 * World-space position + facing. See specs/01_character_controller_spec.md §3.1.
 *
 * POD component: data only, no behaviour.
 */

import { ComponentBase } from '../Component';

export class TransformComponent extends ComponentBase {
  /** World-space X (unit-less; the render layer owns the conversion). */
  public x: number;

  /** World-space Y. */
  public y: number;

  /** Facing angle in radians. `+x` axis is `0`, `+y` is `+PI/2` (atan2 convention). */
  public facingRadians: number;

  constructor(x = 0, y = 0, facingRadians = 0) {
    super();
    this.x = x;
    this.y = y;
    this.facingRadians = facingRadians;
  }
}
