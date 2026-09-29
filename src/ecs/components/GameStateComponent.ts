/**
 * Run-level game state (M8-T01).
 * See specs/14_aoe_and_run_lifecycle_spec.md §3.3 / §4.4 (AC-02).
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
 * The two states a run can be in (spec 14 AC-02).
 *
 * Deliberately minimal for this milestone. The interesting thing is not the
 * number of states but the direction of the transition: `PLAYING -> RUN_FAILED`
 * happens exactly once, from exactly one place (`DeathSystem`), and the only
 * way back is `GameSimulator.restartRun`, which rebuilds the world wholesale
 * (spec 14 I7).
 */
export enum GameStatus {
  /** The run is live: the player acts and the encounter scheduler advances. */
  PLAYING = 'PLAYING',
  /** The player is dead. The run is over; only a restart continues. */
  RUN_FAILED = 'RUN_FAILED',
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
