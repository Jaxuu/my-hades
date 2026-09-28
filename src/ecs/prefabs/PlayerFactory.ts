/**
 * Player entity assembly. See specs/01_character_controller_spec.md §6.
 *
 * Keeps game-specific composition out of the generic `World` class, so the ECS
 * layer stays reusable and `World` stays free of game concepts.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { InputComponent } from '../components/InputComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';

/** Default player speed in world units per second. */
export const DEFAULT_PLAYER_MAX_SPEED = 5;

export interface PlayerSpawnOptions {
  readonly x?: number;
  readonly y?: number;
  readonly facingRadians?: number;
  readonly maxSpeed?: number;
}

export class PlayerFactory {
  /**
   * Create a player entity owning Transform + Velocity + Input.
   * @throws RangeError if `maxSpeed` is not a positive finite number.
   */
  public static spawn(world: World, options: PlayerSpawnOptions = {}): EntityId {
    const maxSpeed = options.maxSpeed ?? DEFAULT_PLAYER_MAX_SPEED;
    if (!Number.isFinite(maxSpeed) || maxSpeed <= 0) {
      throw new RangeError(`maxSpeed must be a positive finite number, received: ${String(maxSpeed)}`);
    }

    const entity = world.createEntity();
    world.addComponent(
      entity.id,
      new TransformComponent(options.x ?? 0, options.y ?? 0, options.facingRadians ?? 0),
    );
    world.addComponent(entity.id, new VelocityComponent(maxSpeed));
    world.addComponent(entity.id, new InputComponent());
    return entity.id;
  }
}
