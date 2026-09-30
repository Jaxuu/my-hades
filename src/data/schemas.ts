/**
 * Config schema + runtime validation for the data-driven pipeline (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §3 (AC-01 / AC-02).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before M10 every balance number lived as a `const` next to the code that used
 * it (`DEFAULT_ELITE_MAX_HP = 300` in `EnemyFactory`, `DEFAULT_ZEUS_STRIKE_DAMAGE
 * = 20` in `ZeusStrikeModifier`). Re-tuning an enemy meant editing — and
 * re-reviewing — engine source, and nothing stopped a caller from passing
 * `{ maxHp: Number.NaN }` straight into assembly.
 *
 * M10 splits the two concerns that were tangled together:
 *
 *  - **Shape** (this file): what a legal `EnemyConfig` / `ModifierConfig` IS, as
 *    TypeScript types, plus a hand-written runtime validator for each.
 *  - **Values** (`assets/data/*.json`): what the shipped numbers ARE.
 *
 * AC-02 — WHY A HAND-WRITTEN VALIDATOR AND NOT A CAST
 * ---------------------------------------------------
 * `resolveJsonModule` types an imported JSON file by its literal contents, so
 * `enemiesJson.grunt.maxHp` is `number` at compile time. That is a *lie* the
 * moment the file is edited: the compiler never sees the edit, and a typo like
 * `"maxHp": "100"` would flow into `HealthComponent` as a string and turn the
 * first damage tick into `NaN`. TypeScript types cannot defend a data boundary —
 * only a runtime check can.
 *
 * So every JSON entry is passed through a parser that FAILS LOUDLY at load time:
 *
 *  - a missing required field  -> `SchemaError`
 *  - a wrong type (`"100"`)    -> `SchemaError`
 *  - an out-of-domain number   -> `SchemaError`
 *
 * and the parsed result is a fresh, fully-populated object. Nothing `undefined`
 * and nothing `NaN` can reach the ECS, because the engine only ever reads the
 * PARSED object — the raw JSON is never handed to a system.
 *
 * The failure is deliberately a THROW rather than a returned `Result`: the
 * loader runs in the Bootstrap phase, before a single tick has been simulated,
 * so aborting the boot is the correct and cheapest response (AC-03).
 *
 * `isEnemyConfig` / `isModifierConfig` are the non-throwing twins, for callers
 * that want to probe a candidate (a tool, a test, a hot-reload diff). They are
 * implemented ON TOP of the parsers, so the two can never drift.
 */

/**
 * The one error type this layer throws.
 *
 * Deliberately its own class rather than a bare `Error`/`RangeError`: a caller
 * catching it knows the failure is a CONFIG problem (fix the JSON) rather than a
 * simulation problem (fix the code), and `name` shows up in stack traces as
 * `SchemaError` so a boot failure is identifiable at a glance.
 */
export class SchemaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Dash tuning of one enemy type; mirrors the fields of `DashStatsComponent`. */
export interface DashConfig {
  readonly speedMultiplier: number;
  readonly durationTicks: number;
  readonly invulnerableTicks: number;
  readonly cooldownTicks: number;
}

/**
 * AI tuning of one enemy type; mirrors the fields of `AIControllerComponent`.
 *
 * `targetEntityId` is deliberately ABSENT: which entity an enemy hunts is a
 * per-INSTANCE fact (it is an `EntityId`, and ids are not stable across a
 * restart), not a property of the enemy TYPE. It travels as spawn placement —
 * see `EnemyPlacement`.
 */
export interface AIConfig {
  readonly sightRadius: number;
  readonly attackRadius: number;
  readonly windupTicks: number;
  readonly cooldownTicks: number;
}

/** Hazard-casting tuning of one enemy type; mirrors `HazardCasterComponent`. */
export interface HazardConfig {
  readonly radius: number;
  readonly damage: number;
  readonly delayTicks: number;
}

/**
 * One declared loot drop, as written in JSON.
 *
 * `kind` is a lowercase STRING rather than the `PickupKind` enum on purpose: a
 * JSON file cannot name a TypeScript enum, and `"GOLD"` in data would be a
 * second, silent spelling of the same thing. `EnemyFactory` is the single place
 * that maps the string onto the enum, so the two spellings meet exactly once.
 */
