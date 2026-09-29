/**
 * CombatActionSystem — attack / cast entry + hitbox spawn.
 * See specs/03_combat_hitbox_spec.md §5.1, specs/04_combat_feedback_spec.md §4.7 and
 * specs/13_arena_and_projectiles_spec.md §4.3 (M7-T01 AC-03).
 *
 * Pipeline position: AFTER StateSystem (so the action state for this tick is
 * settled before we decide whether an action may start) and BEFORE CollisionSystem
 * (so a hitbox — or a projectile — spawned this tick can already connect this tick).
 *
 * TWO actions are consumed here, both on the entity's logical intent pulses:
 *
 *  - `wantsToAttack` -> a MELEE hitbox: a static circle spawned just in front of the
 *    attacker along its facing, which then lives out its `activeTicks` window.
 *  - `wantsToCast`   -> a PROJECTILE (M7-T01): an independent flying entity with its
 *    own `VelocityComponent`, which retires on the first thing it touches. This is
 *    the structural difference between the two — a melee swing is a fixed circle in
 *    space, a cast is a moving one — and it is why `spawnProjectile` exists rather
 *    than a second `HitboxComponent` literal here.
 *
 * Trigger semantics (M2-T02, extended in M7-T01): each pulse is CLEARED as soon as it
 * is read — unconditionally, BEFORE the state gate — so a pulse raised in a state
 * that cannot act is DROPPED, never buffered. One press therefore yields exactly one
 * action, and holding the button does not chain (spec 03 §4.3). If both pulses arrive
 * on the same tick the ATTACK wins and the cast pulse is dropped: one action per tick,
 * and the attack is the primary.
 *
 * Reading intent (not hardware) lets an AI-driven enemy attack without owning an
 * input device.
 *
 * Frozen entities are skipped entirely (spec 04 §4.7).
 *
 * DEAD entities are skipped before even that (M4-T02, spec 08 §4.2): a corpse
 * cannot swing. Skipping before the pulse read-and-clear is deliberate — the pulse
 * is a one-tick wire between an intent producer and this consumer, and a corpse's
 * intent has already been neutralised by `DeathSystem`, so there is nothing left to
 * consume and nothing to buffer.
 *
 * CASTING DOES NOT TOUCH `ActionState`. A projectile is asynchronous damage: it
 * leaves the caster free, so there is no commitment window to model and no new branch
 * in the action-state machine. The gate below still refuses a cast mid-dash /
 * mid-swing / mid-stun, so a cast can never be used as a cancel. Adding a real cast
 * commitment (and a cost/cooldown) is a separate, explicitly deferred design — see
 * spec 13 §10 trade-off 2.
 *
 * Holds NO cross-tick hidden state: every timing decision lives on
 * `StateComponent.ticksInState` (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import { vec2 } from '../../core/math';
import { ActionState, StateComponent } from '../components/StateComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isFrozen } from '../components/FreezeComponent';
import { isDead } from '../components/DeadTagComponent';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent } from '../components/FactionComponent';
import { spawnProjectile } from '../components/ProjectileComponent';
import {
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS,
  DEFAULT_ATTACK_HITBOX_OFFSET,
  DEFAULT_ATTACK_HITBOX_RADIUS,
  HitboxComponent,
} from '../components/HitboxComponent';

export class CombatActionSystem implements System {
  public readonly name = 'CombatActionSystem';

  public update(world: World, _ctx: SystemContext): void {
    const ids = world.query(
      IntentComponent,
      StateComponent,
      TransformComponent,
      FactionComponent,
    );

    for (const id of ids) {
      // Death first: a corpse raises no new hitbox (spec 08 §4.2).
      if (isDead(world, id)) continue;
      if (isFrozen(world, id)) continue;

      const intent = world.getComponent(id, IntentComponent);
      const state = world.getComponent(id, StateComponent);
      const transform = world.getComponent(id, TransformComponent);
      const faction = world.getComponent(id, FactionComponent);
      if (
        intent === undefined ||
        state === undefined ||
        transform === undefined ||
        faction === undefined
      ) {
        continue;
      }

      // Read-and-clear BOTH one-tick action pulses, unconditionally and before any
      // gate: a pulse the gate rejects is dropped here, never buffered.
      const wantsToAttack = intent.wantsToAttack;
      intent.wantsToAttack = false;
      const wantsToCast = intent.wantsToCast;
      intent.wantsToCast = false;

      // Neither an attack nor a cast may start mid-dash, mid-swing or mid-stun
      // (spec 03 §4.3, spec 13 §4.3).
      const blocked =
        state.state === ActionState.DASHING ||
        state.state === ActionState.ATTACKING ||
        state.state === ActionState.HITSTUN;

      if (wantsToAttack && !blocked) {
        this.startAttack(world, id, state, transform, faction);
        continue;
      }

      if (wantsToCast && !blocked) {
        spawnProjectile(world, {
          x: transform.x,
          y: transform.y,
          directionRadians: transform.facingRadians,
          faction: faction.faction,
          ownerEntityId: id,
        });
      }
    }
  }

  /**
   * Enter `ATTACKING` and spawn the melee hitbox in front of the attacker, along its
   * current facing.
   *
   * Unlike a projectile this hitbox is a FIXED circle in world space — it owns no
   * `VelocityComponent` and never moves — so it is also never wall-resolved
   * (`MovementSystem.resolveWalls` only visits bodies that move).
   */
  private startAttack(
    world: World,
    id: EntityId,
    state: StateComponent,
    transform: TransformComponent,
    faction: FactionComponent,
  ): void {
    state.state = ActionState.ATTACKING;
    state.ticksInState = 0;

    const direction = vec2(Math.cos(transform.facingRadians), Math.sin(transform.facingRadians));
    const hitbox = world.createEntity();
    world.addComponent(
      hitbox.id,
      new TransformComponent(
        transform.x + direction.x * DEFAULT_ATTACK_HITBOX_OFFSET,
        transform.y + direction.y * DEFAULT_ATTACK_HITBOX_OFFSET,
        transform.facingRadians,
      ),
    );
    world.addComponent(
      hitbox.id,
      new HitboxComponent(
        DEFAULT_ATTACK_HITBOX_RADIUS,
        DEFAULT_ATTACK_DAMAGE,
        DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS,
        faction.faction,
        id,
      ),
    );
  }
}
