/**
 * Ground pickup: the coin / health flask an enemy leaves behind (M9-T01).
 * See specs/15_economy_and_victory_spec.md §3.3 / §4.2 (AC-01 / AC-02).
 *
 * POD component: data only, no behaviour. The whole lifecycle lives elsewhere —
 * the drop is spawned by `DeathSystem` (on the tick its owner dies), the overlap
 * test and the effect live in `PickupSystem`, and the expiry lives in
 * `LifespanSystem`. That split mirrors `HitboxComponent` + `CollisionSystem` +
 * `LifespanSystem` exactly, so a reader who knows one knows the other.
 *
 * WHAT A PICKUP IS, structurally. It is an entity owning EXACTLY two components:
 *
 *   TransformComponent -> where it lies on the ground
 *   PickupComponent    -> how big, what it grants, how long it lasts
 *
 * and NOTABLY NOT:
 *
 *   - **no `HitboxComponent`** — that is the entire reason `CollisionSystem` can
 *     never make a coin absorb a projectile, deal damage, write hitstop or push a
 *     body. `CollisionSystem`'s producer query is `(Transform, HitboxComponent)`,
 *     so a pickup is not a damage source *by construction* rather than by a flag
 *     some future consumer must remember to check. It is also why "picking up a
 *     coin never triggers HITSTUN or hitstop" is true: those are written ONLY in
 *     `CollisionSystem`, which a pickup cannot enter.
 *   - **no `HurtboxComponent` / `HealthComponent` / `FactionComponent`** — the
 *     target query requires all three, so a pickup cannot be hit, cannot be
 *     auto-acquired by `AISystem`, and cannot be "killed" by a stray swing.
 *   - **no `VelocityComponent`** — `MovementSystem.resolveWalls` visits
 *     `(Transform, Velocity)` bodies, so a pickup can never be de-penetrated,
 *     i.e. it can never push a walking player off their line. "Pickups do not
 *     block movement" is therefore a structural fact, not a tuning choice.
 *   - **no `IntentComponent` / `StateComponent`** — nothing steers a pickup and it
 *     has no action state to be interrupted.
 *
 * `lifespanTicks` is the "independent survival time" of AC-01: it lives on each
 * pickup, so two drops from the same enemy can expire at different moments, and
 * the countdown is visible in the snapshot (spec 00 §6.1 — no cross-tick hidden
 * state). `LifespanSystem` ages it by one per tick and destroys the pickup at
 * `<= 0`, the exact rule `HitboxComponent.activeTicks` already follows.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';
import { TransformComponent } from './TransformComponent';

/** What a pickup grants when the player walks over it. */
export enum PickupKind {
  /** Adds `amount` to the collector's `InventoryComponent.gold`. */
  GOLD = 'GOLD',
  /** Restores `amount` hit points, clamped at `maxHp`. */
  HEAL = 'HEAL',
  /**
   * Adds `amount` to the collector's `InventoryComponent.darkness` (M13-T01) —
   * the run's tally of the OUT-OF-RUN currency.
   *
   * Deliberately a separate KIND rather than a second gold field, because the two
   * currencies have different lifetimes and that difference is the point: gold is
   * spent (or lost) inside the run, darkness is BANKED into the save when the run
   * ends (`GameSimulator.enterHub`) and is therefore the only thing a run leaves
   * behind. Collapsing them would make "what did this run earn" unanswerable.
   *
   * Its effect lands on the wallet exactly like gold — no hitstop, no HITSTUN, no
   * knockback, no event (spec 15 I1 is unchanged by this kind).
   */
  DARKNESS = 'DARKNESS',
}

/**
 * Pickup radius, in world units.
 *
 * Deliberately larger than a player's hurtbox (`DEFAULT_HURTBOX_RADIUS = 0.5`):
 * the overlap test sums the two radii, so a coin is collected from just over a
 * body's width away. A pickup that demanded pixel-accurate centring would turn
 * "walk over the coin" into a chore, which is the opposite of what loot is for.
 */
export const DEFAULT_PICKUP_RADIUS = 0.6;

/**
 * Default survival time of a pickup, in ticks — 600 ticks @60fps = 10 s.
 *
 * Long enough that a pickup never expires while the player is still fighting the
 * wave that dropped it, short enough that an abandoned arena does not fill up
 * with stale loot. A `LootDropOptions.lifespanTicks` override is the tuning knob.
 */
export const DEFAULT_PICKUP_LIFESPAN_TICKS = 600;

/** Default gold granted by a `GOLD` pickup. */
export const DEFAULT_GOLD_AMOUNT = 5;

/** Default hit points restored by a `HEAL` pickup. */
export const DEFAULT_HEAL_AMOUNT = 20;