export interface LootDropConfig {
  readonly kind: 'gold' | 'heal';
  /** Magnitude of the grant; omitted means "the kind's default" (`5` / `20`). */
  readonly amount?: number;
  /** Pickup radius; omitted means `DEFAULT_PICKUP_RADIUS`. */
  readonly radius?: number;
  /** Survival time in ticks; omitted means `DEFAULT_PICKUP_LIFESPAN_TICKS`. */
  readonly lifespanTicks?: number;
}

/**
 * The ELITE variant of an enemy type (the M6-T02 "bigger body, standing armor"
 * concept, now expressed as data).
 *
 * All three fields are REQUIRED. A half-declared elite is a config bug rather
 * than a legal "inherit the base value": `spawnElite` exists precisely to
 * promise "this entity is an elite", and an elite whose armour silently fell
 * back to the base enemy's (none) would ship as a plain enemy wearing the
 * elite's name — the exact failure the pre-M10 `armor: 0` rejection guarded
 * against.
 */
export interface EliteVariantConfig {
  readonly maxHp: number;
  readonly hurtboxRadius: number;
  readonly armor: number;
}

/**
 * One enemy TYPE, fully parsed and validated.
 *
 * `id` is filled in by the loader from the table KEY (`enemies.json` is an
 * object keyed by id), so the id exists exactly once in the file and cannot
 * disagree with itself.
 */
export interface EnemyConfig {
  /** Table key this config was loaded under. */
  readonly id: string;
  /** Hit-point ceiling. Must be a positive finite number. */
  readonly maxHp: number;
  /** Locomotion speed in world units per second. Must be positive finite. */
  readonly maxSpeed: number;
  /** Hurtbox radius in world units. Must be positive finite. */
  readonly hurtboxRadius: number;
  /**
   * Starting hit points. Omitted means "spawn at full health". Must be finite,
   * `>= 0` and `<= maxHp` — a spawn above the ceiling is a config bug, not a
   * free heal.
   */
  readonly hp?: number;
  /**
   * Standing armour pool. Present mounts an `ArmorComponent` (spec 12 AC-01);
   * omitted mounts none. Must be positive finite — `0` is a config bug, not a
   * legal "no armour".
   */
  readonly armor?: number;
  /** Dash tuning. Omitted means "every `DashStatsComponent` default". */
  readonly dash?: DashConfig;
  /** AI tuning. Present mounts an `AIControllerComponent`, making the enemy FSM-driven. */
  readonly ai?: AIConfig;
  /** Hazard-casting tuning. Present mounts a `HazardCasterComponent` (bomb planter). */
  readonly hazard?: HazardConfig;
  /** Loot table. Present mounts a `LootComponent`; must be non-empty. */
  readonly loot?: readonly LootDropConfig[];
  /** The elite variant, for `EnemyFactory.spawnElite`. */
  readonly elite?: EliteVariantConfig;
}

/**
 * One boon's injected-hitbox parameters, fully parsed and validated.
 *
 * This is the shape the two hitbox-spawning boons read (`zeus_strike`,
 * `poseidon_dash`). A boon that injects no hitbox — `dionysus_strike`, which
 * stamps a status whose numbers live in `POISON_STATUS_SPEC` — has no entry, and
 * asks for none.
 */
export interface ModifierConfig {
  /** Radius of the injected hitbox, in world units. Positive finite. */
  readonly radius: number;
  /** Damage the hitbox deals on a landed hit. Non-negative finite (`0` is legal). */
  readonly damage: number;
  /**
   * Lifetime in ticks. Must be `>= 2` — an injected hitbox is created AFTER
   * `CollisionSystem` has run for this tick and is aged by `LifespanSystem` at
   * the END of it, so a lifetime of `1` would destroy it before it was ever
   * tested: a silent no-op (spec 05 §4.4). Enforced here rather than trusted,
   * because that mistake is invisible at runtime.
   */
  readonly lifespanTicks: number;
  /** Hitstop the hitbox requests. Non-negative integer; `0` = pure damage. */
  readonly hitstopTicks: number;
  /** Knockback speed the hitbox requests. Non-negative finite; `0` = no shove. */
  readonly knockbackForce: number;
}

