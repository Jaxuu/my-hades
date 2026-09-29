/**
 * EncounterSystem — the room / wave scheduler.
 * See specs/08_encounter_and_death_spec.md §4.3 (semantics), §5.2 (position) and
 * specs/15_economy_and_victory_spec.md §4.4 (M9-T01 AC-04: the final room wins
 * the run instead of opening a draft).
 *
 * Pipeline position: AFTER `DeathSystem`, BEFORE `LifespanSystem`. Both halves of
 * that slot are forced:
 *
 *  - It must run AFTER `DeathSystem` because its entire input is the death tag:
 *    AC-03 advances a wave when every tracked member is dead-or-destroyed, and
 *    `DeadTagComponent` is written at the end of the tick by `DeathSystem`. Running
 *    earlier would delay every wave transition by one tick and make the
 *    `delayTicks` contract read one tick short.
 *  - It must run BEFORE `LifespanSystem`, which has to stay LAST (spec 05 C7).
 *
 * Consequence of the slot (documented, not accidental): a wave spawned on tick `T`
 * is picked up by the advance systems on `T+1` — every per-entity system has
 * already run this tick. This is the same "1 Tick phase" the rest of the engine
 * treats as an architectural property (spec 08 §6).
 *
 * Per encounter entity (ascending id; normally exactly one — the room is a global
 * singleton), the scheduler makes exactly ONE decision per tick:
 *
 *   1. `ROOM_CLEARED`                       -> inert, skip entirely.
 *   2. nothing spawned for the current wave -> the PENDING SPAWN branch: schedule a
 *                                              deadline on first sight, then spawn
 *                                              the moment `ctx.tick` reaches it.
 *   3. a live wave                          -> the ADVANCE branch: on a wipe, either
 *                                              promote the next wave to pending
 *                                              (`WAVE_CLEAR`) or finish the room
 *                                              (`ROOM_CLEARED`).
 *
 * Branch 2 is entered first and `continue`s, so a spawn NEVER happens on the same
 * tick a wipe was detected: the room observes "the wave is over", and only then
 * schedules. That is what makes `delayTicks = 0` mean "the very next tick" instead
 * of "the same tick", and it keeps the two decisions from interleaving.
 *
 * Holds NO cross-tick hidden state: `state` / `currentWaveIndex` / `nextSpawnTick` /
 * `trackedEntityIds` / `depth` / `pendingRewards` / `currentRoomIndex` all live on
 * `EncounterStateComponent` (spec 00 §6.1). The only thing this class owns is its
 * name — and, as of M6-T01, the PRNG draw it performs through `world.rng` (the
 * generator itself is owned by the World, so no state is hidden here either).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import {
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterState,
  EncounterStateComponent,
  isFinalRoom,
  isWaveCleared,
} from '../components/EncounterStateComponent';
import { EnemyFactory } from '../prefabs/EnemyFactory';
import type { EnemySpawnOptions } from '../prefabs/spawn-helpers';
import { draftRewards } from '../rewards/RewardPool';
import { isRunOver, markRunWon } from '../components/GameStateComponent';

/**
 * Extra world units of separation between a wave's configured enemies and the
 * copies added by depth (M6-T01, spec 11 AC-04).
 *
 * A CONSTANT, not a random offset: escalation must be reproducible, and the copies
 * must not spawn on top of each other (overlapping hurtboxes would make the extra
 * difficulty read as "one enemy" to the player and to a collision assertion).
 */
export const DEPTH_SPAWN_SPACING_UNITS = 1.5;

/**
 * Expand a wave's configured roster for the current depth.
 *
 * The base enemies are returned UNTOUCHED and in config order; then `depth` extra
 * copies are appended, each cloned from a config entry (round-robin) and offset
 * along +x so it does not stack on its template. `depth = 0` returns the config
 * verbatim, which is what keeps every M4 encounter behaving bit-for-bit as it did
 * before M6 — the escalation is purely additive.
 *
 * Pure and exported so the growth rule is testable without standing up a room.
 */
export function buildWaveRoster(
  enemies: readonly EnemySpawnOptions[],
  depth: number,
): EnemySpawnOptions[] {
  const roster: EnemySpawnOptions[] = [...enemies];
  if (depth <= 0) return roster;

  for (let i = 0; i < depth; i += 1) {
    const template = enemies[i % enemies.length];
    // Unreachable for a validated wave (a wave must declare at least one enemy,
    // spec 08 §3.4), but `noUncheckedIndexedAccess` makes the read `T | undefined`
    // and an empty roster must not become an infinite loop.
    if (template === undefined) break;
    roster.push({ ...template, x: (template.x ?? 0) + DEPTH_SPAWN_SPACING_UNITS * (i + 1) });
  }
  return roster;
}

export class EncounterSystem implements System {
  public readonly name = 'EncounterSystem';

  public update(world: World, ctx: SystemContext): void {
    // M8-T01 (spec 14 AC-06), widened by M9-T01 (spec 15 AC-04): a run that is
    // OVER is inert — failed OR won. Without this gate a FAILED run would keep its
    // schedule while the player's corpse lies on the floor (the next wave would
    // spawn 30 ticks after the wipe, which is precisely the "the game carries on
    // like an enemy dying" behaviour AC-02 forbids), and a WON run would be one
    // gate away from trying to spawn a room that does not exist. Asking the single
    // `isRunOver` predicate means a won run is exactly as inert as a lost one, with
    // no second boolean to keep in sync. Evaluated ONCE per tick, before the entity
    // loop, so the verdict cannot differ between two rooms within a tick.
    if (isRunOver(world)) return;

    for (const id of world.query(EncounterStateComponent)) {
      const encounter = world.getComponent(id, EncounterStateComponent);
      if (encounter === undefined) continue;

      // 1. A finished room is inert: no spawn, no wipe check, no state churn.
      //    This is ALSO the "a reward draft is open" case (M6-T01): a draft only
      //    ever exists in ROOM_CLEARED (see the invariant on `pendingRewards`), so
      //    this one gate covers AC-02's "the scheduler is held while the player
      //    chooses" without a second, redundant check.
      if (encounter.state === EncounterState.ROOM_CLEARED) continue;

      // 2. Nothing spawned for the current wave yet => pending spawn.
      if (encounter.trackedEntityIds.length === 0) {
        this.spawnWhenDue(world, ctx.tick, encounter);
        continue;
      }

      // 3. A live wave: advance only once every tracked member is gone.
      if (!isWaveCleared(world, encounter.trackedEntityIds)) continue;
      this.advance(world, ctx.tick, encounter);
    }
  }

