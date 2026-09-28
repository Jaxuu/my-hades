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
  /** The input frame delivered for exactly this tick (FIFO order). */
  readonly input: ReadonlyArray<InputEvent>;
}

export interface System {
  /** Unique, stable name; used for ordering and duplicate detection. */
  readonly name: string;
  /** Called exactly once per tick, in registration order. */
  update(world: World, ctx: SystemContext): void;
}
