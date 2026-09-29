/**
 * DataManager — the static config registry of the data-driven pipeline (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §3.4 / §4 (AC-02 / AC-03).
 *
 * WHAT IT IS
 * ----------
 * A process-wide table of PARSED, VALIDATED configs: `id -> EnemyConfig` and
 * `id -> ModifierConfig`. Everything the engine assembles reads its numbers here
 * (`EnemyFactory`, `createDefaultModifierRegistry`), so "what is an enemy" has
 * exactly one answer and it is not a literal in a factory.
 *
 * WHY STATIC (and why that is not a hidden-state violation)
 * --------------------------------------------------------
 * The engine's no-hidden-state rule (spec 00 §6.1) is about SIMULATION state:
 * anything that can change between two ticks of the same run must live on a
 * component so it is snapshot-visible and replay-exact. Config is the opposite —
 * it is IMMUTABLE for the lifetime of a process and identical for every tick of
 * every run, so it is not state the simulation can observe drifting. Making it
 * process-global is what lets `createDefaultSystems()` keep its zero-argument
 * call shape and what keeps `step()` free of any lookup that could fail.
 *
 * AC-03 makes the timing explicit: the table is filled ONCE, in the Bootstrap
 * phase, BEFORE a `GameSimulator` exists. After that it is only ever read. A
 * lookup before Bootstrap (or for an unknown id) therefore throws rather than
 * returning `undefined` — a missing config is a wiring bug, and a `undefined`
 * reaching `spawnCombatant` would surface as `NaN` health several ticks later.
 *
 * DETERMINISM
 * -----------
 * The registry is keyed by string and never iterated in insertion order for
 * anything observable: `enemyIds` / `modifierIds` return UTF-16 code-unit sorted
 * lists (never `localeCompare`), so error messages and any future tooling that
 * walks the table are byte-for-byte stable across machines.
 */

import { SchemaError, parseEnemyConfig, parseModifierConfig } from './schemas';
import type { EnemyConfig, ModifierConfig } from './schemas';

/**
 * The raw tables, exactly as they appear in `assets/data/*.json`: an object
 * keyed by config id. Values are `unknown` on purpose — they have not been
 * validated yet, and that is precisely what `loadAll` is for.
 */
export interface RawConfigTables {
  readonly enemies: Readonly<Record<string, unknown>>;
  readonly modifiers: Readonly<Record<string, unknown>>;
}

