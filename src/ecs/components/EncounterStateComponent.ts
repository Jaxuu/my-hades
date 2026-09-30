/**
 * Room / encounter state. See specs/08_encounter_and_death_spec.md §3.2 / §4.3,
 * specs/11_roguelike_loop_spec.md §3.1 and specs/15_economy_and_victory_spec.md
 * §3.5 (M9-T01 room sequence).
 *
 * POD component: data only, no behaviour. Every state transition lives in
 * `EncounterSystem`; this component is the WHOLE scheduler state, so the machine
 * is fully described by the snapshot and holds no cross-tick hidden state
 * (specs/00_harness_spec.md §6.1).
 *
 * Mounted on a GLOBAL SINGLETON entity — a bare "world entity" that owns nothing
 * else. It is deliberately NOT a spatial entity: a room has no position, no
 * hurtbox and no lifespan. `EncounterFactory.spawn` is the only writer of the
 * initial state; `EncounterSystem` is the only writer afterwards, EXCEPT for the
 * reward settlement hand-off (M6-T01): `RewardSystem` clears `pendingRewards` and
 * descends the room (spec 11 AC-04) — and, as of M9-T01, it also advances
 * `currentRoomIndex` and swaps `waves` for the next room's configuration
 * (spec 15 AC-03). Those two systems are the only writers, and they write
 * disjoint transitions.
 *
 * The `isWaveCleared` / `findRewardDraft` / `isFinalRoom` helpers below are FREE
 * FUNCTIONS (not component methods), so the "components carry no behaviour"
 * contract (spec 00 §6.1) stays intact — the same shape `TagComponent.hasTag` and
 * `HealthComponent.isAlive` follow.
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
 * One candidate enemy spawn position, in world units (M12-T01, spec 19 §3.5).
 *
 * Deliberately NOT a `TransformComponent` and not a `Vec2` from `core/math`: it is
 * the *address* of a tile's centre, produced by `LevelLoader` from the room grid
 * and consumed by `EncounterSystem` as a placement. Declaring it here — where the
 * field that holds it lives — keeps the components layer free of any dependency on
 * the loader, and keeps the shape plainly POD (two numbers, no methods).
 */
