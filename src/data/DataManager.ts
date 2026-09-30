/**
 * DataManager — the static config registry of the data-driven pipeline (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §3.4 / §4 (AC-02 / AC-03).
 *
 * WHAT IT IS
 * ----------
 * A process-wide table of PARSED, VALIDATED configs: `id -> EnemyConfig`,
 * `id -> ModifierConfig`, and — as of M10-T02 — the ordered ROOM SEQUENCE a run
 * is built from (`EncounterRoomTemplate[]`, indexed by depth). Everything the
 * engine assembles reads its numbers here (`EnemyFactory`,
 * `createDefaultModifierRegistry`, `EncounterFactory`), so "what is an enemy" and
 * "what is a room" have exactly one answer each and neither is a literal in a
 * factory.
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

import {
  SchemaError,
  parseEncounterTable,
  parseEnemyConfig,
  parseHazardConfig,
  parseModifierConfig,
  parseProjectileConfig,
} from './schemas';
import type {
  EncounterRoomTemplate,
  EncounterWaveTemplate,
  EnemyConfig,
  HazardConfig,
  ModifierConfig,
  ProjectileConfig,
} from './schemas';

/**
 * The raw tables, exactly as they appear in `assets/data/*.json`.
 *
 * `enemies` / `modifiers` are objects keyed by config id; `encounters` is an
 * ORDERED ARRAY, because a room sequence has an order that a keyed object would
 * throw away (and would then have to be re-derived by sorting — see
 * `EncounterRoomTemplate`). Values are `unknown` on purpose: they have not been
 * validated yet, and that is precisely what `loadAll` is for.
 *
 * `encounters` is OPTIONAL so a caller that only ships enemies and modifiers (a
 * tool, a focused test, a future mini-build) is not forced to invent an empty
 * room table. An omitted table is treated as "no rooms configured", which
 * `getEncounterWaves` reports loudly rather than silently returning nothing.
 *
 * M11-T01 adds two more OPTIONAL id-keyed tables on the same terms:
 * `projectiles` (`assets/data/projectiles.json`, projectile TYPE templates) and
 * `hazards` (`assets/data/hazards.json`, composite-hazard templates referenced by
 * `onExplodeConfigId`). An omitted table means "this bundle ships no templates of
 * that kind", and `loadAll` treats it as an empty registry — exactly the
 * absent-vs-empty distinction `encounters` draws.
 */
export interface RawConfigTables {
  readonly enemies: Readonly<Record<string, unknown>>;
  readonly modifiers: Readonly<Record<string, unknown>>;
  readonly encounters?: readonly unknown[];
  readonly projectiles?: Readonly<Record<string, unknown>>;
  readonly hazards?: Readonly<Record<string, unknown>>;
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
   * Projectile TYPE templates (M11-T01), keyed by id.
   *
   * `readonly` (the field is never reassigned); `loadAll` clears and refills it ONLY
   * after every table has parsed cleanly, so a failed load leaves the previous
   * templates untouched — the same atomicity rule the enemy / modifier maps follow.
   */
  private static readonly projectiles = new Map<string, ProjectileConfig>();
  /**
   * Composite-hazard templates (M11-T01), keyed by id. Referenced by
   * `onExplodeConfigId` and re-spawned by `HazardSystem.detonate`. Refilled only
   * after a fully successful parse, like every other table.
   */
  private static readonly hazards = new Map<string, HazardConfig>();
  /**
   * The room sequence a run is built from (M10-T02), indexed by depth.
   *
   * An array rather than a `Map`: `depth` is validated to equal the entry's
   * position, so the array IS the depth index and a lookup is `table[depth]`.
   * Held as `readonly` and only ever REPLACED (never mutated in place) so a
   * failed load leaves the previous sequence untouched (I4).
   */
  private static encounters: readonly EncounterRoomTemplate[] = [];

