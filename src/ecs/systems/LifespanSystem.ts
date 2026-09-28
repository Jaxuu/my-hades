/**
 * LifespanSystem — tick-based expiry + destruction of transient entities.
 * See specs/03_combat_hitbox_spec.md §5.3.
 *
 * Pipeline position: LAST. Running after CollisionSystem means a hitbox spawned on
 * tick T is collision-tested on ticks T .. T+L-1 and destroyed on tick T+L-1, i.e.
 * it gets exactly `activeTicks` ticks of active window rather than one fewer.
 *
 * Expiry is measured in Ticks (integers) on the component, never in wall-clock
 * time, so it is fps-independent and replay-exact. The system holds no hidden
 * cross-tick state (spec 00 §6.1).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { HitboxComponent } from '../components/HitboxComponent';

export class LifespanSystem implements System {
  public readonly name = 'LifespanSystem';

  public update(world: World, _ctx: SystemContext): void {
    // `query` returns a fresh ascending array, so destroying entities while we
    // iterate it is safe and stays deterministic.
    for (const id of world.query(HitboxComponent)) {
      const hitbox = world.getComponent(id, HitboxComponent);
      if (hitbox === undefined) continue;

      hitbox.activeTicks -= 1;
      if (hitbox.activeTicks <= 0) {
        world.destroyEntity(id);
      }
    }
  }
}
