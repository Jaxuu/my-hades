/**
 * Shared test fixtures: concrete components + systems used across suites.
 */

import { ComponentBase } from '../../src/ecs/Component';
import type { System, SystemContext } from '../../src/ecs/System';
import type { World } from '../../src/ecs/World';

export class Position extends ComponentBase {
  public x: number;
  public y: number;

  constructor(x = 0, y = 0) {
    super();
    this.x = x;
    this.y = y;
  }
}

export class Velocity extends ComponentBase {
  public vx: number;
  public vy: number;

  constructor(vx = 0, vy = 0) {
    super();
    this.vx = vx;
    this.vy = vy;
  }
}

export class Tag extends ComponentBase {
  public label: string;

  constructor(label = 'tag') {
    super();
    this.label = label;
  }
}

/**
 * R6 regression pair (ADR-001 R6).
 *
 * `'Zebra' < 'alpha'` under UTF-16 code-unit order (0x5A < 0x61) but
 * `'alpha' < 'Zebra'` under locale collation, so a sort of these two components
 * tells the two orderings apart. Used to pin `World.listComponents` to the
 * environment-independent ordering.
 */
export class Zebra extends ComponentBase {
  public readonly marker = 'Zebra';
}

/** See {@link Zebra}. */
export class alpha extends ComponentBase {
  public readonly marker = 'alpha';
}

/**
 * Applies every `move` event in the tick's input frame to entities that have
 * both Position and Velocity. Deterministic: iterates ids in ascending order.
 */
export class MovementSystem implements System {
  public readonly name = 'MovementSystem';

  public update(world: World, ctx: SystemContext): void {
    for (const id of world.query(Position, Velocity)) {
      const pos = world.getComponent(id, Position);
      const vel = world.getComponent(id, Velocity);
      if (pos === undefined || vel === undefined) continue;

      for (const event of ctx.input) {
        if (event.kind === 'move') {
          pos.x += event.vector.x;
          pos.y += event.vector.y;
        }
      }
      pos.x += vel.vx;
      pos.y += vel.vy;
    }
  }
}