  /**
   * Validate a whole config bundle and install it as THE registry (AC-01/AC-02).
   *
   * Atomic: all tables are parsed into fresh structures first, and the
   * registry is only replaced once EVERY one has parsed cleanly. A boot that
   * fails on the third enemy therefore leaves the previous tables untouched
   * instead of half-loaded — "some configs are live" is the worst possible state
   * to debug.
   *
   * The encounter table is additionally CROSS-CHECKED against the enemy table
   * (M10-T02): every enemy id a wave names must exist. This is the one rule that
   * cannot live in a leaf parser — `parseEncounterTable` sees one table, and only
   * this method sees all three. Failing here means a wave that references a
   * typo'd or deleted enemy type aborts the BOOT, rather than throwing from
   * inside `step()` at the moment the wave is due (spec 08 AC-05's "fail at the
   * seam" discipline).
   *
   * M11-T01 adds two more tables and a second cross-table rule: every
   * `onExplodeConfigId` — whether it appears on an entry of the `hazards` table or on
   * an enemy's `hazard` block — must resolve to a hazard id loaded in THIS SAME
   * load. Same rationale as the encounter check: the reference is only knowable with
   * all tables in hand, and it must fail at load time rather than from inside
   * `step()` when a hazard finally detonates.
   *
   * @throws SchemaError from the first entry that fails validation, labelled with
   *   its full path (`enemies.grunt.maxHp`, `encounters[1].waves[0].enemies[2]`,
   *   `hazards.poison_cloud.onExplodeConfigId`), so a boot failure names the exact
   *   field to fix.
   */
  public static loadAll(tables: RawConfigTables): void {
    const enemies = DataManager.parseTable(tables.enemies, 'enemies', parseEnemyConfig);
    const modifiers = DataManager.parseTable(tables.modifiers, 'modifiers', parseModifierConfig);
    // ABSENT and EMPTY are deliberately different answers (the same distinction
    // `loot` draws, spec 15 §3.3): an omitted table means "this bundle ships no
    // rooms", which is a legitimate shape for a tool or a focused test, while an
    // explicitly empty table means someone declared a run and then left it with
    // nothing to fight — a config bug, and `parseEncounterTable` rejects it.
    const encounters =
      tables.encounters === undefined ? [] : parseEncounterTable(tables.encounters, 'encounters');
    // Same absent-vs-present rule for the two M11 tables: an omitted table is an
    // empty registry (a bundle that ships no projectile / hazard templates), which is
    // legitimate — so we skip `parseTable` rather than force an empty object.
    const projectiles =
      tables.projectiles === undefined
        ? new Map<string, ProjectileConfig>()
        : DataManager.parseTable(tables.projectiles, 'projectiles', (id, data) =>
            parseProjectileConfig(id, data),
          );
    const hazards =
      tables.hazards === undefined
        ? new Map<string, HazardConfig>()
        : DataManager.parseTable(tables.hazards, 'hazards', (id, data) =>
            parseHazardConfig(data, `hazards.${id}`),
          );

    DataManager.assertEncounterEnemiesExist(encounters, enemies);
    DataManager.assertHazardRefsExist(hazards, enemies);
    DataManager.assertHazardGraphAcyclic(hazards, enemies);

    DataManager.enemies.clear();
    for (const [id, config] of enemies) DataManager.enemies.set(id, config);
    DataManager.modifiers.clear();
    for (const [id, config] of modifiers) DataManager.modifiers.set(id, config);
    DataManager.projectiles.clear();
    for (const [id, config] of projectiles) DataManager.projectiles.set(id, config);
    DataManager.hazards.clear();
    for (const [id, config] of hazards) DataManager.hazards.set(id, config);
    DataManager.encounters = encounters;
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

  /* ---------------------------------------------------------------------- *
   * Projectile + hazard templates (M11-T01)                                 *
   * ---------------------------------------------------------------------- */

  /**
   * The parsed projectile template for `id`.
   *
   * @throws SchemaError when the registry is EMPTY (Bootstrap never ran) or when
   *   `id` is not in the table (listing the known ids), exactly like
   *   {@link getEnemyConfig}.
   */
  public static getProjectileConfig(id: string): ProjectileConfig {
    const config = DataManager.projectiles.get(id);
    if (config === undefined) {
      throw new SchemaError(
        DataManager.unknownIdMessage('projectile', id, DataManager.projectiles.size),
      );
    }
    return config;
  }

  /** @throws SchemaError under the conditions listed on {@link getProjectileConfig}. */
  public static getHazardConfig(id: string): HazardConfig {
    const config = DataManager.hazards.get(id);
    if (config === undefined) {
      throw new SchemaError(DataManager.unknownIdMessage('hazard', id, DataManager.hazards.size));
    }
    return config;
  }

  /** Whether a projectile template with this id is loaded. */
  public static hasProjectile(id: string): boolean {
    return DataManager.projectiles.has(id);
  }

  /** Whether a hazard template with this id is loaded. */
  public static hasHazard(id: string): boolean {
    return DataManager.hazards.has(id);
  }

  /** Every loaded projectile id, ascending. Sorted so the order is byte-for-byte stable. */
  public static get projectileIds(): readonly string[] {
    return [...DataManager.projectiles.keys()].sort(compareIds);
  }

  /** Every loaded hazard id, ascending. */
  public static get hazardIds(): readonly string[] {
    return [...DataManager.hazards.keys()].sort(compareIds);
  }

  /** How many projectile templates are loaded. */
  public static get projectileCount(): number {
    return DataManager.projectiles.size;
  }

  /** How many hazard templates are loaded. */
  public static get hazardCount(): number {
    return DataManager.hazards.size;
  }

  /* ---------------------------------------------------------------------- *
   * Encounter table (M10-T02)                                              *
   * ---------------------------------------------------------------------- */

  /** How many rooms the configured run has, i.e. the table's length. */
  public static getEncounterRoomCount(): number {
    return DataManager.encounters.length;
  }

  /**
   * Every configured depth, ascending (`[0, 1, …, n - 1]`).
   *
   * Derived from the table's length rather than from the `depth` fields, and that
   * is not a shortcut: the parser enforces `depth === index`, so the two cannot
   * disagree. Sorted by construction, so this is stable across machines with no
   * `localeCompare` anywhere near it (spec 00 §6.2).
   */
  public static get encounterDepths(): readonly number[] {
    return DataManager.encounters.map((_room, index) => index);
  }

  /**
   * The wave templates of the room at `depth` (M10-T02, AC-02).
   *
   * This is the whole of AC-02's "read the config by depth": the run's rooms are
   * a SEQUENCE, so room `d` is `table[d]` — no per-room code, no growing `if`
   * ladder, and adding a room is a JSON edit.
   *
   * Past the end of the table the sequence CYCLES (`table[depth % n]`), which is
   * the "循环复用" half of AC-02. Cycling rather than clamping is deliberate: a
   * clamped lookup would silently replay the last room forever, while a cycle
   * keeps producing a *different* room each descent — which is what a
   * difficulty-escalating descent (the `depth` dial, spec 11 AC-04) expects to
   * find. Either way the run is bounded by `getEncounterRoomCount()`, so in a
   * shipped configuration the final room still wins the run before any wrap can
   * be observed.
   *
   * @throws SchemaError when no encounter table is loaded (Bootstrap never ran,
   *   or it ran against a bundle that ships no rooms) — reported as that, rather
   *   than as a mysterious empty result.
   * @throws SchemaError when `depth` is not a non-negative integer. A fractional
   *   or negative depth is a wiring bug; a modulo would happily turn it into a
   *   plausible-looking room.
   */
  public static getEncounterWaves(depth: number): readonly EncounterWaveTemplate[] {
    const table = DataManager.encounters;
    if (table.length === 0) {
      throw new SchemaError(
        'no encounter config is loaded, so the wave templates cannot be resolved: run the Bootstrap phase (bootstrapData()) before constructing a GameSimulator (spec 17 AC-01).',
      );
    }
    if (!Number.isInteger(depth) || depth < 0) {
      throw new SchemaError(
        `encounter depth must be a non-negative integer, received ${String(depth)}.`,
      );
    }
    const room = table[depth % table.length];
    if (room === undefined) {
      // Unreachable: the modulo above is always inside `[0, length)` and the
      // table is non-empty. Kept total rather than `!`-asserted.
      throw new SchemaError(`no encounter room is configured for depth ${String(depth)}.`);
    }
    return room.waves;
  }

  /**
   * Whether any config is loaded, i.e. whether Bootstrap has run.
   *
   * Encounters are deliberately NOT part of this answer: they are an optional
   * table (see `RawConfigTables`), so an enemy-only bundle is a legitimately
   * loaded registry. `getEncounterWaves` is what reports a missing room table,
   * and it says so in its own words.
   */
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
    DataManager.projectiles.clear();
    DataManager.hazards.clear();
    DataManager.encounters = [];
  }

