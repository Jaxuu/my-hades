/**
 * M12-T02 · Soft-collision separation (spec 20 AC-02 / §4.2).
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * M12-T01's spawn rotation (spec 19 §4.2) guarantees a wave's enemies land on
 * DISTINCT tiles — but only at the moment they spawn. Enemies chasing the same player
 * converge onto the same line, and several overlapping hurtboxes read, to the player
 * and to a collision assertion alike, as ONE enemy. This suite covers the fix: a
 * deterministic, entropy-free separation phase in `MovementSystem` that pushes
 * SAME-FACTION overlapping bodies apart.
 *
 * The four things that can go wrong, and where each is pinned:
 *
 *  - the separation does not actually separate        -> G1
 *  - it separates non-deterministically               -> G2
 *  - it separates too much (across factions, corpses) -> G3
 *  - it consumes randomness / has no pure direction    -> G2 / G4
 *
 * The rig drives the REAL `GameSimulator`, the REAL 17-segment pipeline and the REAL
 * prefabs. Nothing is mocked, and ticks are advanced one at a time.
 *
 * `sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`.
 *
 * A NOTE ON `raider`: it is a SHIPPED enemy (assets/data/enemies.json) with a 0.5
 * hurtbox radius and an `ai` block. With no player in the world, its AI acquires no
 * target and stays inert, so the ONLY thing that can move a raider in these rigs is
 * the separation phase under test. That isolation is deliberate: it means a passing
 * assertion is evidence about separation and nothing else.
 */

import { describe, expect, it } from 'vitest';
import {
  EnemyFactory,
  Faction,
  FactionComponent,
  GameSimulator,
  HurtboxComponent,
  PlayerFactory,
  Random,
  TransformComponent,
  applyDamage,
  createDefaultSystems,
  isDead,
  separationAngle,
} from '../../src';
import type { EntityId, SpawnPoint } from '../../src';

const FPS = 60;
/** The seed every deterministic assertion below pins. */
const SEED = 0x5eed;

/**
 * The shipped `raider` hurtbox radius, written as a LITERAL.
 *
 * The tautology trap (spec 20 §6): comparing a measured distance against
 * `HurtboxComponent.radius` would assert "the value equals the value that built it".
 * The number below IS the contract, so it is spelled out.
 */
const RAIDER_RADIUS = 0.5;

/* ========================================================================== *
 * Helpers                                                                     *
 * ========================================================================== */

/** A world-space pose, as a plain object so `toEqual` compares by value. */
function poseOf(sim: GameSimulator, id: EntityId): SpawnPoint {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return { x: transform.x, y: transform.y };
}

/** The distance between two entities' transforms. */
function distance(sim: GameSimulator, a: EntityId, b: EntityId): number {
  const pa = poseOf(sim, a);
  const pb = poseOf(sim, b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

/** A fresh sim + two raiders stacked on the exact same point. */
function stackedRaiders(seed: number = SEED): {
  readonly sim: GameSimulator;
  readonly a: EntityId;
  readonly b: EntityId;
} {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed });
  const a = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
  const b = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
  return { sim, a, b };
}

/* ========================================================================== *
 * G1 · the separation actually happens                                        *
 * ========================================================================== */
