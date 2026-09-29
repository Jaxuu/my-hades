/**
 * Tick-scoped event buses. See specs/05_boon_modifier_spec.md §3.1 / §3.2 / §4.1,
 * specs/08_encounter_and_death_spec.md §3.3 and
 * specs/12_armor_and_dash_boons_spec.md §3.3 / §4.3.
 *
 * This is the seam that turns "a hit happened" (and, as of M4-T02, "an entity
 * died", and as of M6-T02, "an entity started dashing") from an internal side
 * effect of a system into an explicit, observable FACT that any later system can
 * react to. The M3-T01 modifier engine (ModifierSystem) is the first consumer; the
 * generic parameter is the whole extension story. It has now been cashed in twice:
 * M4-T02 added a SECOND payload type on its own bus ({@link EntityDeathEvent}), and
 * M6-T02 a THIRD ({@link DashEvent}) — which is why the shipped buses are separate
 * instances rather than one `HitEvent | EntityDeathEvent | DashEvent` queue: a
 * consumer of one must never have to discriminate the others.
 *
 * NOT cross-tick state: each queue is a WIRE between systems within a single tick.
 * Every bus has exactly one drainer (ModifierSystem for the hit and dash buses,
 * DeathSystem's `clear()` for the death bus), so its observable state at a tick
 * boundary is bounded and deterministic. They live here rather than on `World` so
 * the generic ECS layer stays free of game concepts, and they are passed by
 * constructor injection rather than through `SystemContext` so the frozen harness
 * contracts (clock / step / SystemContext) are left untouched (spec 05 C6 / §5.3).
 *
 * Determinism: `emit` order is the production order (CollisionSystem iterates
 * hitboxes and targets by ascending id; DeathSystem iterates dying entities by
 * ascending id; DashSystem iterates dashing entities by ascending id), and `drain`
 * preserves that FIFO order, so the sequence of injected entities is reproducible
 * tick for tick.
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
 * A dash ENTRY, as a pure fact (M6-T02). See
 * specs/12_armor_and_dash_boons_spec.md §3.3 / §4.3.
 *
 * Emitted by `DashSystem` on the tick an entity ENTERS `DASHING` — the tick the
 * dash DECISION is taken, not the first tick of its displacement (MovementSystem
 * runs before DashSystem, so the body starts moving on the NEXT tick; the event is
 * about the decision, not the motion).
 *
 * Exactly ONE event per dash entry, ever: the producer emits inside the same
 * `startDash` call that flips the state, and `DASHING` cannot be re-entered without
 * leaving it first (spec 02 §4.1). A dash pulse that the entry gate REJECTS (stunned
 * / mid-swing / on cooldown / frozen) publishes nothing — the event describes "this
 * entity really started dashing", never "this entity wanted to".
 *
 * Carries no policy, exactly like {@link HitEvent}: it says WHO dashed, FROM WHERE
 * and WHICH WAY — never what should happen as a result. "Therefore blast everything
 * around me" is `PoseidonDashModifier`'s business, not this type's.
 *
 * `position` is the entity's origin at the moment of entry, which is what makes a
 * SELF-CENTRED effect (a shockwave) expressible without the consumer re-reading the
 * transform — and correct even though the body will have moved by the time the
 * injected entity is collision-tested.
 *
 * `direction` is the LOCKED dash direction — the unit vector `DashSystem` just wrote
 * onto `VelocityComponent.directionVector`. Carrying it means a consumer never has
 * to re-derive "which way is this dash going" from `facingRadians`, so that
 * conversion keeps exactly one home in the engine.
 */
export interface DashEvent {
  /** Tick the dash started on (`SystemContext.tick` of the producer). */
  readonly tick: number;
  /** The entity that entered `DASHING`. */
  readonly entityId: EntityId;
  /** The entity's origin at dash entry, in world space. */
  readonly position: Vec2;
  /** The locked dash direction (unit vector). */
  readonly direction: Vec2;
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
