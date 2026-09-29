/**
 * System contract. See specs/00_harness_spec.md §6.
 */

import type { InputEvent } from '../core/input';
import type { World } from './World';

export interface SystemContext {
  /** Tick index this update belongs to. */
  readonly tick: number;
  /** Accumulated simulated seconds at the START of this tick. */
  readonly elapsedSeconds: number;
  /**
   * Simulated seconds per tick (= 1 / fps). Systems MUST integrate against this
   * value instead of hard-coding 1/60, so behaviour is fps-independent.
   * See specs/01_character_controller_spec.md §5.2 (AC-05).
   */
  readonly fixedDeltaSeconds: number;
  /** The input frame delivered for exactly this tick (FIFO order). */
  readonly input: ReadonlyArray<InputEvent>;
}

export interface System {
  /** Unique, stable name; used for ordering and duplicate detection. */
  readonly name: string;
  /** Called exactly once per tick, in registration order. */
  update(world: World, ctx: SystemContext): void;
  /**
   * Optional RUN-BOUNDARY hook (M8-T01, spec 14 §4.5).
   *
   * Called by `Scheduler.reset`, which `GameSimulator.restartRun` invokes after
   * clearing the world. It exists for systems that own a TICK-SCOPED BUS:
   * `DeathSystem`'s death bus and `ModifierSystem`'s hit / dash buses are all
   * empty at every tick boundary BY INVARIANT, except that `DeathSystem`
   * deliberately keeps the deaths of the tick it just processed (spec 08 §3.3) —
   * so a restart would otherwise leave a bus full of events pointing at entities
   * the restart just destroyed.
   *
   * Deliberately OPTIONAL and deliberately NOT "reset all game state": every
   * other system in this engine holds no cross-tick state at all (spec 00 §6.1),
   * which is why they need nothing here. A system that had to implement this to
   * be correct would be admitting it had hidden state — the opposite of the
   * design.
   */
  reset?(): void;
}
