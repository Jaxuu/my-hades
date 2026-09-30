/**
 * Meta-progression operations — the run/meta boundary (M13-T01).
 * See specs/21_hub_and_meta_progression_spec.md §4 (AC-02 / AC-03 / AC-04).
 *
 * Two free functions, and they are the ENTIRE write surface of `SaveState`:
 *
 *  - `bankRunDarkness` — the run's collected darkness becomes meta currency. This
 *    is the "结算" half of AC-02: a run EARNS darkness as it is played (on the
 *    player's wallet, exactly like gold) and the save is only written at the run
 *    boundary, so an abandoned or reloaded run cannot half-bank itself.
 *  - `tryPurchaseMetaUpgrade` — spend currency to unlock a permanent bonus.
 *
 * WHY FREE FUNCTIONS RATHER THAN METHODS ON `SaveState`: the same reason
 * `applyDamage` / `addGold` / `markRunFailed` are free functions — the data holder
 * stays a data holder, and the operations that need MORE than the data (a world to
 * read, a config table to price against) live where their dependencies are. This
 * module is also the one place that knows both "what a wallet is" and "what a
 * price is", which is exactly why neither `SaveState` nor the data layer has to.
 *
 * NO HIDDEN STATE, NO RANDOMNESS, NO CLOCK: both functions are pure reads of the
 * world and the config table plus a couple of writes to the save, so calling
 * either one twice with the same inputs cannot drift.
 */

import type { World } from '../ecs/World';
import { findPlayerInventory } from '../ecs/components/InventoryComponent';
import { DataManager } from '../data/DataManager';
import type { SaveState } from './SaveState';

/**
 * Move the run's collected darkness into the save, and zero the wallet's tally.
 *
 * Returns the amount banked (`0` when there is nothing to bank).
 *
 * ZEROING IS THE IDEMPOTENCE GUARD, not tidiness: the tally is the run's, the
 * `SaveState.darkness` is the save's, and the transfer must happen exactly once
 * per run. Without the zero, a second `enterHub()` — or a hub visited twice —
 * would pay the same run out twice.
 *
 * A world with NO wallet (a hand-assembled fixture, a run assembled without a
 * player) banks `0` and is a strict no-op: the opt-in shape every component
 * consumer in this engine follows.
 */
export function bankRunDarkness(world: World, saveState: SaveState): number {
  const wallet = findPlayerInventory(world);
  if (wallet === undefined || wallet.darkness <= 0) return 0;

  const banked = wallet.darkness;
  wallet.darkness = 0;
  saveState.addDarkness(banked);
  return banked;
}

/**
 * Spend `darkness` to unlock a meta upgrade.
 *
 * @returns `true` only when the purchase actually happened. Every other outcome —
 *   an id that is not in the config table, one that is already unlocked, one the
 *   player cannot afford — returns `false` WITHOUT throwing.
 *
 * That is deliberate: the only production caller is a DOM button, and a click
 * handler that throws is a click handler that can break the page. The hub UI
 * re-reads the save every frame, so a rejected click is simply a frame in which
 * nothing changed.
 *
 * The id is looked up through `hasMetaUpgrade` before `getMetaUpgradeConfig`
 * because a save may legitimately name an upgrade that a later config edit
 * removed — the purchase is refused, not crashed on (spec 21 I9).
 */
export function tryPurchaseMetaUpgrade(saveState: SaveState, upgradeId: string): boolean {
  if (!DataManager.hasMetaUpgrade(upgradeId)) return false;
  if (saveState.hasUpgrade(upgradeId)) return false;

  const config = DataManager.getMetaUpgradeConfig(upgradeId);
  if (saveState.darkness < config.cost) return false;

  saveState.addDarkness(-config.cost);
  saveState.unlockUpgrade(upgradeId);
  return true;
}
