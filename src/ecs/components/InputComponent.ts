/**
 * Per-entity input state. See specs/01_character_controller_spec.md §3.3.
 *
 * POD component: data only, no behaviour.
 *
 * `moveVector` is PERSISTENT state, not a per-tick scratch buffer: once a `move`
 * event is bound, the vector is retained on subsequent ticks until a new `move`
 * overwrites it. This is how "hold the stick right" is expressed in a
 * tick-aligned event model (see specs/01 §2 "持续输入").
 *
 * `buttonDash` is likewise PERSISTENT and derived by MovementSystem from
 * `keysHeld`: it stays pressed across empty ticks until the dash key is released
 * (specs/02_dash_and_state_spec.md §3.4).
 */

import { ComponentBase } from '../Component';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';

/** Canonical key name for the dash button (specs/02_dash_and_state_spec.md §3.4). */
export const DASH_KEY = 'dash';

export class InputComponent extends ComponentBase {
  /** Raw, un-normalized virtual-stick vector for the current tick. */
  public moveVector: Vec2;

  /** Keys currently held, kept in ascending order for determinism. */
  public keysHeld: string[];

  /** Whether the dash button is held this tick (derived from `keysHeld`). */
  public buttonDash: boolean;

  constructor(moveVector: Vec2 = vec2(0, 0), keysHeld: string[] = [], buttonDash = false) {
    super();
    this.moveVector = moveVector;
    this.keysHeld = keysHeld;
    this.buttonDash = buttonDash;
  }
}
