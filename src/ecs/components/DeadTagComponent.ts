/**
 * Death marker. See specs/08_encounter_and_death_spec.md §3.1 / §4.
 *
 * POD component: data only, no behaviour. It carries no fields — the FACT of
 * death is the whole payload. The mutation helpers below are FREE FUNCTIONS (not
 * component methods), so the "components carry no behaviour" contract
 * (specs/00_harness_spec.md §6.1) stays intact.
 *
 * Why a dedicated component type rather than a string in `TagComponent.tags`:
 * a component type is an unspoofable key. Nothing else in the codebase can
 * accidentally add `'Dead'` as a flavour tag, and `world.query(DeadTagComponent)`
 * cannot match anything else — whereas `hasTag(world, id, 'Dead')` would silently
 * become true for any future entity that happens to carry that string. Death is
 * the one state every system must agree on, so it gets a first-class marker.
 *
 * Why a tag rather than DESTRUCTION: a destroyed entity stops existing, so
 * `World.query` no longer yields it and its components are gone. "The corpse was
 * recycled" and "this id was never spawned" become indistinguishable, and the
 * encounter scheduler (spec 08 §4.3) — whose whole job is to ask "are all of my
 * wave members gone?" — could not tell a corpse from a recycled slot. Death is
 * therefore a STATE (entity alive + tag present) and destruction stays a
 * separate, explicit, opt-in decision. This milestone deliberately never destroys
 * a combatant: the corpse is RETAINED (spec 08 §10 trade-off 1).
 *
 * Who writes it: `DeathSystem` ONLY, at the END of the tick in which `hp` reached
 * `0` (spec 08 §4.1). Never the system that dealt the damage — that is what keeps
 * the death transition a single, auditable write point and makes the "next tick
 * onwards" contract of AC-01 tick-exact.
 *
 * Who reads it: every gameplay system, as an absolute "skip me" gate
 * (spec 08 §4.2). A tagged entity produces no intent, is not displaced, is not
 * collision-tested and is never a valid hit target.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

export class DeadTagComponent extends ComponentBase {}

/**
 * Mark `id` as dead. Idempotent: re-marking an already-dead entity is a no-op, so
 * the death transition can never be applied twice (and can therefore never
 * publish a second death event for the same entity).
 *
 * No-op when the entity is not alive: `World.addComponent` throws on a stale id,
 * and "mark a recycled slot as dead" is meaningless rather than an error.
 */
export function markDead(world: World, id: EntityId): void {
  if (!world.isAlive(id)) return;
  if (world.hasComponent(id, DeadTagComponent)) return;
  world.addComponent(id, new DeadTagComponent());
}

/**
 * Whether `id` is a DEAD entity: still alive in the world AND carrying the death
 * tag.
 *
 * The `isAlive` guard is what makes this safe to call with a stale id — a
 * destroyed entity has no component stores left, so it reports `false`. That is
 * deliberate and load-bearing: callers must treat "destroyed" as its OWN, separate
 * reason to skip, never as "dead". `isWaveCleared` (see
 * `EncounterStateComponent.ts`) is written that way, and so is `CollisionSystem`'s
 * owner check, which preserves the pre-M4 rule that a hitbox outlives its owner.
 */
export function isDead(world: World, id: EntityId): boolean {
  return world.isAlive(id) && world.hasComponent(id, DeadTagComponent);
}
