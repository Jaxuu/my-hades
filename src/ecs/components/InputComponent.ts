/**
 * Per-entity input state. See specs/01_character_controller_spec.md §3.3 and
 * specs/03_combat_hitbox_spec.md §3.6.
 *
 * POD component: data only, no behaviour.
 *
 * `moveVector` is PERSISTENT state, not a per-tick scratch buffer: once a `move`
 * event is bound, the vector is retained on subsequent ticks until a new `move`
 * overwrites it. This is how "hold the stick right" is expressed in a
 * tick-aligned event model (see specs/01 §2 "持续输入").
 *
 * Buttons come in two flavours, and the distinction matters:
 *
 *  - **level** (`buttonDash` / `buttonAttack`): PERSISTENT, derived by
 *    MovementSystem from `keysHeld`. It stays pressed across empty ticks until
 *    the key is released.
 *  - **edge** (`buttonDashJustPressed` / `buttonAttackJustPressed`): true for
 *    exactly ONE tick — the tick on which the key transitions from released to
 *    held. Actions that must not repeat while the key is held (dash, attack)
 *    read the edge flags only. See specs/03 §3.6 / §4.3.
 */

import { ComponentBase } from '../Component';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';

/** Canonical key name for the dash button (specs/02_dash_and_state_spec.md §3.4). */
export const DASH_KEY = 'dash';

/** Canonical key name for the attack button (specs/03_combat_hitbox_spec.md §3.6). */
export const ATTACK_KEY = 'attack';

export class InputComponent extends ComponentBase {
  /** Raw, un-normalized virtual-stick vector for the current tick. */
  public moveVector: Vec2;

  /** Keys currently held, kept in ascending order for determinism. */
  public keysHeld: string[];

  /** Whether the dash button is held this tick (level; derived from `keysHeld`). */
  public buttonDash: boolean;

  /** Whether the dash button became held on THIS tick (rising edge, one tick wide). */
  public buttonDashJustPressed: boolean;

  /** Whether the attack button is held this tick (level; derived from `keysHeld`). */
  public buttonAttack: boolean;

  /** Whether the attack button became held on THIS tick (rising edge, one tick wide). */
  public buttonAttackJustPressed: boolean;

  constructor(
    moveVector: Vec2 = vec2(0, 0),
    keysHeld: string[] = [],
    buttonDash = false,
    buttonDashJustPressed = false,
    buttonAttack = false,
    buttonAttackJustPressed = false,
  ) {
    super();
    this.moveVector = moveVector;
    this.keysHeld = keysHeld;
    this.buttonDash = buttonDash;
    this.buttonDashJustPressed = buttonDashJustPressed;
    this.buttonAttack = buttonAttack;
    this.buttonAttackJustPressed = buttonAttackJustPressed;
  }
}
