/**
 * The player's carried wealth (M9-T01).
 * See specs/15_economy_and_victory_spec.md §3.2 / §4.2 (AC-02).
 *
 * POD component: data only, no behaviour. The mutation helper below is a FREE
 * FUNCTION (not a component method), so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact — the same shape
 * `HealthComponent` + `applyDamage` already follows.
 *
 * WHY A SEPARATE COMPONENT rather than a field on `HealthComponent` or a new
 * column on the encounter singleton: gold is a PER-ENTITY fact (this body owns
 * this much money), exactly like HP, and it must survive a restart the same way
 * everything else does — by the entity being rebuilt. Hanging it off the run
 * singleton would make "who owns this gold" unanswerable the moment a second
 * wallet exists.
 *
 * WHAT IS DELIBERATELY NOT HERE: equipment. A boon the player picked is already
 * carried by `ModifierComponent` (spec 05 §3.3), and duplicating it into an
 * `equipment` list would create a second source of truth that drifts the first
 * time a modifier is added by a path that does not know about this file. "The
 * restart clears the player's equipment" is therefore asserted against
 * `ModifierComponent`, not against a copy of it.
 *
 * Mounted by `spawnCombatant` whenever `hardwareInput` is true — i.e. on the
 * player and ONLY the player, alongside `PlayerInputComponent` (spec 01 §3.3).
 * That keeps "assembly lives in exactly one place" true and means an AI enemy can
 * never accidentally be given a wallet.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

export class InventoryComponent extends ComponentBase {
  /**
   * Gold held. Non-negative; every write goes through {@link addGold}, which
   * clamps at `0`.
   */
  public gold: number;

  /**
   * Darkness held BY THIS RUN (M13-T01).
   *
   * The run-local tally of the out-of-run currency. It is a component field, and
   * not a write straight into `SaveState`, for three reasons that all follow from
   * the engine's own rules:
   *
   *  1. **It is simulation state.** "How much did this run collect" must be
   *     snapshot-visible and replay-exact (spec 00 §6.1); a value written into a
   *     structure that `snapshot()` does not contain would be hidden state.
   *  2. **It is destroyed with the run.** A restart rebuilds the player, so the
   *     tally resets for free — no explicit clearing, and no way to forget it.
   *  3. **Banking stays a run-boundary event.** `GameSimulator.enterHub` moves
   *     this number into the save and zeroes it (`bankRunDarkness`), which is the
   *     ONE place a run can affect meta progression (AC-02's 结算 point).
   *
   * Non-negative; every write goes through {@link addDarkness}, which clamps at `0`.
   */
  public darkness: number;

  constructor(gold = 0, darkness = 0) {
    super();
    this.gold = gold;
    this.darkness = darkness;
  }
}

/**
 * Add `amount` gold to `entityId`. No-op when the entity has no
 * `InventoryComponent` (the opt-in shape every component consumer follows).
 *
 * Negative amounts are legal and clamped at `0`: "spend gold" is the obvious next
 * use of this function, and a clamp is a cheaper contract than a second
 * `spendGold` with its own affordability check. Deterministic — pure arithmetic,
 * no clock, no randomness.
 *
 * @returns `true` when a wallet was found and written, `false` otherwise.
 */
export function addGold(world: World, entityId: EntityId, amount: number): boolean {
  const inventory = world.getComponent(entityId, InventoryComponent);
  if (inventory === undefined) return false;
  inventory.gold = Math.max(0, inventory.gold + amount);
  return true;
}

/**
 * The FIRST entity's wallet, in ascending id order, or `undefined`.
 *
 * Only the player carries one (see the file docstring), so this is "the player's
 * wallet" in practice — and it is the single read-side accessor shared by
 * `PickupSystem` (which writes through the component it fetches) and by the
 * presentation layer's HUD. Ascending order keeps the choice deterministic if a
 * future build ever has two wallets: the first one wins, forever.
 */
export function findPlayerInventory(world: World): InventoryComponent | undefined {
  for (const id of world.query(InventoryComponent)) {
    const inventory = world.getComponent(id, InventoryComponent);
    if (inventory !== undefined) return inventory;
  }
  return undefined;
}

/**
 * Add `amount` darkness to `entityId` (M13-T01). No-op when the entity has no
 * `InventoryComponent` (the opt-in shape every component consumer follows).
 *
 * The exact twin of {@link addGold}, including the clamp at `0` and the legality
 * of negative amounts — but note that a NEGATIVE write here is not a purchase: it
 * would only ever be a refund, because spending darkness happens against
 * `SaveState` in the hub, not against a run's tally.
 *
 * @returns `true` when a wallet was found and written, `false` otherwise.
 */
export function addDarkness(world: World, entityId: EntityId, amount: number): boolean {
  const inventory = world.getComponent(entityId, InventoryComponent);
  if (inventory === undefined) return false;
  inventory.darkness = Math.max(0, inventory.darkness + amount);
  return true;
}

/**
 * The player's gold, or `0` when the world has no wallet.
 *
 * A read-side convenience for the HUD, so the render layer never has to encode
 * "no wallet means zero" itself (spec 09 AC-01 — the renderer reads, it does not
 * reason about the logic layer's shape).
 */
export function readGold(world: World): number {
  return findPlayerInventory(world)?.gold ?? 0;
}

/**
 * The run's collected darkness, or `0` when the world has no wallet (M13-T01).
 *
 * The `readGold` twin, and the number the in-run HUD shows. NOTE it is NOT
 * `SaveState.darkness`: this is what the CURRENT run has picked up and not yet
 * banked. The two are equal only immediately after `enterHub`.
 */
export function readDarkness(world: World): number {
  return findPlayerInventory(world)?.darkness ?? 0;
}