  /**
   * Schedule the pending wave on first sight, then spawn it the moment its deadline
   * arrives. Doing the scheduling lazily (rather than in the factory) is what makes
   * an encounter loaded at ANY tick behave identically to one loaded before tick 0 —
   * the deadline is always `now + delayTicks`, never an absolute value baked in
   * outside the simulation (spec 08 §3.2).
   */
  private spawnWhenDue(world: World, tick: number, encounter: EncounterStateComponent): void {
    const wave = encounter.waves[encounter.currentWaveIndex];
    if (wave === undefined) return;

    if (encounter.nextSpawnTick === ENCOUNTER_WAVE_UNSCHEDULED) {
      encounter.nextSpawnTick = tick + wave.delayTicks;
    }
    if (tick < encounter.nextSpawnTick) return;

    this.spawnWave(world, encounter, wave.enemies);
  }

  /**
   * The current wave is wiped: promote the next wave to pending, finish the room,
   * or — if this was the FINAL room — win the run (M9-T01, spec 15 AC-04).
   *
   * `ROOM_CLEARED` on the very tick the last wave was detected cleared — the room is
   * not "waiting for a wave that will never come", it is DONE (spec 08 AC-03).
   *
   * M6-T01 adds the reward draft to that terminal transition: the room is done, so
   * the player has EARNED a boon (spec 11 AC-01). The draft is rolled here — and
   * only here — because this is the single place that knows "the run just cleared a
   * room", and it uses the world's seeded PRNG so the same seed always produces the
   * same three options (ADR-004).
   *
   * M9-T01 adds the one exception, and it is checked BEFORE the roll: clearing the
   * run's LAST room does not open a draft at all — it ends the run. That is AC-04's
   * "不再触发掉落三选一，而是将 GameState 直接切为 RUN_WON", and putting it here (rather
   * than letting `RewardSystem` reject a draft nobody wanted) is what makes "the
   * final room rolls nothing" an observable fact: `pendingRewards` is `null` on the
   * very tick the room cleared, and no PRNG draw is even consumed, so the reward
   * stream a replay sees is identical whether or not the last room was reached.
   *
   * The tracked roster is still RETAINED on this transition (spec 08 §4.4): an empty
   * roster means "not spawned yet", which would be a lie about a room that has been
   * fought. Only a promotion to a next wave empties it.
   */
  private advance(world: World, tick: number, encounter: EncounterStateComponent): void {
    const nextIndex = encounter.currentWaveIndex + 1;
    const nextWave = encounter.waves[nextIndex];

    if (nextWave === undefined) {
      encounter.state = EncounterState.ROOM_CLEARED;

      // AC-04: the final room ends the RUN. No draft, no draw, no next wave.
      if (isFinalRoom(encounter)) {
        markRunWon(world);
        return;
      }

      // Roll the draft ONCE per clear. `pendingRewards` is null here by construction
      // (a draft only exists in ROOM_CLEARED, and this branch is the only way in), so
      // there is no re-roll to guard against.
      encounter.pendingRewards = draftRewards(world.rng);
      return;
    }

    encounter.state = EncounterState.WAVE_CLEAR;
    encounter.currentWaveIndex = nextIndex;
    encounter.nextSpawnTick = tick + nextWave.delayTicks;
    // Emptied so the NEXT tick takes the pending-spawn branch. The wiped wave's ids
    // are deliberately dropped rather than kept for history: `trackedEntityIds` means
    // "the wave I must watch", and keeping dead ids in it would make the advance
    // check re-fire against the wrong roster.
    encounter.trackedEntityIds = [];
  }

  /**
   * Spawn a wave's enemies IN CONFIG ORDER (expanded for the current depth) and
   * adopt the resulting ids as the tracked roster. `EnemyFactory.spawn` is the only
   * assembly path — this system never touches components directly, so a new enemy
   * variant needs no change here (spec 08 AC-05).
   *
   * Depth escalation (M6-T01, spec 11 AC-04) is applied by `buildWaveRoster`, which
   * is a pure expansion of the configured roster — the factory still receives plain
   * `EnemySpawnOptions` and knows nothing about depth.
   */
  private spawnWave(
    world: World,
    encounter: EncounterStateComponent,
    enemies: readonly EnemySpawnOptions[],
  ): void {
    const spawned: EntityId[] = [];
    for (const enemy of buildWaveRoster(enemies, encounter.depth)) {
      // M10-T01: the roster entry carries the TYPE (`enemyId`) and the placement;
      // the balance numbers are resolved inside the factory from the config table,
      // so the encounter layer still re-implements no assembly (spec 08 AC-05).
      spawned.push(EnemyFactory.spawn(world, enemy.enemyId, enemy));
    }
    encounter.trackedEntityIds = spawned;
    encounter.nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED;
    encounter.state = EncounterState.IN_PROGRESS;
  }
}