/**
 * One wave of a room TEMPLATE, as written in `assets/data/encounters.json`
 * (M10-T02).
 *
 * `enemies` is a list of enemy TYPE ids — plain strings, not specs — because a
 * wave template is a fact about the ROOM, not about any one entity: it says
 * "this wave is two raiders", not "this raider stands at x = -1". Where each
 * enemy ends up is a per-INSTANCE fact and is derived deterministically by the
 * encounter layer's formation rule (`EncounterFactory.formWaveRoster`), which is
 * the same split `EnemyConfig` / `EnemyPlacement` already follows.
 *
 * Keeping placement OUT of the file is also what makes a wave template readable
 * and diff-able: re-tuning a fight is "change 2 to 3", not "recompute twenty
 * coordinate pairs".
 */
export interface EncounterWaveTemplate {
  /**
   * Ticks to wait before this wave spawns, counted from the moment the wave
   * becomes PENDING. Must be a non-negative integer; `0` means "as soon as it is
   * pending" (spec 08 §3.4).
   */
  readonly delayTicks: number;
  /** Non-empty list of enemy TYPE ids; each must exist in `enemies.json`. */
  readonly enemies: readonly string[];
}

/**
 * One room template, keyed by the depth it belongs to (M10-T02).
 *
 * The table is a SEQUENCE: entry `k` must declare `depth: k`. That single rule
 * buys three things at once —
 *
 *  1. **No drift.** The `depth` field cannot disagree with the entry's position,
 *     because a disagreement is a load error rather than a silent shadowing.
 *  2. **Order is explicit.** Room `0` is the opening room and room `k + 1`
 *     follows it, so the run's shape reads top-to-bottom in the file.
 *  3. **AC-02 is a one-liner.** "Read the config by depth" is `table[depth]`, and
 *     "past the end" is a modulo — see `DataManager.getEncounterWaves`.
 */
export interface EncounterRoomTemplate {
  /** Must equal this entry's index in the table (`0`, `1`, `2`, …). */
  readonly depth: number;
  /** Ordered, non-empty list of waves. Index `0` is the room's opening wave. */
  readonly waves: readonly EncounterWaveTemplate[];
}

/* ========================================================================== *
 * Validation primitives                                                      *
 * ========================================================================== */

/** Human-readable rendering of a rejected value, for the error message. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string "${value}"`;
  if (typeof value === 'number') return `the number ${String(value)}`;
  return `a ${typeof value}`;
}

/** @throws SchemaError — declared `never` so callers get control-flow narrowing. */
function fail(label: string, expected: string, received: unknown): never {
  throw new SchemaError(`${label} must be ${expected}, received ${describe(received)}.`);
}

/** @throws SchemaError if `value` is not a plain (non-array) object. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label, 'an object', value);
  }
  // Safe by the guard above: a non-null, non-array `object`. TypeScript cannot
  // express "object with unknown string keys" as a narrowing, so this is the one
  // explicit cast in the layer — and it is immediately re-checked field by field.
  return value as Record<string, unknown>;
}

/** @throws SchemaError unless the field is exactly `"gold"` or `"heal"`. */
function requireLootKind(value: unknown, label: string): 'gold' | 'heal' {
  if (value === 'gold' || value === 'heal') return value;
  fail(`${label}.kind`, 'either "gold" or "heal"', value);
}

/** @throws SchemaError if the field is not a positive finite number. */
function requirePositiveFinite(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${label}.${key}`, 'a positive finite number', value);
  }
  return value;
}

/** @throws SchemaError if the field is not a non-negative finite number. */
function requireNonNegativeFinite(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label}.${key}`, 'a non-negative finite number', value);
  }
  return value;
}

