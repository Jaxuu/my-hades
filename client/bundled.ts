/**
 * The client's own config source, plus the Vite hot-reload seam (M10-T02).
 * See specs/17_encounters_hmr_spec.md §3.3 / §4.3 (AC-03).
 *
 * WHY THE CLIENT OWNS THE JSON MODULES
 * ------------------------------------
 * `src/data/bundled.ts` already imports the three tables and hands them to the same
 * `DataManager.loadAll`. The client could simply call `bootstrapData()` and be done
 * — but then a dev-mode JSON edit would propagate up the import graph
 * (`assets/data/x.json` -> `src/data/bundled.ts` -> `src/data/index.ts` -> this
 * entry) to a module with no HMR boundary, and Vite would answer with a FULL PAGE
 * RELOAD: canvas torn down, run lost, and none of the "re-open the same run against
 * the new numbers" behaviour AC-03 asks for.
 *
 * So the Vite entry imports the JSON files ITSELF and accepts them here. That makes
 * this module the boundary Vite stops at, and it keeps `src/` completely free of
 * `import.meta` — which is a hard rule of this milestone: HMR is a BUILD-CONCERN,
 * and the deterministic core must not even know it exists.
 *
 * The tables still travel through `DataManager.loadAll`, i.e. through the exact same
 * schema validation the production bootstrap uses. A reload of a broken file
 * therefore fails exactly where a broken boot fails, and — because `loadAll` is
 * atomic — it leaves the RUNNING game's config untouched instead of half-swapping it.
 *
 * PRODUCTION IS UNAFFECTED: `import.meta.hot` is `undefined` outside a Vite dev
 * server, so `installDataHotReload` is a no-op in a build and the dead branch is
 * removed by the bundler.
 */

import enemiesJson from '../assets/data/enemies.json';
import modifiersJson from '../assets/data/modifiers.json';
import encountersJson from '../assets/data/encounters.json';
import roomsJson from '../assets/data/rooms.json';
import metaUpgradesJson from '../assets/data/meta_upgrades.json';

import { DataManager } from '../src/data/DataManager';
import type { RawConfigTables } from '../src/data/DataManager';

/**
 * The shipped tables, verbatim and still UNVALIDATED.
 *
 * Same shape and same source files as `src/data/bundled.ts::bundledConfigTables`;
 * the duplication is the POINT rather than an oversight — this module must be the
 * only place in the client graph that imports them, or Vite's propagation escapes
 * to a non-accepting module (see the file docstring).
 */
export function clientConfigTables(): RawConfigTables {
  return {
    enemies: enemiesJson,
    modifiers: modifiersJson,
    encounters: encountersJson,
    rooms: roomsJson,
    // M13-T01: the hub's talent price list. Without it the hub UI would have
    // nothing to render and `resolveMetaBonuses` would grant nothing.
    metaUpgrades: metaUpgradesJson,
  };
}

/**
 * Fill `DataManager` from the client's bundled tables.
 *
 * Async to match the `bootstrapData()` contract it stands in for (spec 16 AC-03):
 * the boot sequence is "await the config, THEN build a simulator", and keeping the
 * signature async means the client entry cannot accidentally reorder it.
 *
 * @throws SchemaError from `DataManager.loadAll` when any entry is missing a
 *   required field, mistyped, out of domain, or when an encounter wave names an
 *   enemy type that does not exist. A build that cannot parse its own balance data
 *   must not start simulating.
 */
export async function bootstrapClientData(): Promise<void> {
  DataManager.loadAll(clientConfigTables());
}

/** What the caller does once a reload has been accepted and installed. */
export interface DataHotReloadOptions {
  /**
   * Rebuild the run against the freshly installed config — in practice
   * `() => { sim.restartRun(sim.currentSeed); renderer.reset(); }`.
   *
   * It is a CALLBACK rather than logic in here because this module knows about
   * data, and the thing that must be rebuilt is a simulation and a scene graph.
   * Keeping the two apart is what lets the reload be unit-tested in spirit (the
   * data half is a plain `loadAll`) while the rebuild stays where the simulator
   * lives.
   */
  readonly onReload: () => void;
}

