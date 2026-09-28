/**
 * Status-effect bag (poison / burn / vulnerable / ...).
 * See specs/06_status_effect_and_dot_spec.md §3.1 / §3.2.
 *
 * POD component: data only, no behaviour. Every mutation helper below is a FREE
 * FUNCTION (not a component method), so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact — the same shape
 * `TagComponent` and `ModifierComponent` already follow.
 *
 * ONE component holds MANY statuses (`effects`), because an entity is routinely
 * poisoned AND burning AND vulnerable at the same time; a component per status
 * would force the ECS layer to learn every status name.
 *
 * Invariant: `effects` is kept sorted ascending by `id` (UTF-16 code-unit order,
 * NOT locale-sensitive) and holds at most one entry per id, so a snapshot is
 * byte-for-byte deterministic regardless of the order in which statuses were
 * applied — the same invariant `TagComponent.tags` and `ModifierComponent.modifiers`
 * have. Multiplicity is expressed by `stacks`, never by duplicate entries.
 *
 * All timing is in integer Ticks (never wall-clock), so the whole lifecycle is
 * fps-independent and replay-exact (spec 06 C1).
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

/** Canonical status id for the Dionysus Blight damage-over-time (spec 06 §3.3). */
export const POISON_STATUS_ID = 'poison';

/** Canonical status id for a burn-over-time (storage is generic; no boon ships it yet). */
export const BURN_STATUS_ID = 'burn';

/** Canonical status id for an incoming-damage amplifier (storage is generic; no boon ships it yet). */
export const VULNERABLE_STATUS_ID = 'vulnerable';

/**
 * Maximum poison stacks. Re-applying at the cap keeps REFRESHING the duration but
 * stops adding stacks, so a fast attacker cannot run away with unbounded damage
 * (spec 06 AC-02).
 */
export const DEFAULT_POISON_MAX_STACKS = 5;

/**
 * Poison duration in ticks (120 ticks @60fps = 2 s). Re-applying resets it to this
 * value, i.e. the clock restarts from the most recent application.
 */
export const DEFAULT_POISON_DURATION_TICKS = 120;

/**
 * Ticks between two poison damage ticks (30 ticks @60fps = 0.5 s).
 *
 * Chosen so `DEFAULT_POISON_DURATION_TICKS` is an exact multiple of it: a single
 * application then yields exactly `duration / interval` damage ticks, with the
 * last one landing on the very tick the status expires (spec 06 §4.2).
 */
export const DEFAULT_POISON_INTERVAL_TICKS = 30;

/** Damage dealt per stack per poison tick (spec 06 AC-03). */
export const DEFAULT_POISON_DAMAGE_PER_STACK = 4;

/**
 * The full definition of one status effect.
 *
 * `maxStacks` / `durationTicks` / `intervalTicks` / `damagePerStack` are copied
 * onto the instance when it is applied, so a status that is already running keeps
 * behaving consistently even if the spec constant is later retuned mid-run — and
 * so the whole lifecycle is observable from the snapshot alone.
 */
export interface StatusEffectSpec {
  /** Status id; unique within one entity. */
  readonly id: string;
  /** Stack ceiling; `stacks` never exceeds it. Must be a positive integer. */
  readonly maxStacks: number;
  /** Lifetime of one application, in ticks. Must be a positive integer. */
  readonly durationTicks: number;
  /** Ticks between two damage ticks. Must be a positive integer. */
  readonly intervalTicks: number;
  /** Damage per stack per tick; `0` for a non-damaging status (e.g. vulnerable). */
  readonly damagePerStack: number;
}

/** A live status on an entity — the spec, plus the per-entity runtime counters. */
export interface StatusEffect {
  /** Status id; never changes once applied (it is the key). */
  readonly id: string;
  /** Current stack count, `1 .. maxStacks`. */
  stacks: number;
  /** Stack ceiling copied from the spec at apply time. */
  maxStacks: number;
  /** Ticks of life left; the status is dropped when it reaches `0`. */
  remainingTicks: number;
  /** Ticks between two damage ticks (copied from the spec). */
  intervalTicks: number;
  /** Ticks until the next damage tick; reloaded to `intervalTicks` after each one. */
  ticksUntilProc: number;
  /** Damage per stack per tick (copied from the spec). */
  damagePerStack: number;
}

/**
 * The Dionysus Blight poison definition.
 *
 * A DoT is deliberately modelled as `damagePerStack × stacks` per tick rather than
 * as a damage ramp, so "two stacks deal exactly twice the damage" is a structural
 * property, not an emergent one (spec 06 AC-02).
 */
export const POISON_STATUS_SPEC: StatusEffectSpec = {
  id: POISON_STATUS_ID,
  maxStacks: DEFAULT_POISON_MAX_STACKS,
  durationTicks: DEFAULT_POISON_DURATION_TICKS,
  intervalTicks: DEFAULT_POISON_INTERVAL_TICKS,
  damagePerStack: DEFAULT_POISON_DAMAGE_PER_STACK,
};

