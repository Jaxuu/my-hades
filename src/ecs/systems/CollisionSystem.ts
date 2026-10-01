/**
 * CollisionSystem — pure-math circle overlap between hitboxes and hurtboxes.
 * See specs/03_combat_hitbox_spec.md §5.2 and specs/04_combat_feedback_spec.md §4.8.
 *
 * No physics engine, no broadphase, no spatial hash: the hitbox and hurtbox sets
 * are tiny, so an exhaustive id-ascending double loop is both the fastest and the
 * most obviously deterministic option (spec 00 §6.1 — no wall clock, no randomness).
 *
 * Resolution order per (hitbox, target) pair:
 *  1. skip if the target was already struck by THIS hitbox  -> AC-03 multi-hit guard
 *  2. skip if same faction                                 -> AC-01 no friendly fire
 *  3. skip if circles do not overlap                       -> AC-03 circle test
 *  4. skip if the target carries the Invulnerable tag      -> AC-04 i-frame consumption
 *  5. otherwise settle the damage — through ARMOR first (M6-T02), so only the
 *     overflow reaches HP — and record the target in `hitEntities`
 *  6. then write the hit FEEDBACK (M2-T02): hitstop on both sides, HITSTUN on the
 *     victim, and a knockback velocity pointing away from the hitbox centre. The
 *     hitstop is unconditional; HITSTUN + knockback are SKIPPED while the target's
 *     armor stands (M6-T02).
 *  7. then EMIT a `HitEvent` (M3-T01) on the shared event bus, carrying the
 *     hitbox's `sourceModifier` verbatim so a modifier can never re-trigger
 *     itself (spec 05 AC-04).
 *  8. then RETIRE the hitbox if it is marked `destroyOnHit` (M7-T01, spec 13 AC-04):
 *     the entity is destroyed and this hitbox's target loop ends, so a projectile can
 *     never reach a second victim. Only `false` (every pre-M7 hitbox) keeps the
 *     historic "the circle persists and may strike every hostile in it" behaviour.
 *
 * Step 4 is the heart of the invulnerability contract: an i-frame hit is IGNORED
 * ENTIRELY — no damage, no `hitEntities` entry, no feedback AND no event. That is
 * what lets the same hitbox connect later, once the window has lapsed (spec 03
 * §4.4). The M2-T02 feedback (step 6) is likewise only written on a hit that
 * actually LANDS, so an i-frame hit does not freeze or knock back either.
 *
 * Step 6 is GATED (M3-T01): a hitbox that requests NEITHER hitstop NOR knockback
 * (both `0`) injects pure damage and writes no feedback at all. Modifier-injected
 * hitboxes use this — a `zeus_strike` bolt must not extend the hitstop it lands
 * during, nor overwrite (zero out) the knockback the triggering hit wrote, since
 * `KnockbackComponent` is a last-writer-wins overwrite (spec 04 §4.4 / spec 05
 * §4.6). Every pre-M3 configuration keeps at least one of the two fields > 0, so
 * its behaviour is bit-for-bit unchanged.
 *
 * DEATH GATES (M4-T02, spec 08 §4.2). Two guards, in this order, make "dead
 * entities do not collide" true at the producer:
 *
 *  a. **Owner gate** — a hitbox whose owner is DEAD is skipped wholesale, before
 *     the target loop. A corpse's swing is inert: its in-flight hitboxes deal no
 *     damage, write no feedback and publish no event. (Note this is keyed on the
 *     DEATH TAG, not on `world.isAlive`: a hitbox whose owner was *destroyed* keeps
 *     working, which is the pre-M4 contract — the hitbox snapshots its faction and
 *     is an independent entity precisely so it survives its owner. Only DEATH
 *     retires a swing, because death is the one state the whole engine agrees on.)
 *  b. **Target gate** — a dead target is skipped, so a corpse can never be hit.
 *     This is what root-fixes "corpse-whipping": no repeated damage settlements, no
 *     chained hitstop on a body that is already down, and no `hitEntities` entry to
 *     feed a later hit.
 *
 * A THIRD guard closes the same-tick hole those two cannot see. Death is marked at
 * the END of the tick (`DeathSystem` runs later), so within the tick that kills an
 * entity the tag is not set yet — two different hitboxes could both settle on it,
 * the second one writing a redundant (and potentially much longer) hitstop. A
 * target whose `hp` is already `0` is therefore skipped as well: `applyDamage`
 * clamps at `0`, so `hp <= 0` is an exact "already out of hit points" predicate and
 * needs no extra bookkeeping. One entity, one settlement per tick.
 *
 * What is deliberately NOT guarded: an attacker whose `hp` reaches `0` earlier in
 * the SAME tick's resolution still lands its own swing. Tick resolution is atomic —
 * AC-01 constrains "from the NEXT tick onwards", and a mutual kill on the same tick
 * is two simultaneous hits, not corpse-whipping (spec 08 §8).
 *
 * ARMOR (M6-T02, spec 12 AC-01 / AC-02). Damage no longer goes straight to HP: the
 * settlement routes through `applyDamageWithArmor`, which drains an entity's armor
 * FIRST and only lets the overflow reach HP. The same call reports whether the
 * target was `armoredThrough` — armor standing before the hit and surviving it —
 * and that single boolean splits the hit FEEDBACK in two:
 *
 *  - **Hitstop is NEVER gated by armor.** Hitstop is juice, not a reaction: an
 *    armored enemy that eats a hit without flinching must still feel like it was
 *    hit (spec 12 I3). `applyFreeze` therefore stays outside the armor gate, for
 *    both the victim and the attacker.
 *  - **`HITSTUN` and knockback ARE gated.** While the armor stands the target keeps
 *    its action state and its plan, so an enemy's windup survives a non-breaking
 *    hit — which is the entire point of the mechanic. The hit that BREAKS the armor
 *    (`armoredThrough === false`) staggers normally, and so does every hit after it.
 *
 * An entity with no `ArmorComponent`, or one whose armor is already broken, reports
 * `armoredThrough === false` and takes exactly the pre-M6 path (spec 12 I4).
 *
 * This system stays POLICY-FREE (spec 05 C8): it reports that a hit happened; it
 * never decides what a boon should do about it.
 *
 * PIERCING (M11-T01, spec 18 AC-02). Step 8 above is now a two-branch settlement. If
 * the hitbox still has `pierceCount > 0`, a landed hit SPENDS one pierce and decays
 * `damage` by `(1 - damageFalloff)` for the FOLLOW-UP targets, then the target loop
 * `continue`s to the next candidate instead of retiring the hitbox. Only when the
 * allowance is exhausted does the historic `destroyOnHit` retirement apply. With the
 * default `pierceCount === 0` the new branch is never taken, so every pre-M11 hitbox
 * behaves bit-for-bit as before. The loop is a finite array over a set that only
 * shrinks, and every target is guarded by `hitEntities`, so piercing can never loop
 * forever within a single tick.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { normalizeVec2, scaleVec2, vec2 } from '../../core/math';
import { EventQueue } from '../events';
import type { HitEvent } from '../events';
import { TransformComponent } from '../components/TransformComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import { HurtboxComponent } from '../components/HurtboxComponent';
import { FactionComponent, areHostile } from '../components/FactionComponent';
import { HealthComponent } from '../components/HealthComponent';
import { applyDamageWithArmor } from '../components/ArmorComponent';
import { ActionState, StateComponent } from '../components/StateComponent';
import { applyFreeze } from '../components/FreezeComponent';
import { KnockbackComponent } from '../components/KnockbackComponent';
import { INVULNERABLE_TAG, hasTag } from '../components/TagComponent';
import { isDead } from '../components/DeadTagComponent';

export class CollisionSystem implements System {
  public readonly name = 'CollisionSystem';

  /**
   * Tick-scoped event bus. Injected so the SAME queue instance is shared with
   * ModifierSystem (see `createDefaultSystems`); the default keeps the system
   * usable standalone, but a standalone instance's events are never drained.
   */
  private readonly events: EventQueue;

  constructor(events: EventQueue = new EventQueue()) {
    this.events = events;
  }

  public update(world: World, ctx: SystemContext): void {
    const hitboxIds = world.query(TransformComponent, HitboxComponent);
    if (hitboxIds.length === 0) return;

    const targetIds = world.query(
      TransformComponent,
      HurtboxComponent,
      FactionComponent,
      HealthComponent,
    );
    const targetCount = targetIds.length;
    if (targetCount === 0) return;

    // M15-T01 LOSSLESS SPEEDUP — PRECOMPUTE THE TARGET HALF OF THE PAIR LOOP
    // ----------------------------------------------------------------------
    // This is a `hitboxes x targets` double loop, so the target side is visited once
    // per hitbox. The pre-M15 shape resolved four `World.getComponent` calls AND an
    // `isDead` (another lookup) inside that inner loop, i.e. ~5 redundant lookups per
    // (hitbox, target) pair. The M15 stress profile showed that at ~0.16s over 600
    // ticks with only a handful of live hitboxes.
    //
    // Every one of those reads is loop-invariant here. `TransformComponent` object
    // identity, `HurtboxComponent`, `FactionComponent` and dead-ness are all FIXED
    // for the duration of this pass: nothing in `CollisionSystem` moves a body
    // (`MovementSystem` already ran), and nothing tags a corpse (death is written by
    // `DeathSystem`, later in the pipeline). Only `HealthComponent.hp` mutates — and
    // that is exactly why the component REFERENCE is cached and `hp` is still read
    // live below, preserving the "an entity that ran out of hit points earlier this
    // tick is already settled" gate bit-for-bit.
    const targetTransforms: (TransformComponent | undefined)[] = [];
    const targetHurtboxes: (HurtboxComponent | undefined)[] = [];
    const targetFactions: (FactionComponent | undefined)[] = [];
    const targetHealths: (HealthComponent | undefined)[] = [];
    const targetDead: boolean[] = [];
    for (const id of targetIds) {
      targetTransforms.push(world.getComponent(id, TransformComponent));
      targetHurtboxes.push(world.getComponent(id, HurtboxComponent));
      targetFactions.push(world.getComponent(id, FactionComponent));
      targetHealths.push(world.getComponent(id, HealthComponent));
      targetDead.push(isDead(world, id));
    }

    for (const hitboxId of hitboxIds) {
      const hitboxTransform = world.getComponent(hitboxId, TransformComponent);
      const hitbox = world.getComponent(hitboxId, HitboxComponent);
      if (hitboxTransform === undefined || hitbox === undefined) continue;

      // (a) Owner gate: a dead entity's swing is inert (M4-T02, spec 08 §4.2).
      // Checked once per hitbox, before the target loop — it is a property of the
      // swing, not of any particular target.
      if (isDead(world, hitbox.ownerEntityId)) continue;

      for (let k = 0; k < targetCount; k += 1) {
        const targetId = targetIds[k];
        if (targetId === undefined) continue;
        if (targetId === hitboxId) continue;
        if (hitbox.hitEntities.includes(targetId)) continue;

        // (b) Target gate: a corpse is not a hit target at all (M4-T02, spec 08
        // §4.2). Placed before the component fetch and the geometry test so a dead
        // body costs one array read, never a distance computation.
        if (targetDead[k] === true) continue;

        const targetTransform = targetTransforms[k];
        const hurtbox = targetHurtboxes[k];
        const targetFaction = targetFactions[k];
        const targetHealth = targetHealths[k];
        if (
          targetTransform === undefined ||
          hurtbox === undefined ||
          targetFaction === undefined ||
          targetHealth === undefined
        ) {
          continue;
        }

        // (c) Same-tick gate: an entity that ran out of hit points earlier in THIS
        // tick is already settled. Without it, two hitboxes landing on the same
        // victim in the same tick would both apply damage and both write feedback
        // (chained hitstop) — the tag is not set until the tick ends (spec 08 §4.2).
        if (targetHealth.hp <= 0) continue;

        // AC-01 — same side never damages itself.
        if (!areHostile(hitbox.faction, targetFaction.faction)) continue;

        // AC-03 — circle overlap: dist < r1 + r2. Compared as squares so the test
        // needs no square root; both sides are non-negative, so the strict
        // inequality is preserved (spec 03 §5.2).
        const dx = targetTransform.x - hitboxTransform.x;
        const dy = targetTransform.y - hitboxTransform.y;
        const radiusSum = hitbox.radius + hurtbox.radius;
        if (dx * dx + dy * dy >= radiusSum * radiusSum) continue;

        // AC-04 — invulnerability consumption: ignore the collision completely.
        if (hasTag(world, targetId, INVULNERABLE_TAG)) continue;

        // Damage settlement, routed through armor FIRST (M6-T02, spec 12 AC-02):
        // armor soaks `min(current, damage)` and only the overflow reaches HP.
        // `armoredThrough` is the hit-feedback switch below: true means "armor was
        // standing and survived this hit", i.e. the target shrugs it off.
        const armorResult = applyDamageWithArmor(world, targetId, hitbox.damage);
        hitbox.hitEntities.push(targetId);
        hitbox.hitEntities.sort((a, b) => a - b);

        // --- M2-T02 hit feedback (only for a hit that actually landed) ---------
        //
        // Gated (M3-T01): feedback is what the hitbox ASKS for. A hitbox with
        // neither hitstop nor knockback is a pure-damage tick and writes nothing
        // — critically, it must not overwrite the victim's in-flight knockback.
        if (hitbox.hitstopTicks > 0 || hitbox.knockbackForce > 0) {
          // Hitstop freezes BOTH sides for `hitstopTicks` ticks (spec 04 AC-01).
          //
          // DELIBERATELY OUTSIDE the armor gate (M6-T02, spec 12 I3): armor blocks
          // the target's REACTION, never the juice. An armored enemy that eats a hit
          // without flinching must still read as "hit" to both players' hands.
          applyFreeze(world, targetId, hitbox.hitstopTicks);
          if (world.isAlive(hitbox.ownerEntityId)) {
            applyFreeze(world, hitbox.ownerEntityId, hitbox.hitstopTicks);
          }

          // Armor gate (M6-T02, spec 12 AC-01): while the target's armor STANDS it
          // is immune to hitstun AND knockback — it keeps its action state and its
          // plan. The hit that BREAKS the armor reports `armoredThrough === false`,
          // so it staggers normally (spec 12 AC-02), as does every later hit.
          if (!armorResult.armoredThrough) {
            // The victim enters HITSTUN (spec 04 AC-03). Missing StateComponent => skip.
            //
            // The counter is seeded at 1, not 0. HITSTUN is entered HERE, and
            // CollisionSystem runs AFTER StateSystem, so tick `T` is never counted by the
            // state machine. Seeding at 1 (mirroring how ATTACKING counts its own entry
            // tick, which IS counted because CombatActionSystem runs before StateSystem)
            // makes the observable stun span equal DEFAULT_HITSTUN_TICKS exactly.
            const targetState = world.getComponent(targetId, StateComponent);
            if (targetState !== undefined) {
              targetState.state = ActionState.HITSTUN;
              targetState.ticksInState = 1;
            }

            // Knockback direction = from the hitbox centre towards the victim centre.
            // If that vector degenerates (centres coincide), fall back to the hitbox's
            // own facing so the victim is still pushed somewhere deterministic.
            const away = normalizeVec2(vec2(dx, dy));
            const direction =
              away.x === 0 && away.y === 0
                ? vec2(Math.cos(hitboxTransform.facingRadians), Math.sin(hitboxTransform.facingRadians))
                : away;

            // Re-adding overwrites, so the LAST hit of a tick decides the knockback.
            world.addComponent(targetId, new KnockbackComponent(scaleVec2(direction, hitbox.knockbackForce)));
          }
        }

        // --- M3-T01 event hook (AC-01) ----------------------------------------
        //
        // Published AFTER the hit is fully resolved, so a consumer that reacts by
        // injecting new entities sees a world in which the triggering hit has
        // already taken effect. `sourceModifier` travels with the event so the
        // consumer can refuse to re-enter modifier dispatch (spec 05 §4.5).
        const event: HitEvent = {
          tick: ctx.tick,
          attackerId: hitbox.ownerEntityId,
          targetId,
          hitboxEntityId: hitboxId,
          position: vec2(hitboxTransform.x, hitboxTransform.y),
          damage: hitbox.damage,
          sourceModifier: hitbox.sourceModifier,
        };
        this.events.emit(event);

        // M11-T01 (spec 18 AC-02) — PIERCING. While the hitbox still has pierce
        // allowance, a landed hit does NOT retire it: the allowance is spent, the
        // damage is decayed for the FOLLOW-UP targets, and the target loop carries
        // on. `hitEntities` already holds this target (pushed above), so the
        // multi-hit guard makes `continue` skip it on any later tick and there is no
        // way to strike the same victim twice.
        //
        // The loop is a finite array over a set that only shrinks, and every target
        // is guarded by `hitEntities`, so this cannot iterate forever within a tick.
        // The `HitEvent` ABOVE carries the damage THIS hit was owed — the decay
        // applies strictly to the hits that follow, never to the one just resolved.
        if (hitbox.pierceCount > 0) {
          hitbox.pierceCount -= 1;
          hitbox.damage = hitbox.damage * (1 - hitbox.damageFalloff);
          continue;
        }

        // M7-T01 (spec 13 AC-04 / I5) — a PIERCELESS hitbox retires on its first
        // landed hit. Destroying the entity here, rather than merely marking it, is
        // what makes "one projectile, one victim" true by construction: the entity
        // is gone, so no later pass can yield it again, and the `break` ends THIS
        // hitbox's target loop so no second settlement can happen in the same tick.
        //
        // The order matters: the ledger entry (`hitEntities`) and the `HitEvent` are
        // both written ABOVE, so a retired projectile still reports exactly what it
        // struck on the tick it retired. `break` (not `continue`) because there is
        // nothing left to test against.
        if (hitbox.destroyOnHit) {
          world.destroyEntity(hitboxId);
          break;
        }
      }
    }
  }
}
