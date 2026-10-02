/**
 * manifest — the ONE place in the repository that imports an asset FILE.
 * See specs/024-real-art-assets/contracts/asset-manifest.md.
 *
 * WHY A CODE MODULE RATHER THAN A JSON FETCHED AT RUNTIME
 * ------------------------------------------------------
 * Every entry below is a Vite static import, so the asset is resolved at BUILD
 * time. That buys the contract's promise 2 for free: deleting an atlas makes
 * `npm run build` fail loudly instead of shipping a bundle that 404s at run time.
 * A `public/` directory plus a runtime `fetch` would have been simpler to write
 * and would have lost exactly that guarantee (research.md D2).
 *
 * WHY IT IS DOM-FREE
 * ------------------
 * This module is imported by `tests/assets/manifest.test.ts`, i.e. it is compiled
 * by the DOM-less `npm run typecheck` program. It therefore uses no DOM global and
 * imports no pixi.js — the sheet JSON is data, and turning it into textures is
 * `AssetCatalog`'s job.
 *
 * THE LICENSES ARE NOT DECORATION
 * -------------------------------
 * `license` is on every entry because `tests/assets/manifest.test.ts` reads it
 * against a whitelist and cross-checks every id against `assets/**\/LICENSES.md`.
 * FR-020 ("no proprietary asset may ever be redistributed") is enforced by that
 * test, not by good intentions.
 */

import playerSheetJson from '../../assets/art/atlas/player.json';
import enemiesSheetJson from '../../assets/art/atlas/enemies.json';
import tilesSheetJson from '../../assets/art/atlas/tiles.json';
import fxSheetJson from '../../assets/art/atlas/fx.json';
import uiSheetJson from '../../assets/art/atlas/ui.json';

import playerAtlas from '../../assets/art/atlas/player.png?url';
import enemiesAtlas from '../../assets/art/atlas/enemies.png?url';
import tilesAtlas from '../../assets/art/atlas/tiles.png?url';
import fxAtlas from '../../assets/art/atlas/fx.png?url';
import uiAtlas from '../../assets/art/atlas/ui.png?url';

import uiPanelHud from '../../assets/art/ui/panel-hud.png?url';
import uiPanelReward from '../../assets/art/ui/panel-reward.png?url';
import uiPanelCamp from '../../assets/art/ui/panel-camp.png?url';
import uiFrameRewardCard from '../../assets/art/ui/frame-reward-card.png?url';
import uiFrameTalentCard from '../../assets/art/ui/frame-talent-card.png?url';
import uiButtonPrimary from '../../assets/art/ui/button-primary.png?url';
import uiOverlayDeath from '../../assets/art/ui/overlay-death.png?url';
import uiOverlayWin from '../../assets/art/ui/overlay-win.png?url';
import uiFrameSlot from '../../assets/art/ui/slot.png?url';
import uiFrameSlotInlay from '../../assets/art/ui/slot-inlay.png?url';
import uiBarHud from '../../assets/art/ui/bar.png?url';

import sfxHit from '../../assets/audio/sfx/hit.ogg?url';
import sfxDash from '../../assets/audio/sfx/dash.ogg?url';
import sfxCoin from '../../assets/audio/sfx/coin.ogg?url';
import sfxEnemyDeath from '../../assets/audio/sfx/enemy-death.ogg?url';
import sfxHazardBlast from '../../assets/audio/sfx/hazard-blast.ogg?url';
import sfxUiClick from '../../assets/audio/sfx/ui-click.ogg?url';
import sfxRewardSelect from '../../assets/audio/sfx/reward-select.ogg?url';
import sfxDeath from '../../assets/audio/sfx/death.ogg?url';
import sfxWin from '../../assets/audio/sfx/win.ogg?url';

/** What an entry IS, which decides the loader branch and the fallback path. */
export type AssetKind = 'spritesheet' | 'image' | 'audio';

/** What to do when an entry fails to load (contract §3.3). */
export type AssetFallback = 'graphics' | 'silent';

/** One asset. Every field is required: a missing license is a build-time mistake. */
export interface AssetEntry {
  /** Stable id, kebab-case, namespaced (contract §2). */
  readonly id: string;
  readonly kind: AssetKind;
  /** The Vite-resolved URL of the built asset. Never a remote URL. */
  readonly source: string;
  /** Redistribution license — `CC0-1.0` for every entry of this feature. */
  readonly license: string;
  /** The degradation path when this entry cannot be loaded. */
  readonly fallback: AssetFallback;
}

