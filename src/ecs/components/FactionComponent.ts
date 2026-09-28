/**
 * Team allegiance. See specs/03_combat_hitbox_spec.md §3.2.
 *
 * POD component: data only, no behaviour. Its whole reason to exist is AC-01:
 * a hitbox must never damage its own side, so "can this hurtbox be hit by this
 * hitbox?" is answered by comparing factions — not by comparing entity ids.
 */

import { ComponentBase } from '../Component';

/** Team allegiance of a combatant. */
export enum Faction {
  Player = 'Player',
  Enemy = 'Enemy',
}

export class FactionComponent extends ComponentBase {
  /** The team this entity belongs to. */
  public faction: Faction;

  constructor(faction: Faction = Faction.Enemy) {
    super();
    this.faction = faction;
  }
}

/**
 * Whether two factions may damage each other.
 *
 * This milestone uses the simplest possible rule — "different faction = hostile"
 * — which covers Player vs Enemy while leaving room for alliances later.
 */
export function areHostile(a: Faction, b: Faction): boolean {
  return a !== b;
}
