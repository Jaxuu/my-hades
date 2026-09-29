/**
 * GameSimulator — the deterministic, headless simulation core.
 * See specs/00_harness_spec.md §3–§6.
 *
 * Rendering-agnostic: this module never touches DOM/Canvas/WebGL. Time is
 * advanced ONLY via `step()`; the wall clock is never read.
 */

import { FixedClock } from './clock';
import type { InputEvent } from './input';
import { InputQueue } from './input';
import { Scheduler } from './scheduler';
import { cloneValue, deepFreeze } from './snapshot-utils';
import type { System, SystemContext } from '../ecs/System';
import { World } from '../ecs/World';
import type { EntityId } from '../ecs/Entity';

export interface GameSimulatorOptions {
  /** Logical ticks per second. Defaults to 60. */
  readonly fps?: number;
  /** Systems to register up-front, in execution order. */
  readonly systems?: readonly System[];
  /**
   * Seed for the world's deterministic PRNG (M6-T01). Defaults to
   * `DEFAULT_RANDOM_SEED`, so a simulator built without a seed is reproducible —
   * which is what makes test suites and replays stable. A real roguelike run
   * passes a varied seed here; that choice belongs to the caller, never to the
   * logic layer (ADR-004 §Decision 3).
   */
  readonly seed?: number;
}

export interface ComponentSnapshot {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface EntitySnapshot {
  readonly id: EntityId;
  readonly components: readonly ComponentSnapshot[];
}

export interface Snapshot {
  readonly tick: number;
  readonly elapsedSeconds: number;
  readonly entities: readonly EntitySnapshot[];
}

export class GameSimulator {
  public readonly world: World;

  private readonly clock: FixedClock;
  private readonly input: InputQueue;
  private readonly scheduler: Scheduler;

  constructor(options: GameSimulatorOptions = {}) {
    this.clock = new FixedClock(options.fps !== undefined ? { fps: options.fps } : {});
    // The seed is forwarded to the World, which owns the ONE PRNG stream every
    // randomness consumer shares (M6-T01, ADR-004). Guarded rather than passed
    // through directly because `exactOptionalPropertyTypes` forbids handing an
    // explicit `undefined` to an optional property.
    this.world = options.seed !== undefined ? new World({ seed: options.seed }) : new World();
    this.input = new InputQueue();
    this.scheduler = new Scheduler();
    for (const system of options.systems ?? []) {
      this.scheduler.register(system);
    }
  }

  public get fps(): number {
    return this.clock.fps;
  }

  public get fixedDeltaSeconds(): number {
    return this.clock.fixedDeltaSeconds;
  }

  public get tickDurationMs(): number {
    return this.clock.tickDurationMs;
  }

  /** Accumulated tick count (integer, monotonically non-decreasing). */
  public get tick(): number {
    return this.clock.totalTicks;
  }

  /** Accumulated simulated seconds. */
  public get elapsedSeconds(): number {
    return this.clock.elapsedSeconds;
  }

  public get systemCount(): number {
    return this.scheduler.size;
  }

  public registerSystem(system: System): void {
    this.scheduler.register(system);
  }

  /**
   * Schedule an input event for a specific (current or future) tick.
   * @throws RangeError if the tick is invalid or already in the past.
   */
  public inject(event: InputEvent): void {
    if (event.tick < this.clock.totalTicks) {
      throw new RangeError(
        `Cannot inject event for past tick ${event.tick} (current tick is ${this.clock.totalTicks}).`,
      );
    }
    this.input.enqueue(event);
  }

  /** Convenience alias for {@link inject}. */
  public injectAt(tick: number, event: InputEvent): void {
    this.inject({ ...event, tick });
  }

  /**
   * Advance the simulation by `ticks` fixed steps (default 1).
   * Each step: drain the input frame for the current tick, run systems, then
   * advance the clock by exactly one tick.
   */
  public step(ticks = 1): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`step(ticks) must be a non-negative integer, received: ${String(ticks)}`);
    }
    for (let i = 0; i < ticks; i += 1) {
      const currentTick = this.clock.totalTicks;
      const inputFrame = this.input.drain(currentTick);
      const ctx: SystemContext = {
        tick: currentTick,
        elapsedSeconds: currentTick * this.clock.fixedDeltaSeconds,
        fixedDeltaSeconds: this.clock.fixedDeltaSeconds,
        input: inputFrame,
      };
      this.scheduler.run(this.world, ctx);
      this.clock.advance(1);
    }
  }

  /** Advance until the clock reaches `targetTick` (no-op if already there). */
  public runTo(targetTick: number): void {
    if (!Number.isInteger(targetTick) || targetTick < 0) {
      throw new RangeError(`runTo(targetTick) must be a non-negative integer, received: ${String(targetTick)}`);
    }
    if (targetTick < this.clock.totalTicks) {
      throw new RangeError(
        `Cannot run backwards to tick ${targetTick} (current tick is ${this.clock.totalTicks}).`,
      );
    }
    this.step(targetTick - this.clock.totalTicks);
  }

  /**
   * Export a deep-copied, deep-frozen read-only snapshot of the world.
   * The snapshot shares no mutable references with the live world.
   */
  public snapshot(): Snapshot {
    const entities: EntitySnapshot[] = this.world.listEntities().map((id) => {
      const components: ComponentSnapshot[] = this.world.listComponents(id).map((component) => {
        const data: Record<string, unknown> = {};
        const source = component as unknown as Record<string, unknown>;
        for (const key of Object.keys(source)) {
          if (key === '__component') continue;
          data[key] = cloneValue(source[key]);
        }
        return { type: component.constructor.name, data };
      });
      return { id, components };
    });

    const snap: Snapshot = {
      tick: this.clock.totalTicks,
      elapsedSeconds: this.clock.elapsedSeconds,
      entities,
    };
    return deepFreeze(snap);
  }
}
