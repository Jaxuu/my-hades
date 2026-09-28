/**
 * M1-T01 · Movement acceptance tests.
 * See specs/01_character_controller_spec.md §7 (AC-01 .. AC-06).
 *
 * All assertions integrate through the real GameSimulator + MovementSystem; the
 * tick length comes from the simulation clock, never from a literal.
 */

import { describe, expect, it } from 'vitest';
import { GameSimulator } from '../../src/core/GameSimulator';
import { vec2 } from '../../src/core/math';
import type { EntityId } from '../../src/ecs/Entity';
import { InputComponent } from '../../src/ecs/components/InputComponent';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { VelocityComponent } from '../../src/ecs/components/VelocityComponent';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { MovementSystem } from '../../src/ecs/systems/MovementSystem';

const FPS = 60;
const MAX_SPEED = 5;
const TICKS_PER_SECOND = 60;
/** Per-tick integration accumulates float rounding; measured drift is ~1e-15. */
const TOLERANCE = 1e-9;

interface Rig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
}

function makeRig(options: { fps?: number; maxSpeed?: number } = {}): Rig {
  const sim = new GameSimulator({
    fps: options.fps ?? FPS,
    systems: [new MovementSystem()],
  });
  const player = PlayerFactory.spawn(sim.world, { maxSpeed: options.maxSpeed ?? MAX_SPEED });
  return { sim, player };
}

function transformOf(rig: Rig): TransformComponent {
  const transform = rig.sim.world.getComponent(rig.player, TransformComponent);
  if (transform === undefined) throw new Error('TransformComponent missing on player entity');
  return transform;
}

function velocityOf(rig: Rig): VelocityComponent {
  const velocity = rig.sim.world.getComponent(rig.player, VelocityComponent);
  if (velocity === undefined) throw new Error('VelocityComponent missing on player entity');
  return velocity;
}

describe('AC-01 · player assembly', () => {
  it('spawns a player owning Transform + Velocity + Input components', () => {
    const rig = makeRig();

    expect(rig.sim.world.hasComponent(rig.player, TransformComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.player, VelocityComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.player, InputComponent)).toBe(true);
    expect(velocityOf(rig).maxSpeed).toBe(MAX_SPEED);
  });

  it('rejects a non-positive or non-finite maxSpeed', () => {
    const sim = new GameSimulator();

    expect(() => PlayerFactory.spawn(sim.world, { maxSpeed: 0 })).toThrow(RangeError);
    expect(() => PlayerFactory.spawn(sim.world, { maxSpeed: -1 })).toThrow(RangeError);
    expect(() => PlayerFactory.spawn(sim.world, { maxSpeed: Number.NaN })).toThrow(RangeError);
    expect(() => PlayerFactory.spawn(sim.world, { maxSpeed: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });
});

describe('AC-02 · per-tick displacement along one axis', () => {
  it('60 ticks of (1, 0) input moves exactly maxSpeed * 1.0 second', () => {
    const rig = makeRig();

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    rig.sim.step(TICKS_PER_SECOND);

    // The clock itself must land on exactly 1.0 simulated second.
    expect(rig.sim.tick).toBe(TICKS_PER_SECOND);
    expect(Math.abs(rig.sim.elapsedSeconds - 1.0)).toBeLessThan(TOLERANCE);

    const transform = transformOf(rig);
    const expected = MAX_SPEED * 1.0;

    expect(Math.abs(transform.x - expected)).toBeLessThan(TOLERANCE);
    expect(Math.abs(transform.y)).toBeLessThan(TOLERANCE);
    expect(Math.abs(transform.facingRadians - 0)).toBeLessThan(TOLERANCE);
  });

  it('keeps speed at maxSpeed while moving and reports the unit direction', () => {
    const rig = makeRig();

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(0, 1) });
    rig.sim.step(1);

    const velocity = velocityOf(rig);
    expect(velocity.currentSpeed).toBe(MAX_SPEED);
    expect(Math.abs(velocity.directionVector.x)).toBeLessThan(TOLERANCE);
    expect(Math.abs(velocity.directionVector.y - 1)).toBeLessThan(TOLERANCE);
    expect(Math.abs(transformOf(rig).facingRadians - Math.PI / 2)).toBeLessThan(TOLERANCE);
  });
});

describe('AC-03 · input normalization prevents diagonal over-speed', () => {
  it('60 ticks of (1, 1) input travels the same distance as straight-line input', () => {
    const straight = makeRig();
    straight.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    straight.sim.step(TICKS_PER_SECOND);
    const straightTransform = transformOf(straight);
    const straightDistance = Math.hypot(straightTransform.x, straightTransform.y);

    const diagonal = makeRig();
    diagonal.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 1) });
    diagonal.sim.step(TICKS_PER_SECOND);
    const diagonalTransform = transformOf(diagonal);
    const diagonalDistance = Math.hypot(diagonalTransform.x, diagonalTransform.y);

    // Normalized: the diagonal distance must match the straight-line distance.
    // Without normalization it would be sqrt(2) times larger.
    expect(Math.abs(diagonalDistance - straightDistance)).toBeLessThan(TOLERANCE);
    expect(Math.abs(diagonalDistance - MAX_SPEED * 1.0)).toBeLessThan(TOLERANCE);
    expect(diagonalDistance).toBeLessThan(MAX_SPEED * 1.001);

    // Each axis receives maxSpeed / sqrt(2).
    const perAxis = (MAX_SPEED * 1.0) / Math.SQRT2;
    expect(Math.abs(diagonalTransform.x - perAxis)).toBeLessThan(TOLERANCE);
    expect(Math.abs(diagonalTransform.y - perAxis)).toBeLessThan(TOLERANCE);
    expect(Math.abs(diagonalTransform.facingRadians - Math.PI / 4)).toBeLessThan(TOLERANCE);
  });

  it('normalizes an over-long input vector back to unit length', () => {
    const rig = makeRig();

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(3, 4) });
    rig.sim.step(1);

    const velocity = velocityOf(rig);
    const magnitude = Math.hypot(velocity.directionVector.x, velocity.directionVector.y);
    expect(Math.abs(magnitude - 1)).toBeLessThan(TOLERANCE);
  });
});

