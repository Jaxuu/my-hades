/**
 * System scheduler: runs registered systems once per tick in a fixed order.
 * See specs/00_harness_spec.md §6.3.
 */

import type { System, SystemContext } from '../ecs/System';
import type { World } from '../ecs/World';

export class Scheduler {
  private readonly systems: System[] = [];

  public get size(): number {
    return this.systems.length;
  }

  public register(system: System): void {
    if (this.systems.some((existing) => existing.name === system.name)) {
      throw new Error(`A system named "${system.name}" is already registered.`);
    }
    this.systems.push(system);
  }

  public run(world: World, ctx: SystemContext): void {
    for (const system of this.systems) {
      system.update(world, ctx);
    }
  }
}
