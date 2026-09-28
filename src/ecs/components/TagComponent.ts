/**
 * String tag set. See specs/02_dash_and_state_spec.md §3.3.
 *
 * POD component: data only, no behaviour. The tag mutation helpers below are
 * FREE FUNCTIONS (not component methods), so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact.
 *
 * Invariant: `tags` is kept sorted ascending and free of duplicates, so a
 * snapshot of the tag set is byte-for-byte deterministic regardless of the
 * order in which tags were added.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

/** Tag marking an entity as immune to damage while dashing (spec 02 AC-03). */
export const INVULNERABLE_TAG = 'Invulnerable';

export class TagComponent extends ComponentBase {
  /** Tags held, kept in ascending order and deduplicated for determinism. */
  public tags: string[];

  constructor(tags: string[] = []) {
    super();
    this.tags = tags;
  }
}

/**
 * Add `tag` to the entity's tag set, creating a `TagComponent` lazily if the
 * entity has none yet. Idempotent: re-adding an existing tag is a no-op.
 */
export function addTag(world: World, id: EntityId, tag: string): void {
  let component = world.getComponent(id, TagComponent);
  if (component === undefined) {
    component = new TagComponent();
    world.addComponent(id, component);
  }
  if (component.tags.includes(tag)) return;
  component.tags.push(tag);
  component.tags.sort();
}

/**
 * Remove `tag` from the entity's tag set. No-op when the entity has no
 * `TagComponent` or does not carry the tag.
 */
export function removeTag(world: World, id: EntityId, tag: string): void {
  const component = world.getComponent(id, TagComponent);
  if (component === undefined) return;
  const at = component.tags.indexOf(tag);
  if (at !== -1) component.tags.splice(at, 1);
}

/** Whether the entity currently carries `tag`. Missing component counts as `false`. */
export function hasTag(world: World, id: EntityId, tag: string): boolean {
  return world.getComponent(id, TagComponent)?.tags.includes(tag) ?? false;
}
