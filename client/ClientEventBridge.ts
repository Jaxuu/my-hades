/**
 * ClientEventBridge — the presentation layer's OBSERVER of the logic layer's
 * tick-scoped event buses. See specs/22_audio_and_juice_spec.md §3.1 / §4.1
 * (AC-01).
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine already publishes every "a hit landed", "an entity died" and "an
 * entity started dashing" as an explicit FACT on a tick-scoped `EventQueue`
 * (`src/ecs/events.ts`). Those buses are consumed WITHIN the tick — the hit and
 * dash buses are fully drained by `ModifierSystem`, and the death bus is cleared
 * by `DeathSystem` at the start of every update — so by the time `step()`
 * returns, the buses are empty and the render layer has no way to see what
 * happened. The M14 milestone needs the presentation layer to react to those
 * facts (screen shake, hit sparks, a hit/dash chime) WITHOUT teaching the logic
 * layer anything about presentation.
 *
 * The bridge is that seam. It is a `TeeEventQueue` — an `EventQueue` subclass
 * that keeps a COPY of every event it emits in a client-side buffer before
 * delegating to the base queue. Injecting three of them into
 * `createDefaultSystems(hit, death, dash)` means:
 *
 *   - `src/` changes by ZERO lines. The pipeline still sees plain `EventQueue`s
 *     (Liskov: a `TeeEventQueue<T>` IS an `EventQueue<T>`), still drains/clears
 *     them exactly as before, and still has no idea a second observer exists.
 *   - The bus semantics are untouched: the base queue's `drain()` / `clear()`
 *     still empty the PRODUCER->CONSUMER wire; the tee buffer is a separate
 *     field that those methods never touch.
 *
 * WHY A SUBclass RATHER THAN A NEW SIMULATOR CALLBACK
 * ---------------------------------------------------
 * The alternative — a `GameSimulator.onFrameEnd(events)` hook — was rejected
 * (spec 22 §7 T1): it would put a pure-presentation concept ("this frame's
 * events, for the renderer") inside `src/core`, which is the one thing this
 * milestone must not do. The tee keeps the observation entirely on the client
 * side of the one-way dependency.
 *
 * THE BUFFER IS NOT CLEARED BY `scheduler.reset()`
 * ------------------------------------------------
 * `GameSimulator.restartRun` calls `scheduler.reset()`, which asks
 * `DeathSystem` / `ModifierSystem` to drop THEIR buses. The client buffer does
 * not live in the scheduler, so it survives a restart — and would then replay
 * events that reference entities the restart just destroyed. The caller MUST
 * call {@link ClientEventBridge.clear} at every run boundary (spec 22 §4.1).
 *
 * One-way dependency: this module imports `src/` (types + the base queue) but
 * `src/` must never import it back (spec 09 AC-01, spec 22 I1).
 */

import { EventQueue } from '../src/ecs/events';
import type { DashEvent, EntityDeathEvent, HitEvent } from '../src/ecs/events';

/**
 * One render frame's worth of logic events, in the three flavours the
 * presentation layer reacts to. Produced by {@link ClientEventBridge.drainFrame}
 * and handed to `GameRenderer.syncWorld` (visuals) and the audio sink.
 *
 * A frame may span up to `MAX_STEPS_PER_FRAME` logic ticks, so each array can
 * hold more than one tick's events; order is FIFO within a bus (the production
 * order the base `EventQueue` guarantees).
 */
export interface FrameEvents {
  readonly hits: readonly HitEvent[];
  readonly deaths: readonly EntityDeathEvent[];
  readonly dashes: readonly DashEvent[];
}

/** An empty frame's payload — a shared, frozen constant so callers need no allocation. */
export const EMPTY_FRAME_EVENTS: FrameEvents = Object.freeze({
  hits: Object.freeze([]) as readonly HitEvent[],
  deaths: Object.freeze([]) as readonly EntityDeathEvent[],
  dashes: Object.freeze([]) as readonly DashEvent[],
});

/**
 * An `EventQueue` that ALSO retains a copy of every emitted event for the
 * presentation layer.
 *
 * `emit` is overridden to push into a client-side buffer and then call
 * `super.emit`, so the base queue's producer/consumer contract is byte-for-byte
 * unchanged while the bridge accumulates a frame's worth of events. `drainFrame`
 * returns the buffer as a fresh array and empties it — the same ownership
 * contract as `EventQueue.drain` (the caller owns the array).
 *
 * `noImplicitOverride` requires the explicit `override` keyword.
 */
export class TeeEventQueue<T> extends EventQueue<T> {
  private frameBuffer: T[] = [];

  public override emit(event: T): void {
    this.frameBuffer.push(event);
    super.emit(event);
  }

  /**
   * Return every event emitted since the last drain, in FIFO order, as a FRESH
   * array, and empty the buffer. The caller owns the returned array.
   */
  public drainFrame(): T[] {
    const drained = this.frameBuffer;
    this.frameBuffer = [];
    return drained;
  }

  /**
   * Discard the client-side buffer WITHOUT touching the base queue.
   *
   * Used at a run boundary (see {@link ClientEventBridge.clear}): a restart
   * destroys the entities the buffered events reference, so replaying them over
   * the new run would be stale-state contamination.
   */
  public clearFrame(): void {
    this.frameBuffer = [];
  }

  /** Buffered-event count (observability / assertions). */
  public get frameSize(): number {
    return this.frameBuffer.length;
  }
}

/**
 * The client-side trio of tee buses, ready to inject into
 * `createDefaultSystems(bridge.hitQueue, bridge.deathQueue, bridge.dashQueue)`.
 *
 * Owns no logic and mutates no `World`; it only retains a copy of what the
 * engine already publishes.
 */
export class ClientEventBridge {
  /** Hit bus: `CollisionSystem` (producer) -> `ModifierSystem` (consumer). */
  public readonly hitQueue = new TeeEventQueue<HitEvent>();

  /** Death bus: `DeathSystem` (producer; cleared at the start of each tick). */
  public readonly deathQueue = new TeeEventQueue<EntityDeathEvent>();

  /** Dash bus: `DashSystem` (producer) -> `ModifierSystem` (consumer). */
  public readonly dashQueue = new TeeEventQueue<DashEvent>();

  /**
   * Take this frame's accumulated events and reset the buffers. Called EXACTLY
   * once per rendered frame by `GameLoop`, after `sim.step` (spec 22 §4.1).
   */
  public drainFrame(): FrameEvents {
    return {
      hits: this.hitQueue.drainFrame(),
      deaths: this.deathQueue.drainFrame(),
      dashes: this.dashQueue.drainFrame(),
    };
  }

  /**
   * Drop every buffered event at a RUN BOUNDARY (after `restartRun`), so no
   * event referencing a destroyed entity can be replayed over the new run. The
   * base queues are left alone — the scheduler already reset them.
   */
  public clear(): void {
    this.hitQueue.clearFrame();
    this.deathQueue.clearFrame();
    this.dashQueue.clearFrame();
  }
}
