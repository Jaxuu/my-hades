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

  /**
   * Hand every system its optional run-boundary hook (M8-T01, spec 14 §4.5).
   *
   * Called by `GameSimulator.restartRun` AFTER the world has been cleared, so a
   * system that owns a tick-scoped bus can drop its contents instead of leaving
   * events that reference destroyed entities. Registration order is used, which
   * is the same order `run` uses — deterministic by construction.
   *
   * Most systems have no hook and are skipped by the optional call: this engine's
   * whole design is "no cross-tick hidden state", so implementing `reset` is the
   * exception, not the rule.
   */
  public reset(): void {
    for (const system of this.systems) {
      system.reset?.();
    }
  }
}
