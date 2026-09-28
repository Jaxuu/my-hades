/**
 * Player entity assembly. See specs/01_character_controller_spec.md §6 and
 * specs/02_dash_and_state_spec.md §6.
 *
 * Keeps game-specific composition out of the generic `World` class, so the ECS
 * layer stays reusable and `World` stays free of game concepts.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { InputComponent } from '../components/InputComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';
import { StateComponent } from '../components/StateComponent';
import {
  DEFAULT_DASH_COOLDOWN_TICKS,
  DEFAULT_DASH_DURATION_TICKS,
  DEFAULT_DASH_INVULNERABLE_TICKS,
  DEFAULT_DASH_SPEED_MULTIPLIER,
  DashStatsComponent,
} from '../components/DashStatsComponent';
import { TagComponent } from '../components/TagComponent';

/** Default player speed in world units per second. */
export const DEFAULT_PLAYER_MAX_SPEED = 5;

/** Optional dash tuning overrides; every field defaults to the DashStatsComponent default. */
export interface PlayerDashOptions {
  readonly speedMultiplier?: number;
  readonly durationTicks?: number;
  readonly invulnerableTicks?: number;
  readonly cooldownTicks?: number;
}

export interface PlayerSpawnOptions {
  readonly x?: number;
  readonly y?: number;
  readonly facingRadians?: number;
  readonly maxSpeed?: number;
  readonly dash?: PlayerDashOptions;
}

export class PlayerFactory {
  /**
   * Create a player entity owning Transform + Velocity + Input + State + DashStats + Tag.
   * @throws RangeError if `maxSpeed` is not a positive finite number, or if any dash
   *   override is invalid (speed multiplier must be positive finite; tick counts must
   *   be positive integers; `invulnerableTicks` must not exceed `durationTicks`).
   */
  public static spawn(world: World, options: PlayerSpawnOptions = {}): EntityId {
    const maxSpeed = options.maxSpeed ?? DEFAULT_PLAYER_MAX_SPEED;
    if (!Number.isFinite(maxSpeed) || maxSpeed <= 0) {
      throw new RangeError(`maxSpeed must be a positive finite number, received: ${String(maxSpeed)}`);
    }

    const speedMultiplier = options.dash?.speedMultiplier ?? DEFAULT_DASH_SPEED_MULTIPLIER;
    const durationTicks = options.dash?.durationTicks ?? DEFAULT_DASH_DURATION_TICKS;
    const invulnerableTicks = options.dash?.invulnerableTicks ?? DEFAULT_DASH_INVULNERABLE_TICKS;
    const cooldownTicks = options.dash?.cooldownTicks ?? DEFAULT_DASH_COOLDOWN_TICKS;

    if (!Number.isFinite(speedMultiplier) || speedMultiplier <= 0) {
      throw new RangeError(
        `dash.speedMultiplier must be a positive finite number, received: ${String(speedMultiplier)}`,
      );
    }
    if (!Number.isInteger(durationTicks) || durationTicks <= 0) {
      throw new RangeError(
        `dash.durationTicks must be a positive integer, received: ${String(durationTicks)}`,
      );
    }
    if (!Number.isInteger(invulnerableTicks) || invulnerableTicks <= 0) {
      throw new RangeError(
        `dash.invulnerableTicks must be a positive integer, received: ${String(invulnerableTicks)}`,
      );
    }
    if (!Number.isInteger(cooldownTicks) || cooldownTicks <= 0) {
      throw new RangeError(
        `dash.cooldownTicks must be a positive integer, received: ${String(cooldownTicks)}`,
      );
    }
    if (invulnerableTicks > durationTicks) {
      throw new RangeError(
        `dash.invulnerableTicks (${String(invulnerableTicks)}) must not exceed dash.durationTicks (${String(durationTicks)})`,
      );
    }

    const entity = world.createEntity();
    world.addComponent(
      entity.id,
      new TransformComponent(options.x ?? 0, options.y ?? 0, options.facingRadians ?? 0),
    );
    world.addComponent(entity.id, new VelocityComponent(maxSpeed));
    world.addComponent(entity.id, new InputComponent());
    world.addComponent(entity.id, new StateComponent());
    world.addComponent(
      entity.id,
      new DashStatsComponent(speedMultiplier, durationTicks, invulnerableTicks, cooldownTicks, 0),
    );
    world.addComponent(entity.id, new TagComponent());
    return entity.id;
  }
}
