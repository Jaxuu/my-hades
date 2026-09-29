/**
 * Tick-scoped event buses. See specs/05_boon_modifier_spec.md §3.1 / §3.2 / §4.1
 * and specs/08_encounter_and_death_spec.md §3.3.
 *
 * This is the seam that turns "a hit happened" (and, as of M4-T02, "an entity
 * died") from an internal side effect of a system into an explicit, observable
 * FACT that any later system can react to. The M3-T01 modifier engine
 * (ModifierSystem) is the first consumer; future hooks (OnKill, OnDash, ...)
 * reuse the same queue with a different payload type — the generic parameter is
 * the whole extension story. M4-T02 cashes that in with a SECOND payload type on
 * its own bus ({@link EntityDeathEvent}), which is why the two shipped buses are
 * separate instances rather than one `HitEvent | EntityDeathEvent` queue: a
 * consumer of one must never have to discriminate the other.
 *
 * NOT cross-tick state: the queue is a WIRE between systems within a single tick.
 * Each bus has exactly one drainer (ModifierSystem for the hit bus, DeathSystem's
 * `clear()` for the death bus), so its observable state at a tick boundary is
 * bounded and deterministic. It lives here rather than on `World` so the generic
 * ECS layer stays free of game concepts, and it is passed by constructor
 * injection rather than through `SystemContext` so the frozen harness contracts
 * (clock / step / SystemContext) are left untouched (spec 05 C6 / §5.3).
 *
 * Determinism: `emit` order is the production order (CollisionSystem iterates
 * hitboxes and targets by ascending id; DeathSystem iterates dying entities by
 * ascending id), and `drain` preserves that FIFO order, so the sequence of
 * injected entities is reproducible tick for tick.
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
 * A resolved death, as a pure fact (M4-T02). See
 * specs/08_encounter_and_death_spec.md §3.3 / §4.1.
 *
 * Emitted by `DeathSystem` in the same tick it mounts the `DeadTagComponent` —
 * i.e. at the END of the tick in which `hp` reached `0`. Exactly ONE event is
 * published per entity, ever: the producer skips anything already tagged, and
 * `markDead` is idempotent (spec 08 AC-01).
 *
 * Carries no policy, exactly like {@link HitEvent}: it says WHO died and WHEN,
 * never what should happen as a result. "Therefore the room is cleared" is the
 * encounter scheduler's business (spec 08 §4.3), and "therefore play the death
 * VFX" is the render layer's.
 *
 * Deliberately minimal — `tick` + `entityId` only. Faction, position and cause of
 * death are all readable from the corpse itself for as long as the corpse exists
 * (and this milestone never destroys it, spec 08 §10 trade-off 1), so copying them
 * into the event would be redundant state that could drift out of sync. Keeping
 * the payload free of game types is also what lets this live in the generic ECS
 * layer rather than next to the components.
 */
export interface EntityDeathEvent {
  /** Tick the death was resolved on (`SystemContext.tick` of the producer). */
  readonly tick: number;
  /** The entity that died. Still ALIVE in the world — death is a state, not a delete. */
  readonly entityId: EntityId;
}

/**
 * FIFO event queue shared by one producer and one consumer per tick.
 *
 * @typeParam T Payload type; defaults to {@link HitEvent}, so `new EventQueue()`
 *   is a hit-event bus. The death bus is `new EventQueue<EntityDeathEvent>()`.
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

  /**
   * Discard every pending event.
   *
   * Two legitimate uses: tests / fault recovery, and the DEATH bus — `DeathSystem`
   * clears it at the START of every update, which is what bounds that bus to a
   * single tick instead of letting it grow for the whole run (spec 08 §3.3). Note
   * the asymmetry with `drain()`: clearing DISCARDS without observing, which is
   * only correct for a bus whose consumer is optional.
   */
  public clear(): void {
    this.pending = [];
  }
}
