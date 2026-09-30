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
  /**
   * How to ASSEMBLE a run (M8-T01, spec 14 AC-03).
   *
   * A callback the caller supplies, invoked by `GameSimulator.restartRun` to
   * rebuild the world after it has been cleared. It is a CONSTRUCTOR option
   * rather than a `restartRun` parameter so that the restart signature stays the
   * one the milestone asks for (`restartRun(newSeed?)`) while `GameSimulator`
   * stays free of game concepts: the simulator does not know what a player, a
   * room or a game state is — it only knows that a caller can build one.
   *
   * Omit it and `restartRun` still clears the world, reseeds and rewinds the
   * clock; the world is simply left empty. That is the honest behaviour for a
   * simulator whose caller never declared a run shape.
   */
  readonly runSetup?: (world: World) => void;
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
  private readonly runSetup: ((world: World) => void) | undefined;

  constructor(options: GameSimulatorOptions = {}) {
    this.clock = new FixedClock(options.fps !== undefined ? { fps: options.fps } : {});
    // The seed is forwarded to the World, which owns the ONE PRNG stream every
    // randomness consumer shares (M6-T01, ADR-004). Guarded rather than passed
    // through directly because `exactOptionalPropertyTypes` forbids handing an
    // explicit `undefined` to an optional property.
    this.world = options.seed !== undefined ? new World({ seed: options.seed }) : new World();
    this.input = new InputQueue();
    this.scheduler = new Scheduler();
    this.runSetup = options.runSetup;
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

  /**
   * The seed of the world's CURRENT PRNG stream (M10-T02).
   *
   * A read-only projection of `world.rng.seed`, added so a caller that wants to
   * restart a run "as it is" — `restartRun(sim.currentSeed)` — can say so without
   * reaching into the world for the generator. That is exactly what the dev-mode
   * data hot reload needs: a config edit must re-open the SAME run against the NEW
   * numbers, so the reload is a pure config change rather than a config change
   * plus a surprise re-roll.
   *
   * Note it is NOT "the seed the run started with": `restartRun` advances it, so
   * this always reports the stream the current run is drawing from.
   */
  public get currentSeed(): number {
    return this.world.rng.seed;
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
   * Throw the current run away and start a fresh one (M8-T01, spec 14 AC-03).
   *
   * The ONLY way back from `RUN_FAILED`, and the only operation in this engine
   * that rewinds anything. The steps are ordered, and the order is the contract
   * (spec 14 §4.5):
   *
   *  1. `world.clearEntities()` — every entity goes: the player, the room,
   *    corpses, armed hazards, in-flight projectiles, unspent hitboxes, and every
   *    modifier the player had accumulated. Note `World.nextId` is NOT reset, on
   *    purpose: ids must never be reused (`GameRenderer.retired` depends on it).
   *  2. `world.reseed(...)` — a NEW seed. `newSeed` if given, otherwise the
   *    previous seed plus one. Incrementing rather than rolling is what makes
   *    "restart twice from the same starting seed" reproducible (ADR-004).
   *  3. `input.clear()` — drop SCHEDULED input events. Without this the first
   *    tick of the new run would receive the previous run's last `move` / key
   *    events, which is replay contamination rather than a leftover.
   *  4. `scheduler.reset()` — let systems that own a tick-scoped bus drop its
   *    contents (the death bus deliberately keeps the tick's deaths, spec 08
   *    §3.3, and those events reference entities step 1 just destroyed).
   *  5. `clock.reset()` — back to tick `0`.
   *  6. `runSetup(world)` — rebuild the run's entities.
   *
   * Steps 1–2 happen BEFORE 6 so that `runSetup` sees an empty world with the new
   * generator, i.e. the same conditions a fresh construction has. Anything
   * `runSetup` draws is therefore drawn from the new stream, in the same order,
   * for the same seed — which is what makes a restarted run replayable.
   */
  public restartRun(newSeed?: number): void {
    const seed = newSeed ?? this.world.rng.seed + 1;
    this.world.clearEntities();
    this.world.reseed(seed);
    this.input.clear();
    this.scheduler.reset();
    this.clock.reset();
    this.runSetup?.(this.world);
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
