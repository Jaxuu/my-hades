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
 *  5. otherwise apply damage and record the target in `hitEntities`
 *  6. then write the hit FEEDBACK (M2-T02): hitstop on both sides, HITSTUN on the
 *     victim, and a knockback velocity pointing away from the hitbox centre.
 *
 * Step 4 is the heart of the invulnerability contract: an i-frame hit is IGNORED
 * ENTIRELY — no damage AND no `hitEntities` entry. That is what lets the same
 * hitbox connect later, once the window has lapsed (spec 03 §4.4). The M2-T02
 * feedback (step 6) is likewise only written on a hit that actually LANDS, so an
 * i-frame hit does not freeze or knock back either.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { normalizeVec2, scaleVec2, vec2 } from '../../core/math';
import { TransformComponent } from '../components/TransformComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import { HurtboxComponent } from '../components/HurtboxComponent';
import { FactionComponent, areHostile } from '../components/FactionComponent';
import { HealthComponent, applyDamage } from '../components/HealthComponent';
import { ActionState, StateComponent } from '../components/StateComponent';
import { applyFreeze } from '../components/FreezeComponent';
import { KnockbackComponent } from '../components/KnockbackComponent';
import { INVULNERABLE_TAG, hasTag } from '../components/TagComponent';

export class CollisionSystem implements System {
  public readonly name = 'CollisionSystem';

  public update(world: World, _ctx: SystemContext): void {
    const hitboxIds = world.query(TransformComponent, HitboxComponent);
    if (hitboxIds.length === 0) return;

    const targetIds = world.query(
      TransformComponent,
      HurtboxComponent,
      FactionComponent,
      HealthComponent,
    );
    if (targetIds.length === 0) return;

    for (const hitboxId of hitboxIds) {
      const hitboxTransform = world.getComponent(hitboxId, TransformComponent);
      const hitbox = world.getComponent(hitboxId, HitboxComponent);
      if (hitboxTransform === undefined || hitbox === undefined) continue;

      for (const targetId of targetIds) {
        if (targetId === hitboxId) continue;
        if (hitbox.hitEntities.includes(targetId)) continue;

        const targetTransform = world.getComponent(targetId, TransformComponent);
        const hurtbox = world.getComponent(targetId, HurtboxComponent);
        const targetFaction = world.getComponent(targetId, FactionComponent);
        if (targetTransform === undefined || hurtbox === undefined || targetFaction === undefined) {
          continue;
        }

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

        applyDamage(world, targetId, hitbox.damage);
        hitbox.hitEntities.push(targetId);
        hitbox.hitEntities.sort((a, b) => a - b);

        // --- M2-T02 hit feedback (only for a hit that actually landed) ---------

        // Hitstop freezes BOTH sides for `hitstopTicks` ticks (spec 04 AC-01).
        applyFreeze(world, targetId, hitbox.hitstopTicks);
        if (world.isAlive(hitbox.ownerEntityId)) {
          applyFreeze(world, hitbox.ownerEntityId, hitbox.hitstopTicks);
        }

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
  }
}
