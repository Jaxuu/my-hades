/**
 * Shared combatant assembly + tuning validation.
 *
 * Both PlayerFactory and EnemyFactory assemble the exact same component set — the
 * only thing that differs is the faction. Keeping that assembly here (instead of
 * copy-pasting it) means the two prefabs can never drift apart, and it gives the
 * validation rules a single home.
 *
 * Keeps game-specific composition out of the generic `World` class, so the ECS
 * layer stays reusable and `World` stays free of game concepts.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { PlayerInputComponent } from '../components/PlayerInputComponent';
import { IntentComponent } from '../components/IntentComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';
import { StateComponent } from '../components/StateComponent';
import {
  DEFAULT_DASH_COOLDOWN_TICKS,
  DEFAULT_DASH_DURATION_TICKS,
  DEFAULT_DASH_INVULNERABLE_TICKS,
  DEFAULT_DASH_SPEED_MULTIPLIER,
  DashStatsComponent,
} from '../components/DashStatsComponent';
import { TagComponent } from '../components/TagComponent';
import { ModifierComponent } from '../components/ModifierComponent';
import { StatusEffectComponent } from '../components/StatusEffectComponent';
import { Faction, FactionComponent } from '../components/FactionComponent';
import { DEFAULT_MAX_HP, HealthComponent } from '../components/HealthComponent';
import { DEFAULT_HURTBOX_RADIUS, HurtboxComponent } from '../components/HurtboxComponent';

/** Default locomotion speed in world units per second for any combatant. */
export const DEFAULT_COMBATANT_MAX_SPEED = 5;

/** Optional dash tuning overrides; every field defaults to its DashStatsComponent default. */
export interface DashTuningOptions {
  readonly speedMultiplier?: number;
  readonly durationTicks?: number;
  readonly invulnerableTicks?: number;
  readonly cooldownTicks?: number;
}

/** Fully-resolved dash tuning, ready to be written onto a DashStatsComponent. */
export interface ResolvedDashTuning {
  readonly speedMultiplier: number;
  readonly durationTicks: number;
  readonly invulnerableTicks: number;
  readonly cooldownTicks: number;
}

/** @throws RangeError if `value` is not a positive finite number. */
export function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number, received: ${String(value)}`);
  }
}

/** @throws RangeError if `value` is not a positive integer. */
export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer, received: ${String(value)}`);
  }
}

/**
 * Resolve (and validate) dash tuning overrides.
 * @throws RangeError for non-positive multipliers / tick counts, or when
 *   `invulnerableTicks` exceeds `durationTicks` (an i-frame window longer than the
 *   dash itself is always a config bug).
 */
export function resolveDashTuning(options: DashTuningOptions = {}): ResolvedDashTuning {
  const speedMultiplier = options.speedMultiplier ?? DEFAULT_DASH_SPEED_MULTIPLIER;
  const durationTicks = options.durationTicks ?? DEFAULT_DASH_DURATION_TICKS;
  const invulnerableTicks = options.invulnerableTicks ?? DEFAULT_DASH_INVULNERABLE_TICKS;
  const cooldownTicks = options.cooldownTicks ?? DEFAULT_DASH_COOLDOWN_TICKS;

  assertPositiveFinite(speedMultiplier, 'dash.speedMultiplier');
  assertPositiveInteger(durationTicks, 'dash.durationTicks');
  assertPositiveInteger(invulnerableTicks, 'dash.invulnerableTicks');
  assertPositiveInteger(cooldownTicks, 'dash.cooldownTicks');
  if (invulnerableTicks > durationTicks) {
    throw new RangeError(
      `dash.invulnerableTicks (${String(invulnerableTicks)}) must not exceed dash.durationTicks (${String(durationTicks)})`,
    );
  }

  return { speedMultiplier, durationTicks, invulnerableTicks, cooldownTicks };
}

/** Options common to every combatant prefab (player or enemy). */
export interface CombatantSpawnOptions {
  readonly x?: number;
  readonly y?: number;
  readonly facingRadians?: number;
  readonly maxSpeed?: number;
  readonly dash?: DashTuningOptions;
  /** Starting hit points; defaults to `maxHp`. */
  readonly hp?: number;
  readonly maxHp?: number;
  readonly hurtboxRadius?: number;
}

/**
 * Assemble a combatant entity owning the full component set:
 * Transform + Velocity + Intent + State + DashStats + Tag + Modifier
 * + StatusEffect + Faction + Health + Hurtbox.
 *
 * `ModifierComponent` (M3-T01) and `StatusEffectComponent` (M3-T02) are mounted
 * EMPTY on every combatant, exactly like `TagComponent`: boons and statuses are
 * opt-in data, but the component set itself stays defined in this one place so the
 * player and enemy prefabs can never drift.
 *
 * Every combatant owns an `IntentComponent` — the logical-intent seam that every
 * gameplay system reads (M2-T02). The raw HARDWARE component (`PlayerInputComponent`)
 * is added ONLY when `hardwareInput` is true, i.e. for the player: enemies are
 * intent-driven by AI / scripts and must never carry an input device (this is what
 * root-fixed spec 03 §10 trade-off 4 — one global input frame driving every entity).
 *
 * Keeping the whole assembly here (rather than letting each factory build its own
 * component list) preserves the "assembly lives in exactly one place" invariant, so
 * the player and enemy prefabs can never drift apart.
 *
 * @throws RangeError if `maxSpeed` / `maxHp` / `hurtboxRadius` is not a positive
 *   finite number, if `hp` falls outside `[0, maxHp]`, or if any dash override is
 *   invalid (see {@link resolveDashTuning}).
 */
export function spawnCombatant(
  world: World,
  faction: Faction,
  options: CombatantSpawnOptions = {},
  hardwareInput = false,
): EntityId {
  const maxSpeed = options.maxSpeed ?? DEFAULT_COMBATANT_MAX_SPEED;
  assertPositiveFinite(maxSpeed, 'maxSpeed');

  const maxHp = options.maxHp ?? DEFAULT_MAX_HP;
  assertPositiveFinite(maxHp, 'maxHp');
  const hp = options.hp ?? maxHp;
  if (!Number.isFinite(hp) || hp < 0 || hp > maxHp) {
    throw new RangeError(`hp must be a finite number within [0, maxHp], received: ${String(hp)}`);
  }

  const hurtboxRadius = options.hurtboxRadius ?? DEFAULT_HURTBOX_RADIUS;
  assertPositiveFinite(hurtboxRadius, 'hurtboxRadius');

  const dash = resolveDashTuning(options.dash);

  const entity = world.createEntity();
  world.addComponent(
    entity.id,
    new TransformComponent(options.x ?? 0, options.y ?? 0, options.facingRadians ?? 0),
  );
  world.addComponent(entity.id, new VelocityComponent(maxSpeed));
  world.addComponent(entity.id, new IntentComponent());
  if (hardwareInput) {
    world.addComponent(entity.id, new PlayerInputComponent());
  }
  world.addComponent(entity.id, new StateComponent());
  world.addComponent(
    entity.id,
    new DashStatsComponent(
      dash.speedMultiplier,
      dash.durationTicks,
      dash.invulnerableTicks,
      dash.cooldownTicks,
      0,
    ),
  );
  world.addComponent(entity.id, new TagComponent());
  world.addComponent(entity.id, new ModifierComponent());
  world.addComponent(entity.id, new StatusEffectComponent());
  world.addComponent(entity.id, new FactionComponent(faction));
  world.addComponent(entity.id, new HealthComponent(hp, maxHp));
  world.addComponent(entity.id, new HurtboxComponent(hurtboxRadius));
  return entity.id;
}