/** @throws SchemaError if the field is not a positive integer. */
function requirePositiveInteger(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${label}.${key}`, 'a positive integer', value);
  }
  return value;
}

/** @throws SchemaError if the field is not a non-negative integer. */
function requireNonNegativeInteger(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`${label}.${key}`, 'a non-negative integer', value);
  }
  return value;
}

/** The same four checks, but "omitted" is legal and yields `undefined`. */
function optionalPositiveFinite(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  return source[key] === undefined ? undefined : requirePositiveFinite(source, key, label);
}

function optionalNonNegativeFinite(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  return source[key] === undefined ? undefined : requireNonNegativeFinite(source, key, label);
}

function optionalPositiveInteger(
  source: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  return source[key] === undefined ? undefined : requirePositiveInteger(source, key, label);
}

/**
 * @throws SchemaError unless the field is a NON-EMPTY array of non-empty strings.
 *
 * Both halves matter, and neither is cosmetic:
 *  - the empty array would make a wave spawn nothing, which the scheduler reads
 *    as "this wave has not spawned yet" and wedges the room forever (the same
 *    reason `EncounterWaveConfig.enemies` must be non-empty, spec 08 §3.4);
 *  - an empty string is an enemy id that cannot resolve, and it would fail
 *    later as an "unknown enemy id ''" that names no real typo.
 */
function requireNonEmptyStringArray(
  source: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label}.${key}`, 'a non-empty array of enemy type ids', value);
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(`${label}.${key}[${String(index)}]`, 'a non-empty enemy type id', entry);
    }
  }
  return value as readonly string[];
}

/* ========================================================================== *
 * Sub-config parsers                                                         *
 * ========================================================================== */

/** @throws SchemaError for a non-positive multiplier / tick count, or an i-frame window longer than the dash. */
export function parseDashConfig(data: unknown, label: string): DashConfig {
  const source = asRecord(data, label);
  const speedMultiplier = requirePositiveFinite(source, 'speedMultiplier', label);
  const durationTicks = requirePositiveInteger(source, 'durationTicks', label);
  const invulnerableTicks = requirePositiveInteger(source, 'invulnerableTicks', label);
  const cooldownTicks = requirePositiveInteger(source, 'cooldownTicks', label);
  if (invulnerableTicks > durationTicks) {
    throw new SchemaError(
      `${label}.invulnerableTicks (${String(invulnerableTicks)}) must not exceed ${label}.durationTicks (${String(durationTicks)}).`,
    );
  }
  return { speedMultiplier, durationTicks, invulnerableTicks, cooldownTicks };
}

/** @throws SchemaError for non-positive radii / tick counts, or an attack reach longer than sight. */
export function parseAIConfig(data: unknown, label: string): AIConfig {
  const source = asRecord(data, label);
  const sightRadius = requirePositiveFinite(source, 'sightRadius', label);
  const attackRadius = requirePositiveFinite(source, 'attackRadius', label);
  const windupTicks = requirePositiveInteger(source, 'windupTicks', label);
  const cooldownTicks = requirePositiveInteger(source, 'cooldownTicks', label);
  if (attackRadius > sightRadius) {
    throw new SchemaError(
      `${label}.attackRadius (${String(attackRadius)}) must not exceed ${label}.sightRadius (${String(sightRadius)}).`,
    );
  }
  return { sightRadius, attackRadius, windupTicks, cooldownTicks };
}

/** @throws SchemaError for a non-positive radius, a negative damage, or a fractional delay. */
export function parseHazardConfig(data: unknown, label: string): HazardConfig {
  const source = asRecord(data, label);
  return {
    radius: requirePositiveFinite(source, 'radius', label),
    damage: requireNonNegativeFinite(source, 'damage', label),
    delayTicks: requireNonNegativeInteger(source, 'delayTicks', label),
  };
}

/**
 * @throws SchemaError for an EMPTY table, or for any drop that is not an object,
 *   declares an unknown `kind`, or carries a non-positive `amount` / `radius` /
 *   `lifespanTicks`.
 *
 * The empty-table rejection is inherited from the pre-M10 `resolveLootDrops`
 * rule and kept deliberately: a `LootComponent` that can never produce a pickup
 * makes "this enemy drops loot" a lie. Omit the field to drop nothing.
 */
export function parseLootTable(data: unknown, label: string): readonly LootDropConfig[] {
  if (!Array.isArray(data)) fail(label, 'an array of drops', data);
  if (data.length === 0) {
    throw new SchemaError(`${label} must contain at least one drop (omit the field to drop nothing).`);
  }
  return data.map((drop, index) => parseLootDrop(drop, `${label}[${String(index)}]`));
}

