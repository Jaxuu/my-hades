/**
 * M12-T02 · INDEPENDENT adversarial probes for the soft-collision separation
 * phase (spec 20 AC-02 / I5–I10 / §4.2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The shipped `tests/physics/soft_collision.test.ts` covers the happy path (a PAIR
 * separates, determinism, no random, corpse/one-body guards). It does NOT probe the
 * three places where a single-pass pairwise de-overlap is most likely to misbehave:
 *
 *  - THREE OR MORE fully coincident bodies (spec 20 T6 admits one pass is not
 *    enough — this file measures whether, and how fast, it converges);
 *  - a FROZEN / STUNNED body (does separation have a gate? spec 20 I5 lists none);
 *  - a body the separation pushed INTO a wall (the `separateBodies -> resolveWalls`
 *    order contract, spec 20 I9 / F3).
 *
 * Every fixture drives the REAL `GameSimulator` + REAL `createDefaultSystems()` +
 * the REAL prefabs. Nothing is mocked. `raider` is a shipped AI enemy whose AI is
 * inert without a player target, so the ONLY thing that moves a raider in most rigs
 * below is the phase under test.
 *
 * `sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_KEY,
  ActionState,
  EnemyFactory,
  Faction,
  FactionComponent,
  GameSimulator,
  HurtboxComponent,
  PlayerFactory,
  Random,
  StateComponent,
  TransformComponent,
  WallComponent,
  World,
  applyFreeze,
  createDefaultSystems,
  createWall,
  isDead,
  resolveCircleAABB,
} from '../../src';
import type { EntityId, SpawnPoint } from '../../src';

const FPS = 60;
const SEED = 0x5eed;

/** The shipped `raider` hurtbox radius, as a LITERAL (spec 20 §6: no tautologies). */
const RAIDER_RADIUS = 0.5;
/** The tangent distance for two raiders: `rA + rB`. */
const TANGENT = 2 * RAIDER_RADIUS;
/** Float tolerance for position comparisons (spec 20 §6 / MEMORY §3). */
const EPS = 1e-9;

/* ========================================================================== *
 * Helpers                                                                     *
 * ========================================================================== */

function poseOf(sim: GameSimulator, id: EntityId): SpawnPoint {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return { x: transform.x, y: transform.y };
}

function distance(sim: GameSimulator, a: EntityId, b: EntityId): number {
  const pa = poseOf(sim, a);
  const pb = poseOf(sim, b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

/** All pairwise distances of a list of ids (upper triangle), as plain numbers. */
function pairwiseDistances(sim: GameSimulator, ids: readonly EntityId[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      if (a === undefined || b === undefined) continue;
      out.push(distance(sim, a, b));
    }
  }
  return out;
}

/** A fresh sim with `count` raiders all stacked on the exact same point. */
function stackedRaiders(count: number, seed: number = SEED): {
  readonly sim: GameSimulator;
  readonly ids: readonly EntityId[];
} {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed });
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 }));
  }
  return { sim, ids };
}

/* ========================================================================== *
 * B1 · three or more fully coincident bodies                                  *
 * ========================================================================== */
describe('B1 · a fully-coincident CROWD separates (spec 20 T6)', () => {
  it('three raiders on one point: no two stay coincident after one tick', () => {
    const { sim, ids } = stackedRaiders(3);
    sim.step(1); // tick 0

    const distances = pairwiseDistances(sim, ids);
    expect(distances).toHaveLength(3); // C(3,2)
    for (const d of distances) {
      // The ONE thing a single pass MUST guarantee: nobody is left exactly on top
      // of anybody else. (Pairwise tangency is explicitly NOT promised — T6.)
      expect(d).toBeGreaterThan(0);
    }
  });

  it('three raiders converge to a fully-separated configuration and then hold', () => {
    const { sim, ids } = stackedRaiders(3);
    sim.step(120); // 120 ticks is far more than a 3-body projection needs

    const distances = pairwiseDistances(sim, ids);
    for (const d of distances) {
      expect(d).toBeGreaterThanOrEqual(TANGENT - EPS);
    }

    // "Converged" means STABLE, not merely close: 60 more ticks must not move them.
    const settled = ids.map((id) => poseOf(sim, id));
    for (let i = 0; i < 60; i += 1) sim.step(1);
    ids.forEach((id, index) => {
      const after = poseOf(sim, id);
      const before = settled[index];
      if (before === undefined) throw new Error('QA: missing settled pose');
      expect(Math.abs(after.x - before.x)).toBeLessThan(EPS);
      expect(Math.abs(after.y - before.y)).toBeLessThan(EPS);
    });
  });
});

