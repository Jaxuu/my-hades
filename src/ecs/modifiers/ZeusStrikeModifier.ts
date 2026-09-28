/**
 * Zeus Strike — the reference `IModifierHandler`.
 * See specs/05_boon_modifier_spec.md §4.3 / AC-03 and
 * specs/06_status_effect_and_dot_spec.md §3.5.
 *
 * Behaviour is UNCHANGED from M3-T01; only its home moved. It used to be a private
 * method on `ModifierSystem`; it is now a handler so the dispatcher can stay
 * generic (spec 06 §4.4). The tick-phase reasoning below is load-bearing and is
 * carried over verbatim from spec 05.
 */

import type { HitEvent } from '../events';
import type { ModifierContext, IModifierHandler } from './ModifierRegistry';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent } from '../components/FactionComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import {
  DEFAULT_ZEUS_STRIKE_DAMAGE,
  DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS,
  DEFAULT_ZEUS_STRIKE_RADIUS,
  ZEUS_STRIKE_MODIFIER,
} from '../components/ModifierComponent';

/**
 * When the holder's base attack lands, drop a directionless lightning hitbox on
 * the victim's CURRENT position for fixed bonus damage.
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
export class ZeusStrikeModifier implements IModifierHandler {
  public readonly id = ZEUS_STRIKE_MODIFIER;

  public onHit(event: HitEvent, context: ModifierContext): void {
    const world = context.world;

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
