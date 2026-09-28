/**
 * MovementSystem — Input -> Velocity -> Transform.
 * See specs/01_character_controller_spec.md §5 and specs/02_dash_and_state_spec.md §5.
 *
 * Runs two fixed phases per tick:
 *   1. bindInput  : translate this tick's input frame into per-entity InputComponent state
 *   2. integrate  : integrate position against ctx.fixedDeltaSeconds
 *
 * The tick length is READ FROM THE SIMULATION CLOCK (`ctx.fixedDeltaSeconds`) and
 * never hard-coded, so behaviour is identical at any fps (spec 01 §5.2 / AC-05).
 *
 * Dash handling (spec 02 AC-02): while an entity is in ActionState.DASHING the
 * integration uses the direction LOCKED on VelocityComponent by DashSystem and the
 * dash-scaled speed; `input.moveVector` is deliberately NOT consulted and facing is
 * NOT recomputed, so changing the stick mid-dash cannot steer the player.
 *
 * Pipeline position: MovementSystem runs BEFORE DashSystem and StateSystem, so it
 * integrates against the state decided on the previous tick — a dash started this
 * tick therefore begins displacing on the next tick (spec 02 §5, hard timing contract).
 */

import { clampMagnitude } from '../../core/math';
import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { ActionState, StateComponent } from '../components/StateComponent';
import { DASH_KEY, InputComponent } from '../components/InputComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';

export class MovementSystem implements System {
  public readonly name = 'MovementSystem';

  public update(world: World, ctx: SystemContext): void {
    this.bindInput(world, ctx);
    this.integrate(world, ctx.fixedDeltaSeconds);
  }

  /**
   * Phase 1 — bind the tick's input frame onto InputComponent.
   * `move` overwrites the stick vector; `keyDown`/`keyUp` maintain the held-key set.
   *
   * When the tick has no events we return early and PRESERVE the previous
   * `buttonDash`, so a held dash key keeps reading as pressed on empty ticks.
   */
  private bindInput(world: World, ctx: SystemContext): void {
    if (ctx.input.length === 0) return;

    for (const id of world.query(InputComponent)) {
      const input = world.getComponent(id, InputComponent);
      if (input === undefined) continue;

      let keysChanged = false;
      for (const event of ctx.input) {
        switch (event.kind) {
          case 'move':
            input.moveVector = event.vector;
            break;
          case 'keyDown':
            if (!input.keysHeld.includes(event.key)) {
              input.keysHeld.push(event.key);
              keysChanged = true;
            }
            break;
          case 'keyUp': {
            const at = input.keysHeld.indexOf(event.key);
            if (at !== -1) {
              input.keysHeld.splice(at, 1);
              keysChanged = true;
            }
            break;
          }
        }
      }
      // Keep the held-key set ordered so snapshots stay deterministic.
      if (keysChanged) input.keysHeld.sort();
      // Derive the dash button edge from the held-key set (spec 02 §3.4).
      input.buttonDash = input.keysHeld.includes(DASH_KEY);
    }
  }

  /**
   * Phase 2 — integrate. Only entities owning all three components participate;
   * ids are visited in ascending order (World.query guarantees it).
   */
  private integrate(world: World, fixedDeltaSeconds: number): void {
    for (const id of world.query(InputComponent, VelocityComponent, TransformComponent)) {
      const input = world.getComponent(id, InputComponent);
      const velocity = world.getComponent(id, VelocityComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (input === undefined || velocity === undefined || transform === undefined) continue;

      const state = world.getComponent(id, StateComponent);
      const dashing = state !== undefined && state.state === ActionState.DASHING;

      if (dashing) {
        // Direction was locked by DashSystem onto velocity.directionVector.
        // Input and facing are intentionally ignored (spec 02 AC-02).
        const direction = velocity.directionVector;
        velocity.currentSpeed = velocity.maxSpeed * velocity.speedMultiplier;
        transform.x += direction.x * velocity.currentSpeed * fixedDeltaSeconds;
        transform.y += direction.y * velocity.currentSpeed * fixedDeltaSeconds;
        continue;
      }

      const direction = clampMagnitude(input.moveVector, 1);
      const moving = direction.x !== 0 || direction.y !== 0;

      velocity.directionVector = direction;
      velocity.currentSpeed = moving ? velocity.maxSpeed : 0;

      if (!moving) continue;

      transform.x += direction.x * velocity.currentSpeed * fixedDeltaSeconds;
      transform.y += direction.y * velocity.currentSpeed * fixedDeltaSeconds;
      transform.facingRadians = Math.atan2(direction.y, direction.x);
    }
  }
}