/* ========================================================================== *
 * B2 · a large crowd: stability and per-tick determinism                      *
 * ========================================================================== */
describe('B2 · eight coincident raiders are stable and deterministic', () => {
  it('reproduces every tick of a 30-tick run for the same seed', () => {
    const run = (): readonly SpawnPoint[][] => {
      const { sim, ids } = stackedRaiders(8);
      const frames: SpawnPoint[][] = [];
      for (let t = 0; t < 30; t += 1) {
        sim.step(1);
        frames.push(ids.map((id) => poseOf(sim, id)));
      }
      return frames;
    };

    const first = run();
    const second = run();
    expect(second).toEqual(first);
    expect(first).toHaveLength(30);
  });

  it('does not blow up: eight raiders stay within a sane radius of the origin', () => {
    const { sim, ids } = stackedRaiders(8);
    sim.step(200);

    for (const id of ids) {
      const pose = poseOf(sim, id);
      expect(Number.isFinite(pose.x)).toBe(true);
      expect(Number.isFinite(pose.y)).toBe(true);
      // A crowd of eight 0.5-radius bodies has a radius well under 8 units; the
      // point is only that nothing diverges to Infinity / NaN.
      expect(Math.hypot(pose.x, pose.y)).toBeLessThan(8);
    }
  });

  it('settles: after a long run the crowd no longer moves', () => {
    const { sim, ids } = stackedRaiders(8);
    sim.step(300);
    const settled = ids.map((id) => poseOf(sim, id));

    for (let i = 0; i < 60; i += 1) sim.step(1);
    ids.forEach((id, index) => {
      const before = settled[index];
      const after = poseOf(sim, id);
      if (before === undefined) throw new Error('QA: missing settled pose');
      expect(Math.abs(after.x - before.x)).toBeLessThan(EPS);
      expect(Math.abs(after.y - before.y)).toBeLessThan(EPS);
    });
  });
});

/* ========================================================================== *
 * B3 · frozen / stunned bodies                                                *
 * ========================================================================== */
describe('B3 · separation has NO freeze / hitstun gate (spec 20 I5)', () => {
  it('a FROZEN body is still pushed apart by a same-faction partner', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const frozen = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const partner = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });

    // A REAL freeze (the same helper the juice layer reads), not a hand-rolled flag.
    applyFreeze(sim.world, frozen, 30);
    sim.step(1); // tick 0

    // The frozen body moved: separation reads only Transform+Velocity+Hurtbox+Faction
    // and `!isDead`, so a frozen (or stunned) body is NOT skipped. A naive "freeze
    // gates everything" implementation would leave both at (0,0) and fail here.
    const frozenPose = poseOf(sim, frozen);
    const partnerPose = poseOf(sim, partner);
    expect(frozenPose).not.toEqual({ x: 0, y: 0 });
    expect(partnerPose).not.toEqual({ x: 0, y: 0 });
    expect(distance(sim, frozen, partner)).toBeCloseTo(TANGENT, 9);
  });

  it('a HITSTUN body (written by a REAL melee collision) is still separated', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
    const victim = EnemyFactory.spawn(sim.world, 'raider', { x: 0.75, y: 0 });
    const partner = EnemyFactory.spawn(sim.world, 'raider', { x: 0.75, y: 0 });

    // Rising edge on the attack key -> CombatActionSystem spawns a hitbox overlapping
    // both raiders; CollisionSystem writes HITSTUN (and hitstop) onto them. Collision
    // runs AFTER StateSystem, so the HITSTUN is observable on the tick it lands.
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0

    // Prove a REAL collision (not a hand-written field) stunned the victim.
    const victimState = sim.world.getComponent(victim, StateComponent);
    expect(victimState?.state).toBe(ActionState.HITSTUN);
    expect(isDead(sim.world, victim)).toBe(false);

    // Both raiders are the same faction, so they were pushed apart even though the
    // collision also stunned / froze them.
    expect(distance(sim, victim, partner)).toBeGreaterThan(0);

    // The player (a DIFFERENT faction) is never separated from them.
    expect(player).not.toBe(victim);
  });

  it('a HITSTUN body with NO knockback is still moved by separation (isolated)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const stunned = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const partner = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });

    // HITSTUN written DIRECTLY, with no knockback and no freeze — so the ONLY phase
    // that can displace `stunned` this tick is `separateBodies`. If separation had a
    // HITSTUN gate, both bodies would stay at (0,0) and this fails.
    const state = sim.world.getComponent(stunned, StateComponent);
    if (state === undefined) throw new Error('QA: raider lost its StateComponent');
    state.state = ActionState.HITSTUN;

    sim.step(1); // tick 0

    expect(poseOf(sim, stunned)).not.toEqual({ x: 0, y: 0 });
    expect(distance(sim, stunned, partner)).toBeCloseTo(TANGENT, 9);
  });

  it('a frozen body is not displaced by a DIFFERENT-faction neighbour', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const enemy = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    applyFreeze(sim.world, enemy, 30);

    sim.step(1); // tick 0

    // Cross-faction ⇒ no separation ⇒ the frozen enemy stays exactly put.
    expect(poseOf(sim, enemy)).toEqual({ x: 0, y: 0 });
    expect(poseOf(sim, player)).toEqual({ x: 0, y: 0 });
  });
});

