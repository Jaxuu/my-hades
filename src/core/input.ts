/**
 * Input event contract + deterministic FIFO queue. See specs/00_harness_spec.md §4.
 */

import type { Vec2 } from './math';

export interface MoveEvent {
  readonly kind: 'move';
  /** The exact tick at which this event must take effect. */
  readonly tick: number;
  readonly vector: Vec2;
}

export interface KeyDownEvent {
  readonly kind: 'keyDown';
  readonly tick: number;
  readonly key: string;
}

export interface KeyUpEvent {
  readonly kind: 'keyUp';
  readonly tick: number;
  readonly key: string;
}

/**
 * A reward selection made in the presentation layer (M6-T01, spec 11 AC-03).
 *
 * This is the "UI -> logic" seam for the boon draft. A DOM button click is an
 * EXTERNAL, tick-aligned command exactly like a key press, so it rides the SAME
 * deterministic FIFO queue instead of inventing a parallel bus. That choice is
 * load-bearing (spec 11 §10 trade-off 1):
 *
 *  - the queue already guarantees "delivered on exactly tick T, in enqueue order",
 *    which is the whole of AC-03's determinism requirement;
 *  - `GameSimulator.inject` already owns the "no past ticks" rule, so a stale click
 *    fails loudly instead of silently corrupting a replay;
 *  - `GameLoop` already flushes input immediately BEFORE `step`, so a selection
 *    lands on the tick the player saw it on;
 *  - a second queue would need its own injection API, its own drain point and its
 *    own ordering discipline — three chances to desynchronise a replay, bought for
 *    nothing.
 *
 * It carries an ID, not an index: the UI must never be able to select "option 1 of
 * whatever is on screen". The logic layer re-validates the id against the pending
 * draft it rolled itself, so a forged or stale id is simply ignored
 * (spec 11 AC-03 / §4.3).
 */
export interface SelectRewardEvent {
  readonly kind: 'selectReward';
  readonly tick: number;
  /** Id of the reward the player picked (e.g. `'zeus_strike'`). */
  readonly rewardId: string;
}

export type InputEvent = MoveEvent | KeyDownEvent | KeyUpEvent | SelectRewardEvent;

export function assertValidTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`tick must be a non-negative integer, received: ${String(tick)}`);
  }
}

/**
 * Deterministic FIFO queue of tick-aligned input events.
 * Same-tick events are consumed in enqueue order.
 */
export class InputQueue {
  private events: InputEvent[] = [];

  public get pendingCount(): number {
    return this.events.length;
  }

  public enqueue(event: InputEvent): void {
    assertValidTick(event.tick);
    this.events.push(event);
  }

  /**
   * Remove and return all events scheduled for exactly `tick`, preserving
   * enqueue (FIFO) order. Future events are retained.
   */
  public drain(tick: number): InputEvent[] {
    assertValidTick(tick);
    const due: InputEvent[] = [];
    const retained: InputEvent[] = [];
    for (const event of this.events) {
      if (event.tick === tick) {
        due.push(event);
      } else {
        retained.push(event);
      }
    }
    this.events = retained;
    return due;
  }

  public clear(): void {
    this.events = [];
  }
}
