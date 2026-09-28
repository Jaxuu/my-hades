/**
 * MovementSystem — Intent -> Velocity -> Transform.
 * See specs/01_character_controller_spec.md §5, specs/02_dash_and_state_spec.md §5
 * and specs/04_combat_feedback_spec.md §4.6.
 *
 * As of M2-T02 this system ONLY integrates. The former `bindInput` phase moved to
 * PlayerControllerSystem (hardware -> intent), and the direction source is now the
 * entity's `IntentComponent` rather than the raw hardware component — so gameplay
 * is decoupled from the input device and enemies (which have no hardware input)
 * move exactly like the player.
 *
 * Per-entity dispatch inside `integrate`, in priority order:
 *   1. FROZEN  (hitstop)   -> skip entirely: no displacement, no intent read.
 *   2. HITSTUN             -> forced knockback displacement: `knockback.velocity`
 *                             integrated directly, NOT clamped by maxSpeed, NOT
 *                             scaled by speedMultiplier, NOT steered by intent
 *                             (spec 04 AC-03).
 *   3. DASHING             -> direction locked by DashSystem; intent ignored.
 *   4. otherwise           -> normal locomotion from `intent.moveVector`.
 *
 * The tick length is READ FROM THE SIMULATION CLOCK (`ctx.fixedDeltaSeconds`) and
 * never hard-coded, so behaviour is identical at any fps (spec 01 §5.2 / AC-05).
 *
 * Pipeline position: AFTER FreezeSystem (so a freeze granted last tick already
 * suppressed this tick) and BEFORE DashSystem / StateSystem, so it integrates
 * against the state decided on the previous tick (spec 02 §5, hard timing contract).
 */

import { clampMagnitude } from '../../core/math';
import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { ActionState, StateComponent } from '../components/StateComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isFrozen } from '../components/FreezeComponent';
import { KnockbackComponent } from '../components/KnockbackComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';

export class MovementSystem implements System {
  public readonly name = 'MovementSystem';

  public update(world: World, ctx: SystemContext): void {
    this.integrate(world, ctx.fixedDeltaSeconds);
  }

  /**
   * Integrate. Only entities owning all three components participate; ids are
   * visited in ascending order (World.query guarantees it).
   */
  private integrate(world: World, fixedDeltaSeconds: number): void {
    for (const id of world.query(IntentComponent, VelocityComponent, TransformComponent)) {
      const intent = world.getComponent(id, IntentComponent);
      const velocity = world.getComponent(id, VelocityComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (intent === undefined || velocity === undefined || transform === undefined) continue;

      // 1. Hitstop: a frozen entity neither moves nor responds to intent.
      if (isFrozen(world, id)) continue;

      const state = world.getComponent(id, StateComponent);

      // 2. Hitstun: forced knockback displacement, ignoring maxSpeed and intent.
      if (state !== undefined && state.state === ActionState.HITSTUN) {
        const knockback = world.getComponent(id, KnockbackComponent);
        if (knockback !== undefined) {
          transform.x += knockback.velocity.x * fixedDeltaSeconds;
          transform.y += knockback.velocity.y * fixedDeltaSeconds;
        }
        velocity.currentSpeed = 0;
        continue;
      }

      // 3. Dashing: direction was locked by DashSystem onto velocity.directionVector.
      // Intent and facing are intentionally ignored (spec 02 AC-02).
      if (state !== undefined && state.state === ActionState.DASHING) {
        const direction = velocity.directionVector;
        velocity.currentSpeed = velocity.maxSpeed * velocity.speedMultiplier;
        transform.x += direction.x * velocity.currentSpeed * fixedDeltaSeconds;
        transform.y += direction.y * velocity.currentSpeed * fixedDeltaSeconds;
        continue;
      }

      // 4. Locomotion: direction comes from the logical intent.
      const direction = clampMagnitude(intent.moveVector, 1);
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
