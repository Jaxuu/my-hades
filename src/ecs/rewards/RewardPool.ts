/**
 * Reward pool — the data table the boon draft draws from (M6-T01).
 * See specs/11_roguelike_loop_spec.md §3.2 / §4.1.
 *
 * A reward is an IDENTIFIER, exactly like a modifier id (spec 05 §3.3): it carries
 * no behaviour, and the behaviour of granting it lives in `grantReward.ts`. This
 * file owns only two things — WHICH rewards exist, and HOW a draft is drawn from
 * them.
 *
 * The pool is a `const` module table rather than a registry class because nothing
 * varies per pipeline: unlike `ModifierRegistry` (whose handlers are per-simulator
 * instances), a reward definition is inert data that can be shared safely. Adding a
 * reward is "add one entry here + handle it in `grantReward`".
 */

import type { Random } from '../../core/Random';
import { DIONYSUS_BLIGHT_MODIFIER, ZEUS_STRIKE_MODIFIER } from '../components/ModifierComponent';

/** Reward id for the flat health reward (the one non-modifier grant). */
export const REWARD_HP_UP = 'hp_up';

/** Reward id for the dash-cooldown reward. */
export const REWARD_DASH_UP = 'dash_up';

/** Flat bonus to `maxHp` (and to `hp`, capped at the new ceiling) per `hp_up`. */
export const HP_UP_AMOUNT = 20;

/** Ticks shaved off the dash cooldown per `dash_up`. */
export const DASH_UP_COOLDOWN_REDUCTION = 10;

/**
 * Floor for the dash cooldown. Without it, stacking `dash_up` would eventually
 * reach `0` (or negative) ticks — an un-dodgeable, un-tunable state that no test
 * would catch until someone drafted it five times in a row.
 */
export const MIN_DASH_COOLDOWN_TICKS = 10;

/**
 * How many options a draft offers. Three is the genre convention and the number
 * AC-01 names; kept as a constant so the pool can grow without touching call sites.
 */
export const DEFAULT_REWARD_DRAFT_COUNT = 3;

/** One drawable reward: an id plus the label the presentation layer shows. */
export interface RewardDefinition {
  readonly id: string;
  /**
   * Human-readable name. Lives HERE (in the logic layer) rather than in the UI so
   * the draft and its labels can never drift apart — the UI reads this table
   * one-way (spec 09 AC-01) instead of keeping a second id -> label map.
   */
  readonly label: string;
}

/**
 * The global reward pool.
 *
 * MUST hold at least {@link DEFAULT_REWARD_DRAFT_COUNT} entries, or no draft could
 * ever be satisfied; `draftRewards` throws rather than silently returning a short
 * list, so a shrunken pool fails at the seam instead of producing a one-option
 * "choice".
 *
 * Ordered deterministically (and kept short) so the draw sequence for a given seed
 * is reproducible and easy to reason about in tests.
 */
export const REWARD_POOL: readonly RewardDefinition[] = [
  { id: ZEUS_STRIKE_MODIFIER, label: 'Zeus Strike' },
  { id: DIONYSUS_BLIGHT_MODIFIER, label: 'Dionysus Blight' },
  { id: REWARD_HP_UP, label: `Max HP +${String(HP_UP_AMOUNT)}` },
  { id: REWARD_DASH_UP, label: `Dash CD -${String(DASH_UP_COOLDOWN_REDUCTION)}` },
];

/** The definition for `id`, or `undefined` when the id is not a reward in this build. */
export function getRewardDefinition(id: string): RewardDefinition | undefined {
  return REWARD_POOL.find((reward) => reward.id === id);
}

/** Whether `id` names a reward in the shipped pool. */
export function isRewardId(id: string): boolean {
  return getRewardDefinition(id) !== undefined;
}

/**
 * Draw a draft: `count` DISTINCT reward ids, in draw order.
 *
 * The whole point of routing this through {@link Random} is determinism — the same
 * generator state always yields the same draft (spec 11 AC-01 / ADR-004). Distinctness
 * comes from `Random.sample`'s sampling without replacement, which is what makes
 * "three options" mean three *real* options.
 *
 * `pool` is injectable so a test can pin the draft against a tiny, known table
 * without depending on the shipped pool's size or order.
 *
 * @throws RangeError if `count` is not a non-negative integer or exceeds the pool.
 */
export function draftRewards(
  rng: Random,
  count: number = DEFAULT_REWARD_DRAFT_COUNT,
  pool: readonly RewardDefinition[] = REWARD_POOL,
): string[] {
  return rng.sample(pool, count).map((reward) => reward.id);
}
