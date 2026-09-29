/**
 * Per-player HARDWARE input state. See specs/01_character_controller_spec.md §3.3,
 * specs/03_combat_hitbox_spec.md §3.6 and specs/04_combat_feedback_spec.md §3.
 *
 * POD component: data only, no behaviour.
 *
 * This component models the RAW hardware layer (a keyboard / gamepad snapshot) and
 * is owned ONLY by the player entity. Enemies never carry it: their actions are
 * driven by `IntentComponent`, which PlayerControllerSystem derives from this
 * component for the player and which AI / scripts write directly for enemies
 * (M2-T02 decoupled intent from hardware; see spec 04 §10 trade-off 1).
 *
 * `moveVector` is PERSISTENT state, not a per-tick scratch buffer: once a `move`
 * event is bound, the vector is retained on subsequent ticks until a new `move`
 * overwrites it. This is how "hold the stick right" is expressed in a
 * tick-aligned event model (see specs/01 §2 "持续输入").
 *
 * Buttons come in two flavours, and the distinction matters:
 *
 *  - **level** (`buttonDash` / `buttonAttack` / `buttonCast`): PERSISTENT, derived
 *    by PlayerControllerSystem from `keysHeld`. It stays pressed across empty ticks
 *    until the key is released.
 *  - **edge** (`buttonDashJustPressed` / `buttonAttackJustPressed` /
 *    `buttonCastJustPressed`): true for exactly ONE tick — the tick on which the key
 *    transitions from released to held. Actions that must not repeat while the key
 *    is held (dash, attack, cast) read the edge flags only. See specs/03 §3.6 /
 *    §4.3.
 */

import { ComponentBase } from '../Component';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';

/** Canonical key name for the dash button (specs/02_dash_and_state_spec.md §3.4). */
export const DASH_KEY = 'dash';

/** Canonical key name for the attack button (specs/03_combat_hitbox_spec.md §3.6). */
export const ATTACK_KEY = 'attack';

/** Canonical key name for the cast button (specs/13_arena_and_projectiles_spec.md §3.5). */
export const CAST_KEY = 'cast';

export class PlayerInputComponent extends ComponentBase {
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

  /** Whether the cast button is held this tick (level; derived from `keysHeld`). */
  public buttonCast: boolean;

  /** Whether the cast button became held on THIS tick (rising edge, one tick wide). */
  public buttonCastJustPressed: boolean;

  constructor(
    moveVector: Vec2 = vec2(0, 0),
    keysHeld: string[] = [],
    buttonDash = false,
    buttonDashJustPressed = false,
    buttonAttack = false,
    buttonAttackJustPressed = false,
    buttonCast = false,
    buttonCastJustPressed = false,
  ) {
    super();
    this.moveVector = moveVector;
    this.keysHeld = keysHeld;
    this.buttonDash = buttonDash;
    this.buttonDashJustPressed = buttonDashJustPressed;
    this.buttonAttack = buttonAttack;
    this.buttonAttackJustPressed = buttonAttackJustPressed;
    this.buttonCast = buttonCast;
    this.buttonCastJustPressed = buttonCastJustPressed;
  }
}
