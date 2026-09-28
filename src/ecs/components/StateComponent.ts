/**
 * Action-state machine data. See specs/02_dash_and_state_spec.md §3.1.
 *
 * POD component: data only, no behaviour. State TRANSITIONS live in StateSystem;
 * `ticksInState` is the deterministic per-tick counter that drives both the dash
 * duration and the invulnerability span.
 */

import { ComponentBase } from '../Component';

export enum ActionState {
  IDLE = 'IDLE',
  MOVING = 'MOVING',
  DASHING = 'DASHING',
}

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