export interface SpawnPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One wave: how long to wait before it spawns, and what it spawns.
 *
 * `enemies` holds full `EnemySpawnSpec` entries — an enemy TYPE id plus that
 * entity's placement (M10-T01) — so a wave can place each enemy individually while
 * every balance number still comes from one config table. The encounter layer is
 * pure scheduling and never re-implements entity assembly (spec 08 AC-05); each
 * entry is handed verbatim to `EnemyFactory.spawn`.
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

  /**
   * How many times the player has DESCENDED past a cleared room (M6-T01).
   *
   * Starts at `0` and is incremented once per settled reward draft (spec 11 AC-04).
   * It is the roguelike loop's difficulty dial: `EncounterSystem` spawns
   * `depth` extra enemies on top of each configured wave, so the same room
   * configuration becomes progressively harder without a second config table.
   *
   * Deliberately NOT `currentWaveIndex`: that resets to `0` on every descent, so it
   * cannot express "how far into the run are we".
   */
  public depth: number;

  /**
   * The RUN's whole room table (M9-T01, spec 15 AC-03).
   *
   * `roomWaves[k]` is the wave configuration of room `k`. Immutable for the
   * lifetime of the encounter, and held on the component (rather than in a module
   * table) for the same reason `waves` is: the whole run — configuration included
   * — is visible in the snapshot and replays with no external lookup.
   *
   * Room `0` is ALWAYS `waves` (the opening room), so a single-room run is simply
   * `roomWaves.length === 1` and every pre-M9 call site is unchanged.
   */
  public roomWaves: readonly (readonly EncounterWaveConfig[])[];

  /**
   * How many rooms this run has (M9-T01). Always `roomWaves.length`, and `>= 1`.
   *
   * Stored rather than derived at the call site so the "final room" test in
   * `EncounterSystem` / `RewardSystem` reads as a comparison between two fields of
   * the same component, and so a snapshot shows the run's total length directly.
   */
  public maxRooms: number;

  /**
   * Index of the room currently being fought (M9-T01). Starts at `0`; incremented
   * exactly once per settled reward draft, by `RewardSystem`.
   *
   * `currentRoomIndex === maxRooms - 1` is the FINAL room — the one whose clear
   * ends the run with `RUN_WON` instead of rolling another draft (spec 15 AC-04).
   *
   * Deliberately NOT `depth`: `depth` is the difficulty dial (spec 11 AC-04) and
   * counts DESCENTS, while this counts ROOMS. They advance together today, but
   * keeping them separate means a future run that revisits a room can raise
   * difficulty without lying about which room the player is in.
   */
  public currentRoomIndex: number;

  /**
   * The pending boon draft, or `null` when there is nothing to choose (M6-T01).
   *
   * Written ONCE, by `EncounterSystem`, on the tick the room transitions to
   * `ROOM_CLEARED` — three distinct reward ids drawn from the global pool with the
   * world's seeded PRNG (spec 11 AC-01). Consumed by `RewardSystem`, which clears it
   * back to `null` and descends the room (AC-04).
   *
   * INVARIANT: `pendingRewards !== null` implies `state === ROOM_CLEARED`. A draft
   * exists only in the room's terminal state, and settling it leaves that state in
   * the same write — so "the room is inert" and "a draft is pending" are two views
   * of the same fact, and no system needs a separate "is a draft open?" gate to
   * know the scheduler is idle.
   *
   * While it is non-null the room WAITS: time keeps flowing, but the scheduler does
   * not spawn and the player is held (spec 11 AC-02). A `null` here is therefore the
   * only state in which a `selectReward` intent is meaningful.
   */
  public pendingRewards: string[] | null;

  /**
   * The TERRAIN id of every room in the run, index-aligned with `roomWaves`
   * (M12-T01, spec 19 §3.5).
   *
   * `roomIds[k]` is the `rooms.json` key room `k` is played on, or `undefined` when
   * that room declares no topology. Held on the component (rather than looked up
   * from `DataManager` at transition time) for the same reason `roomWaves` is: the
   * run's whole shape — terrain included — is visible in the snapshot, so a replay
   * needs no external table to know which room came next.
   *
   * `(string | undefined)[]` rather than a `Map` or a sentinel string: the truth is
   * "aligned with the room index", a `Map` would hide that alignment, and an empty
   * string cannot arrive from the data layer (`optionalNonEmptyString` rejects it),
   * so a sentinel would be a second, private spelling of "absent".
   */
  public roomIds: readonly (string | undefined)[];

  /**
   * The CURRENT room's enemy spawn pool: the centres of every `3` tile, in
   * row-major order (M12-T01, spec 19 §3.5).
   *
   * Written by `LevelLoader.enterRoom` at a room boundary and read by
   * `EncounterSystem.spawnWave`, which picks each enemy's landing spot from it
   * deterministically through `world.rng`.
   *
   * An EMPTY array means "this room has no topology", and that is the honest
   * reading for every pre-M12 room: `EncounterSystem` then falls back to the
   * centre-line formation `formWaveRoster` derives, consuming no PRNG at all
   * (spec 19 I10). That fallback is what makes this field purely additive.
   *
   * `descendEncounterRoom` CLEARS it, and that is load-bearing rather than tidy: it
   * describes "the room being fought", and the instant the room index moves it
   * describes a room that no longer exists. Forgetting to clear it would let a room
   * without a grid inherit the previous room's landing spots.
   */
  public enemySpawnPoints: readonly SpawnPoint[];

  constructor(
    waves: readonly EncounterWaveConfig[],
    state = EncounterState.IN_PROGRESS,
    currentWaveIndex = 0,
    nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED,
    trackedEntityIds: EntityId[] = [],
    depth = 0,
    pendingRewards: string[] | null = null,
    roomWaves: readonly (readonly EncounterWaveConfig[])[] = [waves],
    currentRoomIndex = 0,
    maxRooms = roomWaves.length,
    roomIds: readonly (string | undefined)[] = [],
    enemySpawnPoints: readonly SpawnPoint[] = [],
  ) {
    super();
    this.waves = waves;
    this.state = state;
    this.currentWaveIndex = currentWaveIndex;
    this.nextSpawnTick = nextSpawnTick;
    this.trackedEntityIds = trackedEntityIds;
    this.depth = depth;
    this.pendingRewards = pendingRewards;
    this.roomWaves = roomWaves;
    this.currentRoomIndex = currentRoomIndex;
    this.maxRooms = maxRooms;
    this.roomIds = roomIds;
    this.enemySpawnPoints = enemySpawnPoints;
  }
}

