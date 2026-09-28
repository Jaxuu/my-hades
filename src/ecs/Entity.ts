/**
 * ECS base types. See specs/00_harness_spec.md §6.
 */

export type EntityId = number;

export class Entity {
  public readonly id: EntityId;

  constructor(id: EntityId) {
    this.id = id;
  }
}