  /**
   * The cross-table rule of M10-T02: every enemy id an encounter wave names must
   * exist in the enemy table that is being installed IN THE SAME LOAD.
   *
   * Checking against the freshly parsed `enemies` map (rather than against the
   * live registry) is what keeps `loadAll` atomic in the only way that matters: a
   * bundle whose enemy table drops a type still referenced by its room table is
   * rejected as a whole, instead of being accepted against the outgoing registry
   * and then failing on the next `spawn`.
   *
   * @throws SchemaError naming the offending path and listing what IS loaded, so
   *   a renamed or deleted enemy type is obvious rather than mysterious.
   */
  private static assertEncounterEnemiesExist(
    encounters: readonly EncounterRoomTemplate[],
    enemies: ReadonlyMap<string, EnemyConfig>,
  ): void {
    for (let roomIndex = 0; roomIndex < encounters.length; roomIndex += 1) {
      const room = encounters[roomIndex];
      if (room === undefined) continue;
      for (let waveIndex = 0; waveIndex < room.waves.length; waveIndex += 1) {
        const wave = room.waves[waveIndex];
        if (wave === undefined) continue;
        for (let enemyIndex = 0; enemyIndex < wave.enemies.length; enemyIndex += 1) {
          const enemyId = wave.enemies[enemyIndex];
          if (enemyId === undefined || enemies.has(enemyId)) continue;
          const known = [...enemies.keys()].sort(compareIds);
          throw new SchemaError(
            `encounters[${String(roomIndex)}].waves[${String(waveIndex)}].enemies[${String(enemyIndex)}] references unknown enemy id '${enemyId}'. Loaded enemy ids: ${known.join(', ')}.`,
          );
        }
      }
    }
  }

