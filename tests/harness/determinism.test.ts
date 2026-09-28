import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/core/GameSimulator';
import { vec2 } from '../../src/core/math';
import { HeadlessHarness } from './HeadlessHarness';
import { MovementSystem, Position, Velocity } from './fixtures';

function runScript(): Snapshot[] {
  const harness = new HeadlessHarness({ systems: [new MovementSystem()] });
  const entity = harness.sim.world.createEntity();
  harness.sim.world.addComponent(entity.id, new Position(0, 0));
  harness.sim.world.addComponent(entity.id, new Velocity(0.5, -0.25));

  harness.moveAt(0, vec2(1, 0));
  harness.moveAt(10, vec2(0, 1));
  harness.keyDownAt(20, 'dash');
  harness.moveAt(20, vec2(-1, 0));
  harness.keyUpAt(30, 'dash');

  const snapshots: Snapshot[] = [];
  for (let tick = 0; tick < 40; tick += 1) {
    harness.step(1);
    snapshots.push(harness.captureSnapshot());
  }
  return snapshots;
}

describe('Deterministic replay (AC-07)', () => {
  it('produces identical snapshot sequences for identical input scripts', () => {
    const first = runScript();
    const second = runScript();

    expect(first).toHaveLength(40);
    expect(first).toEqual(second);
  });

  it('final state reflects exactly the scripted inputs', () => {
    const snapshots = runScript();
    const last = snapshots[snapshots.length - 1];
    expect(last?.tick).toBe(40);

    // Position starts at (0,0), Velocity (0.5,-0.25) applied each of 40 ticks,
    // plus move inputs at tick 0 (1,0), tick 10 (0,1), tick 20 (-1,0).
    const entity = last?.entities[0];
    const position = entity?.components.find((c) => c.type === 'Position');
    expect(position?.data).toEqual({ x: 40 * 0.5 + 1 - 1, y: 40 * -0.25 + 1 });
  });
});
