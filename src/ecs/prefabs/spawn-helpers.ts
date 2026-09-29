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
import {
  AIControllerComponent,
  DEFAULT_AI_ATTACK_RADIUS,
  DEFAULT_AI_COOLDOWN_TICKS,
  DEFAULT_AI_SIGHT_RADIUS,
  DEFAULT_AI_WINDUP_TICKS,
} from '../components/AIControllerComponent';
import { Faction, FactionComponent } from '../components/FactionComponent';
import { DEFAULT_MAX_HP, HealthComponent } from '../components/HealthComponent';
import { ArmorComponent } from '../components/ArmorComponent';
import { HazardCasterComponent } from '../components/HazardCasterComponent';
import {
  DEFAULT_HAZARD_DAMAGE,
  DEFAULT_HAZARD_DELAY_TICKS,
  DEFAULT_HAZARD_RADIUS,
} from '../components/HazardComponent';
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
 * @throws RangeError if `value` is not a non-negative integer.
 *
 * The `0`-inclusive sibling of {@link assertPositiveInteger}, for counts where
 * "none / immediately" is a legal value — encounter wave delays (spec 08 §3.4).
 * Lives here so the whole validation vocabulary has one home.
 */
export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, received: ${String(value)}`);
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
  /**
   * Armor pool (M6-T02). When present, an `ArmorComponent` is mounted with
   * `current = max = armor`, turning the entity into an "elite": it soaks damage
   * BEFORE its HP and cannot be staggered while the armor stands (spec 12 AC-01 /
   * AC-02). Must be a positive finite number — `0` is a config bug, not a legal
   * "no armor" (omit the field instead).
   *
   * Omit it and NO armor component is mounted at all, so every pre-M6 combatant is
   * assembled exactly as before. Like `ai`, this is a CAPABILITY SWITCH rather than
   * an elite-only channel: the component set stays defined in this one place, so
   * the player and enemy prefabs still cannot drift apart (spec 12 §3.2).
   */
  readonly armor?: number;
  /**
   * AI tuning (M4-T01). When present, an `AIControllerComponent` is mounted and the
   * entity becomes AI-driven. When absent, NO AI component is mounted at all — the
   * enemy stays script-driven, exactly as it was before M4. This opt-in shape is
   * deliberate: `AISystem` overwrites the intent of every entity it owns, so
   * mounting it by default would silently break every hand-written-intent test
   * (spec 07 C10 / §10 trade-off 5).
   */
  readonly ai?: AITuningOptions;
  /**
   * Hazard-casting tuning (M8-T01). When present, a `HazardCasterComponent` is
   * mounted and the entity becomes a "bomb planter": on the tick its AI windup
   * ends it raises `wantsToHazard` alongside `wantsToAttack`, and `HazardSystem`
   * plants a delayed AoE at its target's feet (spec 14 AC-01).
   *
   * Omit it and NO hazard component is mounted at all, so every pre-M8 enemy is
   * assembled exactly as before. Like `ai` and `armor`, this is a CAPABILITY
   * SWITCH rather than an elite-only channel: the component set stays defined in
   * this one place, so the player and enemy prefabs still cannot drift apart.
   */
  readonly hazard?: HazardCastingOptions;
}

/**
 * The spec an encounter wave hands to `EnemyFactory.spawn` (spec 08 §3.2).
 *
 * Declared HERE (rather than next to `EnemyFactory`) because it is the shared
 * assembly vocabulary: `EncounterStateComponent` must be able to describe a wave's
 * roster without the components layer depending on the prefabs layer. `EnemyFactory`
 * re-exports it, so `import { EnemySpawnOptions } from './EnemyFactory'` keeps
 * working — it is the same declaration, not a copy.
 *
 * Structurally identical to {@link CombatantSpawnOptions} today. Kept as its own
 * name because a wave's roster is an ENEMY roster: the day enemies gain a field the
 * player must not have, the narrowing belongs here and no call site changes.
 */
export type EnemySpawnOptions = CombatantSpawnOptions;

/** Optional AI tuning overrides; every field defaults to its `AIControllerComponent` default. */
export interface AITuningOptions {
  /** Explicit target; omit (or pass `null`) to let the AI auto-acquire one at run time. */
  readonly targetEntityId?: EntityId | null;
  readonly sightRadius?: number;
  readonly attackRadius?: number;
  readonly windupTicks?: number;
  readonly cooldownTicks?: number;
}

/** Fully-resolved AI tuning, ready to be written onto an `AIControllerComponent`. */
export interface ResolvedAITuning {
  readonly targetEntityId: EntityId | null;
  readonly sightRadius: number;
  readonly attackRadius: number;
  readonly windupTicks: number;
  readonly cooldownTicks: number;
}

/**
 * Resolve (and validate) AI tuning overrides.
 *
 * @throws RangeError for non-positive radii / tick counts, or when `attackRadius`
 *   exceeds `sightRadius` — "can attack something it cannot see" is always a config
 *   bug, and it would make the FSM's attack branch shadow its own sight branch.
 */
export function resolveAITuning(options: AITuningOptions = {}): ResolvedAITuning {
  const targetEntityId = options.targetEntityId ?? null;
  const sightRadius = options.sightRadius ?? DEFAULT_AI_SIGHT_RADIUS;
  const attackRadius = options.attackRadius ?? DEFAULT_AI_ATTACK_RADIUS;
  const windupTicks = options.windupTicks ?? DEFAULT_AI_WINDUP_TICKS;
  const cooldownTicks = options.cooldownTicks ?? DEFAULT_AI_COOLDOWN_TICKS;

  assertPositiveFinite(sightRadius, 'ai.sightRadius');
  assertPositiveFinite(attackRadius, 'ai.attackRadius');
  assertPositiveInteger(windupTicks, 'ai.windupTicks');
  assertPositiveInteger(cooldownTicks, 'ai.cooldownTicks');
  if (attackRadius > sightRadius) {
    throw new RangeError(
      `ai.attackRadius (${String(attackRadius)}) must not exceed ai.sightRadius (${String(sightRadius)})`,
    );
  }

  return { targetEntityId, sightRadius, attackRadius, windupTicks, cooldownTicks };
}

/**
 * Optional hazard-casting overrides (M8-T01); every field defaults to its
 * `HazardComponent` default.
 *
 * There is deliberately NO `targetEntityId` here: the landing spot is resolved at
 * plant time from the caster's live AI target, so a stale id can never be baked
 * into the assembly (spec 14 §4.2).
 */
export interface HazardCastingOptions {
  readonly radius?: number;
  readonly damage?: number;
  readonly delayTicks?: number;
}

/** Fully-resolved hazard tuning, ready to be written onto a `HazardCasterComponent`. */
export interface ResolvedHazardCasting {
  readonly radius: number;
  readonly damage: number;
  readonly delayTicks: number;
}

/**
 * Resolve (and validate) hazard-casting overrides.
 *
 * @throws RangeError for a non-positive radius, a negative damage, or a
 *   non-non-negative-integer delay. `damage: 0` is legal (a pure-displacement
 *   trap); `delayTicks: 0` is legal (detonates on the next tick's update).
 */
export function resolveHazardCasting(options: HazardCastingOptions = {}): ResolvedHazardCasting {
  const radius = options.radius ?? DEFAULT_HAZARD_RADIUS;
  const damage = options.damage ?? DEFAULT_HAZARD_DAMAGE;
  const delayTicks = options.delayTicks ?? DEFAULT_HAZARD_DELAY_TICKS;

  assertPositiveFinite(radius, 'hazard.radius');
  if (!Number.isFinite(damage) || damage < 0) {
    throw new RangeError(`hazard.damage must be a non-negative finite number, received: ${String(damage)}`);
  }
  assertNonNegativeInteger(delayTicks, 'hazard.delayTicks');

  return { radius, damage, delayTicks };
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
 * The component set above is the MANDATORY one. `PlayerInputComponent` (hardware),
 * `AIControllerComponent` (M4-T01), `ArmorComponent` (M6-T02) and
 * `HazardCasterComponent` (M8-T01) are the four OPT-IN extras. Input and AI are
 * mutually exclusive (the player gets the device, an AI-driven enemy gets the
 * FSM, a plain script-driven enemy gets neither); armor and hazard casting are
 * orthogonal to both — any combatant may carry either.
 *
 * @throws RangeError if `maxSpeed` / `maxHp` / `hurtboxRadius` / `armor` is not a
 *   positive finite number, if `hp` falls outside `[0, maxHp]`, if any dash override
 *   is invalid (see {@link resolveDashTuning}), if any AI override is invalid (see
 *   {@link resolveAITuning}), if any hazard override is invalid (see
 *   {@link resolveHazardCasting}), or if AI tuning is combined with `hardwareInput`.
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

  // Armor is an OPT-IN capability (M6-T02): validated here, mounted below. `0` is
  // rejected rather than treated as "no armor" so a mis-specified elite fails at
  // the seam instead of silently shipping as a plain enemy.
  const armor = options.armor;
  if (armor !== undefined) assertPositiveFinite(armor, 'armor');

  const dash = resolveDashTuning(options.dash);

  // AI is an OPT-IN capability, and it is mutually exclusive with hardware input:
  // a player derives its intent from the device, an AI-driven entity has its intent
  // rewritten by AISystem every tick, so mounting both would make one of the two
  // silently dead (spec 07 §3.5 / §8).
  const ai = options.ai === undefined ? undefined : resolveAITuning(options.ai);
  if (ai !== undefined && hardwareInput) {
    throw new RangeError(
      'ai tuning cannot be combined with hardware input: an entity is either device-driven or AI-driven',
    );
  }

  // Hazard casting is an OPT-IN capability too (M8-T01), and it is orthogonal to
  // both of the above: it only decides what a windup DOES, so a hazard caster may
  // equally be script-driven. Mounted last so the component set reads in the order
  // the capabilities were added.
  const hazard = options.hazard === undefined ? undefined : resolveHazardCasting(options.hazard);

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
  if (armor !== undefined) {
    world.addComponent(entity.id, new ArmorComponent(armor, armor));
  }
  if (ai !== undefined) {
    world.addComponent(
      entity.id,
      new AIControllerComponent(
        ai.targetEntityId,
        ai.sightRadius,
        ai.attackRadius,
        ai.windupTicks,
        ai.cooldownTicks,
      ),
    );
  }
  if (hazard !== undefined) {
    world.addComponent(
      entity.id,
      new HazardCasterComponent(hazard.radius, hazard.damage, hazard.delayTicks),
    );
  }
  return entity.id;
}