describe('AC-04 · idle behaviour', () => {
  it('does not move and preserves facing when the stick returns to zero', () => {
    const rig = makeRig();

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(0, 1) });
    rig.sim.step(10);

    const moved = transformOf(rig);
    const xAfterMove = moved.x;
    const yAfterMove = moved.y;
    const facingAfterMove = moved.facingRadians;

    rig.sim.inject({ kind: 'move', tick: 10, vector: vec2(0, 0) });
    rig.sim.step(30);

    const idle = transformOf(rig);
    expect(idle.x).toBe(xAfterMove);
    expect(idle.y).toBe(yAfterMove);
    expect(idle.facingRadians).toBe(facingAfterMove);
    expect(velocityOf(rig).currentSpeed).toBe(0);
  });
});

describe('AC-05 · tick length comes from the simulation clock', () => {
  it('30 ticks at 30 fps travel the same distance as 60 ticks at 60 fps', () => {
    const at60 = makeRig({ fps: 60 });
    at60.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    at60.sim.step(60);

    const at30 = makeRig({ fps: 30 });
    at30.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    at30.sim.step(30);

    expect(Math.abs(at60.sim.elapsedSeconds - 1.0)).toBeLessThan(TOLERANCE);
    expect(Math.abs(at30.sim.elapsedSeconds - 1.0)).toBeLessThan(TOLERANCE);
    expect(Math.abs(transformOf(at60).x - transformOf(at30).x)).toBeLessThan(TOLERANCE);
    expect(Math.abs(transformOf(at30).x - MAX_SPEED * 1.0)).toBeLessThan(TOLERANCE);
  });
});

describe('AC-06 · determinism and snapshot observability', () => {
  it('produces identical snapshots for the same input script', () => {
    const run = (): unknown => {
      const rig = makeRig();
      rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 1) });
      rig.sim.inject({ kind: 'keyDown', tick: 5, key: 'dash' });
      rig.sim.inject({ kind: 'move', tick: 20, vector: vec2(-1, 0.5) });
      rig.sim.inject({ kind: 'keyUp', tick: 30, key: 'dash' });
      rig.sim.step(60);
      return rig.sim.snapshot();
    };

    expect(run()).toEqual(run());
  });

  it('treats "hold once" and "re-inject every tick" as equivalent', () => {
    const held = makeRig();
    held.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    held.sim.step(TICKS_PER_SECOND);

    const repeated = makeRig();
    for (let tick = 0; tick < TICKS_PER_SECOND; tick += 1) {
      repeated.sim.inject({ kind: 'move', tick, vector: vec2(1, 0) });
    }
    repeated.sim.step(TICKS_PER_SECOND);

    expect(transformOf(repeated).x).toBe(transformOf(held).x);
  });

  it('records held keys in ascending order', () => {
    const rig = makeRig();

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: 'dash' });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: 'attack' });
    rig.sim.inject({ kind: 'keyUp', tick: 10, key: 'dash' });
    rig.sim.step(1);

    expect(rig.sim.world.getComponent(rig.player, InputComponent)?.keysHeld).toEqual([
      'attack',
      'dash',
    ]);

    rig.sim.step(10);
    expect(rig.sim.world.getComponent(rig.player, InputComponent)?.keysHeld).toEqual(['attack']);
  });

  it('exposes the moved transform through the read-only snapshot', () => {
    const rig = makeRig();

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(0, -1) });
    rig.sim.step(TICKS_PER_SECOND);

    const snapshot = rig.sim.snapshot();
    const entity = snapshot.entities.find((candidate) => candidate.id === rig.player);
    expect(entity).toBeDefined();

    const transform = entity?.components.find((c) => c.type === 'TransformComponent');
    expect(transform).toBeDefined();
    expect(transform?.data['y'] as number).toBeCloseTo(-MAX_SPEED, 9);
  });
});