/** The subset of the PixiJS spritesheet JSON this project reads. */
export interface SheetFrameData {
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/** A parsed spritesheet: explicit `frames` plus explicit `animations`. */
export interface SpriteSheetData {
  readonly frames: Readonly<Record<string, SheetFrameData>>;
  readonly animations?: Readonly<Record<string, string[]>>;
  /**
   * Atlas metadata. `scale` is required (and `size` declared) so this interface is
   * structurally assignable to PixiJS's own `SpritesheetData` without a cast —
   * `AssetCatalog` hands these objects straight to `new Spritesheet(...)`.
   */
  readonly meta: {
    readonly app?: string;
    readonly format?: string;
    readonly image?: string;
    readonly scale: number | string;
    readonly size?: { readonly w: number; readonly h: number };
  };
}

/** The one license this feature ships under (FR-020). */
const LICENSE = 'CC0-1.0';

/** Shorthand: a visual entry that degrades to the existing geometry. */
function visual(
  id: string,
  kind: AssetKind,
  source: string,
): AssetEntry {
  return { id, kind, source, license: LICENSE, fallback: 'graphics' };
}

/** Shorthand: an audio entry, which can only degrade to silence. */
function audio(id: string, source: string): AssetEntry {
  return { id, kind: 'audio', source, license: LICENSE, fallback: 'silent' };
}

/**
 * The whole registry, in a fixed order (the order tests and diagnostics report in).
 *
 * Several ids intentionally share ONE `source`: the five enemy types and the
 * generic fallback all live in `enemies.png`. `AssetCatalog` de-duplicates by
 * source so the atlas is decoded once, and each id then resolves its own animation
 * out of the shared sheet.
 */
export const MANIFEST: Readonly<Record<string, AssetEntry>> = Object.freeze({
  'player.base': visual('player.base', 'spritesheet', playerAtlas),

  'enemy.grunt': visual('enemy.grunt', 'spritesheet', enemiesAtlas),
  'enemy.elite': visual('enemy.elite', 'spritesheet', enemiesAtlas),
  'enemy.raider': visual('enemy.raider', 'spritesheet', enemiesAtlas),
  'enemy.bomber': visual('enemy.bomber', 'spritesheet', enemiesAtlas),
  'enemy.gunner': visual('enemy.gunner', 'spritesheet', enemiesAtlas),
  'enemy.unknown': visual('enemy.unknown', 'spritesheet', enemiesAtlas),

  'tile.floor': visual('tile.floor', 'spritesheet', tilesAtlas),
  'tile.wall': visual('tile.wall', 'spritesheet', tilesAtlas),

  'fx.spark': visual('fx.spark', 'spritesheet', fxAtlas),
  'fx.dash-trail': visual('fx.dash-trail', 'spritesheet', fxAtlas),
  'fx.hazard-ring': visual('fx.hazard-ring', 'spritesheet', fxAtlas),

  'ui.icon.gold': visual('ui.icon.gold', 'spritesheet', uiAtlas),
  'ui.icon.heal': visual('ui.icon.heal', 'spritesheet', uiAtlas),
  'ui.icon.darkness': visual('ui.icon.darkness', 'spritesheet', uiAtlas),

  'ui.panel.hud': visual('ui.panel.hud', 'image', uiPanelHud),
  'ui.panel.reward': visual('ui.panel.reward', 'image', uiPanelReward),
  'ui.panel.camp': visual('ui.panel.camp', 'image', uiPanelCamp),
  'ui.frame.reward-card': visual('ui.frame.reward-card', 'image', uiFrameRewardCard),
  'ui.frame.talent-card': visual('ui.frame.talent-card', 'image', uiFrameTalentCard),
  'ui.button.primary': visual('ui.button.primary', 'image', uiButtonPrimary),
  'ui.overlay.death': visual('ui.overlay.death', 'image', uiOverlayDeath),
  'ui.overlay.win': visual('ui.overlay.win', 'image', uiOverlayWin),
  'ui.frame.slot': visual('ui.frame.slot', 'image', uiFrameSlot),
  'ui.frame.slot-inlay': visual('ui.frame.slot-inlay', 'image', uiFrameSlotInlay),
  'ui.bar.hud': visual('ui.bar.hud', 'image', uiBarHud),

  'sfx.hit': audio('sfx.hit', sfxHit),
  'sfx.dash': audio('sfx.dash', sfxDash),
  'sfx.coin': audio('sfx.coin', sfxCoin),
  'sfx.enemy-death': audio('sfx.enemy-death', sfxEnemyDeath),
  'sfx.hazard-blast': audio('sfx.hazard-blast', sfxHazardBlast),
  'sfx.ui-click': audio('sfx.ui-click', sfxUiClick),
  'sfx.reward-select': audio('sfx.reward-select', sfxRewardSelect),
  'sfx.death': audio('sfx.death', sfxDeath),
  'sfx.win': audio('sfx.win', sfxWin),
});

/** Every id, in registry order. Derived once so callers never re-sort a hash map. */
export const MANIFEST_IDS: readonly string[] = Object.freeze(Object.keys(MANIFEST));

/**
 * The parsed spritesheet JSON, keyed by the SAME ids as {@link MANIFEST}.
 *
 * Kept as a sibling export rather than a field on `AssetEntry` because the contract
 * fixes `AssetEntry`'s shape (§1) and explicitly leaves the sheet's internal layout
 * out of scope (§5). The loader looks the data up by id and pairs it with the PNG.
 */
export const SHEET_DATA: Readonly<Record<string, SpriteSheetData>> = Object.freeze({
  'player.base': playerSheetJson as SpriteSheetData,
  'enemy.grunt': enemiesSheetJson as SpriteSheetData,
  'enemy.elite': enemiesSheetJson as SpriteSheetData,
  'enemy.raider': enemiesSheetJson as SpriteSheetData,
  'enemy.bomber': enemiesSheetJson as SpriteSheetData,
  'enemy.gunner': enemiesSheetJson as SpriteSheetData,
  'enemy.unknown': enemiesSheetJson as SpriteSheetData,
  'tile.floor': tilesSheetJson as SpriteSheetData,
  'tile.wall': tilesSheetJson as SpriteSheetData,
  'fx.spark': fxSheetJson as SpriteSheetData,
  'fx.dash-trail': fxSheetJson as SpriteSheetData,
  'fx.hazard-ring': fxSheetJson as SpriteSheetData,
  'ui.icon.gold': uiSheetJson as SpriteSheetData,
  'ui.icon.heal': uiSheetJson as SpriteSheetData,
  'ui.icon.darkness': uiSheetJson as SpriteSheetData,
});
