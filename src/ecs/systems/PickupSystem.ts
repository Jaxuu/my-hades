/**
 * PickupSystem — the ground-loot overlap test (M9-T01).
 * See specs/15_economy_and_victory_spec.md §4.2 (AC-02).
 *
 * Pipeline position: the M9-T01 INSERTION, immediately BEFORE `LifespanSystem`
 * (which stays LAST). Three halves of that slot are forced:
 *
 *  - AFTER `MovementSystem` (index 5), which is the whole point: the overlap test
 *    must use the position the collector ENDED the tick at, so "walk onto the
 *    coin" means the coin is taken on the tick the walk completed rather than one
 *    tick later. Running earlier would test last tick's position and make every
 *    pickup read as collected a tick late.
 *  - AFTER `DeathSystem` (index 12), so a pickup dropped by THIS tick's deaths is
 *    already in the world and can be taken on the same tick. That is the "the drop
 *    and its collection live in one tick boundary" contract, and it is why the
 *    drop (a death) and the collection (a walk) never disagree about which tick
 *    they belong to. (Contrast `ModifierSystem`'s injected blasts, which need
 *    `activeTicks = 2` precisely because they are injected after their consumer.)
 *  - BEFORE `LifespanSystem`, so a pickup taken this tick is removed at the end of
 *    this tick rather than lingering for a frame. `LifespanSystem` is the
 *    destroyer; this system only marks.
 *
 * WHAT IT DOES, and nothing more:
 *
 *   1. stop entirely while the run is OVER (failed or won);
 *   2. for each pickup (ascending id), test it against each collector;
 *   3. on the first overlap, apply the effect and MARK the pickup dead.
 *
 * Step 3 marks rather than destroys, and that split is deliberate: `markDead` is
 * the engine's one way to say "this entity is spent" (spec 08 §3.1), and
 * `LifespanSystem` — the system whose whole job is destroying transient entities —
 * is what turns that fact into a removal at the end of the same tick. One
 * transition, one owner, and "collected" is observable in the snapshot for the
 * remainder of the tick instead of vanishing mid-system.
 *
 * WHY NOTHING HERE CAN PRODUCE HITSTUN OR HITSTOP (the milestone's hard
 * requirement): hitstop and `HITSTUN` are written in exactly ONE place in this
 * engine — `CollisionSystem`, from a landed hitbox. A pickup owns no
 * `HitboxComponent` (spec 15 I1), so `CollisionSystem`'s producer query
 * `(Transform, HitboxComponent)` can never yield one, and this system writes
 * neither field. The guarantee is structural, not a convention this file has to
 * remember to honour.
 *
 * Holds NO cross-tick hidden state: the only fields are the pickup's own component
 * data and the collector's wallet. The class owns nothing but its name.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import { TransformComponent } from '../components/TransformComponent';
import { HurtboxComponent } from '../components/HurtboxComponent';
import { HealthComponent } from '../components/HealthComponent';
import { PlayerInputComponent } from '../components/PlayerInputComponent';
import { InventoryComponent } from '../components/InventoryComponent';
import { PickupComponent, PickupKind } from '../components/PickupComponent';
import { isDead, markDead } from '../components/DeadTagComponent';
import { isRunOver } from '../components/GameStateComponent';

export class PickupSystem implements System {
  public readonly name = 'PickupSystem';

  public update(world: World, _ctx: SystemContext): void {
    const pickupIds = world.query(PickupComponent, TransformComponent);
    if (pickupIds.length === 0) return;

    // M9-T01: a run that is OVER collects nothing. Evaluated ONCE per tick, before
    // the loops, so the verdict cannot differ between two pickups within a tick —
    // the same shape `EncounterSystem`'s run gate uses. The dead-collector gate
    // below already covers `RUN_FAILED` (a failed run implies a dead player); this
    // gate is what covers `RUN_WON`, where the player is very much alive and may be
    // standing on a coin when the last room falls. Without it the win screen would
    // sit over a world that keeps paying out, which is precisely the "the game
    // carries on" behaviour spec 14 AC-06 forbids for waves.
    if (isRunOver(world)) return;

    // The collector set is the PLAYER, resolved structurally: a device (spec 01
    // §3.3), a body radius to measure against, and a wallet to pay into. Requiring
    // the wallet is deliberate — a hand-assembled "player" with no
    // `InventoryComponent` has nowhere to put a coin, and consuming the coin for
    // nothing would be worse than leaving it on the ground.
    const collectorIds = world.query(
      PlayerInputComponent,
      TransformComponent,
      HurtboxComponent,
      InventoryComponent,
    );
    if (collectorIds.length === 0) return;

    for (const pickupId of pickupIds) {
      // A pickup already spent this tick (or one that will be removed by
      // `LifespanSystem` at the end of it) is not collectable again.
      if (isDead(world, pickupId)) continue;

      const pickup = world.getComponent(pickupId, PickupComponent);
      const pickupTransform = world.getComponent(pickupId, TransformComponent);
      if (pickup === undefined || pickupTransform === undefined) continue;

      for (const collectorId of collectorIds) {
        // A corpse collects nothing (spec 08 §4.2) — the standard death gate.
        if (isDead(world, collectorId)) continue;

        const collectorTransform = world.getComponent(collectorId, TransformComponent);
        const hurtbox = world.getComponent(collectorId, HurtboxComponent);
        const inventory = world.getComponent(collectorId, InventoryComponent);
        if (
          collectorTransform === undefined ||
          hurtbox === undefined ||
          inventory === undefined
        ) {
          continue;
        }

        // Circle overlap, compared as squares so the test needs no square root —
        // the exact predicate `CollisionSystem` uses, including the strict `<`:
        // a pickup that merely TOUCHES the body is not collected, so standing
        // exactly at the edge is a stable "not yet taken" state rather than a
        // one-tick flicker. The radius sum uses the collector's HURTBOX, which is
        // this engine's one existing definition of "this entity's body".
        const dx = collectorTransform.x - pickupTransform.x;
        const dy = collectorTransform.y - pickupTransform.y;
        const radiusSum = pickup.radius + hurtbox.radius;
        if (dx * dx + dy * dy >= radiusSum * radiusSum) continue;

        this.applyEffect(world, pickup, collectorId, inventory);
        markDead(world, pickupId);
        // One pickup, one collector: the pickup is spent, so there is nothing left
        // to test it against this tick.
        break;
      }
    }
  }

  /**
   * Grant the pickup's effect to `collectorId`.
   *
   * `GOLD` pays into the wallet. `HEAL` tops the body up, CLAMPED at `maxHp` — a
   * heal that overshot the ceiling would be invisible in the HUD and would make
   * "picking up a flask at full health" silently destroy value, so clamping is the
   * honest reading rather than an edge case to document away. A collector with no
   * `HealthComponent` is a silent no-op for the heal branch, exactly like every
   * other opt-in component read.
   *
   * `DARKNESS` (M13-T01) pays into the wallet's SECOND ledger — the run's
   * out-of-run tally — and deliberately stops there: banking it into the save is a
   * run-boundary event (`GameSimulator.enterHub`), not a per-pickup write, so a run
   * that is abandoned cannot half-bank itself (spec 21 AC-02 / I3). Like `GOLD`, it
   * needs only the wallet, so a collector without one is skipped by the target
   * query rather than handled here.
   *
   * Deliberately writes NOTHING else: no freeze, no action state, no knockback, no
   * event. Picking up loot is not a hit, and the milestone requires that it cannot
   * be mistaken for one.
   */
  private applyEffect(
    world: World,
    pickup: PickupComponent,
    collectorId: EntityId,
    inventory: InventoryComponent,
  ): void {
    if (pickup.kind === PickupKind.GOLD) {
      inventory.gold += pickup.amount;
      return;
    }

    if (pickup.kind === PickupKind.DARKNESS) {
      inventory.darkness += pickup.amount;
      return;
    }

    const health = world.getComponent(collectorId, HealthComponent);
    if (health === undefined) return;
    health.hp = Math.min(health.maxHp, health.hp + pickup.amount);
  }
}
