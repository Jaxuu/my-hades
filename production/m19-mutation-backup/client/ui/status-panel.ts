/**
 * Status panel model — the in-run "what am I carrying?" list (M19).
 * See specs/027-hud-boon-ui/data-model.md §6 and contracts/hud-and-overlay-ui.md §6.
 *
 * The panel's content MUST equal the player's actual owned-boon set, exactly
 * (SC-005), and it MUST present an explicit empty state rather than a blank box
 * (FR-024). Each row reuses the card view (quality + glyph + description), so a
 * boon looks the same whether it is being chosen or being reviewed.
 *
 * DOM-free, pixi-free, random-free: node-unit-testable.
 */

import { ModifierComponent } from '../../src/ecs/components/ModifierComponent';
import { PlayerInputComponent } from '../../src/ecs/components/PlayerInputComponent';
import type { World } from '../../src/ecs/World';

import { buildBoonCard, type BoonCardView } from './boon-presentation';

/** Above this many rows the panel scrolls rather than growing. */
export const STATUS_PANEL_SCROLL_THRESHOLD = 6;

/** The panel's derived view. */
export interface StatusPanelView {
  /** One row per owned boon, ascending by id (stable). */
  readonly rows: readonly BoonCardView[];
  readonly isEmpty: boolean;
  readonly scrollable: boolean;
}

/**
 * The player's owned boon ids, ascending and deduplicated.
 *
 * `ModifierComponent.modifiers` is already sorted + deduped, but this read is
 * defensive about it so the panel's row order is a property of THIS module rather
 * than of a component invariant it does not own. A world with no player yields an
 * empty list.
 */
export function readOwnedBoonIds(world: World): readonly string[] {
  const playerId = world.query(PlayerInputComponent)[0];
  const modifiers =
    playerId === undefined ? undefined : world.getComponent(playerId, ModifierComponent);
  return modifiers?.modifiers ?? [];
}

/**
 * Build the panel view for a set of owned ids.
 *
 * Unknown ids are INCLUDED and degrade to a default card, so the panel's set always
 * equals the owned set (SC-005) even if the metadata table lags behind the pool.
 */
export function buildStatusPanel(ownedIds: readonly string[], tickSeconds: number): StatusPanelView {
  const rows = [...new Set(ownedIds)].sort().map((id) => buildBoonCard(id, tickSeconds));
  return {
    rows,
    isEmpty: rows.length === 0,
    scrollable: rows.length > STATUS_PANEL_SCROLL_THRESHOLD,
  };
}