/* ========================================================================== *
 * B4 · the separateBodies -> resolveWalls order contract (never in a wall)     *
 * ========================================================================== */
describe('B4 · separation can never leave a body inside a wall (spec 20 I9 / F3)', () => {
  /**
   * The deepest residual push any wall would apply to `id` — i.e. how far the body
   * is still overlapping geometry.
   *
   * A TOLERANCE rather than `!== 0`: a body resolved to EXACTLY tangent (`dist ===
   * radius`) is not overlapping (the strict `<` predicate), but floating-point
   * rounding can leave it a few ULPs inside, so `resolveCircleAABB` returns a
   * machine-epsilon push (~2e-16). That is noise, not penetration — measured and
   * reported in the review notes — so the contract asserted here is "no residual
   * deeper than `1e-9`".
   */
  function penetrationDepth(world: World, id: EntityId): number {
    const transform = world.getComponent(id, TransformComponent);
    const hurtbox = world.getComponent(id, HurtboxComponent);
    if (transform === undefined || hurtbox === undefined) throw new Error('QA: bad body');
    let worst = 0;
    for (const wallId of world.query(WallComponent)) {
      const wall = world.getComponent(wallId, WallComponent);
      if (wall === undefined) continue;
      const [px, py] = resolveCircleAABB(
        transform.x,
        transform.y,
        hurtbox.radius,
        wall.x,
        wall.y,
        wall.width,
        wall.height,
      );
      worst = Math.max(worst, Math.hypot(px, py));
    }
    return worst;
  }

  it('two coincident bodies tangent to a wall face end up OUTSIDE the wall', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    // A big block whose RIGHT face is x = 4.
    createWall(sim.world, { x: 0, y: 0, width: 4, height: 4 });
    // Two coincident raiders just to the right of the face (centre x = 4.5, i.e.
    // exactly tangent). Any separation direction that pushes one of them left will
    // drive it INTO the wall; resolveWalls must push it back out.
    const a = EnemyFactory.spawn(sim.world, 'raider', { x: 4.5, y: 2 });
    const b = EnemyFactory.spawn(sim.world, 'raider', { x: 4.5, y: 2 });

    sim.step(1); // tick 0

    expect(penetrationDepth(sim.world, a)).toBeLessThanOrEqual(1e-9);
    expect(penetrationDepth(sim.world, b)).toBeLessThanOrEqual(1e-9);
    // And they did separate (the phase ran at all).
    expect(distance(sim, a, b)).toBeGreaterThan(0);
  });

  it('two coincident bodies in a two-wall CORNER are pushed out of both walls', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    // An L: a horizontal bar along y = 0..1 and a vertical bar along x = 0..1. Their
    // inner corner is (1,1); a body at (1.5,1.5) is exactly tangent to BOTH faces.
    createWall(sim.world, { x: 0, y: 0, width: 4, height: 1 });
    createWall(sim.world, { x: 0, y: 0, width: 1, height: 4 });
    const a = EnemyFactory.spawn(sim.world, 'raider', { x: 1.5, y: 1.5 });
    const b = EnemyFactory.spawn(sim.world, 'raider', { x: 1.5, y: 1.5 });

    sim.step(1); // tick 0

    // Whatever direction separation chose, resolveWalls runs last and must leave
    // BOTH bodies outside BOTH walls.
    expect(penetrationDepth(sim.world, a)).toBeLessThanOrEqual(1e-9);
    expect(penetrationDepth(sim.world, b)).toBeLessThanOrEqual(1e-9);
    expect(distance(sim, a, b)).toBeGreaterThan(0);
  });

  it('sweeps many starting positions around a wall — never a body left inside it', () => {
    const RING: SpawnPoint[] = [];
    // A ring of 24 positions at radius 0.55..0.75 around the wall block (0,0,4,4):
    // close enough that separation routinely shoves one body toward a face.
    for (let k = 0; k < 24; k += 1) {
      const theta = (k / 24) * Math.PI * 2;
      const r = 0.55 + (k % 3) * 0.1;
      RING.push({ x: 2 + Math.cos(theta) * (2 + r), y: 2 + Math.sin(theta) * (2 + r) });
    }
    // Also include the four face-centres and the four corners, slightly outside.
    RING.push({ x: 4.6, y: 2 }, { x: -0.6, y: 2 }, { x: 2, y: 4.6 }, { x: 2, y: -0.6 });
    RING.push({ x: 4.6, y: 4.6 }, { x: -0.6, y: -0.6 });

    for (const start of RING) {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
      createWall(sim.world, { x: 0, y: 0, width: 4, height: 4 });
      const a = EnemyFactory.spawn(sim.world, 'raider', { x: start.x, y: start.y });
      const b = EnemyFactory.spawn(sim.world, 'raider', { x: start.x, y: start.y });
      sim.step(1);

      const depth = Math.max(penetrationDepth(sim.world, a), penetrationDepth(sim.world, b));
      expect(
        depth,
        `start=(${String(start.x)},${String(start.y)}) left a body ${String(depth)} inside the wall`,
      ).toBeLessThanOrEqual(1e-9);
    }
  });
});

