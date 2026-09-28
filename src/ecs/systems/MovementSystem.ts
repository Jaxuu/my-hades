/**
 * MovementSystem — Input -> Velocity -> Transform.
 * See specs/01_character_controller_spec.md §5.
 *
 * Runs two fixed phases per tick:
 *   1. bindInput  : translate this tick's input frame into per-entity InputComponent state
 *   2. integrate  : integrate position against ctx.fixedDeltaSeconds
 *
 * The tick length is READ FROM THE SIMULATION CLOCK (`ctx.fixedDeltaSeconds`) and
 * never hard-coded, so behaviour is identical at any fps (spec 01 §5.2 / AC-05).
 */

import { normalizeVec2 } from '../../core/math';
import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { InputComponent } from '../components/InputComponent';
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

      const direction = normalizeVec2(input.moveVector);
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
