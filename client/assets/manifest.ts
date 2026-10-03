/**
 * manifest — the ONE place in the repository that imports an asset FILE.
 * See specs/026-hd-2d-art-assets/contracts/hd-asset-manifest.md.
 *
 * WHY A CODE MODULE RATHER THAN A JSON FETCHED AT RUNTIME
 * ------------------------------------------------------
 * Every entry below is a Vite static import, so the asset is resolved at BUILD
 * time. That buys the contract's promise 3 for free: deleting an atlas makes
 * `npm run build` fail loudly instead of shipping a bundle that 404s at run time.
 * A `public/` directory plus a runtime `fetch` would have been simpler to write
 * and would have lost exactly that guarantee.
 *
 * M18 · WHAT CHANGED
 * ------------------
 * The world art (player / enemies / tiles / fx) now points at the nine HD atlases
 * under `assets/art/hd/`. Two structural things changed with it:
 *
 *   1. **`SHEET_DATA` is an EXPLICIT association.** Each spritesheet id is keyed
 *      to the atlas JSON it belongs to, instead of relying on "same basename means
 *      the same sheet". That implicit rule was already fragile when six enemy ids
 *      shared one file; with one atlas per enemy type it would be unverifiable.
 *   2. **`HD_WORLD_ART_IDS` names the textures that sample `linear`.** The global
 *      `TextureSource` default stays `nearest` (the M17 pixel-sharpness contract),
 *      and only the HD world art is overridden per texture (research.md D7).
 *
 * `ui.*` and `sfx.*` are deliberately untouched (FR-030): the feature's scope is
 * in-run WORLD art, so the interface and audio entries keep their old sources.
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
 * FR-023 ("no proprietary asset may ever be redistributed") is enforced by that
 * test, not by good intentions.
 */

// ── World HD art (M18) ───────────────────────────────────────────────────────
import playerSheetJson from '../../assets/art/hd/player.json';
import enemyGruntSheetJson from '../../assets/art/hd/enemy-grunt.json';
import enemyEliteSheetJson from '../../assets/art/hd/enemy-elite.json';
import enemyRaiderSheetJson from '../../assets/art/hd/enemy-raider.json';
import enemyBomberSheetJson from '../../assets/art/hd/enemy-bomber.json';
import enemyGunnerSheetJson from '../../assets/art/hd/enemy-gunner.json';
import enemyUnknownSheetJson from '../../assets/art/hd/enemy-unknown.json';
import tilesSheetJson from '../../assets/art/hd/tiles.json';
import fxSheetJson from '../../assets/art/hd/fx.json';

import playerAtlas from '../../assets/art/hd/player.png?url';
import enemyGruntAtlas from '../../assets/art/hd/enemy-grunt.png?url';
import enemyEliteAtlas from '../../assets/art/hd/enemy-elite.png?url';
import enemyRaiderAtlas from '../../assets/art/hd/enemy-raider.png?url';
import enemyBomberAtlas from '../../assets/art/hd/enemy-bomber.png?url';
import enemyGunnerAtlas from '../../assets/art/hd/enemy-gunner.png?url';
import enemyUnknownAtlas from '../../assets/art/hd/enemy-unknown.png?url';
import tilesAtlas from '../../assets/art/hd/tiles.png?url';
import fxAtlas from '../../assets/art/hd/fx.png?url';

// ── Interface art (FR-030: NOT in this feature's scope, unchanged content) ────
// M18 relocated these two files out of the deleted `assets/art/atlas/` directory
// (SC-008), so `assets/art/atlas/**` could be removed entirely. The PNG is
// byte-identical; the JSON differs in exactly ONE field — its `meta.app` string,
// which used to name the deleted pixel generator (`build-atlas.py`) and would have
// been a dangling reference to a tool that no longer exists. `meta.app` is
// documentation only: no code reads it, and the frames / animations / silhouettes
// are untouched, so the interface keeps exactly the art it had.
import uiSheetJson from '../../assets/art/ui/icons.json';
import uiAtlas from '../../assets/art/ui/icons.png?url';

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