  /**
   * The cross-table rule of M11-T01: every `onExplodeConfigId` — on an entry of the
   * `hazards` table OR on an enemy's `hazard` block — must name a hazard that is
   * being installed IN THE SAME LOAD.
   *
   * Same reasoning as {@link assertEncounterEnemiesExist}: the reference is only
   * resolvable with all tables in hand, so it must be checked here and fail at load
   * time. `HazardSystem.detonate` then performs a plain lookup that cannot throw
   * (spec 18 I5), which is what keeps the runtime free of config validation.
   *
   * Both sources are walked in ascending id order so the FIRST offending reference
   * is deterministic across machines (no `localeCompare`).
   *
   * @throws SchemaError naming the offending path and listing the loaded hazard ids.
   */
  private static assertHazardRefsExist(
    hazards: ReadonlyMap<string, HazardConfig>,
    enemies: ReadonlyMap<string, EnemyConfig>,
  ): void {
    const known = [...hazards.keys()].sort(compareIds);

    for (const id of known) {
      const config = hazards.get(id);
      if (config === undefined) continue;
      const ref = config.onExplodeConfigId;
      if (ref === undefined || hazards.has(ref)) continue;
      throw new SchemaError(
        `hazards.${id}.onExplodeConfigId references unknown hazard id '${ref}'. Loaded hazard ids: ${known.join(', ')}.`,
      );
    }

    for (const enemyId of [...enemies.keys()].sort(compareIds)) {
      const config = enemies.get(enemyId);
      if (config === undefined) continue;
      const ref = config.hazard?.onExplodeConfigId;
      if (ref === undefined || hazards.has(ref)) continue;
      throw new SchemaError(
        `enemies.${enemyId}.hazard.onExplodeConfigId references unknown hazard id '${ref}'. Loaded hazard ids: ${known.join(', ')}.`,
      );
    }
  }

