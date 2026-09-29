/**
 * Last-tick snapshot of a `TransformComponent`, used by the render layer to
 * interpolate between two logic ticks. See
 * specs/10_render_juice_spec.md §3 and
 * docs/architecture/ADR-002-render-interpolation.md.
 *
 * POD component: data only, no behaviour. It is written EXCLUSIVELY by
 * `TransformSnapshotSystem` (the pipeline's very first segment) and read ONLY by
 * the render layer — no gameplay system may read or write it. That keeps the
 * interpolation state an isolated, disposable mirror of `TransformComponent`:
 * dropping it would change nothing about the simulation.
 *
 * The three fields deliberately mirror the three interpolated quantities of
 * `TransformComponent` (`x` / `y` / `facingRadians`) and use the same
 * `prev`-prefix + `facingRadians` naming so the pairing is obvious at a glance.
 */

import { ComponentBase } from '../Component';

export class PreviousTransformComponent extends ComponentBase {
  /** `TransformComponent.x` as of the START of the current tick. */
  public prevX: number;

  /** `TransformComponent.y` as of the START of the current tick. */
  public prevY: number;

  /** `TransformComponent.facingRadians` as of the START of the current tick. */
  public prevFacingRadians: number;

  constructor(prevX = 0, prevY = 0, prevFacingRadians = 0) {
    super();
    this.prevX = prevX;
    this.prevY = prevY;
    this.prevFacingRadians = prevFacingRadians;
  }
}
