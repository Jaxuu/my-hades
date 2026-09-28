/**
 * ModifierSystem — the event consumer that turns a landed hit into boon effects.
 * See specs/05_boon_modifier_spec.md §4.2 / §5.1 and
 * specs/06_status_effect_and_dot_spec.md §4.4.
 *
 * Pipeline position: AFTER CollisionSystem (it must see the hits produced this
 * tick) and BEFORE LifespanSystem (an injected hitbox must not be aged/destroyed
 * before it has ever been collision-tested — spec 05 §4.4 / §5.2).
 *
 * As of M3-T02 this class is a pure DISPATCHER. It owns no boon behaviour at all:
 * each tick it drains the shared `EventQueue` and, for every event, walks the
 * attacker's modifier list and calls the matching `IModifierHandler.onHit` from the
 * injected {@link ModifierRegistry}. Adding a boon means writing a handler and
 * registering it; this file does not change (spec 06 §4.4).
 *
 * The dispatch chain, in order (spec 05 §4.2 — the order is NOT exchangeable):
 *
 *   1. ANTI-RECURSION gate: `sourceModifier !== null` => drop the event.
 *   2. Holder check: walk `ModifierComponent.modifiers` of the attacker.
 *   3. Look up each id in the registry and invoke its handler.
 *
 * Step 1 MUST come before steps 2/3. A `zeus_strike` bolt is itself a hitbox, so
 * the hit it lands arrives as another event with the SAME attacker — dispatching it
 * would spawn a bolt per bolt, doubling every tick until the sim explodes. The
 * provenance tag makes the guard idempotent and needs no depth counter, no cooldown
 * and therefore no cross-tick state (spec 05 C5 / §4.5).
 *
 * Step 2 walks the modifier list in its stored order (ascending, maintained by
 * `addModifier`), so an entity holding two boons triggers them in a fixed,
 * reproducible order. An id with no registered handler is silently skipped: boons
 * are data, and a data table may legitimately reference a behaviour that this build
 * does not ship.
 *
 * This system does NOT skip frozen entities, unlike Movement / Dash / State /
 * CombatAction. Hitstop is written by CollisionSystem in the SAME tick as the hit
 * that triggers it, so by the time we run, both attacker and victim are already
 * frozen — gating on `isFrozen` would make Zeus Strike impossible to ever fire.
 * Modifiers are EVENT-driven, not action-driven (spec 05 §5.1).
 *
 * Holds NO cross-tick hidden state: the queue is a within-tick wire that is fully
 * drained every tick, so its observable state at every tick boundary is empty.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { HitEvent } from '../events';
import { EventQueue } from '../events';
import { ModifierComponent } from '../components/ModifierComponent';
import type { ModifierContext, ModifierRegistry } from '../modifiers/ModifierRegistry';
import { createDefaultModifierRegistry } from '../modifiers/index';

export class ModifierSystem implements System {
  public readonly name = 'ModifierSystem';

  /** Tick-scoped event bus, shared with the CollisionSystem that produces into it. */
  private readonly events: EventQueue;

  /** id -> behaviour table. Defaults to the shipped boon set. */
  private readonly registry: ModifierRegistry;

  constructor(
    events: EventQueue = new EventQueue(),
    registry: ModifierRegistry = createDefaultModifierRegistry(),
  ) {
    this.events = events;
    this.registry = registry;
  }

  public update(world: World, ctx: SystemContext): void {
    // Full drain: whatever we do not consume here is discarded, so the bus can
    // never leak an event into the next tick (spec 05 C5 / AC-07).
    const pending = this.events.drain();
    // Strict no-op on an empty queue — not even a context object is built, so the
    // C9 "zero side effect" guarantee is structural rather than incidental.
    if (pending.length === 0) return;

    const context: ModifierContext = { ...ctx, world };
    for (const event of pending) {
      this.dispatch(event, context);
    }
  }

  /** Fixed dispatch chain (spec 05 §4.2 / spec 06 §4.4). */
  private dispatch(event: HitEvent, context: ModifierContext): void {
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
}