  /**
   * The acyclicity rule of M11-T01 (spec 18 §4.4): the `onExplodeConfigId` reference
   * graph — over the `hazards` table AND every `enemies.<id>.hazard` block — must be
   * a DAG.
   *
   * WHY: `HazardSystem.advanceHazards` drains a WORK QUEUE, so a hazard detonated on
   * tick `T` appends its child to the SAME tick's drain. That is what makes "planted
   * on tick `T` with `delayTicks = N` detonates on tick `T + N`" hold for phase-A and
   * phase-B hazards alike — but it also means a CYCLE would let a chain re-enter
   * itself within one `step()`. A DAG is the precondition that makes the same-tick
   * drain provably finite; the `MAX_HAZARD_CHAIN_PER_TICK` cap is only defence in
   * depth for a config that somehow slipped past this check. A self-reference
   * (`hazards.x -> hazards.x`) is the smallest cycle and is rejected here too.
   *
   * Existence is checked FIRST ({@link assertHazardRefsExist}), so every edge this
   * walk follows already points at a loaded hazard id.
   *
   * Determinism: start nodes are visited in ascending id order and each node has AT
   * MOST one successor (an `onExplodeConfigId`), so this is a plain functional-graph
   * walk — no `localeCompare`, no reliance on `Map` insertion order.
   *
   * @throws SchemaError naming the cycle path, e.g.
   *   `hazards.a -> hazards.b -> hazards.a`.
   */
  private static assertHazardGraphAcyclic(
    hazards: ReadonlyMap<string, HazardConfig>,
    enemies: ReadonlyMap<string, EnemyConfig>,
  ): void {
    // Node labels: `hazards.<id>` and `enemies.<id>.hazard`. Each node has at most one
    // outgoing edge, so the graph is FUNCTIONAL — the walk below is exhaustive.
    const successor = new Map<string, string>();

    for (const id of [...hazards.keys()].sort(compareIds)) {
      const ref = hazards.get(id)?.onExplodeConfigId;
      if (ref !== undefined) successor.set(`hazards.${id}`, `hazards.${ref}`);
    }
    for (const enemyId of [...enemies.keys()].sort(compareIds)) {
      const ref = enemies.get(enemyId)?.hazard?.onExplodeConfigId;
      if (ref !== undefined) successor.set(`enemies.${enemyId}.hazard`, `hazards.${ref}`);
    }

    const settled = new Set<string>();
    for (const start of [...successor.keys()].sort(compareIds)) {
      if (settled.has(start)) continue;

      const path: string[] = [];
      const onPath = new Map<string, number>();
      let node: string | undefined = start;

      while (node !== undefined && !settled.has(node)) {
        const seenAt = onPath.get(node);
        if (seenAt !== undefined) {
          const cycle = [...path.slice(seenAt), node];
          throw new SchemaError(
            `onExplodeConfigId forms a cycle: ${cycle.join(' -> ')}. A composite-hazard chain must be finite (spec 18 §4.4).`,
          );
        }
        onPath.set(node, path.length);
        path.push(node);
        node = successor.get(node);
      }

      for (const visited of path) settled.add(visited);
    }
  }

  /** Parse a whole id-keyed table, keys in ascending order for stable error reporting. */
  private static parseTable<T>(    table: Readonly<Record<string, unknown>>,
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

  /** Every loaded id of a given config `kind`, ascending — the "known ids" list. */
  private static idsFor(kind: string): readonly string[] {
    switch (kind) {
      case 'enemy':
        return DataManager.enemyIds;
      case 'modifier':
        return DataManager.modifierIds;
      case 'projectile':
        return DataManager.projectileIds;
      case 'hazard':
        return DataManager.hazardIds;
      default:
        return [];
    }
  }

  /** The two distinct "no config" messages, so a boot error reads as what it is. */
  private static unknownIdMessage(kind: string, id: string, loaded: number): string {
    if (loaded === 0) {
      return `no config tables are loaded, so ${kind} '${id}' cannot be resolved: run the Bootstrap phase (bootstrapData()) before constructing a GameSimulator (spec 16 AC-03).`;
    }
    const known = DataManager.idsFor(kind);
    return `unknown ${kind} id '${id}'. Loaded ${kind} ids: ${known.join(', ')}.`;
  }
}
