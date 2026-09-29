/**
 * Room / encounter state. See specs/08_encounter_and_death_spec.md §3.2 / §4.3.
 *
 * POD component: data only, no behaviour. Every state transition lives in
 * `EncounterSystem`; this component is the WHOLE scheduler state, so the machine
 * is fully described by the snapshot and holds no cross-tick hidden state
 * (specs/00_harness_spec.md §6.1).
 *
 * Mounted on a GLOBAL SINGLETON entity — a bare "world entity" that owns nothing
 * else. It is deliberately NOT a spatial entity: a room has no position, no
 * hurtbox and no lifespan. `EncounterFactory.spawn` is the only writer of the
 * initial state; `EncounterSystem` is the only writer afterwards.
 *
 * The `isWaveCleared` helper below is a FREE FUNCTION (not a component method), so
 * the "components carry no behaviour" contract (spec 00 §6.1) stays intact — the
 * same shape `TagComponent.hasTag` and `HealthComponent.isAlive` follow.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';
import type { EnemySpawnOptions } from '../prefabs/spawn-helpers';
import { isDead } from './DeadTagComponent';

/**
 * The three states a room can be in (spec 08 AC-02).
 *
 * `IN_PROGRESS` and `WAVE_CLEAR` are both "the room is not finished"; they differ
 * in what the scheduler is waiting for — a fight to end, versus a timer to expire.
 */
export enum EncounterState {
  /** The current wave is live (or is about to spawn). The room is being fought. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** The current wave is wiped; the scheduler is counting down to the next spawn. */
  WAVE_CLEAR = 'WAVE_CLEAR',
  /** Every wave is wiped. The room is finished and the scheduler is inert. */
  ROOM_CLEARED = 'ROOM_CLEARED',
}

/**
 * `nextSpawnTick` sentinel: the pending wave has no scheduled spawn tick yet.
 *
 * Needed because `EncounterFactory.spawn` has no access to a tick — the component
 * is assembled OUTSIDE `step()`. The scheduler therefore schedules the first
 * pending wave lazily, on the first tick it observes it (spec 08 §4.3 rule 1),
 * which is also what makes an encounter loaded mid-run behave identically to one
 * loaded before tick 0.
 */
export const ENCOUNTER_WAVE_UNSCHEDULED = -1;

/**
 * One wave: how long to wait before it spawns, and what it spawns.
 *
 * `enemies` holds full `EnemySpawnOptions` (not a bare count), so a wave can place
 * and tune each enemy individually — the encounter layer is pure scheduling and
 * never re-implements entity assembly (spec 08 AC-05). Each entry is handed
 * verbatim to `EnemyFactory.spawn`.
 */
export interface EncounterWaveConfig {
  /**
   * Ticks to wait before this wave spawns, counted from the moment the wave
   * becomes PENDING:
   *  - wave 0 becomes pending on the first processed tick of the encounter;
   *  - wave `k > 0` becomes pending on the tick its predecessor was detected
   *    cleared.
   *
   * Must be a non-negative integer. `0` means "spawn as soon as it is pending".
   */
  readonly delayTicks: number;
  /** Non-empty list of enemy specs to spawn for this wave. */
  readonly enemies: readonly EnemySpawnOptions[];
}

export class EncounterStateComponent extends ComponentBase {
  /**
   * The room's total configuration, immutable for the lifetime of the encounter.
   * Held on the component (rather than in a module table) so the whole encounter —
   * config included — is visible in the snapshot and needs no external lookup to
   * replay.
   */
  public waves: readonly EncounterWaveConfig[];

  /** Current room state. */
  public state: EncounterState;

  /**
   * Index of the wave the scheduler is currently working on: the live wave while
   * `IN_PROGRESS`, and the PENDING wave while `WAVE_CLEAR`. Starts at `0`.
   */
  public currentWaveIndex: number;

  /**
   * Tick on which the pending wave spawns, or {@link ENCOUNTER_WAVE_UNSCHEDULED}.
   *
   * Stored as an absolute tick rather than a countdown ON PURPOSE (spec 08 §10
   * trade-off 2): a countdown cannot be started on the same tick the previous wave
   * is detected cleared without an off-by-one — the transition tick would either be
   * counted (spawning one tick early) or skipped (spawning one tick late). An
   * absolute deadline is exact for every wave, including the first one, which is
   * what makes AC-03's "exactly `delayTicks` ticks" assertable tick by tick.
   */
  public nextSpawnTick: number;

  /**
   * Ids of the enemies spawned for the CURRENT wave, ascending, in spawn order.
   *
   * Kept after the wave dies (never pruned) — that is what lets the scheduler ask
   * "is the wave I spawned gone?" without re-deriving membership. An EMPTY list is
   * the "this wave has not spawned yet" marker, which is why a wave is required to
   * declare at least one enemy.
   */
  public trackedEntityIds: EntityId[];

  constructor(
    waves: readonly EncounterWaveConfig[],
    state = EncounterState.IN_PROGRESS,
    currentWaveIndex = 0,
    nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED,
    trackedEntityIds: EntityId[] = [],
  ) {
    super();
    this.waves = waves;
    this.state = state;
    this.currentWaveIndex = currentWaveIndex;
    this.nextSpawnTick = nextSpawnTick;
    this.trackedEntityIds = trackedEntityIds;
  }
}

/**
 * Whether every entity the scheduler tracked for the current wave is GONE — dead
 * (tagged) or destroyed (recycled). This is the AC-03 predicate.
 *
 * An EMPTY list is NOT "cleared": it means the wave has not been spawned yet, and
 * reporting it as cleared would make the scheduler advance a wave it never fought.
 * That distinction is the entire reason this helper exists instead of an inline
 * `every(...)` at the call site.
 *
 * Deterministic and side-effect free: it only reads the world.
 */
export function isWaveCleared(world: World, trackedEntityIds: readonly EntityId[]): boolean {
  if (trackedEntityIds.length === 0) return false;
  for (const id of trackedEntityIds) {
    // "Gone" is `destroyed OR dead`, and `isDead` already implies alive — so the
    // two skip reasons stay distinct rather than being collapsed into one flag.
    const gone = !world.isAlive(id) || isDead(world, id);
    if (!gone) return false;
  }
  return true;
}
