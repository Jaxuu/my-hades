/**
 * Minimal ECS World: entity/component registry with deterministic ordering.
 * See specs/00_harness_spec.md §6.
 */

import { DEFAULT_RANDOM_SEED, Random } from '../core/Random';
import type { Component, ComponentCtor } from './Component';
import { Entity } from './Entity';
import type { EntityId } from './Entity';

/**
 * Order two components by their type name using **UTF-16 code-unit order**.
 *
 * Deliberately NOT `String.prototype.localeCompare`: that compares under the
 * ambient locale / ICU collation, so the same two names can order differently on
 * two machines (or two Node builds with different ICU data). `listComponents`
 * feeds `GameSimulator.snapshot()`, so a locale-sensitive sort would make the
 * exported snapshot — and therefore replay comparison — environment dependent
 * (ADR-001 R6). `a < b` on strings is the ECMAScript abstract relational
 * comparison, which is a pure code-unit comparison with no environment input.
 */
function compareComponentTypeName(a: Component, b: Component): number {
  const left = a.constructor.name;
  const right = b.constructor.name;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Construction options for a {@link World}. */
export interface WorldOptions {
  /**
   * Seed for the world's deterministic PRNG (M6-T01). Defaults to
   * {@link DEFAULT_RANDOM_SEED}, so an unconfigured world is reproducible.
   * See docs/architecture/ADR-004-deterministic-prng.md.
   */
  readonly seed?: number;
}

export class World {
  /**
   * The world's ONE deterministic random source (M6-T01, ADR-004).
   *
   * Mounted on `World` rather than threaded through `SystemContext` because the
   * context is a frozen harness contract (spec 00 §6.1, spec 05 C6) that both
   * `SystemContext` consumers and `ModifierContext` extensions rely on verbatim,
   * and rather than injected per-system because every randomness consumer must
   * share ONE stream — two generators seeded alike would draw the same numbers
   * twice, which is a subtle determinism bug, not a feature.
   *
   * The logic layer READS this; it never reseeds it. Choosing the seed is the
   * caller's job (`new GameSimulator({ seed })`), which is what keeps the wall
   * clock out of `src/` (ADR-004 §Decision 3).
   */
  public readonly rng: Random;

  private nextId: EntityId = 0;
  private readonly alive = new Set<EntityId>();
  private readonly stores = new Map<ComponentCtor, Map<EntityId, Component>>();

  constructor(options: WorldOptions = {}) {
    this.rng = new Random(options.seed ?? DEFAULT_RANDOM_SEED);
  }

  public get entityCount(): number {
    return this.alive.size;
  }

  public createEntity(): Entity {
    const id = this.nextId;
    this.nextId += 1;
    this.alive.add(id);
    return new Entity(id);
  }

  public isAlive(id: EntityId): boolean {
    return this.alive.has(id);
  }

  public destroyEntity(id: EntityId): void {
    this.assertAlive(id);
    this.alive.delete(id);
    for (const store of this.stores.values()) {
      store.delete(id);
    }
  }

  public addComponent<T extends Component>(id: EntityId, component: T): T {
    this.assertAlive(id);
    const ctor = component.constructor as ComponentCtor;
    let store = this.stores.get(ctor);
    if (store === undefined) {
      store = new Map<EntityId, Component>();
      this.stores.set(ctor, store);
    }
    store.set(id, component);
    return component;
  }

  public getComponent<T extends Component>(id: EntityId, ctor: ComponentCtor<T>): T | undefined {
    const found = this.stores.get(ctor)?.get(id);
    return found as T | undefined;
  }

  public hasComponent<T extends Component>(id: EntityId, ctor: ComponentCtor<T>): boolean {
    return this.stores.get(ctor)?.has(id) ?? false;
  }

  public removeComponent<T extends Component>(id: EntityId, ctor: ComponentCtor<T>): boolean {
    return this.stores.get(ctor)?.delete(id) ?? false;
  }

  /** Return all alive entities that own every listed component type, sorted by id. */
  public query(...ctors: ComponentCtor[]): EntityId[] {
    if (ctors.length === 0) return [];
    const result: EntityId[] = [];
    for (const id of this.alive) {
      let matches = true;
      for (const ctor of ctors) {
        if (!this.stores.get(ctor)?.has(id)) {
          matches = false;
          break;
        }
      }
      if (matches) result.push(id);
    }
    return result.sort((a, b) => a - b);
  }

  /** All alive entity ids, sorted ascending (deterministic). */
  public listEntities(): EntityId[] {
    return [...this.alive].sort((a, b) => a - b);
  }

  /** All components attached to an entity, sorted by component type name. */
  public listComponents(id: EntityId): ReadonlyArray<Component> {
    const out: Component[] = [];
    for (const store of this.stores.values()) {
      const component = store.get(id);
      if (component !== undefined) out.push(component);
    }
    return out.sort(compareComponentTypeName);
  }

  private assertAlive(id: EntityId): void {
    if (!this.alive.has(id)) {
      throw new Error(`Entity ${id} is not alive.`);
    }
  }
}