/** A JSON module namespace: the parsed value rides on `default`. */
interface JsonModule {
  readonly default?: unknown;
}

/** The module's new value if the hot update carried one, else the original import. */
function moduleValue(module: unknown, fallback: unknown): unknown {
  if (module === null || typeof module !== 'object') return fallback;
  const value = (module as JsonModule).default;
  return value === undefined ? fallback : value;
}

/**
 * Assemble a `RawConfigTables` from the modules Vite hands the accept callback.
 *
 * The `??` fallbacks are not defensive noise: Vite calls the callback with the
 * CHANGED modules only, and an entry can legitimately be `undefined` for a file that
 * did not change. Falling back to the module-level import keeps the untouched tables
 * at their current values, so a reload of `enemies.json` alone does not blank the
 * encounter table.
 */
function tablesFromHotModules(modules: readonly unknown[] | undefined): RawConfigTables {
  const [enemies, modifiers, encounters, rooms, metaUpgrades] = modules ?? [];
  return {
    enemies: moduleValue(enemies, enemiesJson) as Readonly<Record<string, unknown>>,
    modifiers: moduleValue(modifiers, modifiersJson) as Readonly<Record<string, unknown>>,
    encounters: moduleValue(encounters, encountersJson) as readonly unknown[],
    // M12-T01: the terrain library rides the same seam, so editing `rooms.json`
    // mid-session re-validates the grids AND re-runs the cross-table "every roomId
    // names a real room" check before the run is rebuilt against them.
    rooms: moduleValue(rooms, roomsJson) as Readonly<Record<string, unknown>>,
    // M13-T01: the meta-upgrade table rides it too, so re-pricing a talent is a
    // JSON edit that takes effect without a page reload.
    metaUpgrades: moduleValue(metaUpgrades, metaUpgradesJson) as Readonly<Record<string, unknown>>,
  };
}

/**
 * Install the dev-mode JSON hot reload (AC-03).
 *
 * Wires Vite's HMR API to the data layer: a change to any of the three tables
 * re-runs `DataManager.loadAll` with the NEW module contents and then asks the
 * caller to rebuild the run, so editing `enemies.json` mid-session shows the new
 * numbers without a page reload and without restarting the dev server.
 *
 * Three properties are deliberate:
 *
 *  1. **Dev-only.** `import.meta.hot` is `undefined` in a production bundle, so this
 *     function returns immediately and nothing else in the file is reachable.
 *  2. **Fail-soft.** A malformed edit is caught, reported, and the running game is
 *     left alone — `loadAll` is atomic, so the previous tables are still live. A hot
 *     reload that killed the session on a typo would be worse than no hot reload.
 *  3. **The seed is preserved.** The caller restarts with `sim.currentSeed`, so the
 *     reload changes the CONFIG and nothing else; a data edit is not a free re-roll.
 *
 * M12-T01 adds `rooms.json` to the accepted set. Editing a grid therefore
 * re-validates the tilemap (shape, tile domain, player spawn) AND the cross-table
 * "every encounter `roomId` names a real room" rule, and then re-opens the same run
 * on the new terrain — which is what makes level authoring a data edit rather than a
 * code change.
 */
export function installDataHotReload(options: DataHotReloadOptions): void {
  const hot = import.meta.hot;
  if (hot === undefined) return;

  // The dependency list must be written out literally: Vite resolves it STATICALLY
  // to decide which modules this one accepts, so a variable would silently accept
  // nothing and fall back to a full page reload.
  hot.accept(
    [
      '../assets/data/enemies.json',
      '../assets/data/modifiers.json',
      '../assets/data/encounters.json',
      '../assets/data/rooms.json',
      '../assets/data/meta_upgrades.json',
    ],
    (modules) => {
      try {
        DataManager.loadAll(tablesFromHotModules(modules));
      } catch (error) {
        // Report and keep the previous config live (see `loadAll`'s atomicity).
        console.error('[data-hmr] config reload rejected; the running run keeps the previous tables.', error);
        return;
      }
      options.onReload();
    },
  );
}