/** @throws SchemaError under the conditions listed on {@link parseLootTable}. */
export function parseLootDrop(data: unknown, label: string): LootDropConfig {
  const source = asRecord(data, label);
  const kind = requireLootKind(source.kind, label);
  const amount = optionalPositiveFinite(source, 'amount', label);
  const radius = optionalPositiveFinite(source, 'radius', label);
  const lifespanTicks = optionalPositiveInteger(source, 'lifespanTicks', label);
  return {
    kind,
    ...(amount === undefined ? {} : { amount }),
    ...(radius === undefined ? {} : { radius }),
    ...(lifespanTicks === undefined ? {} : { lifespanTicks }),
  };
}

/** @throws SchemaError if any of the three elite fields is missing or non-positive. */
export function parseEliteVariant(data: unknown, label: string): EliteVariantConfig {
  const source = asRecord(data, label);
  return {
    maxHp: requirePositiveFinite(source, 'maxHp', label),
    hurtboxRadius: requirePositiveFinite(source, 'hurtboxRadius', label),
    armor: requirePositiveFinite(source, 'armor', label),
  };
}

/* ========================================================================== *
 * Top-level parsers                                                          *
 * ========================================================================== */

/**
 * Parse (and validate) one enemy type.
 *
 * @param id Table key, echoed into the error label and stamped onto the result.
 * @throws SchemaError for a non-object entry, a missing / mistyped required
 *   field, an out-of-domain number, an `hp` above `maxHp`, or any invalid
 *   sub-config.
 */
export function parseEnemyConfig(id: string, data: unknown): EnemyConfig {
  const label = `enemies.${id}`;
  const source = asRecord(data, label);

  const maxHp = requirePositiveFinite(source, 'maxHp', label);
  const maxSpeed = requirePositiveFinite(source, 'maxSpeed', label);
  const hurtboxRadius = requirePositiveFinite(source, 'hurtboxRadius', label);

  const hp = optionalNonNegativeFinite(source, 'hp', label);
  if (hp !== undefined && hp > maxHp) {
    throw new SchemaError(
      `${label}.hp (${String(hp)}) must not exceed ${label}.maxHp (${String(maxHp)}).`,
    );
  }
  const armor = optionalPositiveFinite(source, 'armor', label);
  const dash = source.dash === undefined ? undefined : parseDashConfig(source.dash, `${label}.dash`);
  const ai = source.ai === undefined ? undefined : parseAIConfig(source.ai, `${label}.ai`);
  const hazard =
    source.hazard === undefined ? undefined : parseHazardConfig(source.hazard, `${label}.hazard`);
  const loot = source.loot === undefined ? undefined : parseLootTable(source.loot, `${label}.loot`);
  const elite =
    source.elite === undefined ? undefined : parseEliteVariant(source.elite, `${label}.elite`);

  return {
    id,
    maxHp,
    maxSpeed,
    hurtboxRadius,
    ...(hp === undefined ? {} : { hp }),
    ...(armor === undefined ? {} : { armor }),
    ...(dash === undefined ? {} : { dash }),
    ...(ai === undefined ? {} : { ai }),
    ...(hazard === undefined ? {} : { hazard }),
    ...(loot === undefined ? {} : { loot }),
    ...(elite === undefined ? {} : { elite }),
  };
}

/**
 * Parse (and validate) one boon's hitbox parameters.
 *
 * @throws SchemaError for a non-object entry, a missing / mistyped field, or a
 *   `lifespanTicks` below `2` (see {@link ModifierConfig.lifespanTicks}).
 */
export function parseModifierConfig(id: string, data: unknown): ModifierConfig {
  const label = `modifiers.${id}`;
  const source = asRecord(data, label);

  const radius = requirePositiveFinite(source, 'radius', label);
  const damage = requireNonNegativeFinite(source, 'damage', label);
  const lifespanTicks = requirePositiveInteger(source, 'lifespanTicks', label);
  const hitstopTicks = requireNonNegativeInteger(source, 'hitstopTicks', label);
  const knockbackForce = requireNonNegativeFinite(source, 'knockbackForce', label);

  if (lifespanTicks < 2) {
    throw new SchemaError(
      `${label}.lifespanTicks (${String(lifespanTicks)}) must be at least 2: a boon's hitbox is injected after CollisionSystem and aged at the end of the same tick, so a lifetime of 1 is a silent no-op (spec 05 §4.4).`,
    );
  }

  return { radius, damage, lifespanTicks, hitstopTicks, knockbackForce };
}

