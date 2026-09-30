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
import { DataManager } from '../../data/DataManager';
import { SchemaError } from '../../data/schemas';
import type { EncounterWaveTemplate } from '../../data/schemas';
import { EncounterState, EncounterStateComponent, ENCOUNTER_WAVE_UNSCHEDULED } from '../components/EncounterStateComponent';
import type { EncounterWaveConfig } from '../components/EncounterStateComponent';
import type { EnemySpawnOptions } from './spawn-helpers';
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
   *
   * As of M10-T02 this is the HAND-BUILT path. A data-backed run does not list
   * its rooms here at all — `spawnFromData` fills the table from
   * `assets/data/encounters.json` (see {@link EncounterFactory.spawnFromData}).
   */
  readonly rooms?: readonly (readonly EncounterWaveConfig[])[];
  /**
   * The terrain id of each room, index-aligned with the run's room table
   * (`[waves, ...rooms]`) — i.e. `roomIds[k]` is the grid room `k` is played on
   * (M12-T01, spec 19 §3.5).
   *
   * Omit it and the run has NO topology: no walls are built, the player keeps
   * whatever pose the caller gave it, and waves keep the centre-line formation.
   * That is exactly what every pre-M12 call site declares, so nothing there
   * changes (spec 19 I10).
   *
   * A `undefined` ENTRY is legal and means "this one room has no grid" — which is
   * why the element type is nullable rather than the array being all-or-nothing.
   */
  readonly roomIds?: readonly (string | undefined)[];
}

/**
 * Extra world units between two enemies of the SAME wave when their placement is
 * derived from a data template (M10-T02).
 *
 * A CONSTANT, not a random offset, for the same reason `DEPTH_SPAWN_SPACING_UNITS`
 * is one: a data-backed run must be reproducible, and two enemies must not spawn
 * inside each other (overlapping hurtboxes would read as "one enemy" to the
 * player and to a collision assertion).
 */
export const ENCOUNTER_FORMATION_SPACING_UNITS = 2;

/**
 * Turn a wave template's enemy TYPE ids into a placeable roster (M10-T02).
 *
 * The formation is the deliberate answer to "the JSON says three raiders — where
 * do they stand?". Placement is a per-INSTANCE fact and cannot be written down
 * once for a TYPE, so the file does not try: it names the types, and this pure
 * function lays them out on a horizontal line CENTRED on the room origin, spaced
 * by {@link ENCOUNTER_FORMATION_SPACING_UNITS}. So a one-enemy wave stands at
 * `x = 0`, a two-enemy wave at `x = ±1`, a three-enemy wave at `x = -2, 0, +2`.
 *
 * Pure and exported so the layout rule is testable without standing up a room,
 * and so the whole conversion is a function of the template alone — same
 * template, same roster, every time (spec 00 §6.2).
 */
export function formWaveRoster(enemyIds: readonly string[]): EnemySpawnOptions[] {
  const count = enemyIds.length;
  return enemyIds.map((enemyId, index) => ({
    enemyId,
    x: (index - (count - 1) / 2) * ENCOUNTER_FORMATION_SPACING_UNITS,
    y: 0,
  }));
}

/**
 * Convert parsed wave TEMPLATES (plain data from `encounters.json`) into the
 * `EncounterWaveConfig`s the scheduler reads (M10-T02).
 *
 * The only translation between the two vocabularies, kept in one place so the
 * data layer never has to know about placement and the scheduler never has to
 * know about JSON.
 */
export function toEncounterWaveConfigs(
  templates: readonly EncounterWaveTemplate[],
): readonly EncounterWaveConfig[] {
  return templates.map((template) => ({
    delayTicks: template.delayTicks,
    enemies: formWaveRoster(template.enemies),
  }));
}

/**
 * The waves of the room at `depth`, read from the encounter table (M10-T02,
 * AC-02).
 *
 * This is the single seam through which a run's room layout enters the engine:
 * `spawnFromData` calls it once per configured depth at assembly time, and
 * `descendEncounterRoom` calls it as the past-the-end fallback. Both callers ask
 * the same question, so they cannot disagree about what "the room at depth `d`"
 * means.
 *
 * @throws SchemaError when no encounter table is loaded, or when `depth` is not a
 *   non-negative integer (see `DataManager.getEncounterWaves`).
 */