/**
 * Whether the room the scheduler is working on is the run's FINAL room (M9-T01).
 *
 * The whole of AC-04 in one predicate: the final room's clear ends the run instead
 * of opening a draft. Exported (rather than inlined twice) because two systems ask
 * the same question — `EncounterSystem` when a room is cleared, and `RewardSystem`
 * when a draft is settled — and "which room is last" must have exactly one answer.
 *
 * A component with `maxRooms === 0` (only reachable by hand-assembling one) is
 * NOT final: `currentRoomIndex (0) >= maxRooms - 1 (-1)` would be true, and
 * reporting a room that does not exist as "the last room" is the wrong way to be
 * wrong. The guard makes the predicate answer `false` for a degenerate config, so
 * the room keeps behaving as an ordinary one.
 */
export function isFinalRoom(encounter: EncounterStateComponent): boolean {
  if (encounter.maxRooms <= 0) return false;
  return encounter.currentRoomIndex >= encounter.maxRooms - 1;
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

/**
 * The room component currently holding an UNSETTLED reward draft, or `undefined`.
 *
 * The single read-side accessor for the draft, shared by its three consumers:
 * `RewardSystem` (settles it), `PlayerControllerSystem` (holds the player while it
 * is open, spec 11 AC-02) and the presentation layer (renders the buttons, spec 11
 * §4.5). One helper rather than three inline scans keeps the "which room, and what
 * counts as pending" rule in exactly one place.
 *
 * Returns the LIVE component (not a copy) so the logic-layer callers can write back
 * through it. The render layer's read-only contract (spec 09 AC-01) is what stops
 * the UI from mutating it — the same discipline every other component read follows.
 *
 * Deterministic and side-effect free: it only reads the world, iterating ids in
 * ascending order (`World.query`).
 */
export function findRewardDraft(world: World): EncounterStateComponent | undefined {
  for (const id of world.query(EncounterStateComponent)) {
    const encounter = world.getComponent(id, EncounterStateComponent);
    if (encounter !== undefined && encounter.pendingRewards !== null) return encounter;
  }
  return undefined;
}

/**
 * The terrain id of the room currently being fought, or `undefined` (M12-T01).
 *
 * The single read-side accessor for `roomIds[currentRoomIndex]`, shared by its two
 * consumers: `RewardSystem` (assembles the next room's scene) and `runSetup`
 * (assembles the opening room's). One helper rather than two inline index reads
 * keeps "which room am I in, and does it have a grid" in exactly one place — the
 * same reasoning `findRewardDraft` and `isFinalRoom` record.
 *
 * Returns `undefined` for BOTH ways of saying "no topology" — a short `roomIds`
 * array (a hand-assembled run) and an explicit `undefined` entry (a data-backed run
 * whose room declares no `roomId`) — so no caller has to know which shape it is
 * looking at.
 *
 * Deterministic and side-effect free: it only reads the component.
 */
export function currentRoomId(encounter: EncounterStateComponent): string | undefined {
  const id = encounter.roomIds[encounter.currentRoomIndex];
  return id === undefined || id.length === 0 ? undefined : id;
}