export class StatusEffectComponent extends ComponentBase {
  /** Live statuses, kept ascending by id and unique by id for determinism. */
  public effects: StatusEffect[];

  constructor(effects: StatusEffect[] = []) {
    super();
    this.effects = effects;
  }
}

/** Deterministic (locale-free) ordering by status id. */
function compareStatusId(a: StatusEffect, b: StatusEffect): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** @throws RangeError when a spec field cannot describe a runnable status. */
function assertValidSpec(spec: StatusEffectSpec): void {
  if (!Number.isInteger(spec.maxStacks) || spec.maxStacks <= 0) {
    throw new RangeError(
      `status.maxStacks must be a positive integer, received: ${String(spec.maxStacks)}`,
    );
  }
  if (!Number.isInteger(spec.durationTicks) || spec.durationTicks <= 0) {
    throw new RangeError(
      `status.durationTicks must be a positive integer, received: ${String(spec.durationTicks)}`,
    );
  }
  if (!Number.isInteger(spec.intervalTicks) || spec.intervalTicks <= 0) {
    throw new RangeError(
      `status.intervalTicks must be a positive integer, received: ${String(spec.intervalTicks)}`,
    );
  }
  if (!Number.isFinite(spec.damagePerStack) || spec.damagePerStack < 0) {
    throw new RangeError(
      `status.damagePerStack must be a non-negative finite number, received: ${String(spec.damagePerStack)}`,
    );
  }
}

/**
 * Apply (or re-apply) a status, mounting a `StatusEffectComponent` lazily if the
 * entity has none yet.
 *
 * Two branches, and the difference is the whole stacking contract (spec 06 AC-02):
 *
 *  - FIRST application: one stack, full duration, a full `intervalTicks` until the
 *    first damage tick.
 *  - RE-APPLICATION: `stacks` grows by one but is CLAMPED at `maxStacks`, and the
 *    duration AND the damage countdown are both reset. Resetting the countdown is
 *    what makes a refresh strictly a gain — an attacker who keeps landing hits
 *    keeps pushing the next damage tick away, and the total lifetime is measured
 *    from the most recent hit.
 *
 * No-op when the entity is not alive (`addComponent` would throw otherwise), so a
 * status can never be attached to a destroyed entity.
 *
 * @throws RangeError if `spec` cannot describe a runnable status.
 */
export function applyStatusEffect(world: World, id: EntityId, spec: StatusEffectSpec): void {
  assertValidSpec(spec);
  if (!world.isAlive(id)) return;

  let component = world.getComponent(id, StatusEffectComponent);
  if (component === undefined) {
    component = new StatusEffectComponent();
    world.addComponent(id, component);
  }

  const existing = component.effects.find((effect) => effect.id === spec.id);
  if (existing === undefined) {
    component.effects.push({
      id: spec.id,
      stacks: 1,
      maxStacks: spec.maxStacks,
      remainingTicks: spec.durationTicks,
      intervalTicks: spec.intervalTicks,
      ticksUntilProc: spec.intervalTicks,
      damagePerStack: spec.damagePerStack,
    });
    component.effects.sort(compareStatusId);
    return;
  }

  // Clamped, so "hit six times against a cap of five" leaves exactly five stacks.
  existing.stacks = Math.min(existing.stacks + 1, spec.maxStacks);
  existing.maxStacks = spec.maxStacks;
  existing.remainingTicks = spec.durationTicks;
  existing.intervalTicks = spec.intervalTicks;
  existing.ticksUntilProc = spec.intervalTicks;
  existing.damagePerStack = spec.damagePerStack;
}

/** The live status with `statusId`, or `undefined` when it is not running. */
export function getStatusEffect(
  world: World,
  id: EntityId,
  statusId: string,
): StatusEffect | undefined {
  return world
    .getComponent(id, StatusEffectComponent)
    ?.effects.find((effect) => effect.id === statusId);
}

/** Whether `statusId` is currently running on the entity. Missing component counts as `false`. */
export function hasStatusEffect(world: World, id: EntityId, statusId: string): boolean {
  return getStatusEffect(world, id, statusId) !== undefined;
}

/**
 * Drop `statusId` from the entity. No-op when the entity has no
 * `StatusEffectComponent` or does not carry the status.
 *
 * The component itself is deliberately KEPT (possibly empty) once mounted, so the
 * snapshot shape stays stable across ticks — the same rule `FreezeComponent` and
 * `TagComponent` follow (spec 06 §10 trade-off 3).
 */
export function removeStatusEffect(world: World, id: EntityId, statusId: string): void {
  const component = world.getComponent(id, StatusEffectComponent);
  if (component === undefined) return;
  const at = component.effects.findIndex((effect) => effect.id === statusId);
  if (at !== -1) component.effects.splice(at, 1);
}
