import { describe, expect, it } from 'vitest';
import { GameSimulator } from '../../src/core/GameSimulator';
import { MovementSystem, Position, Velocity } from './fixtures';

function buildSim(): GameSimulator {
  const sim = new GameSimulator({ systems: [new MovementSystem()] });
  const entity = sim.world.createEntity();
  sim.world.addComponent(entity.id, new Position(0, 0));
  sim.world.addComponent(entity.id, new Velocity(1, 0));
  return sim;
}

describe('Snapshot immutability (AC-06)', () => {
  it('returns a deeply frozen object graph', () => {
    const sim = buildSim();
    sim.step(3);
    const snap = sim.snapshot();

    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.entities)).toBe(true);

    const entity = snap.entities[0];
    expect(entity).toBeDefined();
    expect(Object.isFrozen(entity)).toBe(true);

    const component = entity?.components[0];
    expect(component).toBeDefined();
    expect(Object.isFrozen(component)).toBe(true);
    expect(Object.isFrozen(component?.data)).toBe(true);
  });

  it('throws when attempting to mutate a frozen snapshot', () => {
    const sim = buildSim();
    sim.step(3);
    const snap = sim.snapshot();

    const asMutable = snap as unknown as { tick: number };
    expect(() => {
      asMutable.tick = 999;
    }).toThrow(TypeError);
  });

  it('shares no mutable references with the live world', () => {
    const sim = buildSim();
    sim.step(2);
    const snap = sim.snapshot();
    const frozenCopy = JSON.stringify(snap.entities);

    sim.step(5); // advance the live world

    expect(JSON.stringify(snap.entities)).toBe(frozenCopy);
    expect(JSON.stringify(sim.snapshot().entities)).not.toBe(frozenCopy);
  });

  it('is stable when no ticks are stepped in between', () => {
    const sim = buildSim();
    sim.step(2);
    expect(sim.snapshot()).toEqual(sim.snapshot());
  });
});
