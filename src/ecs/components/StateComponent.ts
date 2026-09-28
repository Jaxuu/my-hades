/**
 * Action-state machine data. See specs/02_dash_and_state_spec.md §3.1 and
 * specs/03_combat_hitbox_spec.md §3.5.
 *
 * POD component: data only, no behaviour. State TRANSITIONS live in StateSystem;
 * `ticksInState` is the deterministic per-tick counter that drives the dash
 * duration, the attack commitment window and the invulnerability span.
 */

import { ComponentBase } from '../Component';

export enum ActionState {
  IDLE = 'IDLE',
  MOVING = 'MOVING',
  DASHING = 'DASHING',
  ATTACKING = 'ATTACKING',
}

/**
 * Ticks an ATTACKING entity stays committed before control returns to locomotion
 * (12 ticks @60fps = 0.2 s). Spec 03 deliberately reuses the generic action-state
 * machine instead of adding a dedicated AttackStats component this milestone; see
 * specs/03 §10 trade-off 3.
 */
export const DEFAULT_ATTACK_DURATION_TICKS = 12;

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
