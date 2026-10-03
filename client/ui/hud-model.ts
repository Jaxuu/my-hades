/**
 * HUD model — the pure derivation behind the material HUD (M19).
 * See specs/027-hud-boon-ui/data-model.md §5 and design/engineering-architecture.md §5.3.
 *
 * Three always-on components (FR-001…004):
 *   - HEALTH: a value AND a ratio,
 *   - DASH:   available / cooling + a progress,
 *   - GOLD:   this run's tally.
 *
 * It is a READ-ONLY projection of the logic layer (FR-005 / FR-033): every input
 * comes from a component or a free read function, and the module writes nothing.
 *
 * EDGE CASES ARE THE WHOLE POINT (Edge Cases list): `maxHp = 0` must not divide by
 * zero, `hp = 0` must read as critical rather than as a reversed bar, and a
 * `cooldownTicks` of `0` must read as a full ring rather than as `NaN`.
 *
 * DOM-free, pixi-free, random-free: node-unit-testable.
 */

import { DashStatsComponent } from '../../src/ecs/components/DashStatsComponent';
import { HealthComponent } from '../../src/ecs/components/HealthComponent';
import { readGold } from '../../src/ecs/components/InventoryComponent';
import { PlayerInputComponent } from '../../src/ecs/components/PlayerInputComponent';
import type { World } from '../../src/ecs/World';

/** Health band, driving the three-state CSS colour. */
export type HpState = 'healthy' | 'mid' | 'critical';

/** Dash band: a dash is either available or cooling down. */
export type DashState = 'ready' | 'cooling';

/** The ratio at or above which health reads as healthy (art §3.1). */
export const HEALTH_HEALTHY_MIN = 0.66;

/** The ratio at or above which health reads as mid; below it reads as critical. */
export const HEALTH_MID_MIN = 0.33;

/** The read-only inputs the HUD derives from (a plain value bag, not the world). */
export interface HudInputs {
  readonly hp: number;
  readonly maxHp: number;
  readonly cooldownRemaining: number;
  readonly cooldownTicks: number;
  readonly gold: number;
}

/** The fully-derived HUD view a renderer writes to the DOM. */
export interface HudView {
  readonly hp: number;
  readonly maxHp: number;
  /** `hp / maxHp` clamped to `[0, 1]`; `0` when `maxHp <= 0` (no divide-by-zero). */
  readonly hpRatio: number;
  readonly hpText: string;
  readonly hpState: HpState;
  readonly dashReady: boolean;
  readonly dashState: DashState;
  /** `1 - cooldownRemaining / cooldownTicks`, clamped; `1` when a dash is ready. */
  readonly dashProgress: number;
  readonly dashText: string;
  readonly gold: number;
  readonly goldText: string;
  /** A value key: equal keys mean "nothing the HUD draws changed". */
  readonly key: string;
}

/** Clamp to `[0, 1]`, mapping any non-finite input to `0`. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** A finite, non-negative number, else `0`. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Derive the HUD view from raw read-only inputs. Total; never throws. */
export function buildHudView(inputs: HudInputs): HudView {
  const maxHp = nonNegative(inputs.maxHp);
  const hp = nonNegative(inputs.hp);
  const hpRatio = maxHp <= 0 ? 0 : clamp01(hp / maxHp);
  const hpState: HpState =
    hpRatio >= HEALTH_HEALTHY_MIN ? 'healthy' : hpRatio >= HEALTH_MID_MIN ? 'mid' : 'critical';

  const cooldownTicks = nonNegative(inputs.cooldownTicks);
  const cooldownRemaining = nonNegative(inputs.cooldownRemaining);
  const dashReady = cooldownRemaining <= 0;
  const dashProgress = dashReady ? 1 : cooldownTicks <= 0 ? 1 : clamp01(1 - cooldownRemaining / cooldownTicks);

  const gold = nonNegative(inputs.gold);

  return {
    hp,
    maxHp,
    hpRatio,
    hpText: `${String(Math.round(hp))} / ${String(Math.round(maxHp))}`,
    hpState,
    dashReady,
    dashState: dashReady ? 'ready' : 'cooling',
    dashProgress,
    dashText: dashReady ? '可用' : `冷却 ${String(Math.ceil(cooldownRemaining))}`,
    gold,
    goldText: String(gold),
    key: `${String(hp)}|${String(maxHp)}|${String(cooldownRemaining)}|${String(cooldownTicks)}|${String(gold)}`,
  };
}

/**
 * Read the player's health / dash / gold as raw inputs.
 *
 * The player is re-resolved every call (a restart replaces the entity), and a world
 * with no player (hub / terminal / the frame before a spawn) yields zeroes rather
 * than throwing — the HUD must be correct in EVERY frame (FR-005).
 */
export function readHudState(world: World): HudInputs {
  const playerId = world.query(PlayerInputComponent)[0];
  const health = playerId === undefined ? undefined : world.getComponent(playerId, HealthComponent);
  const dash = playerId === undefined ? undefined : world.getComponent(playerId, DashStatsComponent);
  return {
    hp: health?.hp ?? 0,
    maxHp: health?.maxHp ?? 0,
    cooldownRemaining: dash?.cooldownRemaining ?? 0,
    cooldownTicks: dash?.cooldownTicks ?? 0,
    gold: readGold(world),
  };
}
