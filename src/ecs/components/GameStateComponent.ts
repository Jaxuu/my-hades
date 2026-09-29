/**
 * Run-level game state (M8-T01, extended by M9-T01).
 * See specs/14_aoe_and_run_lifecycle_spec.md §3.3 / §4.4 (AC-02) and
 * specs/15_economy_and_victory_spec.md §3.4 / §4.4 (AC-04).
 *
 * POD component: data only, no behaviour. The mutation helpers below are FREE
 * FUNCTIONS (not component methods), so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact — the same shape
 * `DeadTagComponent` + `markDead` / `isDead` and `EncounterStateComponent` +
 * `findRewardDraft` already follow.
 *
 * WHY A SEPARATE COMPONENT RATHER THAN REUSING `DeadTagComponent`: death is a
 * per-ENTITY fact (this body is out of the fight), while `RUN_FAILED` is a
 * per-RUN fact (this attempt is over). An enemy dying must not end the run, and
 * a run ending must survive the player's corpse being retained (spec 08 §3.1 —
 * death is a state, not a delete). Collapsing the two would make "who died"
 * and "is the game over" the same question, and the first thing that breaks is
 * a future revive / second player.
 *
 * Mounted on a GLOBAL SINGLETON — a bare "world entity" owning nothing else,
 * exactly like the room singleton `EncounterStateComponent` lives on. A game
 * state has no position, no hurtbox and no lifespan, so giving it a
 * `TransformComponent` would be inventing data that means nothing (and, worse,
 * would put it into every `(Transform, …)` query in the engine).
 *
 * OPT-IN, and that is load-bearing: the component is assembled by
 * `GameStateFactory.spawn`, which only the composition root (and the M8 test
 * suite) calls. A world without it reads as `PLAYING` forever, so every M1–M7
 * test — which knows nothing about runs — keeps behaving bit-for-bit as before
 * (spec 14 AC-11).
 */

import { ComponentBase } from '../Component';
import type { World } from '../World';

/**
 * The three states a run can be in (spec 14 AC-02, spec 15 AC-04).
 *
 * Deliberately minimal. The interesting thing is not the number of states but the
 * direction of the transitions: `PLAYING -> RUN_FAILED` happens exactly once, from
 * exactly one place (`DeathSystem`), `PLAYING -> RUN_WON` happens exactly once,
 * from exactly one place (`EncounterSystem`), and the only way back from either is
 * `GameSimulator.restartRun`, which rebuilds the world wholesale (spec 14 I7).
 *
 * The two terminal states are SIBLINGS, not a chain: a run cannot be both won and
 * lost, and neither may be entered from the other. `isRunOver` is the predicate
 * that expresses "no run-level decision is left to make", and it is what every
 * consumer that used to ask `isRunFailed` now asks — so a won run is exactly as
 * inert as a lost one without a second gate anywhere.
 */
export enum GameStatus {
  /** The run is live: the player acts and the encounter scheduler advances. */
  PLAYING = 'PLAYING',
  /** The player is dead. The run is over; only a restart continues. */
  RUN_FAILED = 'RUN_FAILED',
  /** Every room is cleared. The run is over; only a restart continues. */
  RUN_WON = 'RUN_WON',
}

export class GameStateComponent extends ComponentBase {
  /** Current run status. Written only by `DeathSystem` and `GameStateFactory`. */
  public status: GameStatus;

  constructor(status: GameStatus = GameStatus.PLAYING) {
    super();
    this.status = status;
  }
}

/**
 * The run's singleton component, or `undefined` when the world has no run state.
 *
 * The single read-side accessor, shared by its three logic consumers
 * (`DeathSystem`, `PlayerControllerSystem`, `EncounterSystem`) and by the
 * presentation layer. One helper rather than four inline scans keeps "which
 * entity is the run, and what counts as failed" in exactly one place — the same
 * argument `findRewardDraft` records for the boon draft.
 *
 * Returns the LIVE component (not a copy) so `DeathSystem` can write through it.
 * The render layer's read-only contract (spec 09 AC-01) is what stops the UI
 * from mutating it.
 *
 * Ascending id order (`World.query`) keeps the choice deterministic if a future
 * build ever manages to assemble two — the first one wins, forever.
 */
export function findGameState(world: World): GameStateComponent | undefined {
  for (const id of world.query(GameStateComponent)) {
    const state = world.getComponent(id, GameStateComponent);
    if (state !== undefined) return state;
  }
  return undefined;
}

/**
 * Whether the run has failed. A world with NO game state is never failed — the
 * opt-in reading that keeps every pre-M8 world unchanged (spec 14 AC-11).
 */
export function isRunFailed(world: World): boolean {
  return findGameState(world)?.status === GameStatus.RUN_FAILED;
}

/**
 * Mark the run as failed. Idempotent, and a strict no-op when the world has no
 * game-state singleton (a world that never assembled a run cannot fail one).
 *
 * Free function rather than a component method, and the ONE write point for the
 * transition: `DeathSystem` is the only caller, which is what makes "the run
 * fails at most once, on the tick the player dies" true by construction.
 */
export function markRunFailed(world: World): void {
  const state = findGameState(world);
  if (state === undefined) return;
  state.status = GameStatus.RUN_FAILED;
}

/**
 * Whether the run has been WON (M9-T01, spec 15 AC-04). A world with NO game
 * state is never won — the same opt-in reading {@link isRunFailed} records.
 */
export function isRunWon(world: World): boolean {
  return findGameState(world)?.status === GameStatus.RUN_WON;
}

/**
 * Mark the run as won. Idempotent, and a strict no-op when the world has no
 * game-state singleton (a world that never assembled a run cannot win one).
 *
 * Free function rather than a component method, and the ONE write point for the
 * transition: `EncounterSystem` is the only caller — it is the single place that
 * knows "the final room's last wave is gone", which is the whole of AC-04. That
 * makes "a run is won at most once, on the tick the last room is cleared" true by
 * construction.
 *
 * Note it does NOT clear `pendingRewards`: a won run has no draft by
 * construction (the final room never rolls one), and reaching here from a
 * hand-assembled room that DID open one leaves the draft exactly as it was, so
 * the world never silently contradicts itself.
 */
export function markRunWon(world: World): void {
  const state = findGameState(world);
  if (state === undefined) return;
  state.status = GameStatus.RUN_WON;
}

/**
 * Whether the run is OVER — failed or won (M9-T01).
 *
 * The predicate every "the run has stopped making decisions" gate asks, so a won
 * run is inert in exactly the same places a lost one is, with no second boolean
 * to keep in sync. A world with no game state is never over (spec 14 AC-11).
 */
export function isRunOver(world: World): boolean {
  const status = findGameState(world)?.status;
  return status === GameStatus.RUN_FAILED || status === GameStatus.RUN_WON;
}
