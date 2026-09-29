/**
 * Encounter (room) assembly. See specs/08_encounter_and_death_spec.md §3.4 and
 * specs/15_economy_and_victory_spec.md §3.5 / §4.4 (M9-T01 multi-room runs).
 *
 * `EncounterFactory.spawn` mounts the room's whole configuration onto ONE bare
 * "world entity" and returns its id — the same `EntityId`-returning prefab shape
 * `PlayerFactory` / `EnemyFactory` follow. The entity is deliberately component-poor
 * (a single `EncounterStateComponent`): a room has no position, no hurtbox and no
 * lifespan, so giving it a `TransformComponent` would be inventing data that means
 * nothing.
 *
 * `resolveEncounterConfig` is the assembly layer's validation, and it validates by
 * DRY-RUNNING the assembly (see below). Keeping validation at load time is what
 * makes the scheduler crash-free: `EncounterSystem` calls `EnemyFactory.spawn`
 * from inside `step()`, so a bad enemy spec surfacing at spawn time would abort a
 * simulation mid-tick. Here it aborts the LOAD instead, before a single tick has
 * run — the same "fail loudly at the seam" discipline `resolveDashTuning` /
 * `resolveAITuning` established (spec 08 AC-05).
 */

import type { EntityId } from '../Entity';
import { World } from '../World';
import { EncounterState, EncounterStateComponent, ENCOUNTER_WAVE_UNSCHEDULED } from '../components/EncounterStateComponent';
import type { EncounterWaveConfig } from '../components/EncounterStateComponent';
import { EnemyFactory } from './EnemyFactory';
import { assertNonNegativeInteger } from './spawn-helpers';

/** A room's full configuration, as handed to `EncounterFactory.spawn`. */
export interface EncounterRoomConfig {
  /** Ordered, non-empty list of waves. Index 0 is the opening wave. */
  readonly waves: readonly EncounterWaveConfig[];
  /**
   * The run's FOLLOW-UP rooms, in order (M9-T01, spec 15 AC-03).
   *
   * Room `k + 1` uses `rooms[k]`, so the run's total room count is
   * `1 + (rooms?.length ?? 0)`. Omit the field and the run is a single room whose
   * configuration is `waves` — which is exactly what every pre-M9 call site
   * declares, so nothing there changes.
   *
   * Declared as "the rooms after the first" rather than as a full table
   * `[waves, ...rooms]` so there is no invariant to police: a table would make
   * `waves` a duplicate of `roomWaves[0]`, and a duplicate is a drift bug waiting
   * for its first editor.
   */
  readonly rooms?: readonly (readonly EncounterWaveConfig[])[];
}

/**
 * Validate ONE room's waves and return them.
 *
 * Structural rules (all `@throws RangeError`):
 *  - at least one wave;
 *  - every `delayTicks` a non-negative integer;
 *  - every wave declaring at least one enemy.
 *
 * The last rule is load-bearing rather than cosmetic: the scheduler uses an EMPTY
 * `trackedEntityIds` list as its "this wave has not spawned yet" marker
 * (spec 08 §3.2), so a wave with no enemies would be indistinguishable from an
 * unspawned one and would wedge the room in `WAVE_CLEAR` forever.
 *
 * Per-enemy validation is NOT duplicated here. Instead every enemy spec is
 * assembled once on a THROWAWAY `World` and the result discarded, so the exact
 * rules `spawnCombatant` will apply at spawn time are the rules that run here.
 * Copying those rules would be a second source of truth that silently drifts the
 * moment combatant assembly changes; a scratch world cannot drift.
 */
function resolveRoomWaves(
  waves: readonly EncounterWaveConfig[],
  roomIndex: number,
): readonly EncounterWaveConfig[] {
  if (waves.length === 0) {
    throw new RangeError(`encounter.room[${String(roomIndex)}].waves must contain at least one wave.`);
  }

  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index];
    if (wave === undefined) continue;

    const label = `encounter.room[${String(roomIndex)}].waves[${String(index)}]`;
    assertNonNegativeInteger(wave.delayTicks, `${label}.delayTicks`);

    if (wave.enemies.length === 0) {
      throw new RangeError(`${label}.enemies must contain at least one enemy spec.`);
    }

    // Dry-run assembly: no side effect on the caller's world, full validation.
    const scratch = new World();
    for (const enemy of wave.enemies) {
      EnemyFactory.spawn(scratch, enemy);
    }
  }

  return waves;
}

/**
 * Validate the WHOLE run configuration and return its room table (M9-T01).
 *
 * The table is always `[config.waves, ...(config.rooms ?? [])]`, so room 0 is the
 * opening room and the length is the run's `maxRooms`. Every room is validated —
 * including the ones the player may never reach — because a run that crashes on
 * its third room is a bug that only shows up after ten minutes of play.
 *
 * @throws RangeError under the conditions listed on {@link resolveRoomWaves}.
 */
export function resolveEncounterRooms(
  config: EncounterRoomConfig,
): readonly (readonly EncounterWaveConfig[])[] {
  const table = [config.waves, ...(config.rooms ?? [])];
  return table.map((waves, roomIndex) => resolveRoomWaves(waves, roomIndex));
}

/**
 * Validate a room configuration and return its OPENING room's waves.
 *
 * Kept as the single-room entry point (its pre-M9 signature is unchanged) and
 * implemented in terms of {@link resolveEncounterRooms}, so there is exactly one
 * validation implementation. A caller that needs the whole run asks for
 * `resolveEncounterRooms` instead.
 *
 * @throws RangeError under the conditions listed on {@link resolveRoomWaves}.
 */
export function resolveEncounterConfig(config: EncounterRoomConfig): readonly EncounterWaveConfig[] {
  const table = resolveEncounterRooms(config);
  const opening = table[0];
  if (opening === undefined) {
    // Unreachable: `resolveEncounterRooms` always yields at least `config.waves`,
    // and an empty `waves` throws above. Kept total rather than `!`-asserted.
    throw new RangeError('encounter must contain at least one room.');
  }
  return opening;
}

export class EncounterFactory {
  /**
   * Create the room's singleton entity, carrying the validated configuration in its
   * initial state (`IN_PROGRESS`, room `0`, wave `0`, no spawn scheduled, nothing
   * tracked).
   *
   * The room does NOT spawn its opening wave here: spawning is a per-tick decision
   * and belongs to `EncounterSystem`, which runs inside `step()` (spec 08 §4.3).
   * Consequence, and it is the documented contract: wave 0 appears on the first
   * processed tick (`waves[0].delayTicks = 0`), so a caller must `step()` at least
   * once before the room has any enemies.
   *
   * M9-T01: the component is handed the WHOLE room table (spec 15 AC-03), so the
   * run's length and its per-room configurations are snapshot-visible from the very
   * first tick rather than being introduced later by a descent.
   *
   * @throws RangeError under the conditions listed on {@link resolveRoomWaves}.
   */
  public static spawn(world: World, config: EncounterRoomConfig): EntityId {
    const roomWaves = resolveEncounterRooms(config);
    const waves = roomWaves[0];
    if (waves === undefined) {
      throw new RangeError('encounter must contain at least one room.');
    }

    const entity = world.createEntity();
    world.addComponent(
      entity.id,
      new EncounterStateComponent(
        waves,
        EncounterState.IN_PROGRESS,
        0,
        ENCOUNTER_WAVE_UNSCHEDULED,
        [],
        0,
        null,
        roomWaves,
        0,
        roomWaves.length,
      ),
    );
    return entity.id;
  }
}
