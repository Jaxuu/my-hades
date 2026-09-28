/**
 * Minimal ECS World: entity/component registry with deterministic ordering.
 * See specs/00_harness_spec.md §6.
 */

import type { Component, ComponentCtor } from './Component';
import { Entity } from './Entity';
import type { EntityId } from './Entity';

export class World {
  private nextId: EntityId = 0;
  private readonly alive = new Set<EntityId>();
  private readonly stores = new Map<ComponentCtor, Map<EntityId, Component>>();

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
    return out.sort((a, b) => a.constructor.name.localeCompare(b.constructor.name));
  }

  private assertAlive(id: EntityId): void {
    if (!this.alive.has(id)) {
      throw new Error(`Entity ${id} is not alive.`);
    }
  }
}
