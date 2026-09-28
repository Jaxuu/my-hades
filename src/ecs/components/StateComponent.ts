/**
 * Action-state machine data. See specs/02_dash_and_state_spec.md §3.1,
 * specs/03_combat_hitbox_spec.md §3.5 and specs/04_combat_feedback_spec.md §3.5.
 *
 * POD component: data only, no behaviour. State TRANSITIONS live in StateSystem;
 * `ticksInState` is the deterministic per-tick counter that drives the dash
 * duration, the attack commitment window, the hitstun span and the
 * invulnerability span.
 */

import { ComponentBase } from '../Component';

export enum ActionState {
  IDLE = 'IDLE',
  MOVING = 'MOVING',
  DASHING = 'DASHING',
  ATTACKING = 'ATTACKING',
  HITSTUN = 'HITSTUN',
}

/**
 * Ticks an ATTACKING entity stays committed before control returns to locomotion
 * (12 ticks @60fps = 0.2 s). Spec 03 deliberately reuses the generic action-state
 * machine instead of adding a dedicated AttackStats component this milestone; see
 * specs/03 §10 trade-off 3.
 */
export const DEFAULT_ATTACK_DURATION_TICKS = 12;

/**
 * Ticks a HITSTUN entity stays stunned before control returns to locomotion
 * (8 ticks @60fps ≈ 0.133 s). Like the attack window, this milestone keeps the
 * duration as a MODULE CONSTANT rather than a component field, following the
 * precedent of specs/03 §10 trade-off 3; a future `HitstunStatsComponent` can
 * move it onto the entity when per-attack tuning is needed (spec 04 §10).
 */
export const DEFAULT_HITSTUN_TICKS = 8;

export class StateComponent extends ComponentBase {
  /** Current action state. */
  public state: ActionState;

  /** Ticks spent in the current state (reset to 0 on every transition). */
  public ticksInState: number;

  constructor(state: ActionState = ActionState.IDLE, ticksInState = 0) {
    super();
    this.state = state;
    this.ticksInState = ticksInState;
  }
}