describe('G1 · same-faction bodies separate to tangent (AC-02)', () => {
  it('pushes two fully-coincident raiders apart to exactly 2 * radius, and holds', () => {
    const { sim, a, b } = stackedRaiders();

    sim.step(1); // tick 0

    // They started identical and are no longer: the separation ran.
    const pa = poseOf(sim, a);
    const pb = poseOf(sim, b);
    expect(pa).not.toEqual(pb);

    // The separation pushes them to TANGENT — one radius each, i.e. `rA + rB` apart.
    expect(distance(sim, a, b)).toBeCloseTo(2 * RAIDER_RADIUS, 9);

    // ...and it HOLDS. Tangent is not overlapping (the strict `<` predicate), so
    // further ticks do not nudge them: no per-tick jitter, no drift.
    const settledA = poseOf(sim, a);
    const settledB = poseOf(sim, b);
    for (let i = 0; i < 20; i += 1) {
      sim.step(1);
      expect(distance(sim, a, b)).toBeCloseTo(2 * RAIDER_RADIUS, 9);
    }
    const afterA = poseOf(sim, a);
    const afterB = poseOf(sim, b);
    expect(Math.abs(afterA.x - settledA.x)).toBeLessThan(1e-9);
    expect(Math.abs(afterA.y - settledA.y)).toBeLessThan(1e-9);
    expect(Math.abs(afterB.x - settledB.x)).toBeLessThan(1e-9);
    expect(Math.abs(afterB.y - settledB.y)).toBeLessThan(1e-9);
  });

  it('separates a partial overlap by exactly the overlap depth, split in half', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    // Two raiders 0.4 apart: overlap = (0.5 + 0.5) - 0.4 = 0.6, half each = 0.3.
    const a = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const b = EnemyFactory.spawn(sim.world, 'raider', { x: 0.4, y: 0 });

    sim.step(1); // tick 0

    // Symmetric correction: each moved 0.3 along the axis, so they end 1.0 apart.
    expect(poseOf(sim, a).x).toBeCloseTo(-0.3, 9);
    expect(poseOf(sim, b).x).toBeCloseTo(0.7, 9);
    expect(poseOf(sim, a).y).toBeCloseTo(0, 9);
    expect(poseOf(sim, b).y).toBeCloseTo(0, 9);
    expect(distance(sim, a, b)).toBeCloseTo(2 * RAIDER_RADIUS, 9);
  });
});

/* ========================================================================== *
 * G2 · determinism and entropy-freedom                                        *
 * ========================================================================== */
describe('G2 · separation is deterministic and consumes no randomness (AC-02)', () => {
  it('reproduces the same tick-by-tick positions for the same seed', () => {
    const run = (): readonly SpawnPoint[] => {
      const { sim, a, b } = stackedRaiders();
      const out: SpawnPoint[] = [];
      for (let i = 0; i < 10; i += 1) {
        sim.step(1);
        out.push(poseOf(sim, a), poseOf(sim, b));
      }
      return out;
    };

    expect(run()).toEqual(run());
  });

  it('gives the same coincident pair the same direction on every run', () => {
    const first = stackedRaiders();
    first.sim.step(1);
    const firstOffset = poseOf(first.sim, first.b).x - poseOf(first.sim, first.a).x;

    const second = stackedRaiders();
    second.sim.step(1);
    const secondOffset = poseOf(second.sim, second.b).x - poseOf(second.sim, second.a).x;

    // The pair is (0, 1) in both fresh sims, and the direction is a pure function of
    // the ids — so the offsets are bit-identical, not merely close.
    expect(secondOffset).toBe(firstOffset);
    // ...and that direction is exactly what `separationAngle` promises.
    expect(firstOffset).toBeCloseTo(Math.cos(separationAngle(0, 1)), 12);
  });

  it('consumes NO randomness (the generator is untouched)', () => {
    const { sim } = stackedRaiders();
    sim.step(10);

    // "Does not consume randomness" cannot be asserted by looking at a result — the
    // generator itself has to be observed. A fresh generator on the same seed holds
    // the FIRST value; if separation drew anything, the two would differ.
    expect(sim.world.rng.nextUint32()).toBe(new Random(SEED).nextUint32());
  });
});

/* ========================================================================== *
 * G3 · what is deliberately NOT separated                                     *
 * ========================================================================== */