// ── M19 material UI frames (HUD / boon cards / status panel) ─────────────────
// Seven nine-slice frames, all 48x48, all drawn with `border-image` (slice 12).
// No ICON entry is added: user ruling U3 makes the boon icon a pure CSS glyph, so
// `boons.json`'s `icon` field is a glyph token rather than an asset id.
import uiFrameHealth from '../../assets/art/ui/frame-health.png?url';
import uiFrameDash from '../../assets/art/ui/frame-dash.png?url';
import uiFrameBoonCommon from '../../assets/art/ui/frame-boon-common.png?url';
import uiFrameBoonEpic from '../../assets/art/ui/frame-boon-epic.png?url';
import uiFrameBoonLegendary from '../../assets/art/ui/frame-boon-legendary.png?url';
import uiPanelStatus from '../../assets/art/ui/panel-status.png?url';
import uiRuleBronze from '../../assets/art/ui/rule-bronze.png?url';

// ── Audio (FR-030: NOT in this feature's scope, unchanged) ────────────────────
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

/** What to do when an entry fails to load (contract §4). */
export type AssetFallback = 'graphics' | 'silent';

/** One asset. Every field is required: a missing license is a build-time mistake. */
export interface AssetEntry {
  /** Stable id, kebab-case, namespaced (contract §2). */
  readonly id: string;
  readonly kind: AssetKind;
  /** The Vite-resolved URL of the built asset. Never a remote URL. */
  readonly source: string;
  /** Redistribution license — one of the registered open tiers (contract §5). */
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
  /**
   * Animation name -> the frame names it plays, in order.
   *
   * The ARRAY is mutable while the RECORD is readonly. That is not sloppiness: the
   * contract's C1 requires this interface to be structurally assignable to PixiJS's
   * `SpritesheetData` with NO cast, and PixiJS types its animations as
   * `Dict<string[]>`. `readonly string[]` would force a cast at the `new
   * Spritesheet(...)` call site — trading a real, checkable property for a
   * cosmetic one. Nothing in this project ever writes to the array.
   */
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
    /** M18 · the atlas's natural tile/frame base in pixels (HD = 128). */
    readonly tilePx?: number;
    /** M18 · per-id silhouette reference, used by the shape-distinctness tests. */
    readonly silhouettes?: Readonly<Record<string, unknown>>;
  };
}

/** The one license tier this feature ships under (FR-023). */
const LICENSE = 'CC0-1.0';

/** Shorthand: a visual entry that degrades to the existing geometry. */
function visual(id: string, kind: AssetKind, source: string): AssetEntry {
  return { id, kind, source, license: LICENSE, fallback: 'graphics' };
}

/** Shorthand: an audio entry, which can only degrade to silence. */
function audio(id: string, source: string): AssetEntry {
  return { id, kind: 'audio', source, license: LICENSE, fallback: 'silent' };
}

/**
 * The whole registry, in a fixed order (the order tests and diagnostics report in).
 *
 * M18 · every world-art id now has its OWN atlas, so `AssetCatalog`'s
 * de-duplication by `source` is a no-op for them — which is exactly why the
 * per-type split was chosen: it keeps the de-duplication rule honest instead of
 * silently relying on six ids sharing one file.
 */
