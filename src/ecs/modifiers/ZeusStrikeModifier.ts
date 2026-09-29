/**
 * Zeus Strike — the reference `IModifierHandler`.
 * See specs/05_boon_modifier_spec.md §4.3 / AC-03,
 * specs/06_status_effect_and_dot_spec.md §3.5 and
 * specs/16_data_driven_pipeline_spec.md §4.2 (M10-T01).
 *
 * Behaviour is UNCHANGED from M3-T01; only its home and its numbers moved. It used
 * to be a private method on `ModifierSystem`, then a handler with hard-coded
 * constants; as of M10 it is a handler that is HANDED its hitbox parameters at
 * construction time (from `assets/data/modifiers.json`). The tick-phase reasoning
 * below is load-bearing and is carried over verbatim from spec 05.
 *
 * The parameters arrive through the constructor rather than being looked up on
 * every hit on purpose: a hit happens inside `step()`, and `step()` must never
 * consult the config registry — not for performance, but because a lookup that can
 * throw is a lookup that can abort a simulation mid-tick. Reading once, at
 * registry construction (i.e. in the Bootstrap phase), makes "the bolt's numbers
 * are known-good" a property of the handler rather than a hope.
 */

import type { HitEvent } from '../events';
import type { ModifierContext, IModifierHandler } from './ModifierRegistry';
import type { ModifierConfig } from '../../data/schemas';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent } from '../components/FactionComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import { ZEUS_STRIKE_MODIFIER } from '../components/ModifierComponent';

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

  /**
   * The bolt's parameters, read once from the config table. Immutable for the
   * handler's lifetime, so the handler stays stateless with respect to TICKS
   * (spec 00 §6.1) while still being parameterised by data.
   */
  private readonly config: ModifierConfig;

  public constructor(config: ModifierConfig) {
    this.config = config;
  }

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
        this.config.radius,
        this.config.damage,
        // The schema guarantees this is >= 2: we run after CollisionSystem, so
        // this tick's test is already over, and LifespanSystem decrements at the
        // end of this tick. 2 leaves exactly one collision test, on the next tick
        // (spec 05 §4.4).
        this.config.lifespanTicks,
        faction,
        event.attackerId,
        this.config.hitstopTicks, // pure damage in the shipped table
        this.config.knockbackForce, // pure damage in the shipped table
        [], // hitEntities
        ZEUS_STRIKE_MODIFIER, // anti-recursion provenance
      ),
    );
  }
}