export function resolveEncounterWaves(depth: number): readonly EncounterWaveConfig[] {
  return toEncounterWaveConfigs(DataManager.getEncounterWaves(depth));
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
    // M10-T01: an entry names an enemy TYPE plus its placement, and the factory
    // resolves the numbers — so a wave referencing an unknown type, or a type whose
    // config is malformed, fails HERE, at load time, rather than inside `step()`.
    const scratch = new World();
    for (const enemy of wave.enemies) {
      EnemyFactory.spawn(scratch, enemy.enemyId, enemy);
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

/**
 * Advance a cleared room to the next depth (M10-T02, refactoring the M9-T01
 * descent out of `RewardSystem`).
 *
 * The transition is the whole of "settle a draft and go deeper", and it lives here
 * — beside the assembly that CREATED the room — so there is exactly one
 * implementation of it and `RewardSystem` reads as "grant, then descend" instead of
 * carrying a seven-line block of state writes that no other file can reuse.
 *
 * The next room's waves are resolved in two steps, and the ORDER is the contract:
 *
 *  1. `roomWaves[currentRoomIndex]` — the depth-indexed table the room was
 *     assembled with. This is the fast path for every room of a normal run, and it
 *     is what keeps the room's configuration SNAPSHOT-VISIBLE (spec 15 §3.5): the
 *     table travelled with the component, so a replay needs no external lookup.
 *  2. `resolveEncounterWaves(room.depth)` — the past-the-end fallback (AC-02's
 *     "循环复用 / 兜底生成"), read from `DataManager` by the room's CURRENT depth.
 *     Only reachable for a hand-assembled room whose `maxRooms` exceeds its
 *     `roomWaves` length; a data-backed run always wins the run on its final room
 *     before the index can run off the end.
 *
 * `depth` and `currentRoomIndex` both rise because they answer different questions
 * (descents vs. rooms, spec 15 §3.5); keeping them in one write is what stops them
 * drifting apart here.
 *
 * M12-T01 adds the ONE field that must be CLEARED rather than carried:
 * `enemySpawnPoints` describes "the room being fought", and the instant the index
 * moves it describes a room that no longer exists. Clearing it here (rather than
 * relying on `LevelLoader` to overwrite it) is what keeps the "no topology" case
 * honest: a room without a grid would otherwise inherit the previous room's landing
 * spots, and the bug would only appear on a `with-grid -> without-grid` descent.
 * `LevelLoader.enterRoom` then publishes the NEW room's pool, in the same tick.
 */
export function descendEncounterRoom(room: EncounterStateComponent): void {
  room.currentRoomIndex += 1;
  room.depth += 1;
  room.waves = room.roomWaves[room.currentRoomIndex] ?? resolveEncounterWaves(room.depth);
  room.state = EncounterState.IN_PROGRESS;
  room.currentWaveIndex = 0;
  room.trackedEntityIds = [];
  room.nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED;
  room.enemySpawnPoints = [];
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
        config.roomIds ?? [],
        [],
      ),
    );
    return entity.id;
  }

  /**
   * Create the room singleton for a DATA-BACKED run (M10-T02, AC-01 / AC-02).
   *
   * The run's whole room table is read from `assets/data/encounters.json`, one
   * entry per configured depth, and handed to {@link spawn} — which means the
   * layout of a run is a JSON edit and the caller (`buildRun` in `client/main.ts`,
   * or a test) declares nothing at all. That is the point: before M10-T02 the demo
   * run's rooms were a literal in client source, so "how many rooms, and what is
   * in each" had a second answer outside the data layer.
   *
   * Depth is the ONLY index. Room `d` is the table's entry `d` (`DataManager`
   * enforces `depth === index`), so there is no second list to keep in step and no
   * "room table" concept in the engine beyond "the config, by depth".
   *
   * The assembled table is still validated by {@link resolveEncounterRooms} (the
   * dry-run assembly), so a data-backed run enjoys exactly the same load-time
   * guarantees as a hand-built one — including the cross-table check that every
   * referenced enemy type exists, which `DataManager.loadAll` already performed.
   *
   * @throws SchemaError when no encounter table is loaded (Bootstrap never ran, or
   *   it ran against a bundle that ships no rooms).
   * @throws RangeError under the conditions listed on `resolveRoomWaves`.
   */
  public static spawnFromData(world: World): EntityId {
    const roomWaves: (readonly EncounterWaveConfig[])[] = [];
    // M12-T01: the terrain id of each room, index-aligned with `roomWaves`. A room
    // that declares no `roomId` contributes an explicit `undefined`, so the two
    // arrays stay aligned without a sentinel and `currentRoomId` can answer "does
    // this room have a grid" for any index (spec 19 §3.5).
    const roomIds: (string | undefined)[] = [];
    for (const depth of DataManager.encounterDepths) {
      roomWaves.push(resolveEncounterWaves(depth));
      roomIds.push(DataManager.getEncounterRoomId(depth));
    }

    const opening = roomWaves[0];
    if (opening === undefined) {
      throw new SchemaError(
        'no encounter config is loaded, so a run cannot be assembled: run the Bootstrap phase (bootstrapData()) before building a run (spec 17 AC-01).',
      );
    }

    return EncounterFactory.spawn(world, {
      waves: opening,
      rooms: roomWaves.slice(1),
      roomIds,
    });
  }
}
