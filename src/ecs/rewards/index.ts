/**
 * Reward / boon-draft vocabulary. See specs/11_roguelike_loop_spec.md.
 *
 * `RewardPool` owns which rewards exist and how a draft is drawn; `grantReward`
 * owns how a chosen reward becomes world state. Kept as two files because the two
 * have different audiences: the pool is read by the draft (logic) AND by the UI
 * (labels), while the grant is write-only logic the UI must never touch.
 */

export * from './RewardPool';
export * from './grantReward';
