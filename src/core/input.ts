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

export type InputEvent = MoveEvent | KeyDownEvent | KeyUpEvent;

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