/**
 * Parse (and validate) one wave of a room template (M10-T02).
 *
 * @throws SchemaError for a non-object entry, a missing / mistyped `delayTicks`,
 *   or an `enemies` list that is empty, non-array, or holds a non-string / empty
 *   entry.
 */
export function parseEncounterWaveTemplate(data: unknown, label: string): EncounterWaveTemplate {
  const source = asRecord(data, label);
  return {
    delayTicks: requireNonNegativeInteger(source, 'delayTicks', label),
    enemies: requireNonEmptyStringArray(source, 'enemies', label),
  };
}

/**
 * Parse (and validate) one room template (M10-T02).
 *
 * @param index The entry's position in the table. Enforced to EQUAL the declared
 *   `depth` — see {@link EncounterRoomTemplate} for why the redundancy is
 *   deliberate rather than a drift hazard.
 * @throws SchemaError for a non-object entry, a `depth` that is not a
 *   non-negative integer, a `depth` that disagrees with `index`, or a `waves`
 *   list that is empty or holds an invalid wave.
 */
export function parseEncounterRoomTemplate(
  data: unknown,
  index: number,
  label: string,
): EncounterRoomTemplate {
  const source = asRecord(data, label);
  const depth = requireNonNegativeInteger(source, 'depth', label);
  if (depth !== index) {
    throw new SchemaError(
      `${label}.depth (${String(depth)}) must equal its position in the table (${String(index)}): the encounter table is an ordered sequence of rooms, so entry ${String(index)} is depth ${String(index)}.`,
    );
  }

  const waves = source.waves;
  if (!Array.isArray(waves) || waves.length === 0) {
    fail(`${label}.waves`, 'a non-empty array of waves', waves);
  }
  const parsedWaves = waves.map((wave, waveIndex) =>
    parseEncounterWaveTemplate(wave, `${label}.waves[${String(waveIndex)}]`),
  );

  return { depth, waves: parsedWaves };
}

/**
 * Parse (and validate) the whole encounter table — the room sequence a run is
 * built from (M10-T02, AC-01 / AC-02).
 *
 * The table must be a NON-EMPTY array whose entry `k` declares `depth: k`; see
 * {@link EncounterRoomTemplate}. An empty table is rejected rather than treated
 * as "a run with no rooms": a run needs at least one room to clear, and the
 * failure belongs at load time, not at the moment the player's first room fails
 * to appear.
 *
 * Cross-table validation — "does every referenced enemy id exist?" — deliberately
 * does NOT live here. This parser sees one table; only `DataManager.loadAll` sees
 * all three, and that is where the check belongs (the same reason `resolveLootDrops`
 * runs at assembly rather than inside a leaf parser).
 *
 * @throws SchemaError under the conditions listed on
 *   {@link parseEncounterRoomTemplate}, or when the table is not a non-empty
 *   array.
 */
export function parseEncounterTable(data: unknown, label: string): readonly EncounterRoomTemplate[] {
  if (!Array.isArray(data) || data.length === 0) {
    fail(label, 'a non-empty array of room templates', data);
  }
  return data.map((room, index) =>
    parseEncounterRoomTemplate(room, index, `${label}[${String(index)}]`),
  );
}

/**
 * Whether `data` would parse as an encounter table — the non-throwing twin of
 * {@link parseEncounterTable}, implemented in terms of it so the two cannot drift.
 */
export function isEncounterTable(data: unknown): boolean {
  try {
    parseEncounterTable(data, '__probe__');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `data` would parse as an `EnemyConfig` — the non-throwing twin of
 * {@link parseEnemyConfig}, implemented in terms of it so the two cannot drift.
 */
export function isEnemyConfig(data: unknown): boolean {
  try {
    parseEnemyConfig('__probe__', data);
    return true;
  } catch {
    return false;
  }
}

/** The non-throwing twin of {@link parseModifierConfig}. */
export function isModifierConfig(data: unknown): boolean {
  try {
    parseModifierConfig('__probe__', data);
    return true;
  } catch {
    return false;
  }
}