/**
 * Default darkness granted by a `DARKNESS` pickup (M13-T01).
 *
 * Larger than the gold default on purpose: darkness is the SLOW currency — it is
 * banked only when a run ends, and a meta upgrade costs tens of it (see
 * `assets/data/meta_upgrades.json`), so a per-gem grant of `5` would make the hub
 * unreachable in a normal session.
 */
export const DEFAULT_DARKNESS_AMOUNT = 10;

/**
 * The default grant of a kind, used when a spawn declares no `amount`.
 *
 * Lives HERE rather than next to the loot table because `LootComponent` already
 * imports this file — the reverse would be a cycle — and because "what a kind is
 * worth by default" is a fact about the kind.
 */
export function defaultPickupAmount(kind: PickupKind): number {
  if (kind === PickupKind.HEAL) return DEFAULT_HEAL_AMOUNT;
  if (kind === PickupKind.DARKNESS) return DEFAULT_DARKNESS_AMOUNT;
  return DEFAULT_GOLD_AMOUNT;
}

/**
 * Gap (world units) inserted between the drops of ONE enemy, along +x.
 *
 * A CONSTANT rather than a random offset: the drop pattern must be reproducible,
 * and two drops landing exactly on top of each other would read as a single coin
 * (and would make "the first drop was taken" impossible to assert). This is the
 * same deterministic-spacing rule `DEPTH_SPAWN_SPACING_UNITS` records for depth
 * escalation (spec 11 AC-04).
 */
export const LOOT_DROP_SPACING_UNITS = 1.2;

export class PickupComponent extends ComponentBase {
  /** Pickup radius in world units. Must be > 0. */
  public radius: number;

  /** What walking over this grants. */
  public kind: PickupKind;

  /** Magnitude of the grant. Must be a positive finite number. */
  public amount: number;

  /**
   * Remaining survival time in ticks. `LifespanSystem` decrements it once per
   * tick and destroys the entity at `<= 0` (the `HitboxComponent.activeTicks`
   * rule, verbatim).
   */
  public lifespanTicks: number;

  constructor(
    radius = DEFAULT_PICKUP_RADIUS,
    kind: PickupKind = PickupKind.GOLD,
    amount = DEFAULT_GOLD_AMOUNT,
    lifespanTicks = DEFAULT_PICKUP_LIFESPAN_TICKS,
  ) {
    super();
    this.radius = radius;
    this.kind = kind;
    this.amount = amount;
    this.lifespanTicks = lifespanTicks;
  }
}

/** The spec of a pickup to place on the ground. */
export interface PickupSpawnOptions {
  /** Ground position X. Must be finite. */
  readonly x: number;
  /** Ground position Y. Must be finite. */
  readonly y: number;
  /** What it grants; defaults to `PickupKind.GOLD`. */
  readonly kind?: PickupKind;
  /** Magnitude of the grant; defaults to the kind's default amount. */
  readonly amount?: number;
  /** Pickup radius; defaults to {@link DEFAULT_PICKUP_RADIUS}. */
  readonly radius?: number;
  /** Survival time in ticks; defaults to {@link DEFAULT_PICKUP_LIFESPAN_TICKS}. */
  readonly lifespanTicks?: number;
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

/**
 * Assemble a pickup entity owning exactly `TransformComponent` +
 * `PickupComponent` — and nothing else (see the class docstring for why every
 * omitted component is load-bearing).
 *
 * Validation lives at this seam (never inside the component), so a malformed
 * pickup can never reach the world: a non-positive radius would make the overlap
 * test degenerate, and a non-finite origin would poison every distance derived
 * from it. Nothing is created before validation passes, so a rejected pickup
 * leaks no entity — the same discipline `spawnHazard` / `spawnProjectile` follow.
 *
 * @throws RangeError if `x` / `y` is not finite, or `radius` / `amount` /
 *   `lifespanTicks` fails its validation.
 */
export function spawnPickup(world: World, options: PickupSpawnOptions): EntityId {
  const kind = options.kind ?? PickupKind.GOLD;
  const amount = options.amount ?? defaultPickupAmount(kind);
  const radius = options.radius ?? DEFAULT_PICKUP_RADIUS;
  const lifespanTicks = options.lifespanTicks ?? DEFAULT_PICKUP_LIFESPAN_TICKS;

  if (!Number.isFinite(options.x)) {
    throw new RangeError(`pickup.x must be a finite number, received: ${String(options.x)}`);
  }
  if (!Number.isFinite(options.y)) {
    throw new RangeError(`pickup.y must be a finite number, received: ${String(options.y)}`);
  }
  assertPositiveFinite(radius, 'pickup.radius');
  assertPositiveFinite(amount, 'pickup.amount');
  assertPositiveInteger(lifespanTicks, 'pickup.lifespanTicks');

  const entity = world.createEntity();
  world.addComponent(entity.id, new TransformComponent(options.x, options.y, 0));
  world.addComponent(entity.id, new PickupComponent(radius, kind, amount, lifespanTicks));
  return entity.id;
}
