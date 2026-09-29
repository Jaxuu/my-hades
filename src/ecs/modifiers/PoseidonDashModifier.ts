/**
 * Poseidon Dash — the reference `onDash` handler.
 * See specs/12_armor_and_dash_boons_spec.md §3.5 / §4.4 (AC-04).
 *
 * Where Zeus Strike injects on a landed HIT, this handler injects on a DASH ENTRY:
 * the instant its holder enters `DASHING`, a self-centred shockwave hitbox appears —
 * large radius, high knockback, low damage (AC-04). It is the first boon driven by
 * the action hook rather than the hit hook, and its existence is the proof that the
 * modifier engine reacts to EVENTS, not specifically to hits.
 *
 * CENTRED ON THE DASHER, not offset along the facing: "dash through a crowd" should
 * scatter the crowd, not poke the one enemy in front. `event.position` is the
 * dasher's origin at the moment of entry, which is the right anchor precisely
 * because the body will have moved by the time the blast is tested.
 *
 * Tick phase (spec 12 §4.4): `DashSystem` emits the `DashEvent` on tick `T`;
 * `ModifierSystem` consumes it LATER IN THE SAME TICK and spawns the blast.
 * `CollisionSystem` has already run by then, so the blast gets its single collision
 * test on `T+1` — the same one-tick phase the Zeus bolt has, and the reason its
 * lifespan is `2` rather than `1`.
 *
 * Feedback: the blast asks for knockback but NO hitstop (`0`), so the victims are
 * staggered and blown away while the dasher keeps moving — a dash boon must never
 * clip its own mobility. Because `knockbackForce > 0`, `CollisionSystem`'s feedback
 * gate is open, so the victims DO enter `HITSTUN`; that is not a side effect but the
 * mechanism, since `MovementSystem` only integrates knockback during hitstun
 * (spec 04 AC-03).
 *
 * The blast carries `sourceModifier = POSEIDON_DASH_MODIFIER`, so any hit IT lands
 * is dropped by the anti-recursion gate and can never re-enter modifier dispatch
 * (spec 05 AC-04).
 *
 * This boon has NO on-hit behaviour, so `onHit` is a documented no-op — see
 * spec 12 §10 trade-off 2 for why `onHit` stays required and a dash-only boon pays
 * one empty method instead.
 */

import type { DashEvent, HitEvent } from '../events';
import type { IModifierHandler, ModifierContext } from './ModifierRegistry';
import { FactionComponent } from '../components/FactionComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import { TransformComponent } from '../components/TransformComponent';
import {
  DEFAULT_POSEIDON_DASH_DAMAGE,
  DEFAULT_POSEIDON_DASH_HITSTOP_TICKS,
  DEFAULT_POSEIDON_DASH_KNOCKBACK,
  DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS,
  DEFAULT_POSEIDON_DASH_RADIUS,
  POSEIDON_DASH_MODIFIER,
} from '../components/ModifierComponent';

export class PoseidonDashModifier implements IModifierHandler {
  public readonly id = POSEIDON_DASH_MODIFIER;

  /**
   * No on-hit behaviour: this boon is driven entirely by dashes. Present because
   * `IModifierHandler.onHit` is the mandatory half of the interface.
   */
  public onHit(_event: HitEvent, _context: ModifierContext): void {
    // Intentionally empty — see the class docstring.
  }

  /**
   * Detonate a self-centred shockwave at the dasher's origin.
   *
   * The blast inherits the dasher's FACTION, so `CollisionSystem`'s same-side gate
   * keeps the dasher (and any ally) out of it — the dasher is additionally protected
   * by its own dash i-frames.
   */
  public onDash(event: DashEvent, context: ModifierContext): void {
    const world = context.world;

    const faction = world.getComponent(event.entityId, FactionComponent);
    if (faction === undefined) return;

    const blast = world.createEntity();
    world.addComponent(
      blast.id,
      // The blast is DIRECTIONLESS in effect (it is a circle centred on the dasher),
      // but the facing is derived from the LOCKED dash direction rather than pinned
      // to 0: it is what CollisionSystem falls back to for the knockback direction
      // when a victim's centre coincides with the blast centre, and "keep going the
      // way you dashed" is the only sensible answer there.
      new TransformComponent(
        event.position.x,
        event.position.y,
        Math.atan2(event.direction.y, event.direction.x),
      ),
    );
    world.addComponent(
      blast.id,
      new HitboxComponent(
        DEFAULT_POSEIDON_DASH_RADIUS,
        DEFAULT_POSEIDON_DASH_DAMAGE,
        DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS,
        faction.faction,
        event.entityId,
        DEFAULT_POSEIDON_DASH_HITSTOP_TICKS,
        DEFAULT_POSEIDON_DASH_KNOCKBACK,
        [], // hitEntities — nothing struck yet
        POSEIDON_DASH_MODIFIER, // anti-recursion provenance
      ),
    );
  }
}
