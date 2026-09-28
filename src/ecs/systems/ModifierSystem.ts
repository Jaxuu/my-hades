/**
 * ModifierSystem — the event consumer that turns a landed hit into boon effects.
 * See specs/05_boon_modifier_spec.md §4.2 / §4.3 / §5.1.
 *
 * Pipeline position: AFTER CollisionSystem (it must see the hits produced this
 * tick) and BEFORE LifespanSystem (an injected hitbox must not be aged/destroyed
 * before it has ever been collision-tested — spec 05 §4.4 / §5.2).
 *
 * Each tick it drains the shared `EventQueue` in full and dispatches every event
 * through a fixed, order-sensitive chain:
 *
 *   1. ANTI-RECURSION gate: `sourceModifier !== null` => drop the event.
 *   2. Holder check: the attacker must own the modifier.
 *   3. Injection: spawn the modifier's effect.
 *
 * Step 1 MUST come before step 2. A `zeus_strike` bolt is itself a hitbox, so the
 * hit it lands arrives as another event with the SAME attacker — checking the
 * holder first would spawn a bolt per bolt, doubling every tick until the sim
 * explodes. The provenance tag makes the guard idempotent and needs no depth
 * counter, no cooldown and therefore no cross-tick state (spec 05 C5 / §4.5).
 *
 * This system does NOT skip frozen entities, unlike Movement / Dash / State /
 * CombatAction. Hitstop is written by CollisionSystem in the SAME tick as the hit
 * that triggers it, so by the time we run, both attacker and victim are already
 * frozen — gating on `isFrozen` would make Zeus Strike impossible to ever fire.
 * Modifiers are EVENT-driven, not action-driven (spec 05 §5.1).
 *
 * The effects are hard-coded this milestone (dispatch asks for exactly that); a
 * data-driven boon table can replace step 3 later without touching the pipeline.
 *
 * Holds NO cross-tick hidden state: the queue is a within-tick wire that is fully
 * drained every tick, so its observable state at every tick boundary is empty.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { HitEvent } from '../events';
import { EventQueue } from '../events';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent } from '../components/FactionComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import {
  DEFAULT_ZEUS_STRIKE_DAMAGE,
  DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS,
  DEFAULT_ZEUS_STRIKE_RADIUS,
  ZEUS_STRIKE_MODIFIER,
  hasModifier,
} from '../components/ModifierComponent';

export class ModifierSystem implements System {
  public readonly name = 'ModifierSystem';

  /** Tick-scoped event bus, shared with the CollisionSystem that produces into it. */
  private readonly events: EventQueue;

  constructor(events: EventQueue = new EventQueue()) {
    this.events = events;
  }

  public update(world: World, _ctx: SystemContext): void {
    // Full drain: whatever we do not consume here is discarded, so the bus can
    // never leak an event into the next tick (spec 05 C5 / AC-07).
    for (const event of this.events.drain()) {
      this.dispatch(world, event);
    }
  }

  /** Fixed dispatch chain (spec 05 §4.2). Order between the two gates matters. */
  private dispatch(world: World, event: HitEvent): void {
    // 1. Anti-recursion: a modifier-sourced hit never re-enters modifier dispatch.
    if (event.sourceModifier !== null) return;

    // 2. Holder check: only the entity that OWNS the boon reacts to its own hits.
    if (!hasModifier(world, event.attackerId, ZEUS_STRIKE_MODIFIER)) return;

    // 3. Inject the effect.
    this.applyZeusStrike(world, event);
  }

  /**
   * Zeus Strike (spec 05 AC-03): drop a directionless lightning hitbox on the
   * victim's CURRENT position for fixed bonus damage.
   *
   * Position is read from the VICTIM (not the impact point, not the attacker):
   * "strike where the target is". MovementSystem runs before CollisionSystem, so
   * this is the target's post-movement position for this tick — and since the
   * triggering hit also froze the victim, it will still be there next tick.
   *
   * The bolt asks for neither hitstop nor knockback (`0` / `0`), which makes it a
   * pure-damage tick: CollisionSystem skips the whole feedback block for it, so it
   * cannot extend the hitstop it lands inside, and cannot overwrite the victim's
   * in-flight knockback with a zero vector (spec 05 §4.6).
   */
  private applyZeusStrike(world: World, event: HitEvent): void {
    const targetTransform = world.getComponent(event.targetId, TransformComponent);
    if (targetTransform === undefined) return;

    // The bolt inherits the side of the attack that triggered it. Read from the
    // triggering hitbox (guaranteed alive here — LifespanSystem runs after us),
    // falling back to the attacker if that hitbox is somehow gone.
    const triggeringHitbox = world.getComponent(event.hitboxEntityId, HitboxComponent);
    const attackerFaction = world.getComponent(event.attackerId, FactionComponent);
    const faction = triggeringHitbox?.faction ?? attackerFaction?.faction;
    if (faction === undefined) return;

    const bolt = world.createEntity();
    world.addComponent(
      bolt.id,
      // facingRadians = 0: the bolt is DIRECTIONLESS — it never reads the
      // attacker's facing, and 0 is a deterministic placeholder (no randomness).
      new TransformComponent(targetTransform.x, targetTransform.y, 0),
    );
    world.addComponent(
      bolt.id,
      new HitboxComponent(
        DEFAULT_ZEUS_STRIKE_RADIUS,
        DEFAULT_ZEUS_STRIKE_DAMAGE,
        // MUST be >= 2: we run after CollisionSystem, so this tick's test is
        // already over, and LifespanSystem decrements at the end of this tick.
        // 2 leaves exactly one collision test, on the next tick (spec 05 §4.4).
        DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS,
        faction,
        event.attackerId,
        0, // hitstopTicks  — pure damage
        0, // knockbackForce — pure damage
        [], // hitEntities
        ZEUS_STRIKE_MODIFIER, // anti-recursion provenance
      ),
    );
  }
}