export const MANIFEST: Readonly<Record<string, AssetEntry>> = Object.freeze({
  'player.base': visual('player.base', 'spritesheet', playerAtlas),

  'enemy.grunt': visual('enemy.grunt', 'spritesheet', enemyGruntAtlas),
  'enemy.elite': visual('enemy.elite', 'spritesheet', enemyEliteAtlas),
  'enemy.raider': visual('enemy.raider', 'spritesheet', enemyRaiderAtlas),
  'enemy.bomber': visual('enemy.bomber', 'spritesheet', enemyBomberAtlas),
  'enemy.gunner': visual('enemy.gunner', 'spritesheet', enemyGunnerAtlas),
  'enemy.unknown': visual('enemy.unknown', 'spritesheet', enemyUnknownAtlas),

  'tile.floor': visual('tile.floor', 'spritesheet', tilesAtlas),
  'tile.wall': visual('tile.wall', 'spritesheet', tilesAtlas),

  'fx.spark': visual('fx.spark', 'spritesheet', fxAtlas),
  'fx.dash-trail': visual('fx.dash-trail', 'spritesheet', fxAtlas),
  'fx.hazard-ring': visual('fx.hazard-ring', 'spritesheet', fxAtlas),
  'fx.pickup.gold': visual('fx.pickup.gold', 'spritesheet', fxAtlas),
  'fx.pickup.heal': visual('fx.pickup.heal', 'spritesheet', fxAtlas),
  'fx.pickup.darkness': visual('fx.pickup.darkness', 'spritesheet', fxAtlas),

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

  // M19 · the material UI frames. Slots are `--ui-*` in `index.html`, injected by
  // `main.ts::applyUiSkin`; every one defaults to `none` so a degraded catalog
  // falls back to the plain-CSS surface underneath.
  'ui.frame.health': visual('ui.frame.health', 'image', uiFrameHealth),
  'ui.frame.dash': visual('ui.frame.dash', 'image', uiFrameDash),
  'ui.frame.boon-common': visual('ui.frame.boon-common', 'image', uiFrameBoonCommon),
  'ui.frame.boon-epic': visual('ui.frame.boon-epic', 'image', uiFrameBoonEpic),
  'ui.frame.boon-legendary': visual('ui.frame.boon-legendary', 'image', uiFrameBoonLegendary),
  'ui.panel.status': visual('ui.panel.status', 'image', uiPanelStatus),
  'ui.rule.bronze': visual('ui.rule.bronze', 'image', uiRuleBronze),

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
 * M18 · the association is EXPLICIT (contract §7): each id is keyed to the exact
 * atlas object it draws from. Six enemy types used to share one `enemies.json`; now
 * each has its own, so "which sheet is this id's?" can no longer be inferred from a
 * filename and must be stated.
 */
export const SHEET_DATA: Readonly<Record<string, SpriteSheetData>> = Object.freeze({
  'player.base': playerSheetJson as SpriteSheetData,

  'enemy.grunt': enemyGruntSheetJson as SpriteSheetData,
  'enemy.elite': enemyEliteSheetJson as SpriteSheetData,
  'enemy.raider': enemyRaiderSheetJson as SpriteSheetData,
  'enemy.bomber': enemyBomberSheetJson as SpriteSheetData,
  'enemy.gunner': enemyGunnerSheetJson as SpriteSheetData,
  'enemy.unknown': enemyUnknownSheetJson as SpriteSheetData,

  'tile.floor': tilesSheetJson as SpriteSheetData,
  'tile.wall': tilesSheetJson as SpriteSheetData,

  'fx.spark': fxSheetJson as SpriteSheetData,
  'fx.dash-trail': fxSheetJson as SpriteSheetData,
  'fx.hazard-ring': fxSheetJson as SpriteSheetData,
  'fx.pickup.gold': fxSheetJson as SpriteSheetData,
  'fx.pickup.heal': fxSheetJson as SpriteSheetData,
  'fx.pickup.darkness': fxSheetJson as SpriteSheetData,

  'ui.icon.gold': uiSheetJson as SpriteSheetData,
  'ui.icon.heal': uiSheetJson as SpriteSheetData,
  'ui.icon.darkness': uiSheetJson as SpriteSheetData,
});

/**
 * M18 · the ids whose textures sample `linear` with mipmaps (research.md D7).
 *
 * The GLOBAL default stays `'nearest'` — that is the M17 contract, pinned by a
 * literal in `tests/render/camera_zoom_sharpness.test.ts`, which this feature is
 * NOT allowed to touch (FR-028). HD art is not pixel art: magnified by a
 * non-integer factor `nearest` produces hard aliasing, and minified (the 30x30
 * stress room at `z = 2.88`, 128px -> 29px) it produces moire unless mipmaps exist.
 * So the override is applied PER TEXTURE, and this list is what says which.
 *
 * Membership rule: the in-run WORLD art namespaces (`player.` / `enemy.` /
 * `tile.` / `fx.`) — never `ui.` (kept pixel-crisp) or `sfx.` (not a texture).
 */
export const HD_WORLD_ART_IDS: readonly string[] = Object.freeze(
  MANIFEST_IDS.filter((id) => {
    if (MANIFEST[id]?.kind === 'audio') return false;
    return (
      id.startsWith('player.') ||
      id.startsWith('enemy.') ||
      id.startsWith('tile.') ||
      id.startsWith('fx.')
    );
  }),
);

/** True when `id` is HD world art, i.e. must be sampled `linear` + mipmapped. */
export function isHdWorldArt(id: string): boolean {
  return HD_WORLD_ART_IDS.includes(id);
}
