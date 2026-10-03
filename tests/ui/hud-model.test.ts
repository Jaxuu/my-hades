/**
 * HUD model suite (M19 · specs/027-hud-boon-ui T016 · FR-002/003/004 · SC-001).
 *
 * The material HUD is a READ-ONLY projection of the logic layer. Every assertion
 * here drives a REAL `GameSimulator` and reads the model's output; nothing is
 * mocked, and the "behavioural" checks make the projection follow a real event
 * (damage / dash / gold) rather than reading back a constant it was built from.
 */

import { describe, expect, it } from 'vitest';

import { buildHudView, readHudState } from '../../client/ui/hud-model';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { applyDamage } from '../../src/ecs/components/HealthComponent';
import { HealthComponent, DEFAULT_MAX_HP } from '../../src/ecs/components/HealthComponent';
import { DashStatsComponent, DEFAULT_DASH_COOLDOWN_TICKS } from '../../src/ecs/components/DashStatsComponent';
import { addGold } from '../../src/ecs/components/InventoryComponent';
import { DASH_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import type { EntityId } from '../../src/ecs/Entity';

function spawnPlayer(): { readonly sim: GameSimulator; readonly player: EntityId } {
  const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  return { sim, player };
}

describe('health (FR-002)', () => {
  it('mirrors the component and follows a real damage event', () => {
    const { sim, player } = spawnPlayer();

    const before = buildHudView(readHudState(sim.world));
    expect(before.maxHp).toBe(DEFAULT_MAX_HP);
    expect(before.hp).toBe(DEFAULT_MAX_HP);
    expect(before.hpRatio).toBeCloseTo(1, 9);

    applyDamage(sim.world, player, 30);

    const after = buildHudView(readHudState(sim.world));
    expect(after.hp).toBe(DEFAULT_MAX_HP - 30);
    expect(after.hp).toBeLessThan(before.hp); // behavioural, not tautological
    expect(after.hpRatio).toBeCloseTo(0.7, 9);
  });

  it('reads hp = 0 as critical with a ratio of 0 (never a reversed bar)', () => {
    const { sim, player } = spawnPlayer();
    applyDamage(sim.world, player, DEFAULT_MAX_HP * 10);
    const view = buildHudView(readHudState(sim.world));
    expect(view.hp).toBe(0);
    expect(view.hpRatio).toBe(0);
    expect(view.hpState).toBe('critical');
    expect(view.hpRatio).toBeGreaterThanOrEqual(0);
  });

  it('does not divide by zero when maxHp is 0', () => {
    const { sim, player } = spawnPlayer();
    const health = sim.world.getComponent(player, HealthComponent);
    if (health === undefined) throw new Error('QA: player has no HealthComponent');
    health.maxHp = 0;

    const view = buildHudView(readHudState(sim.world));
    expect(view.hpRatio).toBe(0);
    expect(Number.isFinite(view.hpRatio)).toBe(true);
    expect(view.hpRatio).toBeGreaterThanOrEqual(0);
    expect(view.hpRatio).toBeLessThanOrEqual(1);
  });
});

describe('dash charge (FR-003)', () => {
  it('flips ready -> cooling on a real dash input', () => {
    const { sim } = spawnPlayer();

    expect(buildHudView(readHudState(sim.world)).dashState).toBe('ready');

    sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    sim.step(1);

    const view = buildHudView(readHudState(sim.world));
    expect(view.dashState).toBe('cooling');
    expect(view.dashReady).toBe(false);
    expect(view.dashProgress).toBeGreaterThanOrEqual(0);
    expect(view.dashProgress).toBeLessThan(1);
  });

  it('pins the two literal boundaries (rem = 0 => 1, rem = cool => 0)', () => {
    const base = { hp: 100, maxHp: 100, gold: 0 } as const;
    expect(
      buildHudView({ ...base, cooldownRemaining: 0, cooldownTicks: DEFAULT_DASH_COOLDOWN_TICKS })
        .dashProgress,
    ).toBe(1);
    expect(
      buildHudView({
        ...base,
        cooldownRemaining: DEFAULT_DASH_COOLDOWN_TICKS,
        cooldownTicks: DEFAULT_DASH_COOLDOWN_TICKS,
      }).dashProgress,
    ).toBe(0);
    // A zero-length cooldown must not produce NaN.
    expect(
      buildHudView({ ...base, cooldownRemaining: 0, cooldownTicks: 0 }).dashProgress,
    ).toBe(1);
  });

  it('reports a fractional progress mid-cooldown', () => {
    const { sim, player } = spawnPlayer();
    const dash = sim.world.getComponent(player, DashStatsComponent);
    if (dash === undefined) throw new Error('QA: player has no DashStatsComponent');
    dash.cooldownTicks = 30;
    dash.cooldownRemaining = 15;
    expect(buildHudView(readHudState(sim.world)).dashProgress).toBeCloseTo(0.5, 9);
  });
});

describe('gold (FR-004)', () => {
  it('reads the run wallet and never truncates a large value', () => {
    const { sim, player } = spawnPlayer();

    // Anti-vacuous: establish that the wallet can be non-zero before asserting 0.
    expect(buildHudView(readHudState(sim.world)).gold).toBe(0);

    expect(addGold(sim.world, player, 9999)).toBe(true);
    const rich = buildHudView(readHudState(sim.world));
    expect(rich.gold).toBe(9999);
    expect(rich.goldText).toBe('9999');
    expect(rich.goldText).not.toContain('e');
    expect(rich.goldText).not.toContain('NaN');

    expect(addGold(sim.world, player, -9999)).toBe(true);
    expect(buildHudView(readHudState(sim.world)).gold).toBe(0);
  });
});

describe('a world with no player', () => {
  it('yields zeroes rather than throwing (hub / terminal / pre-spawn)', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const view = buildHudView(readHudState(sim.world));
    expect(view.hp).toBe(0);
    expect(view.maxHp).toBe(0);
    expect(view.hpRatio).toBe(0);
    expect(view.gold).toBe(0);
    expect(Number.isFinite(view.hpRatio)).toBe(true);
  });
});
