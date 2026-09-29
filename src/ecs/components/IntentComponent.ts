/**
 * Per-entity LOGICAL intent. See specs/04_combat_feedback_spec.md §3.1.
 *
 * POD component: data only, no behaviour.
 *
 * `IntentComponent` is the seam between "what an entity wants to do" and "what it
 * is physically allowed to do". Every combatant owns one:
 *
 *  - For the PLAYER, PlayerControllerSystem derives the intent from the raw
 *    hardware snapshot (`PlayerInputComponent`) each tick.
 *  - For an ENEMY, an AI / script system writes the intent directly. Enemies never
 *    own `PlayerInputComponent`, which is what removed the old cross-response bug
 *    (one global input frame driving every entity — spec 03 §10 trade-off 4).
 *
 * Consumers (MovementSystem / DashSystem / CombatActionSystem / StateSystem) read
 * ONLY this component, never the hardware layer, so gameplay logic is fully
 * decoupled from the input device.
 *
 * Field semantics (IMPORTANT — the pulse/persistent split is a hard contract):
 *
 *  - `moveVector` is PERSISTENT, exactly like the old `InputComponent.moveVector`:
 *    an empty input frame leaves it untouched, so "hold the stick" is expressed by
 *    retaining the last vector.
 *  - `wantsToDash` / `wantsToAttack` / `wantsToCast` are SINGLE-TICK PULSES
 *    (rising-edge semantics). The consumer (DashSystem / CombatActionSystem) sets
 *    them back to `false` after evaluating its gate. This preserves the "holding
 *    the dash key does not auto-repeat a dash once the cooldown lapses" contract
 *    (spec 03 §4.3): if the consumer were skipped (e.g. while frozen) the pulse
 *    stays set, which is why FreezeSystem explicitly clears the whole intent while
 *    an entity is frozen (spec 04 §4.3).
 *  - `aimRadians` is PERSISTENT, like `moveVector`, and `null` means "this entity
 *    has no facing of its own". It exists so an entity can express "face THIS way
 *    without moving" through the intent seam instead of writing
 *    `TransformComponent.facingRadians` directly — which would create a second
 *    facing writer alongside MovementSystem (spec 07 §3.3).
 */

import { ComponentBase } from '../Component';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';

export class IntentComponent extends ComponentBase {
  /** Logical move intent for this tick (un-normalized; MovementSystem clamps). */
  public moveVector: Vec2;

  /** Logical dash intent for this tick (single-tick pulse; consumer clears it). */
  public wantsToDash: boolean;

  /** Logical attack intent for this tick (single-tick pulse; consumer clears it). */
  public wantsToAttack: boolean;

  /**
   * Facing intent in radians, or `null` for "no facing of my own" (M4-T01).
   *
   * MovementSystem applies it to `TransformComponent.facingRadians` ONLY while the
   * entity is not moving (a moving entity faces its movement direction, which is
   * the M1 contract). The AI uses it to lock the attack direction during a windup
   * (spec 07 AC-04); the player never sets it in this milestone, so it stays
   * `null` and the M1 behaviour is unchanged bit for bit (spec 07 C9).
   */
  public aimRadians: number | null;

  /**
   * Logical cast intent for this tick (single-tick pulse; consumer clears it).
   *
   * M7-T01 (spec 13 AC-03) adds the third action pulse alongside `wantsToDash` /
   * `wantsToAttack`, and it follows their contract verbatim: a rising-edge flag
   * copied by `PlayerControllerSystem`, read-and-cleared by `CombatActionSystem`
   * BEFORE the state gate, so a pulse the gate rejects is DROPPED rather than
   * buffered (spec 03 §4.3). `FreezeSystem` and `DeathSystem` clear it too, for the
   * same reasons they clear the other two — a frozen or dead entity must not have an
   * action waiting for it.
   */
  public wantsToCast: boolean;

  constructor(
    moveVector: Vec2 = vec2(0, 0),
    wantsToDash = false,
    wantsToAttack = false,
    aimRadians: number | null = null,
    wantsToCast = false,
  ) {
    super();
    this.moveVector = moveVector;
    this.wantsToDash = wantsToDash;
    this.wantsToAttack = wantsToAttack;
    this.aimRadians = aimRadians;
    this.wantsToCast = wantsToCast;
  }
}

