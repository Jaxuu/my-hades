import { describe, expect, it } from 'vitest';
import { World } from '../../src/ecs/World';
import { Position, Tag, Velocity, Zebra, alpha } from './fixtures';

describe('ECS basics (AC-08)', () => {
  it('creates and tracks entities with sequential ids', () => {
    const world = new World();
    const first = world.createEntity();
    const second = world.createEntity();

    expect(first.id).toBe(0);
    expect(second.id).toBe(1);
    expect(world.entityCount).toBe(2);
    expect(world.isAlive(first.id)).toBe(true);
    expect(world.listEntities()).toEqual([0, 1]);
  });

  it('adds, gets, checks, and removes components', () => {
    const world = new World();
    const entity = world.createEntity();
    const position = world.addComponent(entity.id, new Position(3, 4));

    expect(position.x).toBe(3);
    expect(world.hasComponent(entity.id, Position)).toBe(true);
    expect(world.getComponent(entity.id, Position)).toBe(position);
    expect(world.getComponent(entity.id, Velocity)).toBeUndefined();

    expect(world.removeComponent(entity.id, Position)).toBe(true);
    expect(world.hasComponent(entity.id, Position)).toBe(false);
    expect(world.removeComponent(entity.id, Position)).toBe(false);
  });

  it('queries entities owning all requested components, sorted by id', () => {
    const world = new World();
    const e0 = world.createEntity();
    const e1 = world.createEntity();
    const e2 = world.createEntity();

    world.addComponent(e0.id, new Position());
    world.addComponent(e1.id, new Position());
    world.addComponent(e1.id, new Velocity());
    world.addComponent(e2.id, new Velocity());

    expect(world.query(Position)).toEqual([0, 1]);
    expect(world.query(Position, Velocity)).toEqual([1]);
    expect(world.query(Velocity)).toEqual([1, 2]);
    expect(world.query()).toEqual([]);
  });

  it('destroys entities together with their components', () => {
    const world = new World();
    const entity = world.createEntity();
    world.addComponent(entity.id, new Position());
    world.addComponent(entity.id, new Tag('enemy'));

    world.destroyEntity(entity.id);

    expect(world.isAlive(entity.id)).toBe(false);
    expect(world.entityCount).toBe(0);
    expect(world.query(Position)).toEqual([]);
    expect(() => world.destroyEntity(entity.id)).toThrow();
  });

  it('rejects adding components to a dead entity', () => {
    const world = new World();
    const entity = world.createEntity();
    world.destroyEntity(entity.id);

    expect(() => world.addComponent(entity.id, new Position())).toThrow();
  });

  it('lists components in UTF-16 code-unit order, never locale order (ADR-001 R6)', () => {
    // `listComponents` feeds `GameSimulator.snapshot()`, so its ordering must be
    // environment independent. Under locale collation these two sort the other way
    // round ('alpha' before 'Zebra'), which is exactly the cross-machine drift this
    // test pins shut; the assertion below is on the code-unit result only, so the
    // test itself stays environment independent.
    expect('Zebra' < 'alpha').toBe(true);

    const world = new World();
    const entity = world.createEntity();
    // Added lowercase-first so a locale sort would look "correct" here too; the
    // assertion is on the code-unit result, not on insertion order.
    world.addComponent(entity.id, new alpha());
    world.addComponent(entity.id, new Zebra());
    world.addComponent(entity.id, new Velocity());

    expect(world.listComponents(entity.id).map((c) => c.constructor.name)).toEqual([
      'Velocity',
      'Zebra',
      'alpha',
    ]);
  });
});