/* ========================================================================== *
 * B5 · no randomness consumed                                                 *
 * ========================================================================== */
describe('B5 · separation consumes NO randomness (spec 20 I6 / F5)', () => {
  it('the generator holds its first value after a long separation run', () => {
    const { sim } = stackedRaiders(8);
    sim.step(50);

    // "Does not consume randomness" is observed on the GENERATOR, never inferred
    // from a result (MEMORY §3).
    expect(sim.world.rng.nextUint32()).toBe(new Random(SEED).nextUint32());
  });
});

/* ========================================================================== *
 * B6 · the same-faction predicate                                             *
 * ========================================================================== */
describe('B6 · the predicate is on Faction VALUE, not on "enemy-ness"', () => {
  it('two PLAYERS on one point separate (same faction: Player)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const p1 = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const p2 = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    expect(sim.world.getComponent(p1, FactionComponent)?.faction).toBe(Faction.Player);
    expect(sim.world.getComponent(p2, FactionComponent)?.faction).toBe(Faction.Player);

    sim.step(1); // tick 0

    expect(poseOf(sim, p1)).not.toEqual({ x: 0, y: 0 });
    expect(poseOf(sim, p2)).not.toEqual({ x: 0, y: 0 });
    expect(distance(sim, p1, p2)).toBeCloseTo(TANGENT, 9);
  });

  it('two DIFFERENT enemy types (raider + bomber) still separate — same faction', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const raider = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const bomber = EnemyFactory.spawn(sim.world, 'bomber', { x: 0, y: 0 });

    expect(sim.world.getComponent(raider, FactionComponent)?.faction).toBe(Faction.Enemy);
    expect(sim.world.getComponent(bomber, FactionComponent)?.faction).toBe(Faction.Enemy);

    sim.step(1); // tick 0

    // Different TYPES, same FACTION ⇒ they separate. A predicate keyed on the type
    // (or on "is this the same enemy") would leave them stacked.
    expect(distance(sim, raider, bomber)).toBeCloseTo(TANGENT, 9);
  });

  it('a player and an enemy do NOT separate, and neither is nudged', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 1, y: 2 });
    const enemy = EnemyFactory.spawn(sim.world, 'raider', { x: 1, y: 2 });

    sim.step(5);

    expect(poseOf(sim, player)).toEqual({ x: 1, y: 2 });
    expect(poseOf(sim, enemy)).toEqual({ x: 1, y: 2 });
  });
});
