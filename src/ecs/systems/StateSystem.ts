/**
 * StateSystem — the ActionState machine.
 * See specs/02_dash_and_state_spec.md §5.3.
 *
 * Pipeline position: runs LAST, after MovementSystem and DashSystem, so it
 * advances `ticksInState` only once the dash entry / invulnerability decisions
 * for this tick are already applied. This keeps the dash duration (15 ticks) and
 * the invulnerability span (leading 12 ticks) aligned with the movement ticks.
 *
 * Holds NO cross-tick hidden state: the machine is fully described by
 * `StateComponent.state` / `StateComponent.ticksInState` (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { ActionState, StateComponent } from '../components/StateComponent';
import { DEFAULT_DASH_DURATION_TICKS, DashStatsComponent } from '../components/DashStatsComponent';
import { InputComponent } from '../components/InputComponent';

export class StateSystem implements System {
  public readonly name = 'StateSystem';

  public update(world: World, _ctx: SystemContext): void {
    for (const id of world.query(StateComponent)) {
      const state = world.getComponent(id, StateComponent);
      if (state === undefined) continue;
      const input = world.getComponent(id, InputComponent);
      const moving = input !== undefined && (input.moveVector.x !== 0 || input.moveVector.y !== 0);

      if (state.state === ActionState.DASHING) {
        const dash = world.getComponent(id, DashStatsComponent);
        const durationTicks = dash?.durationTicks ?? DEFAULT_DASH_DURATION_TICKS;
        if (state.ticksInState >= durationTicks) {
          // Dash finished: hand control back to locomotion (still MOVING if the
          // stick is held, otherwise IDLE) and reset the tick counter.
          state.state = moving ? ActionState.MOVING : ActionState.IDLE;
          state.ticksInState = 0;
        } else {
          state.ticksInState += 1;
        }
        continue;
      }

      const next = moving ? ActionState.MOVING : ActionState.IDLE;
      if (next === state.state) {
        state.ticksInState += 1;
      } else {
        state.state = next;
        state.ticksInState = 0;
      }
    }
  }
}
