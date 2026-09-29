/**
 * RewardSystem — settles the boon draft the room rolled (M6-T01) and descends the
 * run to the next room (M9-T01).
 * See specs/11_roguelike_loop_spec.md §4.3 / §4.4 and
 * specs/15_economy_and_victory_spec.md §4.5 (AC-03 / AC-04).
 *
 * Pipeline position: AFTER `EncounterSystem`, BEFORE `LifespanSystem`.
 *
 *  - It must run AFTER `EncounterSystem` because `EncounterSystem` is what CREATES
 *    the draft (on the `ROOM_CLEARED` transition). Running before it would mean a
 *    selection could only ever be honoured one tick after the draft appeared — and,
 *    worse, the "is there a draft?" question would be answered against last tick's
 *    world for no reason. Sitting immediately after it makes the two halves of the
 *    loop (roll, then settle) adjacent and readable.
 *  - It must run BEFORE `LifespanSystem`, which stays LAST (spec 05 C7).
 *
 * The settle-and-descend write happens at the END of the tick, so the reset room
 * (`IN_PROGRESS`, wave 0, nothing tracked, no deadline) is picked up by
 * `EncounterSystem` on the NEXT tick — the same one-tick phase the rest of the
 * engine treats as an architectural property (spec 08 §6.2). Consequence, and it is
 * the documented contract: choosing a reward spawns the next, deeper wave on the
 * FOLLOWING tick, not the same one.
 *
 * INPUT, not state: the selection arrives as a `selectReward` event in `ctx.input`
 * — the tick-aligned external-command channel (spec 11 AC-03). This system therefore
 * owns no queue, no callback and no listener; it reads the same frame every other
 * consumer reads, which is what makes a click reproducible in a replay.
 *
 * WHAT IT DOES, and nothing more:
 *
 *   1. read the tick's selection (the FIRST `selectReward` event wins);
 *   2. find the room holding an unsettled draft — no draft, strict no-op;
 *   3. reject the selection unless it is one of the ids the room ITSELF rolled;
 *   4. grant it to the player, clear the draft, and advance the room.
 *
 * Step 3 is the security/robustness property of AC-03: the UI sends an ID, never an
 * index, and the logic layer re-validates it against the draft it rolled. A stale
 * click (the draft was already settled) or a forged id is silently ignored — the
 * room simply keeps waiting, which is the honest outcome for "that option was not
 * on offer".
 *
 * Step 4's "advance the room" is the M9-T01 addition (spec 15 AC-03): the room
 * index moves on, `depth` rises, and `waves` is REPLACED by the next room's
 * configuration, so a run is a sequence of rooms rather than one room replayed
 * harder. The finality guard in front of it is the settlement-side twin of
 * `EncounterSystem`'s AC-04 branch: in the shipped configuration the last room
 * never opens a draft at all, so a draft can only be open on the final room if a
 * caller hand-assembled one — and in that case the honest outcome is still "the run
 * is over", never "descend past the end of the room table".
 *
 * Holds NO cross-tick hidden state: no fields at all beyond its name.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import type { InputEvent } from '../../core/input';
import { PlayerInputComponent } from '../components/PlayerInputComponent';
import {
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterState,
  findRewardDraft,
  isFinalRoom,
} from '../components/EncounterStateComponent';
import { markRunWon } from '../components/GameStateComponent';
import { grantReward } from '../rewards/grantReward';

/** The first `selectReward` event in the tick's frame, or `null`. */
function readRewardSelection(input: ReadonlyArray<InputEvent>): string | null {
  for (const event of input) {
    if (event.kind === 'selectReward') return event.rewardId;
  }
  return null;
}

export class RewardSystem implements System {
  public readonly name = 'RewardSystem';

  public update(world: World, ctx: SystemContext): void {
    const selection = readRewardSelection(ctx.input);
    // No click this tick => nothing to do, and no context object is even built.
    if (selection === null) return;

    // No room is waiting on a choice => the click is stale (e.g. the player clicked
    // twice, or clicked during a fight). Ignore it rather than buffering it: a
    // buffered selection would fire on some future draft the player never saw.
    const room = findRewardDraft(world);
    if (room === undefined) return;

    // Only an option the room actually offered may be taken. `pendingRewards` is the
    // authority — never a client-supplied index or label.
    const pending = room.pendingRewards;
    if (pending === null || !pending.includes(selection)) return;

    const playerId = this.findPlayer(world);
    if (playerId === undefined) return;

    grantReward(world, playerId, selection);

    // Settle the draft in ONE place. Clearing it is what re-opens the scheduler:
    // `EncounterSystem`'s `ROOM_CLEARED` gate no longer sees an inert room, and the
    // emptied roster makes it schedule the next wave (spec 11 AC-04).
    room.pendingRewards = null;

    // AC-04's settlement-side guard (spec 15): settling a draft that somehow exists
    // on the FINAL room wins the run instead of descending past the end of the room
    // table. Unreachable in the shipped configuration — `EncounterSystem` never
    // rolls a draft on the final room — which is exactly why it is here: the
    // alternative to this branch is an out-of-range room index, and "the run is
    // over" is the honest answer for a room that has no successor.
    if (isFinalRoom(room)) {
      markRunWon(world);
      return;
    }

    // Descend to the next room (M9-T01, spec 15 AC-03): the index moves on, the
    // difficulty dial rises, and the room's wave configuration is swapped for the
    // next entry of the run's table. `?? room.waves` is unreachable for a
    // factory-assembled room (the index is always inside `roomWaves`), but it keeps
    // the swap total rather than able to produce `undefined` waves.
    room.currentRoomIndex += 1;
    room.depth += 1;
    room.waves = room.roomWaves[room.currentRoomIndex] ?? room.waves;
    room.state = EncounterState.IN_PROGRESS;
    room.currentWaveIndex = 0;
    room.trackedEntityIds = [];
    room.nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED;
  }

  /**
   * The entity to reward: the FIRST player, in ascending id order.
   *
   * `PlayerInputComponent` is the player marker (spec 01 §3.3 — it is mounted on the
   * player and ONLY the player), so this never accidentally rewards an AI enemy.
   * Ascending id keeps the choice deterministic if a future build ever has more than
   * one device-driven entity.
   */
  private findPlayer(world: World): EntityId | undefined {
    return world.query(PlayerInputComponent)[0];
  }
}