/** Deterministic (locale-free) string ordering — UTF-16 code units, not collation. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class DataManager {
  private static readonly enemies = new Map<string, EnemyConfig>();
  private static readonly modifiers = new Map<string, ModifierConfig>();

  /**
   * Validate a whole config bundle and install it as THE registry (AC-01/AC-02).
   *
   * Atomic: both tables are parsed into fresh maps first, and the registry is
   * only replaced once BOTH have parsed cleanly. A boot that fails on the third
   * enemy therefore leaves the previous table untouched instead of half-loaded —
   * "some configs are live" is the worst possible state to debug.
   *
   * @throws SchemaError from the first entry that fails validation, labelled with
   *   its full path (`enemies.grunt.maxHp`), so a boot failure names the exact
   *   field to fix.
   */
  public static loadAll(tables: RawConfigTables): void {
    const enemies = DataManager.parseTable(tables.enemies, 'enemies', parseEnemyConfig);
    const modifiers = DataManager.parseTable(tables.modifiers, 'modifiers', parseModifierConfig);

    DataManager.enemies.clear();
    for (const [id, config] of enemies) DataManager.enemies.set(id, config);
    DataManager.modifiers.clear();
    for (const [id, config] of modifiers) DataManager.modifiers.set(id, config);
  }

  /**
   * Validate and add ONE enemy type without touching the rest of the registry.
   *
   * The additive counterpart of {@link loadAll}, used by tooling and by the test
   * harness (which derives throwaway enemy types from the shipped ones). It
   * exists so a caller that only wants to add a fixture never has to reconstruct
   * — and risk truncating — the whole table.
   *
   * @throws SchemaError under the conditions listed on `parseEnemyConfig`.
   */
  public static registerEnemy(id: string, data: unknown): void {
    DataManager.enemies.set(id, parseEnemyConfig(id, data));
  }

  /** @throws SchemaError under the conditions listed on `parseModifierConfig`. */
  public static registerModifier(id: string, data: unknown): void {
    DataManager.modifiers.set(id, parseModifierConfig(id, data));
  }

  /**
   * The parsed config for `id`.
   *
   * @throws SchemaError when the registry is EMPTY (Bootstrap never ran — the
   *   AC-03 failure mode, reported as such rather than as a mysterious unknown
   *   id) or when `id` is not in the table (listing the known ids, because the
   *   usual cause is a typo or a config that was never added).
   */
  public static getEnemyConfig(id: string): EnemyConfig {
    const config = DataManager.enemies.get(id);
    if (config === undefined) {
      throw new SchemaError(DataManager.unknownIdMessage('enemy', id, DataManager.enemies.size));
    }
    return config;
  }

  /** @throws SchemaError under the conditions listed on {@link getEnemyConfig}. */
  public static getModifierConfig(id: string): ModifierConfig {
    const config = DataManager.modifiers.get(id);
    if (config === undefined) {
      throw new SchemaError(DataManager.unknownIdMessage('modifier', id, DataManager.modifiers.size));
    }
    return config;
  }

  /** Whether an enemy type with this id is loaded. */
  public static hasEnemy(id: string): boolean {
    return DataManager.enemies.has(id);
  }

  /** Whether a modifier config with this id is loaded. */
  public static hasModifier(id: string): boolean {
    return DataManager.modifiers.has(id);
  }

  /** Every loaded enemy id, ascending. Sorted so the order is byte-for-byte stable. */
  public static get enemyIds(): readonly string[] {
    return [...DataManager.enemies.keys()].sort(compareIds);
  }

  /** Every loaded modifier id, ascending. */
  public static get modifierIds(): readonly string[] {
    return [...DataManager.modifiers.keys()].sort(compareIds);
  }

  /** How many enemy types are loaded. */
  public static get enemyCount(): number {
    return DataManager.enemies.size;
  }

  /** How many modifier configs are loaded. */
  public static get modifierCount(): number {
    return DataManager.modifiers.size;
  }

  /** Whether any config is loaded, i.e. whether Bootstrap has run. */
  public static get isLoaded(): boolean {
    return DataManager.enemies.size > 0 || DataManager.modifiers.size > 0;
  }

  /**
   * Drop every config. The ONLY caller is a test that wants to assert the
   * un-bootstrapped failure mode; production code never unloads its config.
   */
  public static clear(): void {
    DataManager.enemies.clear();
    DataManager.modifiers.clear();
  }

  /** Parse a whole id-keyed table, keys in ascending order for stable error reporting. */
  private static parseTable<T>(
    table: Readonly<Record<string, unknown>>,
    label: string,
    parse: (id: string, data: unknown) => T,
  ): Map<string, T> {
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      throw new SchemaError(`${label} must be an object keyed by config id.`);
    }
    const parsed = new Map<string, T>();
    for (const id of Object.keys(table).sort(compareIds)) {
      parsed.set(id, parse(id, table[id]));
    }
    return parsed;
  }

  /** The two distinct "no config" messages, so a boot error reads as what it is. */
  private static unknownIdMessage(kind: string, id: string, loaded: number): string {
    if (loaded === 0) {
      return `no config tables are loaded, so ${kind} '${id}' cannot be resolved: run the Bootstrap phase (bootstrapData()) before constructing a GameSimulator (spec 16 AC-03).`;
    }
    const known = kind === 'enemy' ? DataManager.enemyIds : DataManager.modifierIds;
    return `unknown ${kind} id '${id}'. Loaded ${kind} ids: ${known.join(', ')}.`;
  }
}
