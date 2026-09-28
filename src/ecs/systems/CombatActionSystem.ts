/**
 * CombatActionSystem — attack entry + hitbox spawn. See specs/03_combat_hitbox_spec.md §5.1.
 *
 * Pipeline position: AFTER StateSystem (so the action state for this tick is
 * settled before we decide whether an attack may start) and BEFORE CollisionSystem
 * (so a hitbox spawned this tick can already connect this tick).
 *
 * Trigger semantics: the attack fires on the RISING EDGE of the attack button
 * (`buttonAttackJustPressed`), never on the held level, and only when the entity is
 * neither DASHING nor already ATTACKING. One press therefore yields exactly one
 * attack — holding the button does not chain attacks (spec 03 §4.3).
 *
 * Holds NO cross-tick hidden state: every timing decision lives on
 * `StateComponent.ticksInState` (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { vec2 } from '../../core/math';
import { ActionState, StateComponent } from '../components/StateComponent';
import { InputComponent } from '../components/InputComponent';
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
      InputComponent,
      StateComponent,
      TransformComponent,
      FactionComponent,
    );

    for (const id of ids) {
      const input = world.getComponent(id, InputComponent);
      const state = world.getComponent(id, StateComponent);
      const transform = world.getComponent(id, TransformComponent);
      const faction = world.getComponent(id, FactionComponent);
      if (
        input === undefined ||
        state === undefined ||
        transform === undefined ||
        faction === undefined
      ) {
        continue;
      }

      if (!input.buttonAttackJustPressed) continue;
      // Cannot start an attack mid-dash or mid-attack (spec 03 §4.3).
      if (state.state === ActionState.DASHING || state.state === ActionState.ATTACKING) continue;

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
        ),
      );
    }
  }
}
