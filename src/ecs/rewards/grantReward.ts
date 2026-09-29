/**
 * Reward settlement — turning a chosen reward id into world state (M6-T01).
 * See specs/11_roguelike_loop_spec.md §4.4.
 *
 * A FREE FUNCTION (not a method on a component or a system), for the same reason
 * `addModifier` / `applyDamage` / `markDead` are: components stay POD (spec 00
 * §6.1), and the grant logic stays callable from a test without standing up a whole
 * pipeline.
 *
 * TWO KINDS OF GRANT, and the split is deliberate:
 *
 *  - **Modifier rewards** (the overwhelming majority) are granted by mounting their
 *    id on the player's `ModifierComponent`. `grantReward` does NOT know what a
 *    given boon does — the behaviour lives in an `IModifierHandler` and is dispatched
 *    by `ModifierSystem` on the next landed hit (spec 05 §4.2). Adding a boon reward
 *    is therefore "add a pool entry"; this file does not change.
 *  - **Stat rewards** (`hp_up` / `dash_up`) write a component field directly. They
 *    are not boons — nothing is "held" and nothing reacts to a hit — so modelling
 *    them as a modifier id with no handler would produce a reward that visibly does
 *    nothing. They are the reason this function exists at all instead of the caller
 *    just calling `addModifier`.
 *
 * Idempotence mirrors `addModifier`: re-granting a modifier reward is a no-op (the
 * list is deduplicated), so a reward can never stack through this API. Stat rewards
 * DO stack additively — that is the intended reading of "max HP +20" as a repeated
 * reward.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { addModifier } from '../components/ModifierComponent';
import { HealthComponent } from '../components/HealthComponent';
import { DashStatsComponent } from '../components/DashStatsComponent';
import {
  DASH_UP_COOLDOWN_REDUCTION,
  HP_UP_AMOUNT,
  MIN_DASH_COOLDOWN_TICKS,
  REWARD_DASH_UP,
  REWARD_HP_UP,
  getRewardDefinition,
} from './RewardPool';

/**
 * Apply `rewardId` to `entityId`.
 *
 * @returns `true` when the reward was applied, `false` when nothing happened —
 *   either because the id is not a reward in this build, or because the entity is
 *   gone. Returning a boolean (rather than throwing) keeps the caller free to treat
 *   "unknown id" as a silently-ignored data-table mismatch, the same way
 *   `ModifierSystem` treats an id with no registered handler (spec 05 §4.2).
 *
 * Never mutates the reward pool or the entity's identity: it only writes component
 * data. Fully deterministic — no clock, no randomness, no allocation of entities.
 */
export function grantReward(world: World, entityId: EntityId, rewardId: string): boolean {
  if (getRewardDefinition(rewardId) === undefined) return false;
  if (!world.isAlive(entityId)) return false;

  if (rewardId === REWARD_HP_UP) {
    const health = world.getComponent(entityId, HealthComponent);
    if (health === undefined) return false;
    // "Raise the base pool AND top it up by the same amount": a reward that raised
    // the ceiling without healing would leave the player at a LOWER health fraction
    // than before they took it, which reads as a punishment.
    health.maxHp += HP_UP_AMOUNT;
    health.hp = Math.min(health.maxHp, health.hp + HP_UP_AMOUNT);
    return true;
  }

  if (rewardId === REWARD_DASH_UP) {
    const dash = world.getComponent(entityId, DashStatsComponent);
    if (dash === undefined) return false;
    // Floored so repeated picks cannot drive the cooldown to zero or below.
    dash.cooldownTicks = Math.max(
      MIN_DASH_COOLDOWN_TICKS,
      dash.cooldownTicks - DASH_UP_COOLDOWN_REDUCTION,
    );
    return true;
  }

  // Every other reward is a boon: mounting the modifier id IS the whole grant. Its
  // behaviour is dispatched later, from the modifier registry, on a landed hit.
  addModifier(world, entityId, rewardId);
  return true;
}
