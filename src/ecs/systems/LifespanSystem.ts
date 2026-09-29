/**
 * LifespanSystem — tick-based expiry + destruction of transient entities.
 * See specs/03_combat_hitbox_spec.md §5.3 and
 * specs/15_economy_and_victory_spec.md §4.3 (M9-T01 AC-01 / AC-02).
 *
 * Pipeline position: LAST. Running after CollisionSystem means a hitbox spawned on
 * tick T is collision-tested on ticks T .. T+L-1 and destroyed on tick T+L-1, i.e.
 * it gets exactly `activeTicks` ticks of active window rather than one fewer.
 *
 * Expiry is measured in Ticks (integers) on the component, never in wall-clock
 * time, so it is fps-independent and replay-exact. The system holds no hidden
 * cross-tick state (spec 00 §6.1).
 *
 * TWO transient kinds, one rule. As of M9-T01 this system owns the lifetime of
 * PICKUPS as well as hitboxes, and the split of responsibility is the same for
 * both: `PickupSystem` decides that a pickup was TAKEN (it marks it dead), and this
 * system turns that — or an expired fuse — into an actual removal at the end of
 * the tick. Keeping destruction here (rather than in the system that decides) is
 * what makes "a pickup exists for exactly `lifespanTicks` ticks" and "a hitbox
 * exists for exactly `activeTicks` ticks" two instances of one contract instead of
 * two rules that can drift apart.
 *
 * DELIBERATELY NOT gated on death (M4-T02, spec 08 §4.2): a hitbox is not a
 * combatant and has no `HealthComponent` — a corpse's in-flight swing still ages
 * out on schedule, keeping its full `activeTicks` window. Retirement of a DEAD
 * owner's swing is enforced where it belongs, at the point of use, by
 * `CollisionSystem`'s owner gate; expiring it early here would instead couple
 * expiry to a game concept and break the "a hitbox lives exactly `activeTicks`
 * ticks" contract that spec 03 §6 pins (spec 08 §10 trade-off 3).
 *
 * The same "death is a state, not an expiry" reading holds for pickups: a pickup
 * that was TAKEN is destroyed here because it is spent, and that is a different
 * question from "its fuse ran out" — both are answered below, in that order.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { HitboxComponent } from '../components/HitboxComponent';
import { PickupComponent } from '../components/PickupComponent';
import { isDead } from '../components/DeadTagComponent';

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

    this.agePickups(world);
  }

  /**
   * Remove collected pickups and age the rest (M9-T01, spec 15 AC-01 / AC-02).
   *
   * The two branches are checked in this order, and the order matters:
   *
   *  1. **TAKEN** (`isDead`) -> destroy outright. `PickupSystem` marked it this
   *     tick, which is the engine's one way to say "spent". It is NOT aged: a
   *     collected pickup has no fuse left to run.
   *  2. **Otherwise** -> decrement the fuse and destroy at `<= 0`, the exact rule
   *     the hitbox loop above uses. A pickup spawned with `lifespanTicks = N` on
   *     tick `T` is therefore collectable on ticks `T .. T+N-1` and gone at the end
   *     of `T+N-1` — `N` ticks of life, matching the hitbox contract bit for bit.
   *
   * A destroyed-but-taken pickup is the ONLY entity this milestone removes on
   * collection, and that asymmetry with combatants is intentional: a corpse is
   * retained because the encounter scheduler must still see it (spec 08 §10
   * trade-off 1), whereas nothing in the engine consumes a spent coin. Retaining
   * one would simply accumulate entities for the rest of the run.
   */
  private agePickups(world: World): void {
    for (const id of world.query(PickupComponent)) {
      if (isDead(world, id)) {
        world.destroyEntity(id);
        continue;
      }

      const pickup = world.getComponent(id, PickupComponent);
      if (pickup === undefined) continue;

      pickup.lifespanTicks -= 1;
      if (pickup.lifespanTicks <= 0) {
        world.destroyEntity(id);
      }
    }
  }
}
