/**
 * Boon / modifier list. See specs/05_boon_modifier_spec.md §3.3.
 *
 * POD component: data only, no behaviour. The mutation helpers below are FREE
 * FUNCTIONS (not component methods), so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact.
 *
 * Invariant: `modifiers` is kept sorted ascending and free of duplicates, so a
 * snapshot of the boon list is byte-for-byte deterministic regardless of the
 * order in which boons were granted — the same invariant TagComponent.tags has.
 *
 * A modifier is just an IDENTIFIER. It carries no data and no behaviour: the
 * behaviour lives in ModifierSystem, which listens to events and injects new
 * world state when the entity holding the modifier is involved (spec 05 §4.2).
 * This milestone hard-codes the effects; a data-driven boon table can later
 * replace the dispatch without touching the pipeline (spec 05 §10 trade-off 5).
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

/**
 * Zeus Strike: when the holder's base attack lands, an extra, directionless
 * lightning hitbox is spawned on the victim for bonus damage (spec 05 AC-03).
 */
export const ZEUS_STRIKE_MODIFIER = 'zeus_strike';

/**
 * Dionysus Blight (M3-T02): when the holder's base attack lands, the victim is
 * POISONED — a stacking damage-over-time status (spec 06 AC-02).
 */
export const DIONYSUS_BLIGHT_MODIFIER = 'dionysus_strike';

/**
 * Poseidon Dash (M6-T02): the holder's DASH ENTRY detonates a self-centred
 * shockwave — a large-radius, high-knockback, low-damage burst that exists for a
 * single active tick (spec 12 AC-04).
 *
 * The first boon driven by the `onDash` hook rather than `onHit`: it demonstrates
 * that the modifier engine is about EVENTS, not specifically about hits.
 */
export const POSEIDON_DASH_MODIFIER = 'poseidon_dash';

/**
 * Radius / damage / knockback / hitstop / lifespan of a boon's injected hitbox
 * are DATA, not code (M10-T01). They live in `assets/data/modifiers.json` and are
 * read once at registry construction — see `specs/16_data_driven_pipeline_spec.md
 * §4.2`. This file therefore declares only the IDS; the numbers moved out with the
 * rest of the balance table.
 */

export class ModifierComponent extends ComponentBase {
  /** Modifier ids held, kept ascending and deduplicated for determinism. */
  public modifiers: string[];

  constructor(modifiers: string[] = []) {
    super();
    this.modifiers = modifiers;
  }
}

/**
 * Grant `modifier` to the entity, mounting a `ModifierComponent` lazily if the
 * entity has none yet. Idempotent: re-granting an existing modifier is a no-op,
 * so boons never stack through this API (stacking, if ever wanted, needs an
 * explicit level field rather than a duplicated list entry).
 */
export function addModifier(world: World, id: EntityId, modifier: string): void {
  let component = world.getComponent(id, ModifierComponent);
  if (component === undefined) {
    component = new ModifierComponent();
    world.addComponent(id, component);
  }
  if (component.modifiers.includes(modifier)) return;
  component.modifiers.push(modifier);
  component.modifiers.sort();
}

/**
 * Revoke `modifier` from the entity. No-op when the entity has no
 * `ModifierComponent` or does not hold the modifier.
 */
export function removeModifier(world: World, id: EntityId, modifier: string): void {
  const component = world.getComponent(id, ModifierComponent);
  if (component === undefined) return;
  const at = component.modifiers.indexOf(modifier);
  if (at !== -1) component.modifiers.splice(at, 1);
}

/** Whether the entity currently holds `modifier`. Missing component counts as `false`. */
export function hasModifier(world: World, id: EntityId, modifier: string): boolean {
  return world.getComponent(id, ModifierComponent)?.modifiers.includes(modifier) ?? false;
}
