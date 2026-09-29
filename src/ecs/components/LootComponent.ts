/**
 * Loot table carried by a dying entity (M9-T01).
 * See specs/15_economy_and_victory_spec.md §3.1 / §4.1 (AC-01).
 *
 * POD component: data only, no behaviour. It declares WHAT an entity leaves
 * behind; `DeathSystem` is the only system that reads it, and it reads it exactly
 * once, on the tick the owner dies.
 *
 * WHY THE TABLE LIVES ON THE ENTITY rather than in a global
 * enemy-type -> loot registry: the encounter layer hands `EnemyFactory` a FULL
 * spec per enemy (`EncounterWaveConfig.enemies`, spec 08 §3.2) precisely so that
 * "what this one enemy is" never needs a second lookup table. A drop table keyed
 * by enemy type would be exactly such a table — invisible in the snapshot, and
 * one more thing a test would have to stand up to assert one coin.
 *
 * THE TABLE IS VALIDATED AT ASSEMBLY TIME, not at drop time. `DeathSystem` runs
 * inside `step()`, so a malformed drop surfacing there would abort a simulation
 * mid-tick; `resolveLootDrops` therefore resolves (and rejects) the whole table
 * while the combatant is being built, the same "fail loudly at the seam" rule
 * `resolveDashTuning` / `resolveAITuning` / `resolveHazardCasting` established.
 * For the same reason the component stores the RESOLVED drops: by the time
 * `DeathSystem` reads it, every number is known-good and no validation (and no
 * throw) can happen inside a tick.
 */

import { ComponentBase } from '../Component';
import {
  DEFAULT_GOLD_AMOUNT,
  DEFAULT_HEAL_AMOUNT,
  DEFAULT_PICKUP_LIFESPAN_TICKS,
  DEFAULT_PICKUP_RADIUS,
  PickupKind,
} from './PickupComponent';

/** One declared drop, as handed to a prefab. Every field is optional but `kind`. */
export interface LootDropOptions {
  /** What the drop grants. */
  readonly kind: PickupKind;
  /**
   * Magnitude of the grant; defaults to the kind's default (`5` gold / `20` hp).
   * Must be a positive finite number — `0` is a config bug, not a legal "empty"
   * drop (omit the entry instead).
   */
  readonly amount?: number;
  /** Pickup radius; defaults to `DEFAULT_PICKUP_RADIUS`. */
  readonly radius?: number;
  /** Survival time in ticks; defaults to `DEFAULT_PICKUP_LIFESPAN_TICKS`. */
  readonly lifespanTicks?: number;
}

/** A fully-resolved drop: every field known-good, ready for `spawnPickup`. */
export interface ResolvedLootDrop {
  readonly kind: PickupKind;
  readonly amount: number;
  readonly radius: number;
  readonly lifespanTicks: number;
}

/** @throws RangeError if `value` is not a positive finite number. */
function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number, received: ${String(value)}`);
  }
}

/** @throws RangeError if `value` is not a positive integer. */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer, received: ${String(value)}`);
  }
}

/** The default grant of a kind, used when a drop declares no `amount`. */
export function defaultLootAmount(kind: PickupKind): number {
  return kind === PickupKind.HEAL ? DEFAULT_HEAL_AMOUNT : DEFAULT_GOLD_AMOUNT;
}

/**
 * Resolve (and validate) ONE declared drop.
 *
 * @throws RangeError for a non-positive-finite `amount` / `radius`, or a
 *   non-positive-integer `lifespanTicks`.
 */
export function resolveLootDrop(options: LootDropOptions, index: number): ResolvedLootDrop {
  const label = `loot[${String(index)}]`;
  const amount = options.amount ?? defaultLootAmount(options.kind);
  const radius = options.radius ?? DEFAULT_PICKUP_RADIUS;
  const lifespanTicks = options.lifespanTicks ?? DEFAULT_PICKUP_LIFESPAN_TICKS;

  assertPositiveFinite(amount, `${label}.amount`);
  assertPositiveFinite(radius, `${label}.radius`);
  assertPositiveInteger(lifespanTicks, `${label}.lifespanTicks`);

  return { kind: options.kind, amount, radius, lifespanTicks };
}

/**
 * Resolve (and validate) a whole loot table.
 *
 * @throws RangeError when the table is EMPTY. An empty table is a config bug
 *   rather than "drops nothing": mounting a `LootComponent` that can never
 *   produce a pickup makes "this enemy drops loot" a lie that a reader — and a
 *   snapshot — cannot distinguish from a working drop. Omit `loot` entirely to
 *   mean "drops nothing".
 */
export function resolveLootDrops(options: readonly LootDropOptions[]): ResolvedLootDrop[] {
  if (options.length === 0) {
    throw new RangeError('loot must contain at least one drop (omit the field to drop nothing).');
  }
  return options.map((drop, index) => resolveLootDrop(drop, index));
}

export class LootComponent extends ComponentBase {
  /**
   * The drops this entity leaves behind, in declaration order. Immutable for the
   * entity's lifetime, and already validated (see the file docstring).
   */
  public readonly drops: readonly ResolvedLootDrop[];

  constructor(drops: readonly ResolvedLootDrop[] = []) {
    super();
    this.drops = drops;
  }
}
