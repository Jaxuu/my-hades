/**
 * StateSystem — the ActionState machine.
 * See specs/02_dash_and_state_spec.md §5.3 and specs/04_combat_feedback_spec.md §4.7.
 *
 * Pipeline position: runs LAST of the movement trio, after MovementSystem and
 * DashSystem, so it advances `ticksInState` only once the dash entry /
 * invulnerability decisions for this tick are already applied. This keeps the dash
 * duration (15 ticks) and the invulnerability span (leading 12 ticks) aligned with
 * the movement ticks.
 *
 * `moving` is derived from the entity's `IntentComponent.moveVector` (not the
 * hardware component), so enemies with no input device still transition
 * IDLE <-> MOVING correctly.
 *
 * Frozen entities are skipped entirely (spec 04 §4.7): hitstop pauses the state
 * machine, so `ticksInState` is preserved across the freeze and RESUMES from where
 * it stopped (spec 04 AC-02).
 *
 * DEAD entities are skipped before even that (M4-T02, spec 08 §4.2): a corpse's
 * state machine is over. Its `ticksInState` stops where it stood — including the
 * `HITSTUN` it died in — which is exactly what "inert" means, and why a test must
 * never use the action state as evidence that a corpse was *not* hit (spec 08 §6.4).
 *
 * Holds NO cross-tick hidden state: the machine is fully described by
 * `StateComponent.state` / `StateComponent.ticksInState` (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import {
  ActionState,
  DEFAULT_ATTACK_DURATION_TICKS,
  DEFAULT_HITSTUN_TICKS,
  StateComponent,
} from '../components/StateComponent';
import { DEFAULT_DASH_DURATION_TICKS, DashStatsComponent } from '../components/DashStatsComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isFrozen } from '../components/FreezeComponent';
import { isDead } from '../components/DeadTagComponent';

export class StateSystem implements System {
  public readonly name = 'StateSystem';

  public update(world: World, _ctx: SystemContext): void {
    for (const id of world.query(StateComponent)) {
      // Death first: the state machine of a corpse is finished (spec 08 §4.2).
      if (isDead(world, id)) continue;
      if (isFrozen(world, id)) continue;

      const state = world.getComponent(id, StateComponent);
      if (state === undefined) continue;
      const intent = world.getComponent(id, IntentComponent);
      const moving = intent !== undefined && (intent.moveVector.x !== 0 || intent.moveVector.y !== 0);

      // HITSTUN is the highest-priority interrupt: it pre-empts DASHING and
      // ATTACKING and holds for DEFAULT_HITSTUN_TICKS before control returns to
      // locomotion. It is entered by CollisionSystem, not here.
      if (state.state === ActionState.HITSTUN) {
        if (state.ticksInState >= DEFAULT_HITSTUN_TICKS) {
          state.state = moving ? ActionState.MOVING : ActionState.IDLE;
          state.ticksInState = 0;
        } else {
          state.ticksInState += 1;
        }
        continue;
      }

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

      if (state.state === ActionState.ATTACKING) {
        // Attack commitment window (spec 03 §5.4): the entity stays ATTACKING for
        // DEFAULT_ATTACK_DURATION_TICKS, then hands control back to locomotion.
        // CombatActionSystem cannot re-enter ATTACKING while this state is held,
        // so one attack press yields exactly one attack.
        if (state.ticksInState >= DEFAULT_ATTACK_DURATION_TICKS) {
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
