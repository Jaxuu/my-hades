/**
 * DashSystem — dash entry, cooldown and invulnerability span.
 * See specs/02_dash_and_state_spec.md §5.2.
 *
 * Pipeline position: runs AFTER MovementSystem (so this tick's displacement is
 * integrated against the state decided last tick) and BEFORE StateSystem (so the
 * dash decision and the invulnerability tag are in place before `ticksInState`
 * advances). See `pipeline.ts` for the full ordering rationale.
 *
 * All timing is measured in Ticks and driven by `ticksInState` / `cooldownRemaining`
 * on components — the system holds NO cross-tick hidden state (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import { vec2 } from '../../core/math';
import { ActionState, StateComponent } from '../components/StateComponent';
import { DashStatsComponent } from '../components/DashStatsComponent';
import { InputComponent } from '../components/InputComponent';
import { INVULNERABLE_TAG, addTag, removeTag } from '../components/TagComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';

export class DashSystem implements System {
  public readonly name = 'DashSystem';

  public update(world: World, _ctx: SystemContext): void {
    const ids = world.query(
      InputComponent,
      StateComponent,
      DashStatsComponent,
      VelocityComponent,
      TransformComponent,
    );

    for (const id of ids) {
      const input = world.getComponent(id, InputComponent);
      const state = world.getComponent(id, StateComponent);
      const dash = world.getComponent(id, DashStatsComponent);
      const velocity = world.getComponent(id, VelocityComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (
        input === undefined ||
        state === undefined ||
        dash === undefined ||
        velocity === undefined ||
        transform === undefined
      ) {
        continue;
      }

      if (state.state !== ActionState.DASHING) {
        // Not dashing: tick the cooldown down, clear any stale speed multiplier,
        // then start a dash if requested and off cooldown.
        if (dash.cooldownRemaining > 0) dash.cooldownRemaining -= 1;
        velocity.speedMultiplier = 1;
        if (input.buttonDash && dash.cooldownRemaining === 0) {
          this.startDash(world, id, state, dash, velocity, transform.facingRadians);
        }
      } else {
        // Dashing: keep the cooldown ticking, and hold the invulnerability tag for
        // the leading `invulnerableTicks` ticks of the dash only.
        if (dash.cooldownRemaining > 0) dash.cooldownRemaining -= 1;
        if (state.ticksInState < dash.invulnerableTicks) {
          addTag(world, id, INVULNERABLE_TAG);
        } else {
          removeTag(world, id, INVULNERABLE_TAG);
        }
      }
    }
  }

  /**
   * Enter DASHING: lock the current facing into the velocity direction (so input
   * can no longer steer), apply the dash speed multiplier and grant i-frames.
   */
  private startDash(
    world: World,
    id: EntityId,
    state: StateComponent,
    dash: DashStatsComponent,
    velocity: VelocityComponent,
    facingRadians: number,
  ): void {
    const lockedDir = vec2(Math.cos(facingRadians), Math.sin(facingRadians));

    state.state = ActionState.DASHING;
    state.ticksInState = 0;
    dash.cooldownRemaining = dash.cooldownTicks;
    velocity.speedMultiplier = dash.speedMultiplier;
    velocity.directionVector = lockedDir;
    velocity.currentSpeed = velocity.maxSpeed * dash.speedMultiplier;
    addTag(world, id, INVULNERABLE_TAG);
  }
}
