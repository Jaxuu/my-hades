/**
 * Description-truth suite (M19 · specs/027-hud-boon-ui T011 · FR-013/014 · SC-004).
 *
 * THE TRAP THIS SUITE EXISTS TO AVOID
 * -----------------------------------
 * "The description quotes N, and N came from the constant the description was built
 * with" is a TAUTOLOGY — it passes no matter how wrong N is. So the numbers are
 * checked TWO independent ways:
 *
 *   CHANNEL A (literal cross-check) — the number parsed out of the rendered string
 *     must equal the value in `assets/data/modifiers.json` (read as raw text) AND the
 *     value the engine's `DataManager` reports. Two sources that could drift apart.
 *
 *   CHANNEL B (behavioural) — the STRONGEST proof: grant the boon on a REAL
 *     GameSimulator, drive a hit, and measure the ACTUAL damage. If the description
 *     said 20 but the engine dealt 5, only this channel notices. Anti-vacuous first:
 *     assert the target really DID lose health, or `before - after === N` would pass
 *     trivially at `0 === 0`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildBoonCard } from '../../client/ui/boon-presentation';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { HealthComponent } from '../../src/ecs/components/HealthComponent';
import { addModifier } from '../../src/ecs/components/ModifierComponent';
import { POISON_STATUS_SPEC } from '../../src/ecs/components/StatusEffectComponent';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { grantReward } from '../../src/ecs/rewards/grantReward';
import {
  DASH_UP_COOLDOWN_REDUCTION,
  HP_UP_AMOUNT,
} from '../../src/ecs/rewards/RewardPool';
import type { EntityId } from '../../src/ecs/Entity';
import { testEnemy } from '../harness/config-fixtures';

const TICK_SECONDS = new GameSimulator({ systems: createDefaultSystems() }).fixedDeltaSeconds;

/** The raw balance table, read as TEXT so it is a genuinely independent source. */
const MODIFIERS_JSON = JSON.parse(
  readFileSync(resolve(process.cwd(), 'assets/data/modifiers.json'), 'utf8'),
) as Record<string, Record<string, number>>;

/** Every number appearing in a string, in order. */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity has no HealthComponent');
  return health.hp;
}

describe('CHANNEL A · the rendered number matches two independent logic sources', () => {
  it('zeus_strike quotes the modifiers.json damage', () => {
    const card = buildBoonCard('zeus_strike', TICK_SECONDS);
    const parsed = numbersIn(card.description);
    expect(parsed).toEqual([MODIFIERS_JSON.zeus_strike?.damage]);
    expect(MODIFIERS_JSON.zeus_strike?.damage).toBe(20); // literal pin
  });

  it('poseidon_dash quotes the modifiers.json damage and knockback', () => {
    const card = buildBoonCard('poseidon_dash', TICK_SECONDS);
    const parsed = numbersIn(card.description);
    expect(parsed).toEqual([
      MODIFIERS_JSON.poseidon_dash?.damage,
      MODIFIERS_JSON.poseidon_dash?.knockbackForce,
    ]);
    expect(MODIFIERS_JSON.poseidon_dash?.damage).toBe(5);
    expect(MODIFIERS_JSON.poseidon_dash?.knockbackForce).toBe(40);
  });

  it('hp_up quotes HP_UP_AMOUNT', () => {
    const card = buildBoonCard('hp_up', TICK_SECONDS);
    expect(numbersIn(card.description)).toEqual([HP_UP_AMOUNT]);
    expect(HP_UP_AMOUNT).toBe(20);
  });

  it('dash_up quotes DASH_UP_COOLDOWN_REDUCTION', () => {
    const card = buildBoonCard('dash_up', TICK_SECONDS);
    expect(numbersIn(card.description)).toEqual([DASH_UP_COOLDOWN_REDUCTION]);
    expect(DASH_UP_COOLDOWN_REDUCTION).toBe(10);
  });

  it('dionysus_strike quotes the poison spec (interval / per-stack / cap)', () => {
    const card = buildBoonCard('dionysus_strike', TICK_SECONDS);
    const [seconds, perStack, cap] = numbersIn(card.description);
    expect(seconds).toBeCloseTo(POISON_STATUS_SPEC.intervalTicks * TICK_SECONDS, 9);
    expect(perStack).toBe(POISON_STATUS_SPEC.damagePerStack);
    expect(cap).toBe(POISON_STATUS_SPEC.maxStacks);
    expect(POISON_STATUS_SPEC.damagePerStack).toBe(4);
    expect(POISON_STATUS_SPEC.maxStacks).toBe(5);
  });
});

describe('CHANNEL B · the engine really deals the number the card quotes', () => {
  it('zeus_strike: a landed hit takes exactly the quoted damage one tick later', () => {
    const quoted = numbersIn(buildBoonCard('zeus_strike', TICK_SECONDS).description)[0] ?? 0;

    const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
    const enemy = EnemyFactory.spawn(
      sim.world,
      ...testEnemy({ x: 1.5, y: 0, facingRadians: 0, maxSpeed: 5 }),
    );
    addModifier(sim.world, player, 'zeus_strike');

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0 — the base hit lands
    const hpAfterBase = hpOf(sim, enemy);
    sim.step(1); // tick 1 — the bolt lands
    const hpAfterBolt = hpOf(sim, enemy);

    // Anti-vacuous: the bolt really did deal damage.
    expect(hpAfterBase).toBeGreaterThan(hpAfterBolt);
    expect(hpAfterBase - hpAfterBolt).toBe(quoted);
  });

  it('hp_up: granting it raises maxHp by exactly the quoted amount', () => {
    const quoted = numbersIn(buildBoonCard('hp_up', TICK_SECONDS).description)[0] ?? 0;

    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
    const health = sim.world.getComponent(player, HealthComponent);
    if (health === undefined) throw new Error('QA: player has no HealthComponent');
    const before = health.maxHp;

    expect(grantReward(sim.world, player, 'hp_up')).toBe(true);

    const after = sim.world.getComponent(player, HealthComponent)?.maxHp ?? 0;
    expect(after).toBeGreaterThan(before); // anti-vacuous
    expect(after - before).toBe(quoted);
  });
});
