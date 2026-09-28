/**
 * Tick-scoped event bus. See specs/05_boon_modifier_spec.md §3.1 / §3.2 / §4.1.
 *
 * This is the seam that turns "a hit happened" from an internal side effect of
 * CollisionSystem into an explicit, observable FACT that any later system can
 * react to. The M3-T01 modifier engine (ModifierSystem) is the first consumer;
 * future hooks (OnKill, OnDash, ...) reuse the same queue with a different
 * payload type — the generic parameter is the whole extension story.
 *
 * NOT cross-tick state: the queue is a WIRE between two systems within a single
 * tick. ModifierSystem drains it in full every tick, so its observable state at
 * every tick boundary is `size === 0` (spec 05 C5). It lives here rather than on
 * `World` so the generic ECS layer stays free of game concepts, and it is passed
 * by constructor injection rather than through `SystemContext` so the frozen
 * harness contracts (clock / step / SystemContext) are left untouched
 * (spec 05 C6 / §5.3).
 *
 * Determinism: `emit` order is the production order (CollisionSystem iterates
 * hitboxes and targets by ascending id), and `drain` preserves that FIFO order,
 * so the sequence of injected entities is reproducible tick for tick.
 */

import type { EntityId } from './Entity';
import type { Vec2 } from '../core/math';

/**
 * A landed hit, as a pure fact.
 *
 * Emitted by CollisionSystem AFTER a hit has actually been resolved — damage
 * applied, the hit ledger updated and the hit feedback written. An
 * invulnerability (i-frame) hit is ignored entirely by CollisionSystem
 * (spec 03 §4.4), so it emits NOTHING: "hitting an i-frame" must leave no trace
 * for a modifier to react to (spec 05 §4.1).
 *
 * Carries no policy (spec 05 C8): it says WHO hit WHOM, WHERE and FOR HOW MUCH —
 * never what should happen as a result. "Therefore spawn a lightning bolt" is
 * ModifierSystem's business, not this type's.
 */
export interface HitEvent {
  /** Tick this hit was resolved on (`SystemContext.tick` of the producer). */
  readonly tick: number;
  /** Attacker entity — snapshot of the hitbox's `ownerEntityId`. */
  readonly attackerId: EntityId;
  /** Victim entity. */
  readonly targetId: EntityId;
  /** The hitbox entity that produced this hit. */
  readonly hitboxEntityId: EntityId;
  /**
   * Impact point = the HITBOX CENTRE in world space. Deliberately not the
   * victim's position: a modifier that wants to strike "where the target is"
   * must read the victim's `TransformComponent` itself (spec 05 §3.1 / §4.3).
   */
  readonly position: Vec2;
  /** Damage actually dealt by this hit. */
  readonly damage: number;
  /**
   * Provenance of the hitbox that produced the hit: `null` for a base attack,
   * or the modifier id for a modifier-injected hitbox. This is the
   * anti-recursion key — a modifier-sourced hit never re-enters modifier
   * dispatch, which bounds nesting depth at 1 (spec 05 AC-04 / §4.5).
   */
  readonly sourceModifier: string | null;
}

/**
 * FIFO event queue shared by one producer and one consumer per tick.
 *
 * @typeParam T Payload type; defaults to {@link HitEvent}, so `new EventQueue()`
 *   is a hit-event bus. New hooks instantiate `EventQueue<SomeOtherEvent>`.
 */
export class EventQueue<T = HitEvent> {
  private pending: T[] = [];

  /** Number of events waiting to be drained (observability / assertions). */
  public get size(): number {
    return this.pending.length;
  }

  /** Append an event to the tail (FIFO). */
  public emit(event: T): void {
    this.pending.push(event);
  }

  /**
   * Return every pending event, in FIFO order, as a FRESH array, and empty the
   * queue. The caller owns the returned array — mutating it cannot corrupt the
   * bus, so a consumer can never accidentally re-publish a drained event.
   */
  public drain(): T[] {
    const drained = this.pending;
    this.pending = [];
    return drained;
  }

  /** Discard every pending event. For tests / fault recovery only. */
  public clear(): void {
    this.pending = [];
  }
}