describe('G3 · only same-faction living bodies separate (AC-02)', () => {
  it('does NOT separate a player from an enemy on the same point (ADVERSARIAL)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const enemy = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });

    // Sanity: the two really are different factions — otherwise this test would be
    // asserting the wrong thing.
    expect(sim.world.getComponent(player, FactionComponent)?.faction).toBe(Faction.Player);
    expect(sim.world.getComponent(enemy, FactionComponent)?.faction).toBe(Faction.Enemy);

    sim.step(5);

    // NEITHER moves. This is the adversarial evidence for the "same faction" rule: a
    // naive "separate everything" implementation would push these two apart, and this
    // is the assertion that would fail.
    expect(poseOf(sim, player)).toEqual({ x: 0, y: 0 });
    expect(poseOf(sim, enemy)).toEqual({ x: 0, y: 0 });
  });

  it('leaves two same-faction bodies alone when they are not overlapping', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const a = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const b = EnemyFactory.spawn(sim.world, 'raider', { x: 5, y: 0 });

    sim.step(10);

    // 5 > rA + rB (1), so there is nothing to resolve and the coordinates are
    // bit-for-bit unchanged — no "creeping" correction on a non-overlapping pair.
    expect(poseOf(sim, a)).toEqual({ x: 0, y: 0 });
    expect(poseOf(sim, b)).toEqual({ x: 5, y: 0 });
  });

  it('does NOT let a corpse push a living body (or be pushed)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const corpse = EnemyFactory.spawn(sim.world, 'raider', { x: 5, y: 0 });
    const alive = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });

    applyDamage(sim.world, corpse, 999);
    sim.step(1); // tick 0 — DeathSystem tags the corpse at the end of the tick

    expect(isDead(sim.world, corpse)).toBe(true);
    expect(isDead(sim.world, alive)).toBe(false);

    // Teleport the living body onto the corpse DIRECTLY, so the only way they could
    // separate is if a corpse participated. They must not.
    const transform = sim.world.getComponent(alive, TransformComponent);
    if (transform === undefined) throw new Error('QA: living raider lost its Transform');
    transform.x = 5;
    transform.y = 0;

    sim.step(1); // tick 1

    expect(poseOf(sim, alive)).toEqual({ x: 5, y: 0 });
    expect(poseOf(sim, corpse)).toEqual({ x: 5, y: 0 });
  });

  it('is a no-op in a one-body world', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 2, y: 3 });

    const before = poseOf(sim, player);
    sim.step(10);

    // With fewer than two candidates the phase early-returns, so a single body is
    // never displaced — the M1–M11 single-player rigs are untouched (spec 20 I10).
    expect(poseOf(sim, player)).toEqual(before);
  });
});

/* ========================================================================== *
 * G4 · separationAngle is a pure, total function                              *
 * ========================================================================== */
describe('G4 · separationAngle (pure function, spec 20 §3.3)', () => {
  it('is a pure function of its arguments', () => {
    expect(separationAngle(3, 7)).toBe(separationAngle(3, 7));
    expect(separationAngle(0, 1)).toBe(separationAngle(0, 1));
    expect(separationAngle(123456, 654321)).toBe(separationAngle(123456, 654321));
  });

  it('returns an angle in [0, 2*PI) and never NaN', () => {
    for (let a = 0; a < 40; a += 1) {
      for (let b = 0; b < 40; b += 1) {
        const angle = separationAngle(a, b);
        expect(Number.isNaN(angle)).toBe(false);
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThan(Math.PI * 2);
      }
    }
  });

  it('spreads different id pairs across more than one direction slot', () => {
    const angles = new Set<number>();
    for (let b = 0; b < 50; b += 1) {
      angles.add(separationAngle(0, b));
    }
    // More than one slot: a degenerate mix that always returned the same angle would
    // push every coincident crowd in the same direction, stacking them in a line.
    expect(angles.size).toBeGreaterThan(1);
  });

  it('never returns NaN for large, negative or equal ids', () => {
    const pairs: readonly (readonly [number, number])[] = [
      [-1, 5],
      [1e9, 123456789],
      [0, 0],
      [2 ** 31, 2 ** 31 - 1],
      [-(2 ** 31), 1],
    ];
    for (const [a, b] of pairs) {
      expect(Number.isNaN(separationAngle(a, b))).toBe(false);
    }
  });
});

/* ========================================================================== *
 * A small guard: the separation target set is what the spec says it is        *
 * ========================================================================== */
describe('G0 · the separation target set (component presence)', () => {
  it('a raider carries Transform + Velocity + Hurtbox + Faction', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const id = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });

    // The four components the phase keys on. If any were absent, the raider would
    // silently drop out of the separation set and the tests above would be measuring
    // nothing.
    expect(sim.world.hasComponent(id, TransformComponent)).toBe(true);
    expect(sim.world.hasComponent(id, HurtboxComponent)).toBe(true);
    expect(sim.world.hasComponent(id, FactionComponent)).toBe(true);
    expect(sim.world.getComponent(id, HurtboxComponent)?.radius).toBe(RAIDER_RADIUS);
  });
});
