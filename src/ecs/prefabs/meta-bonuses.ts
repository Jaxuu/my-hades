/**
 * Meta-bonus resolution — "what do my unlocked upgrades DO to a body" (M13-T01).
 * See specs/21_hub_and_meta_progression_spec.md §3.3 / §4.4 (AC-04).
 *
 * WHY THIS FILE EXISTS, AND WHY IT SITS IN THE PREFAB LAYER
 * --------------------------------------------------------
 * The save stores IDS (`thick_skin`), not numbers. Turning ids into numbers needs
 * two things that must not be allowed to drift apart:
 *
 *  - the CONFIG table (`assets/data/meta_upgrades.json`), which says a
 *    `MAX_HP` upgrade is worth `50` — owned by the data layer;
 *  - the MEANING of `MAX_HP` — "add it to `HealthComponent.maxHp`" — which is a
 *    fact about entity assembly, and therefore lives in the prefab layer, next to
 *    `spawnCombatant` that consumes it.
 *
 * So this is the one module that bridges the two, and it is deliberately NOT a
 * system and NOT part of `step()`: it runs ONCE per run, inside `runSetup`, when
 * there is no tick to be deterministic about and a `SchemaError` is still allowed
 * to abort loudly. By the time a tick runs, the bonuses are plain numbers on
 * `CombatantSpawnOptions` and nothing inside the loop can throw.
 *
 * STALE IDS ARE SKIPPED, NOT REJECTED
 * -----------------------------------
 * A save can name an upgrade that a later config edit removed or renamed. That is
 * a NORMAL consequence of a save outliving a build, not corruption, so it grants
 * nothing rather than aborting the run (spec 21 I9). The alternative — throwing —
 * would make a rename a boot failure for every player who had bought the thing.
 */

import { DataManager } from '../../data/DataManager';

/**
 * The aggregate of every unlocked upgrade, as ADDITIVE deltas.
 *
 * Three plain numbers rather than a list of effects, because that is all
 * `spawnCombatant` needs: it is assembling one body, and two upgrades of the same
 * type must stack. A list would push the summation into the assembly seam, where
 * it would have to be repeated for every consumer.
 */
export interface MetaBonuses {
  /** Added to `HealthComponent.maxHp` (and therefore to the starting `hp`). */
  readonly maxHp: number;
  /** Added to `VelocityComponent.maxSpeed`. */
  readonly moveSpeed: number;
  /** Ticks removed from `DashStatsComponent.cooldownTicks`, floored at `1`. */
  readonly dashCooldownReductionTicks: number;
}

/**
 * The identity element: no upgrades owned, no deltas. A frozen shared constant so
 * "a run with no meta progression" allocates nothing and compares equal to itself.
 */
export const NO_META_BONUSES: MetaBonuses = Object.freeze({
  maxHp: 0,
  moveSpeed: 0,
  dashCooldownReductionTicks: 0,
});

/**
 * Sum the effects of every unlocked upgrade.
 *
 * Deterministic and order-independent (addition commutes), and a no-op for an
 * empty list — which is what every pre-M13 caller and every fresh save gets.
 *
 * Duplicated ids are counted ONCE: `SaveState` already guarantees uniqueness, but
 * a hand-built list must not be able to buy the same bonus twice by repeating
 * itself.
 *
 * @throws SchemaError only for a MALFORMED config table — never for an unknown id
 *   (those are skipped; see the file docstring).
 */
export function resolveMetaBonuses(unlockedUpgrades: readonly string[]): MetaBonuses {
  let maxHp = 0;
  let moveSpeed = 0;
  let dashCooldownReductionTicks = 0;

  for (const id of new Set(unlockedUpgrades)) {
    // The existence probe is what makes a stale save id harmless. It is asked
    // BEFORE the getter, because the getter throws on an unknown id by design.
    if (!DataManager.hasMetaUpgrade(id)) continue;

    const config = DataManager.getMetaUpgradeConfig(id);
    switch (config.type) {
      case 'MAX_HP':
        maxHp += config.value;
        break;
      case 'MOVE_SPEED':
        moveSpeed += config.value;
        break;
      case 'DASH_COOLDOWN_REDUCTION':
        dashCooldownReductionTicks += config.value;
        break;
    }
  }

  return { maxHp, moveSpeed, dashCooldownReductionTicks };
}
