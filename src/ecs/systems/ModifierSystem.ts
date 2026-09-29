/**
 * ModifierSystem — the event consumer that turns a tick's FACTS into boon effects.
 * See specs/05_boon_modifier_spec.md §4.2 / §5.1,
 * specs/06_status_effect_and_dot_spec.md §4.4 and
 * specs/12_armor_and_dash_boons_spec.md §4.3.
 *
 * Pipeline position: AFTER CollisionSystem (it must see the hits produced this
 * tick) and BEFORE LifespanSystem (an injected hitbox must not be aged/destroyed
 * before it has ever been collision-tested — spec 05 §4.4 / §5.2). It is also
 * AFTER DashSystem, which is what lets a `DashEvent` produced this tick be consumed
 * this tick (M6-T02, spec 12 AC-03).
 *
 * As of M3-T02 this class is a pure DISPATCHER. It owns no boon behaviour at all:
 * each tick it drains the shared buses and, for every event, walks the involved
 * entity's modifier list and calls the matching hook from the injected
 * {@link ModifierRegistry}. Adding a boon means writing a handler and registering
 * it; this file does not change (spec 06 §4.4).
 *
 * TWO BUSES, TWO CHAINS (M6-T02). The hit chain is unchanged; the dash chain is its
 * structural twin:
 *
 *   HIT  (spec 05 §4.2 — the order is NOT exchangeable):
 *     1. ANTI-RECURSION gate: `sourceModifier !== null` => drop the event.
 *     2. Holder check: walk `ModifierComponent.modifiers` of the ATTACKER.
 *     3. Look up each id and invoke `onHit`.
 *
 *   DASH (spec 12 §4.3):
 *     1. Holder check: walk `ModifierComponent.modifiers` of the DASHER.
 *     2. Look up each id and invoke `onDash` (optional — `?.` skips non-implementers).
 *
 * Step 1 of the hit chain MUST come before steps 2/3. A `zeus_strike` bolt is itself
 * a hitbox, so the hit it lands arrives as another event with the SAME attacker —
 * dispatching it would spawn a bolt per bolt, doubling every tick until the sim
 * explodes. The provenance tag makes the guard idempotent and needs no depth
 * counter, no cooldown and therefore no cross-tick state (spec 05 C5 / §4.5).
 *
 * The dash chain needs NO such gate, and that is a structural fact rather than an
 * omission: a `DashEvent` has no provenance field because the only entities a
 * modifier can inject are HITBOXES, and a hitbox owns no `IntentComponent` and
 * therefore can never enter `DASHING` (spec 12 §4.3).
 *
 * Dispatch order across the two buses is dash-first, then hit: DashSystem runs
 * earlier in the tick than CollisionSystem, so replaying the dash facts first keeps
 * the injected-entity sequence a faithful echo of pipeline order. Both loops are
 * full drains, so both buses are empty at every tick boundary.
 *
 * This system does NOT skip frozen entities, unlike Movement / Dash / State /
 * CombatAction. Hitstop is written by CollisionSystem in the SAME tick as the hit
 * that triggers it, so by the time we run, both attacker and victim are already
 * frozen — gating on `isFrozen` would make Zeus Strike impossible to ever fire.
 * Modifiers are EVENT-driven, not action-driven (spec 05 §5.1).
 *
 * Holds NO cross-tick hidden state: each queue is a within-tick wire that is fully
 * drained every tick, so its observable state at every tick boundary is empty.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { DashEvent, HitEvent } from '../events';
import { EventQueue } from '../events';
import { ModifierComponent } from '../components/ModifierComponent';
import type { ModifierContext, ModifierRegistry } from '../modifiers/ModifierRegistry';
import { createDefaultModifierRegistry } from '../modifiers/index';

export class ModifierSystem implements System {
  public readonly name = 'ModifierSystem';

  /** Tick-scoped hit bus, shared with the CollisionSystem that produces into it. */
  private readonly events: EventQueue;

  /** id -> behaviour table. Defaults to the shipped boon set. */
  private readonly registry: ModifierRegistry;

  /**
   * Tick-scoped dash bus, shared with the DashSystem that produces into it
   * (M6-T02). Appended AFTER `registry` so the existing `(events, registry)`
   * construction shape keeps working (spec 12 §5.3).
   */
  private readonly dashEvents: EventQueue<DashEvent>;

  constructor(
    events: EventQueue = new EventQueue(),
    registry: ModifierRegistry = createDefaultModifierRegistry(),
    dashEvents: EventQueue<DashEvent> = new EventQueue<DashEvent>(),
  ) {
    this.events = events;
    this.registry = registry;
    this.dashEvents = dashEvents;
  }

  public update(world: World, ctx: SystemContext): void {
    // Full drain on BOTH buses: whatever we do not consume here is discarded, so
    // neither can leak an event into the next tick (spec 05 C5 / AC-07, spec 12 I6).
    const pendingHits = this.events.drain();
    const pendingDashes = this.dashEvents.drain();
    // Strict no-op when both are empty — not even a context object is built, so the
    // C9 "zero side effect" guarantee is structural rather than incidental.
    if (pendingHits.length === 0 && pendingDashes.length === 0) return;

    const context: ModifierContext = { ...ctx, world };
    // Dash entries were produced EARLIER in the tick (DashSystem < CollisionSystem),
    // so they are replayed first: the engine reacts to the tick's facts in the order
    // the tick produced them (spec 12 §4.3).
    for (const event of pendingDashes) {
      this.dispatchDash(event, context);
    }
    for (const event of pendingHits) {
      this.dispatchHit(event, context);
    }
  }

  /**
   * Drop both tick-scoped buses at a run boundary (M8-T01, spec 14 §4.5).
   *
   * `GameSimulator.restartRun` reaches this through `Scheduler.reset`. Both buses
   * are already empty at every tick boundary by invariant (this system full-drains
   * them every tick), so this is defensive rather than load-bearing today — but it
   * is the honest counterpart to `DeathSystem.reset`, and it means "no bus
   * survives a restart" is a property of the SYSTEM rather than a property of
   * "nothing happened to leave anything behind".
   *
   * `clear()` rather than `drain()`: there is no consumer to hand the events to,
   * so discarding without observing is exactly the right primitive — the same
   * asymmetry `EventQueue.clear` documents.
   */
  public reset(): void {
    this.events.clear();
    this.dashEvents.clear();
  }

  /** Fixed hit dispatch chain (spec 05 §4.2 / spec 06 §4.4). */  private dispatchHit(event: HitEvent, context: ModifierContext): void {
    // 1. Anti-recursion: a modifier-sourced hit never re-enters modifier dispatch.
    if (event.sourceModifier !== null) return;

    // 2. Holder check: only the entity that OWNS the boon reacts to its own hits.
    const modifiers = context.world.getComponent(event.attackerId, ModifierComponent);
    if (modifiers === undefined) return;

    // 3. Dispatch to every boon the attacker holds, in ascending id order.
    for (const modifierId of modifiers.modifiers) {
      this.registry.get(modifierId)?.onHit(event, context);
    }
  }

  /**
   * Dash dispatch chain (M6-T02, spec 12 §4.3).
   *
   * No anti-recursion gate — see the class docstring: a modifier-injected entity is
   * always a hitbox, and a hitbox can never dash, so the nesting depth is
   * structurally 1.
   */
  private dispatchDash(event: DashEvent, context: ModifierContext): void {
    // 1. Holder check: only the entity that OWNS the boon reacts to its own dash.
    const modifiers = context.world.getComponent(event.entityId, ModifierComponent);
    if (modifiers === undefined) return;

    // 2. Dispatch to every boon the dasher holds, in ascending id order. An id with
    // no handler — or a handler that only implements `onHit` — is silently skipped.
    for (const modifierId of modifiers.modifiers) {
      this.registry.get(modifierId)?.onDash?.(event, context);
    }
  }
}
