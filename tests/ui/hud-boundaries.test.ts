/**
 * HUD boundary suite (M19 · specs/027-hud-boon-ui T018 · FR-006).
 *
 * The edge cases the spec names, plus the TESTABLE form of "the HUD does not flicker
 * when nothing changed": FR-006 is defined as "the frame performs ZERO DOM writes",
 * and the model exposes that as a value `key` — equal keys mean the manager short
 * circuits before touching the DOM.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildHudView } from '../../client/ui/hud-model';

const UI_MANAGER = readFileSync(resolve(process.cwd(), 'client/UIManager.ts'), 'utf8');

const BASE = { hp: 50, maxHp: 100, cooldownRemaining: 0, cooldownTicks: 30, gold: 7 } as const;

describe('boundaries', () => {
  it('never reverses the health bar (ratio stays in [0, 1])', () => {
    expect(buildHudView({ ...BASE, hp: 250, maxHp: 100 }).hpRatio).toBe(1);
    expect(buildHudView({ ...BASE, hp: -10, maxHp: 100 }).hpRatio).toBe(0);
    expect(buildHudView({ ...BASE, hp: 0, maxHp: 0 }).hpRatio).toBe(0);
    // A negative / NaN ceiling must not produce a negative or NaN ratio.
    expect(buildHudView({ ...BASE, hp: 50, maxHp: -100 }).hpRatio).toBe(0);
    expect(Number.isFinite(buildHudView({ ...BASE, maxHp: Number.NaN }).hpRatio)).toBe(true);
  });

  it('reads a full cooldown clearly and a zero cooldown as ready', () => {
    const full = buildHudView({ ...BASE, cooldownRemaining: 30, cooldownTicks: 30 });
    expect(full.dashState).toBe('cooling');
    expect(full.dashProgress).toBe(0);
    expect(full.dashText).toContain('冷却');

    const ready = buildHudView({ ...BASE, cooldownRemaining: 0, cooldownTicks: 30 });
    expect(ready.dashState).toBe('ready');
    expect(ready.dashProgress).toBe(1);
    expect(ready.dashText).toBe('可用');
  });

  it('does not truncate an extreme gold value', () => {
    const view = buildHudView({ ...BASE, gold: 1_000_000 });
    expect(view.gold).toBe(1_000_000);
    expect(view.goldText).toBe('1000000');
    expect(view.goldText).not.toContain('e');
  });
});

describe('FR-006 · an unchanged frame is a no-op', () => {
  it('produces an identical key for identical inputs and a different one on change', () => {
    expect(buildHudView(BASE).key).toBe(buildHudView({ ...BASE }).key);
    expect(buildHudView(BASE).key).not.toBe(buildHudView({ ...BASE, hp: 49 }).key);
    expect(buildHudView(BASE).key).not.toBe(buildHudView({ ...BASE, gold: 8 }).key);
    expect(buildHudView(BASE).key).not.toBe(
      buildHudView({ ...BASE, cooldownRemaining: 1 }).key,
    );
  });

  it('is guarded in the manager: the material HUD returns before any DOM write', () => {
    // The manager compares the model key and returns early — the only honest way to
    // assert "zero DOM writes" without a DOM to count writes on.
    expect(UI_MANAGER).toMatch(/if \(this\.renderedHudMaterial === view\.key\) return;/);
    expect(UI_MANAGER).toMatch(/if \(this\.renderedHud === key\) return;/);
  });
});
