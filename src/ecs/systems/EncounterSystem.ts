/**
 * EncounterSystem — the room / wave scheduler.
 * See specs/08_encounter_and_death_spec.md §4.3 (semantics) and §5.2 (position).
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
 * `trackedEntityIds` all live on `EncounterStateComponent` (spec 00 §6.1). The only
 * thing this class owns is its name.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import {
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterState,
  EncounterStateComponent,
  isWaveCleared,
} from '../components/EncounterStateComponent';
import { EnemyFactory } from '../prefabs/EnemyFactory';
import type { EnemySpawnOptions } from '../prefabs/spawn-helpers';

export class EncounterSystem implements System {
  public readonly name = 'EncounterSystem';

  public update(world: World, ctx: SystemContext): void {
    for (const id of world.query(EncounterStateComponent)) {
      const encounter = world.getComponent(id, EncounterStateComponent);
      if (encounter === undefined) continue;

      // 1. A finished room is inert: no spawn, no wipe check, no state churn.
      if (encounter.state === EncounterState.ROOM_CLEARED) continue;

      // 2. Nothing spawned for the current wave yet => pending spawn.
      if (encounter.trackedEntityIds.length === 0) {
        this.spawnWhenDue(world, ctx.tick, encounter);
        continue;
      }

      // 3. A live wave: advance only once every tracked member is gone.
      if (!isWaveCleared(world, encounter.trackedEntityIds)) continue;
      this.advance(ctx.tick, encounter);
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
   * The current wave is wiped: promote the next wave to pending, or finish the room.
   *
   * `ROOM_CLEARED` on the very tick the last wave was detected cleared — the room is
   * not "waiting for a wave that will never come", it is DONE (spec 08 AC-03).
   */
  private advance(tick: number, encounter: EncounterStateComponent): void {
    const nextIndex = encounter.currentWaveIndex + 1;
    const nextWave = encounter.waves[nextIndex];

    if (nextWave === undefined) {
      encounter.state = EncounterState.ROOM_CLEARED;
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
   * Spawn a wave's enemies IN CONFIG ORDER and adopt the resulting ids as the
   * tracked roster. `EnemyFactory.spawn` is the only assembly path — this system
   * never touches components directly, so a new enemy variant needs no change here
   * (spec 08 AC-05).
   */
  private spawnWave(
    world: World,
    encounter: EncounterStateComponent,
    enemies: readonly EnemySpawnOptions[],
  ): void {
    const spawned: EntityId[] = [];
    for (const enemy of enemies) {
      spawned.push(EnemyFactory.spawn(world, enemy));
    }
    encounter.trackedEntityIds = spawned;
    encounter.nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED;
    encounter.state = EncounterState.IN_PROGRESS;
  }
}
