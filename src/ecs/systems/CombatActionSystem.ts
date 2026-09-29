/**
 * CombatActionSystem — attack entry + hitbox spawn. See specs/03_combat_hitbox_spec.md §5.1
 * and specs/04_combat_feedback_spec.md §4.7.
 *
 * Pipeline position: AFTER StateSystem (so the action state for this tick is
 * settled before we decide whether an attack may start) and BEFORE CollisionSystem
 * (so a hitbox spawned this tick can already connect this tick).
 *
 * Trigger semantics (M2-T02): the attack fires on the entity's logical intent pulse
 * `IntentComponent.wantsToAttack`, which is CLEARED as soon as it is read, and only
 * when the entity is neither DASHING, ATTACKING nor HITSTUN. One press therefore
 * yields exactly one attack — holding the button does not chain attacks
 * (spec 03 §4.3). Reading intent (not hardware) lets an AI-driven enemy attack
 * without owning an input device.
 *
 * Frozen entities are skipped entirely (spec 04 §4.7).
 *
 * DEAD entities are skipped before even that (M4-T02, spec 08 §4.2): a corpse
 * cannot swing. Skipping before the pulse read-and-clear is deliberate — the pulse
 * is a one-tick wire between an intent producer and this consumer, and a corpse's
 * intent has already been neutralised by `DeathSystem`, so there is nothing left to
 * consume and nothing to buffer.
 *
 * Holds NO cross-tick hidden state: every timing decision lives on
 * `StateComponent.ticksInState` (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { vec2 } from '../../core/math';
import { ActionState, StateComponent } from '../components/StateComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isFrozen } from '../components/FreezeComponent';
import { isDead } from '../components/DeadTagComponent';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent } from '../components/FactionComponent';
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

      // Read-and-clear the one-tick attack pulse.
      const wantsToAttack = intent.wantsToAttack;
      intent.wantsToAttack = false;

      if (!wantsToAttack) continue;
      // Cannot start an attack mid-dash, mid-attack or mid-hitstun (spec 03 §4.3).
      if (
        state.state === ActionState.DASHING ||
        state.state === ActionState.ATTACKING ||
        state.state === ActionState.HITSTUN
      ) {
        continue;
      }

      state.state = ActionState.ATTACKING;
      state.ticksInState = 0;

      // Spawn the hitbox in front of the attacker, along its current facing.
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
}
