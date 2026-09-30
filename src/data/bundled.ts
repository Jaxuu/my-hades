/**
 * Bundled config source + the asynchronous Bootstrap seam (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §4.3 (AC-03).
 *
 * THE CONTRACT (AC-03)
 * --------------------
 * Config is loaded ASYNCHRONOUSLY, ONCE, during the Bootstrap phase — BEFORE a
 * `GameSimulator` is constructed and therefore long before the first `step()`.
 * After Bootstrap the engine only ever reads an already-parsed table, so the
 * simulation loop is purely synchronous and can never block, await, or throw on
 * a config problem mid-tick.
 *
 * `bootstrapData` is the seam that makes that ordering enforceable rather than
 * conventional: it is the only supported way to fill `DataManager`, it returns a
 * `Promise` so a caller cannot accidentally treat it as a synchronous side
 * effect, and it takes the READER as a parameter. The default reader resolves the
 * two JSON files that ship in the repository; a caller that streams its config
 * from disk or the network supplies its own reader and the engine never knows.
 *
 * WHY THE DEFAULT READER IS SYNCHRONOUS INSIDE
 * -------------------------------------------
 * The bundled tables are ES-module imports, so by the time this module is
 * evaluated the data is already in memory and there is nothing to await. The
 * asynchrony lives in the SEAM (`Promise<RawConfigTables>`), not in the read,
 * because that is the part the engine depends on: the engine must be able to be
 * bootstrapped from an I/O-bound source without a single change to `src/ecs`.
 * Pretending the bundled read is slow would buy nothing; hiding the fact that
 * the seam exists is what the signature prevents.
 */

import enemiesJson from '../../assets/data/enemies.json';
import modifiersJson from '../../assets/data/modifiers.json';
import encountersJson from '../../assets/data/encounters.json';
import projectilesJson from '../../assets/data/projectiles.json';
import hazardsJson from '../../assets/data/hazards.json';
import roomsJson from '../../assets/data/rooms.json';
import { DataManager } from './DataManager';
import type { RawConfigTables } from './DataManager';

/**
 * The shipped tables, verbatim and still UNVALIDATED.
 *
 * Exported mainly so tooling and tests can see the raw source the Bootstrap
 * consumes; nothing in the engine reads it directly — the engine reads
 * `DataManager`, which holds the PARSED objects.
 *
 * M10-T02 adds `encounters`: the room sequence (`assets/data/encounters.json`).
 * It travels through the same seam as the other two so the room layout is
 * validated — including the cross-table "every wave names a real enemy" check —
 * during Bootstrap, before a single tick has been simulated.
 *
 * M11-T01 adds `projectiles` (`assets/data/projectiles.json`, projectile TYPE
 * templates) and `hazards` (`assets/data/hazards.json`, composite-hazard templates).
 * Both travel through the same seam, so their fields AND the cross-table
 * "every `onExplodeConfigId` names a real hazard" rule are validated during
 * Bootstrap.
 *
 * M12-T01 adds `rooms` (`assets/data/rooms.json`, the terrain library). It travels
 * through the same seam so the grid shape, the tile domain and the "at least one
 * player spawn" rule are validated — and so the cross-table "every `roomId` names a
 * real room" rule runs — during Bootstrap, before a single tick has been simulated.
 */
export function bundledConfigTables(): RawConfigTables {
  return {
    enemies: enemiesJson,
    modifiers: modifiersJson,
    encounters: encountersJson,
    projectiles: projectilesJson,
    hazards: hazardsJson,
    rooms: roomsJson,
  };
}

/** How a Bootstrap obtains its raw tables. Async by contract — see the file docstring. */
export type ConfigTableReader = () => Promise<RawConfigTables>;

/** The default reader: the JSON files that ship with the repository. */
export async function readBundledConfigTables(): Promise<RawConfigTables> {
  return bundledConfigTables();
}

/**
 * Fill `DataManager` from `read` (the bundled JSON by default).
 *
 * Call this ONCE, before constructing the first `GameSimulator` — in the
 * browser entry point (`client/main.ts`) and in the test harness setup file.
 *
 * @throws SchemaError from `DataManager.loadAll` when any entry is missing a
 *   required field, mistyped, or out of domain. The process is expected to abort:
 *   a build that cannot parse its own balance data must not start simulating.
 */
export async function bootstrapData(read: ConfigTableReader = readBundledConfigTables): Promise<void> {
  DataManager.loadAll(await read());
}
