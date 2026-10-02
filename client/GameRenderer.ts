/**
 * GameRenderer — the read-only bridge from the headless ECS world to PixiJS.
 * See specs/09_renderer_bridge_spec.md §3.2–§4.5 and
 * specs/10_render_juice_spec.md §4 (interpolation + juice).
 *
 * The render layer is a pure CONSUMER of `World`. It never calls a mutating API
 * (`addComponent` / `removeComponent` / `destroyEntity` / `applyDamage` / …) and
 * never advances the simulation. The only thing it owns is a
 * `Map<EntityId, EntityView>` — a disposable cache that can be dropped and
 * rebuilt without affecting logic (spec 09 §10 trade-off 4).
 *
 * M5-T02 layers the "game feel" on top of the M5-T01 bridge, still strictly
 * read-only:
 *   1. Render interpolation — blend `PreviousTransformComponent` -> `Transform`
 *      by `alpha` so 60Hz logic plays back smoothly on any refresh rate (ADR-002).
 *   2. Damage floaters — a `-N` text rises and fades when an entity's HP DROPS.
 *   3. Hit flash — a frozen (hitstop) or HITSTUN entity is tinted.
 * Items 2 and 3 are OBSERVATIONS: they read component state and read the ticker's
 * real delta for their own visual lifetime; they never feed back into `src/`.
 *
 * M12-T01 adds item 0 — STATIC GEOMETRY. A room's walls carry no
 * `TransformComponent` (spec 13 §3.2), so they cannot come through the
 * transform-keyed view path at all; they get their own lazily-created layer on the
 * `stage`, holding one colour block per wall plus a floor block behind them. That
 * layer exists only while the world contains a wall, which is what keeps the
 * pre-M12 scene graph — and the frozen M5 render assertions about it — untouched.
 *
 * M12-T02 adds item 4 — THE CAMERA. Until now the room was drawn at the world
 * origin in the canvas's top-left corner, so a player who walked far enough simply
 * walked off screen (spec 19 R5). The fix is a single `Container` (`camera`) that
 * becomes the public parent of everything WORLD-SPACE — the static layer, the entity
 * views and the FX layer — and is translated every frame so the player sits at the
 * centre of the screen. That changes the top of the scene graph: `app.stage`'s only
 * child is now the CAMERA, and the render root is the camera's LAST child. The two
 * frozen contracts that matter — `fxLayer` is the render root's last child, and
 * entity views keep ascending-id order under it — are untouched, because the camera
 * simply wraps the old root without reordering its children.
 *
 * The camera is PURE PRESENTATION (spec 20 I11/I14): entity and wall views still
 * carry WORLD-pixel coordinates and the camera is the only node whose `x/y` is a
 * view transform. It never writes to `World`, and `src/` has no notion of a camera.
 * Floating damage text hangs under the FX layer, i.e. inside the camera, so its
 * world-space coordinates ride along for free. The HUD is DOM (`#hud` / `#gold`) and
 * is therefore ALREADY fixed to the screen — which is exactly why the Pixi side
 * needs no screen-space container of its own.
 *
 * M14-T01 adds item 5 — SCREEN SHAKE and HIT SPARKS — driven by this frame's
 * logic events (`FrameEvents`, drained from `ClientEventBridge` and passed as the
 * new optional third argument of `syncWorld`). Both are pure observations: the
 * shake is a decaying random offset layered on top of the camera follow (EXACTLY
 * zero at rest), and the sparks live in a lazily-mounted `VFXManager` layer that
 * exists only while a spark is alive. Neither the shake nor the particles can
 * alter the pre-M14 scene graph in the idle case, which is what keeps the frozen
 * M5/M12 render contracts intact.
 *
 * One-way dependency: this module imports `src/` (types + components) but `src/`
 * must never import it back (enforced by ESLint, spec 09 AC-01).
 *
 * M16 (specs/024-real-art-assets) replaces the placeholder geometry with real CC0
 * art, WITHOUT touching a single one of the frozen contracts above:
 *
 *  - every view keeps its `Container`, its position, its `rotation` (= the
 *    interpolated facing) and its `tint`; the ART is a child node inside it. That
 *    is why `renderer_bridge.test.ts`'s `playerView.rotation === 0.75` and
 *    `juice-verify.test.ts`'s near-`PI` rotation assertions still hold verbatim.
 *  - the sprite child is counter-rotated by `-facing`, because the container's
 *    rotation is a FROZEN contract and a top-down sprite must not spin with it.
 *  - the static layer keeps its node and its position; only its CONTENTS change
 *    (colour blocks -> tile sprites), so F1–F6 and `camera_follow`'s
 *    `staticLayer.children[1].x === wall.x * PX_PER_UNIT` are untouched.
 *  - every sprite branch has the pre-M16 geometry branch as its `else`, which is
 *    what FR-013's "graceful degradation" actually means in code.
 */

import { AnimatedSprite, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Application, Rectangle, Texture, Ticker } from 'pixi.js';

import type { EntityId } from '../src/ecs/Entity';
import type { World } from '../src/ecs/World';
import { TransformComponent } from '../src/ecs/components/TransformComponent';
import { PreviousTransformComponent } from '../src/ecs/components/PreviousTransformComponent';
import { HitboxComponent } from '../src/ecs/components/HitboxComponent';
import { HurtboxComponent } from '../src/ecs/components/HurtboxComponent';
import { Faction, FactionComponent } from '../src/ecs/components/FactionComponent';
import { HealthComponent } from '../src/ecs/components/HealthComponent';
import { ActionState, StateComponent } from '../src/ecs/components/StateComponent';
import { isFrozen } from '../src/ecs/components/FreezeComponent';
import { isDead } from '../src/ecs/components/DeadTagComponent';
import { HazardComponent } from '../src/ecs/components/HazardComponent';
import { PickupComponent, PickupKind } from '../src/ecs/components/PickupComponent';
import { WallComponent } from '../src/ecs/components/WallComponent';

import type { FrameEvents } from './ClientEventBridge';
import { VFXManager } from './VFXManager';
import { NULL_SPRITE_PROVIDER } from './assets/AssetCatalog';
import type { SpriteProvider } from './assets/AssetCatalog';
import {
  FLOOR_TILE_ID,
  HAZARD_RING_FX_ID,
  PLAYER_SPRITE_ID,
  WALL_TILE_ID,
  animationCandidates,
  animationFromState,
  facingFromRadians,
  hurtboxSpriteScale,
  pickupIconId,
  selectSprite,
} from './assets/sprite-map';
import type { AnimationState, Facing4 } from './assets/sprite-map';

/**
 * The render layer's ONE constant contract: world units -> pixels (spec 09 C8).
 * The logic layer has no concept of pixels; this number lives only here.
 */
export const PX_PER_UNIT = 10;

/**
 * How much of the remaining distance the camera closes each frame (M12-T02, spec 20
 * §3.4).
 *
 * The camera does not snap to the player; it eases towards the target with a first
 * order lerp. `0.2` closes ~50% of the gap in ~3 frames and ~99% in ~20 frames at
 * 60fps — fast enough to read as "following", slow enough that the world has a
 * sense of weight rather than being welded to the player's exact position. Exported
 * so the behaviour is a named contract a test can pin rather than a magic number
 * buried in `syncCamera`.
 */
export const CAMERA_LERP_FACTOR = 0.2;

/** Radius (world units) of the player placeholder circle. */
const PLAYER_RADIUS = 0.5;

/** Length (world units) of the player's facing indicator; MUST be >= PLAYER_RADIUS. */
const PLAYER_FACING_LENGTH = 1;

/** Death FX duration in real milliseconds (linear fade + shrink). */
const DEATH_FADE_MS = 400;

/** Fraction of scale removed by the end of the death FX (0.6 => shrinks to 40%). */
const DEATH_SHRINK = 0.6;

/** How long a damage floater lives (real ms) before it fades out and is destroyed. */
const FLOATING_TEXT_LIFETIME_MS = 1000;

/** Vertical gap (px) between the entity's render origin and the floater's start. */
const FLOATING_TEXT_OFFSET_PX = 22;

/** Total upward travel (px) of a floater over its whole lifetime. */
const FLOATING_TEXT_RISE_PX = 28;

/**
 * Screen-shake duration (real ms) after a landed hit (M14-T01, spec 22 §3.4).
 *
 * A short, punchy window: long enough to read as impact, short enough that it
 * decays fully back to zero before the camera-convergence assertions can ever
 * observe it (spec 20 AC-03). While no hit is active the shake offset is EXACTLY
 * `0`, so the follow lerp is bit-for-bit the pre-M14 behaviour.
 */
const SHAKE_DURATION_MS = 180;

/** Peak screen-shake offset (px) at the instant of impact; decays linearly to 0. */
const SHAKE_INTENSITY = 6;

const PLAYER_COLOR = 0x4da3ff;
const ENEMY_COLOR = 0xff4d4d;
const HITBOX_PLAYER_COLOR = 0xffe14d;
const HITBOX_ENEMY_COLOR = 0xff4d4d;
const HITBOX_ALPHA = 0.35;
const HURTBOX_STROKE_ALPHA = 0.35;

/**
 * Hazard telegraph colour (M8-T01). A saturated warning red, deliberately the
 * same hue family as the enemy body so "this is hostile ground" reads instantly,
 * but drawn as a translucent FILL so the player can still see what is standing
 * inside it.
 */
const HAZARD_COLOR = 0xff2d2d;

/**
 * Pickup colours (M9-T01, extended by M13-T01). Deliberately NOT in the hazard red
 * family: loot is the one thing on the ground the player is supposed to run
 * TOWARDS, so it must never be confusable with the one thing they are supposed to
 * run away from.
 *
 * Three kinds, three colours, because they are three different promises: gold is
 * spendable now, a flask is survival now, and a darkness gem (M13-T01) is the only
 * one that outlives the run — so it gets its own hue rather than borrowing gold's.
 */
const GOLD_PICKUP_COLOR = 0xffd24d;
const HEAL_PICKUP_COLOR = 0x4dff88;
const DARKNESS_PICKUP_COLOR = 0xb07dff;

/** Pickup fill alpha. Solid enough to read at a glance, light enough to look like an item. */
const PICKUP_FILL_ALPHA = 0.95;

/** Pickup ring stroke width (px) — a thin outline so the coin reads against any background. */
const PICKUP_RING_WIDTH = 1;

/** Fill alpha of a hazard's warning circle at the START of its fuse. */
const HAZARD_FILL_ALPHA_MIN = 0.08;

/** Fill alpha of a hazard's warning circle at the moment of detonation. */
const HAZARD_FILL_ALPHA_MAX = 0.5;

/** Ring stroke alpha at the start of the fuse. */
const HAZARD_RING_ALPHA_MIN = 0.4;

/** Ring stroke alpha at the moment of detonation. */
const HAZARD_RING_ALPHA_MAX = 1;

/**
 * Scale of a hazard's warning circle at the START of its fuse, as a fraction of
 * the true blast radius. The circle grows to `1.0` as the fuse burns down, so the
 * warning reads as "closing in" rather than as a static decal.
 */
const HAZARD_SCALE_MIN = 0.82;

/** Fixed ring line width (px). The animation is alpha + scale, not stroke growth. */
const HAZARD_RING_WIDTH = 2;

/** No tint — the neutral resting value (PixiJS multiplies by white = identity). */
const NO_TINT = 0xffffff;

/**
 * Hit-flash tint. PixiJS `tint` MULTIPLIES the fill, so it can only darken /
 * shift hue — it cannot brighten. Pure red is therefore the strongest, most
 * legible flash on both the blue player circle and the red enemy square.
 */
const HIT_FLASH_TINT = 0xff0000;

/**
 * Static-geometry colours (M12-T01, spec 19 AC-08).
 *
 * Deliberately muted and LOW-CONTRAST: the floor and the walls are the room's
 * BACKGROUND, and the one thing on screen that must stay loudest is the hazard
 * telegraph's saturated warning red. A floor that competed with it would make the
 * room's shape readable at the cost of the room's danger being readable.
 */
const FLOOR_COLOR = 0x232733;
const WALL_COLOR = 0x4a5266;

const TWO_PI = Math.PI * 2;

/**
 * The natural pixel size of every sprite in the atlas (M16).
 *
 * One world unit is `PX_PER_UNIT` pixels and every source tile is 16x16, so a
 * scene tile draws at `PX_PER_UNIT / TILE_NATURAL_PX` and a body draws at whatever
 * its hurtbox says. Keeping the number here — rather than in `sprite-map` — is the
 * same discipline `PX_PER_UNIT` follows: pixels are the renderer's business.
 */
const TILE_NATURAL_PX = 16;

/**
 * Real milliseconds per animation frame, by action (M16).
 *
 * Driven by the ticker's `deltaMS`, exactly like the floaters, the shake and the
 * death fade — this is a VISUAL clock and must never be derived from logic ticks
 * (ADR-002, spec 22 §3.4). Longer actions read as heavier: a dash snaps, an idle
 * breathes.
 */
const ANIM_FRAME_MS: Readonly<Record<AnimationState, number>> = {
  idle: 260,
  move: 130,
  dash: 90,
  attack: 110,
  hit: 120,
  death: 150,
};

/** Scene-tile tint applied to the wall sprite so walls read darker than the floor. */
const WALL_TILE_TINT = 0x9aa4b8;

/**
 * Signed shortest-arc delta from `from` to `to`, normalised to [-PI, PI].
 *
 * The interval is closed on BOTH ends: `-PI` and `+PI` denote the same heading
 * (they differ by 2*PI), so returning either is correct and the closed ends do
 * not affect correctness.
 *
 * A naive `to - from` blend across the +/-PI seam would rotate the long way round
 * (e.g. from 3.0 rad to -3.0 rad would sweep 6 rad through PI instead of the
 * 0.28 rad across the seam). See specs/10 §10 trade-off 1.
 */
function shortestArcDelta(from: number, to: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  else if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

/** View classification, decided by component presence (spec 09 §4.3). */
export type ViewKind = 'pickup' | 'hazard' | 'hitbox' | 'player' | 'enemy';

/** One entity's presentation object, plus the state its lifecycle needs. */
export interface EntityView {
  readonly container: Container;
  readonly kind: ViewKind;
  /** True once a `DeadTagComponent` has been observed (spec 09 §4.4). */
  isDying: boolean;
  /** Real elapsed milliseconds since the death FX started. */
  deathElapsedMs: number;
  /**
   * HP observed on the PREVIOUS sync, used to detect a downward step and spawn a
   * damage floater (spec 10 AC-02). Seeded from the live HP at view creation so
   * the first sync never reports a phantom hit. `undefined` for entities without
   * a `HealthComponent` (e.g. hitboxes).
   */
  lastHp: number | undefined;
  /**
   * Hazard-only: the two animated layers of the warning (M8-T01). Present exactly
   * when `kind === 'hazard'`. Held by reference so the per-frame animation sets
   * their alphas directly instead of reaching into `container.children` by index —
   * the warning's layers are a structural fact, not a positional one.
   *
   * M16: when the atlas is available the ring is a `Sprite` instead of a `Graphics`,
   * so the type is the union. Both expose `.alpha`, which is all `syncHazards`
   * writes.
   */
  hazard?: {
    readonly fill: Graphics;
    readonly ring: Graphics | Sprite;
  };
  /**
   * M16 · the animated body sprite, or `null` when this view fell back to the
   * pre-M16 geometry. Its presence is the single source of truth for "is this view
   * art or placeholder", so no other field has to be kept in step with it.
   */
  sprite: AnimatedSprite | null;
  /**
   * M16 · the animation key currently assigned to {@link sprite} (`null` for a
   * geometry view). Re-assigning `AnimatedSprite.textures` RESTARTS the clip, so
   * the assignment is guarded by "did the key change" — otherwise a walking enemy
   * would be frozen on frame 0 forever.
   */
  animKey: string | null;
  /**
   * M16 · the ACTION the current clip belongs to. Kept beside {@link animKey}
   * rather than parsed back out of it, because a sprite id contains dots
   * (`player.base.idle.down`) and re-splitting that string in the hot path would be
   * both slower and one rename away from being wrong.
   */
  animAction: AnimationState;
  /** M16 · real elapsed milliseconds inside the current animation. */
  animElapsedMs: number;
  /**
   * M16 · the sprite id this view draws, resolved ONCE at creation.
   *
   * An entity's faction and capability components are fixed for its whole life
   * (data-model E3), so re-deriving the id every frame would be component lookups
   * for a value that cannot move — and that cost is measured: see
   * `tests/performance/render_art_cost.test.ts` (T045/SC-006).
   */
  spriteId: string | null;
  /**
   * M16 · the three inputs the animation choice actually depends on, cached so the
   * per-frame path is three comparisons instead of a re-selection. `null` means
   * "never selected yet".
   */
  animState: ActionState | null;
  animDead: boolean;
  animFacing: Facing4 | null;
  /**
   * M16 · the current clip's milliseconds-per-frame and frame count, cached when the
   * clip is assigned.
   *
   * Both are otherwise re-derived EVERY frame per entity — a string-keyed record
   * lookup and a `totalFrames` getter — and at ~180 entities that alone was ~2% of
   * the per-frame budget. They are clip properties, so caching them cannot drift.
   */
  animFrameMs: number;
  animTotal: number;
  /**
   * M16 · the raw container rotation the cached `animFacing` was derived from.
   * `NaN` initially, which never compares equal to anything — so the first frame
   * always recomputes. A CONSTANT facing (an enemy standing still, which is most of
   * a stress room) then costs one float compare instead of a quantiser call.
   */
  animRot: number;
}

/** A live damage floater: a PixiJS `Text` plus the bookkeeping its lifetime needs. */
interface FloatingText {
  readonly node: Text;
  elapsedMs: number;
  readonly startY: number;
}

export class GameRenderer {
  private readonly app: Application;

  /**
   * The camera (M12-T02). The public parent of everything WORLD-SPACE — the static
   * layer, the render root (and therefore every entity view and the FX layer) — and
   * the ONE node whose `x/y` is a view transform. It is translated every frame by
   * `syncCamera` so the player sits at the centre of the screen.
   *
   * It is a plain `Container` rather than a PixiJS `Camera`/`Viewport` because all
   * this milestone needs is a translation: no zoom, no rotation, no bounds. Making it
   * a container keeps the change to the scene graph minimal — the camera simply wraps
   * the existing root instead of re-parenting its children — which is what keeps the
   * frozen M5 child-index contracts intact (see the class docstring).
   *
   * Held under `cameraContainer` rather than `camera` because `camera` is the name of
   * the public getter below; TypeScript forbids a field and an accessor sharing a
   * name, and the getter is the shape the tests and diagnostics want.
   */
  private readonly cameraContainer = new Container();

  private readonly root = new Container();
  private readonly views = new Map<EntityId, EntityView>();

  /**
   * Dedicated UI layer for transient FX (damage floaters). It is a child of the
   * render root, added once in `init()` and kept as the TOPMOST child so FX draw
   * over the entity placeholders. See `createMissingViews` for how entity views
   * are inserted beneath it.
   */
  private readonly fxLayer = new Container();

  /** Live damage floaters, oldest-first. Pruned in `advanceFloatingTexts`. */
  private readonly floatingTexts: FloatingText[] = [];

  /**
   * The static-geometry layer (M12-T01): one colour block per `WallComponent`, plus
   * a floor block behind them.
   *
   * WHY IT IS ATTACHED TO THE `stage` AND NOT TO `root`
   * --------------------------------------------------
   * Walls carry NO `TransformComponent` (spec 13 §3.2) — they are geometry, not
   * movers — so they can never come through `createMissingViews`, which is keyed on
   * `query(TransformComponent)`. They therefore need their own layer, and the only
   * question is where it hangs.
   *
   * Hanging it under `root` would shift every index the M5 render suites depend on:
   * `root.children[0]` must be the first ENTITY view and
   * `root.children[root.children.length - 1]` must be the FX layer (spec 09 §4.3).
   * Hanging it on the stage at index 0 leaves `root` and its children completely
   * untouched and still draws below every entity, because the stage renders its
   * children in order.
   *
   * `null` until the world contains at least one wall, and torn back down to `null`
   * when it contains none. That laziness is what makes the whole feature
   * non-invasive: a world with no walls — every pre-M12 rig, and every frozen M5
   * render test — sees a scene graph byte-for-byte identical to before, including
   * `app.stage.children[0] === root`.
   */
  private staticLayer: Container | null = null;

  /**
   * The floor node. Child 0 of {@link staticLayer}. Since M16 it is a `Container`
   * holding one tile sprite per floor cell (or, when the atlas is unavailable, a
   * single flat `Graphics` rectangle) and is rebuilt only when the extent moves.
   */
  private floorNode: Container | null = null;

  /** One node per wall entity. Dropped when a wall is destroyed. */
  private readonly wallViews = new Map<EntityId, Container>();

  /**
   * Signature of the last drawn floor extent (`minX,minY,maxX,maxY,count`).
   *
   * The floor is a function of the WALL SET, and the wall set only changes at a room
   * boundary — so redrawing the block every frame would be pure churn on a scene
   * graph that is static by definition. Comparing a short string is the cheapest way
   * to say "the geometry changed" without keeping a second copy of the geometry.
   */
  private floorSignature = '';

  /**
   * Ids whose death FX has ALREADY finished. Such an id must never be re-viewed.
   *
   * This exists because a corpse is never destroyed (spec 08 §4.4 / §10 trade-off
   * 1): it stays `world.isAlive` and keeps its `TransformComponent`, so
   * `createMissingViews` would otherwise rebuild the view the very next frame and
   * the death FX would loop forever. Retiring the id is the only way to make the
   * "dead square disappears" acceptance criterion hold.
   *
   * SAFE AS A PLAIN `Set` because `EntityId` is a monotonically increasing integer
   * handed out by `World.createEntity` (`World.nextId`) and NEVER reused — so an id
   * in this set can never legitimately need a view again. If ids were ever
   * recycled, this set would hide a live entity and would have to be revisited.
   *
   * Only the death-FX path retires. The `recycleDestroyed` path (entity actually
   * `destroyEntity`'d, e.g. an expired hitbox) must NOT retire: that path is
   * self-correcting, since a destroyed entity no longer appears in `query`.
   */
  private readonly retired = new Set<EntityId>();

  /**
   * Remaining screen-shake time (real ms) and its peak intensity (px) (M14-T01).
   * Both are ZERO at rest, so `shakeIntensityAt()` returns exactly `0` and the
   * camera is untouched by shake in the idle case (spec 22 §3.4) — which is what
   * keeps the frozen camera-convergence assertions exact.
   */
  private shakeTimeMs = 0;
  private shakeIntensity = 0;

  /**
   * The transient particle pool (M14-T01). Its layer is mounted into the CAMERA
   * subtree LAZILY — only while sparks are alive — so an idle scene graph is
   * byte-for-byte the pre-M14 one (spec 20 I13, spec 22 §4.3). `VFXManager`
   * depends only on `pixi.js`, so it is safe to import here (spec 22 §2.5).
   */
  private readonly vfx: VFXManager;

  /** True while {@link vfx}'s layer is parented to the camera. */
  private vfxAttached = false;

  /**
   * The loaded art (M16). Defaults to {@link NULL_SPRITE_PROVIDER}, whose every
   * lookup misses — so a renderer built without a catalog behaves EXACTLY like the
   * pre-M16 one (geometry everywhere). That default is what lets the frozen render
   * suites keep calling `new GameRenderer(app)` and stay green unchanged.
   */
  private readonly art: SpriteProvider;

  constructor(app: Application, art: SpriteProvider = NULL_SPRITE_PROVIDER) {
    this.app = app;
    this.art = art;
    // The particle layer takes the SAME art source, so a degraded atlas degrades
    // the sparks with everything else instead of half the screen.
    this.vfx = new VFXManager(art);
  }

  /**
   * The app's ticker, exposed so `GameLoop` can drive itself without holding the
   * `Application`. Keeps `GameLoop`'s constructor signature (sim, renderer, input).
   */
  public get ticker(): Ticker {
    return this.app.ticker;
  }

  /** Live view count (diagnostics / HUD). */
  public get viewCount(): number {
    return this.views.size;
  }

  /**
   * The camera container (M12-T02). Exposed so a test (or a diagnostic overlay) can
   * read where the world is being drawn relative to the screen without reaching into
   * a private field. The render root is always its LAST child; the static-geometry
   * layer, when it exists, is always its child at index 0.
   */
  public get camera(): Container {
    return this.cameraContainer;
  }

  /** Live static-geometry block count (diagnostics / HUD). Zero when there are no walls. */
  public get wallViewCount(): number {
    return this.wallViews.size;
  }

  /**
   * Live hit-spark count (diagnostics / assertions). Zero at rest (M14-T01).
   */
  public get sparkCount(): number {
    return this.vfx.particleCount;
  }

  /**
   * How many ids the render layer has RETIRED (M15-T01).
   *
   * `retired` is the one piece of renderer state that is deliberately NEVER pruned
   * during a run (see the field's own docstring): a corpse is never destroyed, so
   * "this id's death FX already played" must be remembered or the FX would loop.
   * Ids are never reused, so the set only ever grows — which makes it the renderer's
   * ONE unbounded structure, and therefore the thing a leak guard has to be able to
   * SEE. Exposed as a count rather than as the set itself so a caller can assert on
   * its size without being able to mutate it (spec 09 §10 trade-off 4).
   *
   * `GameRenderer.reset()` clears it, and the run boundary in `client/main.ts` calls
   * `reset()` for exactly this reason — see the note there.
   */
  public get retiredCount(): number {
    return this.retired.size;
  }

  /**
   * Remaining screen-shake time in real milliseconds (diagnostics / assertions).
   * Exactly `0` at rest — which is the observable form of "no hit => no shake"
   * (M14-T01, spec 22 §3.4).
   */
  public get shakeTimeRemainingMs(): number {
    return this.shakeTimeMs;
  }

  /** Attach the camera (and, under it, the render root and its FX layer) to the
   * stage. Call once, after `app.init`. */
  public init(): void {
    // M12-T02: the camera becomes the stage's single child and the render root
    // becomes the camera's child. Wrapping the root — rather than re-parenting its
    // children under a new node — leaves the root's own child order, and therefore
    // every frozen M5 index contract, exactly as it was.
    this.app.stage.addChild(this.cameraContainer);
    this.cameraContainer.addChild(this.root);
    // fxLayer is added FIRST and stays the last child of the root: entity views are
    // always inserted just below it (see `createMissingViews`), so FX render on top
    // while the frozen M5-T01 child-index contract (root.children[0] = first entity
    // view) still holds.
    this.root.addChild(this.fxLayer);
  }

  /**
   * Sync one frame of the logic world into the scene graph. Steps, in order:
   * draw the room's static geometry, create missing views, sync transforms
   * (interpolated by `alpha` + hit flash), move the camera, age existing damage
   * floaters, spawn new ones, advance death FX, recycle destroyed views.
   *
   * `alpha` is the interpolation factor in [0, 1]: 0 draws the previous tick, 1
   * draws the current tick. It is clamped here so a caller cannot extrapolate.
   *
   * `alpha` DEFAULTS TO 1 on purpose: with `alpha = 1` the projection is
   * `renderX = currX`, bit-for-bit identical to the M5-T01 behaviour, so the
   * frozen `tests/render/renderer_bridge.test.ts` (which calls `syncWorld(world)`
   * with one argument) keeps passing unchanged. The live loop always passes the
   * real blend factor from `GameLoop` (spec 10 §10 trade-off 2).
   *
   * Real frame time for the visual FX is read from the app ticker: it is a VISUAL
   * concern and must not feed back into the simulation (spec 09 §3.6).
   *
   * M14-T01 adds a THIRD, OPTIONAL parameter: this frame's logic events
   * (`FrameEvents`, drained from `ClientEventBridge`). It drives the screen shake
   * and the hit/dash sparks. It is ADDITIVE and defaults to `undefined`, so the
   * frozen `syncWorld(world)` / `syncWorld(world, alpha)` call shapes keep
   * type-checking and behaving EXACTLY as before (spec 22 §4.3). The parameter
   * carries facts the engine already published — the renderer still writes
   * nothing back to `World`.
   */
  public syncWorld(world: World, alpha = 1, frameEvents?: FrameEvents): void {
    const clampedAlpha = Math.min(1, Math.max(0, alpha));
    const deltaMs = this.app.ticker.deltaMS;
    // M12-T01: the room's geometry is drawn FIRST so it lands behind everything —
    // both inside the static layer (floor before walls) and on the stage (the layer
    // sits at index 0, below the render root).
    this.syncStaticGeometry(world);
    this.createMissingViews(world);
    // M16: the transform pass ALSO advances the art clips, on the REAL frame clock
    // (never on logic ticks). Fusing the two saves a second walk of the view map
    // every frame, which is what keeps the art swap inside SC-006's 1.2x budget.
    this.syncTransforms(world, clampedAlpha, deltaMs);
    // M14-T01: age + spawn transient FX and (re)trigger the screen shake BEFORE the
    // camera is moved, so a hit landing this frame shakes the camera THIS frame.
    this.syncEffects(deltaMs, frameEvents);
    // M12-T02: the camera is moved AFTER the transforms are projected, so it tracks
    // the INTERPOLATED player position (what the player actually sees) rather than
    // the raw logic coordinate (which would be half a frame ahead).
    this.syncCamera(world);
    // M8-T01: hazard warnings are animated from their own countdown, so they are
    // synced here rather than inside `syncTransforms` (which is about position).
    this.syncHazards(world);
    // Age the floaters that already exist BEFORE spawning this frame's, so a fresh
    // floater starts at full alpha instead of losing a frame of life immediately.
    this.advanceFloatingTexts(deltaMs);
    this.detectDamage(world);
    this.advanceDeaths(deltaMs);
    this.recycleDestroyed(world);
  }

  /** Tear down every view, every floater and the camera (with the render root). */
  public destroy(): void {
    for (const view of this.views.values()) {
      view.container.destroy({ children: true });
    }
    this.views.clear();
    this.retired.clear();
    this.floatingTexts.length = 0;
    // M12-T01: the static layer lives on the CAMERA (not under `root`), so destroying
    // `root` does not reach it — it has to be torn down explicitly or its blocks
    // would outlive the renderer.
    this.teardownStaticLayer();
    // M14-T01: the particle layer may be parented to the camera. Destroy it FIRST
    // (which detaches it) so the camera's recursive destroy below cannot double-free
    // it.
    this.vfx.destroy();
    this.vfxAttached = false;
    // M12-T02: the camera is now the thing attached to the stage, so IT is what has
    // to be destroyed. `{ children: true }` reaches the render root, its entity
    // views, and the FX layer (with any floater still parented to it) in one pass.
    this.cameraContainer.destroy({ children: true });
  }

  /**
   * Drop every cached view, every live floater and the retired-id set, WITHOUT
   * tearing down the render root or the PixiJS application (M10-T02).
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT `destroy()`
   * ---------------------------------------------
   * `destroy()` is a teardown: it destroys the root, so the renderer is finished
   * and `init()` would have to run again. A dev-mode data hot reload needs the
   * opposite — the loop keeps running, the `Application` keeps its canvas, and the
   * ONLY thing that must go is the presentation state that belonged to the run
   * being thrown away. Rebuilding the app would also mean re-mounting the canvas,
   * which is a visible flash rather than a reload.
   *
   * WHY A RESET IS NEEDED AT ALL, GIVEN `restartRun` DESTROYS EVERY ENTITY
   * ---------------------------------------------------------------------
   * Entity views clean themselves up (a destroyed entity leaves `query`, so
   * `recycleDestroyed` recycles its view on the next sync), but two kinds of state
   * do NOT:
   *
   *  - **Damage floaters.** They live for `FLOATING_TEXT_LIFETIME_MS` of REAL time
   *    and are driven by the ticker, not by the world. A `-40` left over from the
   *    previous run would keep rising over the new one for up to a second — the
   *    "重影" a hot reload must not show.
   *  - **The retired-id set.** It is deliberately never pruned (see `retired`), so
   *    it would accumulate across every reload. Ids are never reused, so clearing
   *    it cannot resurrect a corpse — and NOT clearing it would be a slow leak.
   *
   * Call it at a RUN BOUNDARY, immediately after `GameSimulator.restartRun`:
   * clearing `retired` while corpses of the CURRENT run are still in the world
   * would let their views be rebuilt, which is the one thing the set prevents.
   * The next `syncWorld` then rebuilds the scene from the fresh run.
   */
  public reset(): void {
    for (const view of this.views.values()) {
      view.container.destroy({ children: true });
    }
    this.views.clear();

    for (const entry of this.floatingTexts) {
      entry.node.destroy();
    }
    this.floatingTexts.length = 0;

    // Defensive sweep: anything still parented to the FX layer that is not a
    // tracked floater would otherwise survive the reset and ghost over the new run.
    // There is nothing like that today — `spawnFloatingText` is the only writer —
    // but a future FX that forgets to register itself would fail silently.
    this.fxLayer.removeChildren().forEach((child) => {
      child.destroy();
    });

    // Safe at a run boundary: ids are never reused (`World.nextId` is never
    // reset), so every id in the set belongs to the run that just ended.
    this.retired.clear();

    // M12-T02: the camera belongs to the run being thrown away. Zeroing it here —
    // rather than letting the next sync ease towards the new player from wherever the
    // old one left the camera — keeps `reset()` a complete "forget the previous run"
    // operation, and avoids a visible pan across the new room on the first frame.
    this.cameraContainer.x = 0;
    this.cameraContainer.y = 0;

    // M14-T01: the shake and the sparks also belong to the run being thrown away.
    // Dropping them here (and unmounting the now-empty layer) keeps `reset()` a
    // complete "forget the previous run" operation, the same discipline the floaters
    // and the static layer follow.
    this.shakeTimeMs = 0;
    this.shakeIntensity = 0;
    this.vfx.clear();
    this.syncVfxLayer();

    // M12-T01: the room's geometry belongs to the run being thrown away. Dropping
    // the blocks here (rather than waiting for the next sync to notice the walls are
    // gone) keeps `reset()` a complete "forget the previous run" operation, which is
    // what the hot-reload path relies on.
    this.teardownStaticLayer();
  }

  /**
   * Step ⓪ — draw the room's static geometry (M12-T01, spec 19 AC-08).
   *
   * One colour block per `WallComponent`, plus a floor block spanning their bounding
   * box. That is deliberately ALL it is: the milestone asks for "极简的地板和墙体色块
   * 绘制，以便能在浏览器中直观看到房间形状", and the room's SHAPE is exactly what a
   * wall-per-tile rendering conveys. There is no camera, no tile atlas and no
   * auto-tiling (spec 19 §1.3), so the room is drawn at the world origin in the
   * canvas's top-left corner.
   *
   * Pure reads: `WallComponent` is read and nothing is written back to `World`
   * (spec 09 AC-01). The blocks are cached per entity id and only rebuilt when a wall
   * APPEARS, because a wall's AABB can never change — a room transition destroys the
   * old walls and creates new ones, which is precisely the "appears / disappears"
   * event this cache keys on.
   *
   * An empty wall set tears the whole layer down (see `staticLayer`), so a world with
   * no geometry is byte-for-byte the pre-M12 scene graph.
   */
  private syncStaticGeometry(world: World): void {
    const wallIds = world.query(WallComponent);
    if (wallIds.length === 0) {
      this.teardownStaticLayer();
      return;
    }

    const layer = this.ensureStaticLayer();

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const id of wallIds) {
      const wall = world.getComponent(id, WallComponent);
      if (wall === undefined) continue;

      minX = Math.min(minX, wall.x);
      minY = Math.min(minY, wall.y);
      maxX = Math.max(maxX, wall.x + wall.width);
      maxY = Math.max(maxY, wall.y + wall.height);

      if (this.wallViews.has(id)) continue;
      const node = this.buildWallNode(wall);
      this.wallViews.set(id, node);
      layer.addChild(node);
    }

    this.recycleWallViews(wallIds);
    this.syncFloor(layer, minX, minY, maxX, maxY, this.wallViews.size);
  }

  /**
   * M16 · one wall entity's node.
   *
   * The node is POSITIONED at the wall's world pixel origin and its children are
   * drawn relative to that — rather than drawing each block at absolute
   * coordinates with the node at the origin. That is not cosmetic: the frozen
   * `camera_follow` assertion `staticLayer.children[1].x === wall.x * PX_PER_UNIT`
   * only held before because the first wall of `start_room` happens to sit at the
   * origin; positioning the node makes it true for ANY room.
   *
   * A wall AABB can be wider or taller than one world unit (the loader meshes runs
   * of tiles), so the art is TILED across the AABB rather than stretched — FR-009's
   * "no stretching" applies to walls exactly as it does to the floor.
   */
  private buildWallNode(wall: WallComponent): Container {
    const node = new Container();
    node.x = wall.x * PX_PER_UNIT;
    node.y = wall.y * PX_PER_UNIT;

    const texture = this.tileTexture(WALL_TILE_ID);
    if (texture === undefined) {
      const block = new Graphics();
      block
        .rect(0, 0, wall.width * PX_PER_UNIT, wall.height * PX_PER_UNIT)
        .fill({ color: WALL_COLOR });
      node.addChild(block);
      return node;
    }

    const cols = Math.max(1, Math.round(wall.width));
    const rows = Math.max(1, Math.round(wall.height));
    const scale = PX_PER_UNIT / TILE_NATURAL_PX;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const tile = new Sprite(texture);
        tile.scale.set(scale);
        tile.x = col * PX_PER_UNIT;
        tile.y = row * PX_PER_UNIT;
        // Slight darkening keeps the wall legible against the floor without
        // competing with the hazard telegraph (spec 19 AC-08's colour rule).
        tile.tint = WALL_TILE_TINT;
        node.addChild(tile);
      }
    }
    return node;
  }

  /** Create the static layer on demand and put it BEHIND the render root. */
  private ensureStaticLayer(): Container {
    const existing = this.staticLayer;
    if (existing !== null) return existing;

    const layer = new Container();
    const floor = new Container();
    layer.addChild(floor);
    // Index 0 on the CAMERA: below the render root (which is appended by `init`), so
    // the floor and walls can never cover an entity or an FX. `addChildAt` on an
    // empty camera is a plain append, so this is also correct if a caller syncs
    // before `init()`. M12-T02 moved the layer from the stage to the camera so the
    // room's geometry travels with the world instead of staying pinned to the
    // canvas origin.
    this.cameraContainer.addChildAt(layer, 0);
    this.staticLayer = layer;
    this.floorNode = floor;
    return layer;
  }

  /**
   * Lay the floor across the wall bounding box, but only when the extent actually
   * changed (see `floorSignature`).
   *
   * The bounding box — rather than the union of the walkable tiles — is the honest
   * simplification here: a room's walls form its outline, so their bounding box IS
   * the room's footprint, and the wall nodes drawn on top of it leave exactly the
   * interior visible. A non-rectangular room therefore over-fills its corners, which
   * is invisible in a bordered room and is registered as a known simplification
   * (spec 19 §4.5).
   *
   * M16 tiles that area with `tile.floor` sprites instead of one flat rectangle, so
   * the floor reads as a MATERIAL. The rebuild is signature-guarded, so a 30x30 room
   * pays for ~900 sprites once per room transition — never per frame.
   */
  private syncFloor(
    layer: Container,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    wallCount: number,
  ): void {
    const signature = `${String(minX)},${String(minY)},${String(maxX)},${String(maxY)},${String(wallCount)}`;
    if (signature === this.floorSignature) return;
    this.floorSignature = signature;

    const floor = this.floorNode;
    if (floor === null) return;
    floor.removeChildren().forEach((child) => {
      child.destroy();
    });
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

    const texture = this.tileTexture(FLOOR_TILE_ID);
    if (texture === undefined) {
      const block = new Graphics();
      block
        .rect(
          minX * PX_PER_UNIT,
          minY * PX_PER_UNIT,
          (maxX - minX) * PX_PER_UNIT,
          (maxY - minY) * PX_PER_UNIT,
        )
        .fill({ color: FLOOR_COLOR });
      floor.addChild(block);
    } else {
      const cols = Math.max(1, Math.ceil(maxX - minX));
      const rows = Math.max(1, Math.ceil(maxY - minY));
      const scale = PX_PER_UNIT / TILE_NATURAL_PX;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const tile = new Sprite(texture);
          tile.scale.set(scale);
          tile.x = (minX + col) * PX_PER_UNIT;
          tile.y = (minY + row) * PX_PER_UNIT;
          floor.addChild(tile);
        }
      }
    }
    // Re-assert child order: the floor must stay behind the wall blocks.
    layer.setChildIndex(floor, 0);
  }

  /**
   * M16 · the texture for a scene tile id.
   *
   * Prefers the single-frame animation NAMED after the id (`tile.floor`), because
   * the tiles atlas holds two unrelated tiles — falling back to "the sheet's first
   * frame" would silently paint every wall with the floor texture. The `texture()`
   * lookup is the second chance, for an `image` entry.
   */
  private tileTexture(id: string): Texture | undefined {
    const frames = this.art.animation(id);
    if (frames !== undefined && frames[0] !== undefined) return frames[0];
    return this.art.texture(id);
  }

  /** Drop nodes whose wall is gone (a destroyed wall leaves `query`). */
  private recycleWallViews(liveIds: readonly EntityId[]): void {
    const live = new Set<EntityId>(liveIds);
    for (const [id, node] of this.wallViews) {
      if (live.has(id)) continue;
      this.wallViews.delete(id);
      node.destroy({ children: true });
    }
  }

  /** Destroy the static layer and forget its nodes. A no-op when there is none. */
  private teardownStaticLayer(): void {
    const layer = this.staticLayer;
    if (layer === null) return;
    this.wallViews.clear();
    this.floorNode = null;
    this.floorSignature = '';
    this.staticLayer = null;
    // Recursively destroys the floor and every wall node parented to the layer.
    layer.destroy({ children: true });
  }

  /**
   * Step ① — build a view for every entity that has a `TransformComponent`, EXCEPT
   * ids whose death FX already finished (see `retired`).
   */
  private createMissingViews(world: World): void {
    for (const id of world.query(TransformComponent)) {
      if (this.views.has(id)) continue;
      // A corpse that already played its death FX must stay gone (spec 09 §4.4).
      if (this.retired.has(id)) continue;
      const view = this.createView(world, id);
      if (view === undefined) continue;
      this.views.set(id, view);
      // Insert just BELOW fxLayer so the FX layer stays topmost, and so entity
      // views keep ascending-id child order (root.children[0], [1], ... — the
      // M5-T01 frozen index contract relied on by renderer_bridge.test.ts). The
      // `max(0, …)` guard keeps this correct even if a caller syncs before
      // `init()` (empty root), where `addChildAt(…, 0)` is a plain append.
      const insertIndex = Math.max(0, this.root.children.length - 1);
      this.root.addChildAt(view.container, insertIndex);
    }
  }

  /** Step ② — project the transform (interpolated), apply the hit flash, tag corpses. */
  private syncTransforms(world: World, alpha: number, deltaMs: number): void {
    for (const [id, view] of this.views) {
      // A dying view is only driven by the death FX, never by the world (§4.4).
      if (view.isDying) continue;

      const transform = world.getComponent(id, TransformComponent);
      if (transform !== undefined) {
        // Fall back to the current transform when there is no previous snapshot
        // (e.g. an entity that has never been stepped): prev == curr, so alpha is
        // a no-op and the entity renders exactly where it is.
        const previous = world.getComponent(id, PreviousTransformComponent);
        const prevX = previous !== undefined ? previous.prevX : transform.x;
        const prevY = previous !== undefined ? previous.prevY : transform.y;
        const prevFacing =
          previous !== undefined ? previous.prevFacingRadians : transform.facingRadians;

        view.container.x = (prevX + (transform.x - prevX) * alpha) * PX_PER_UNIT;
        view.container.y = (prevY + (transform.y - prevY) * alpha) * PX_PER_UNIT;
        // Shortest-arc blend keeps the facing indicator from spinning the long way
        // round when it crosses the +/-PI seam (spec 10 §10 trade-off 1).
        view.container.rotation =
          prevFacing + shortestArcDelta(prevFacing, transform.facingRadians) * alpha;
      }

      // Hit flash (spec 10 AC-03): a frozen entity (hitstop) or a HITSTUN entity is
      // tinted. This is a pure READ — no system is added and no logic state changes.
      // M16: `Container.tint` propagates to children in PixiJS v8, so the SAME
      // assignment now tints the art sprite — the flash survives the art swap.
      const state = world.getComponent(id, StateComponent);
      const hit =
        isFrozen(world, id) || (state !== undefined && state.state === ActionState.HITSTUN);
      view.container.tint = hit ? HIT_FLASH_TINT : NO_TINT;

      // M16: the art sprite must NOT inherit the container's facing rotation —
      // `container.rotation === facingRadians` is a frozen contract that other
      // suites assert on — so the sprite is counter-rotated and stays upright. The
      // geometry fallback keeps rotating with the container, exactly as before.
      //
      // The animation is re-selected only when one of its THREE inputs changed.
      // That guard is a performance contract, not a micro-optimisation: SC-006
      // budgets the whole art swap at a 1.2x per-frame ratio, and re-deriving the
      // sprite id (five component lookups) for 150 idle enemies every frame spent
      // most of that budget on a value that cannot move.
      // ONE `isDead` read per view per frame, shared by the art branch below and the
      // death-FX branch further down: the component store lookup is the single most
      // expensive thing this loop does, and reading it twice bought nothing.
      const dead = isDead(world, id);
      if (view.sprite !== null) {
        // Recompute-on-CHANGE, never recompute-every-frame. Each of the three
        // selection inputs is compared against the value it had when the clip was
        // last chosen, so a standing enemy costs three primitive compares instead
        // of a quantiser call, a switch and a clip lookup. SC-006 budgets the whole
        // art swap at a 1.2x per-frame ratio; recomputing unchanged inputs spent
        // most of it (tests/performance/render_art_cost.test.ts).
        let stale = false;

        const rotation = view.container.rotation;
        if (rotation !== view.animRot) {
          view.animRot = rotation;
          const upright = -rotation;
          if (view.sprite.rotation !== upright) view.sprite.rotation = upright;
          const facing = facingFromRadians(rotation);
          if (facing !== view.animFacing) {
            view.animFacing = facing;
            stale = true;
          }
        }

        const rawState = state === undefined ? null : state.state;
        if (rawState !== view.animState || dead !== view.animDead) {
          view.animState = rawState;
          view.animDead = dead;
          const action = dead ? 'death' : animationFromState(rawState ?? undefined);
          if (action !== view.animAction) {
            view.animAction = action;
            stale = true;
          }
        }

        if (stale && view.animFacing !== null) {
          this.selectAnimation(view, view.animAction, view.animFacing);
        }
        this.advanceAnimation(view, deltaMs);
      }

      // Corpses are NEVER destroyed (spec 08 §4.4), so "play the death FX" must be
      // keyed on the DeadTag, not on the entity leaving the query (§3.3).
      if (isDead(world, id)) {
        view.isDying = true;
        view.deathElapsedMs = 0;
      }
    }
  }

  /**
   * Step ②a (M16) — pick the clip for one art view and (re)assign it when it
   * CHANGED.
   *
   * The `key === view.animKey` early return is load-bearing, not an optimisation:
   * assigning `AnimatedSprite.textures` calls `gotoAndStop(0)`, so an unguarded
   * assignment would pin every sprite to its first frame for the whole session —
   * the sprites would look correct and never move.
   *
   * `action` and `facing` arrive already resolved (the caller needed them for its
   * own change detection), and the sprite id is read from the view, so this method
   * performs NO component lookups.
   *
   * The lookup walks {@link animationCandidates}, so a sheet that carries only
   * `<spriteId>.<action>.down` still plays the right action for a body facing up.
   */
  private selectAnimation(view: EntityView, action: AnimationState, facing: Facing4): void {
    const sprite = view.sprite;
    const spriteId = view.spriteId;
    if (sprite === null || spriteId === null) return;

    let frames: readonly Texture[] | undefined;
    let key: string | null = null;
    for (const candidate of animationCandidates({ spriteId, action, facing })) {
      const found = this.art.animation(candidate);
      if (found !== undefined && found.length > 0) {
        frames = found;
        key = candidate;
        break;
      }
    }
    if (frames === undefined || key === null) return;
    if (key === view.animKey) return;

    view.animKey = key;
    view.animAction = action;
    view.animFrameMs = ANIM_FRAME_MS[action];
    view.animElapsedMs = 0;
    // The setter restarts the clip at frame 0 and pushes the texture, so no extra
    // `currentFrame` write is needed here.
    sprite.textures = [...frames];
    // ORDER IS LOAD-BEARING: `totalFrames` reads the textures the setter just
    // installed. Reading it before the assignment caches the PREVIOUS clip's length,
    // and `currentFrame` throws when handed an index past the new clip's end — a
    // crash on the exact frame a longer action replaced a shorter one.
    view.animTotal = sprite.totalFrames;
    // The renderer owns the clock (see `syncAnimations`): leaving PixiJS's own
    // auto-update on would drive the same clip from a second, uncontrolled source.
    sprite.autoUpdate = false;
  }

  /**
   * Step ②c (M16) — advance ONE art view's clip on the REAL frame clock.
   *
   * Why the renderer drives this instead of `AnimatedSprite.update(ticker)`:
   * PixiJS's own update reads `ticker.deltaTime`, and the render suites build the
   * `Application` as a duck-typed `{ stage, ticker }` stub with no `deltaTime` —
   * driving the clip ourselves keeps the same code path in the browser and in the
   * tests, and makes the frame index a pure function of `deltaMS`.
   *
   * The clip holds its LAST frame (it never wraps to 0), so `hit` (one frame) and
   * `death` (a squash) settle instead of looping — the same "settle, do not
   * flicker" rule the death FX follows.
   */
  private advanceAnimation(view: EntityView, deltaMs: number): void {
    const sprite = view.sprite;
    if (sprite === null) return;
    // A view whose death FX is running holds its last frame (the FX owns the
    // motion from here), and a single-frame clip has nowhere to advance to.
    if (view.isDying) return;
    const total = view.animTotal;
    if (total <= 1) return;

    view.animElapsedMs += deltaMs;
    const index = Math.min(total - 1, Math.floor(view.animElapsedMs / view.animFrameMs));
    if (sprite.currentFrame !== index) sprite.currentFrame = index;
  }

  /**
   * Step ②b (M12-T02) — move the camera so the player sits at the centre of the
   * screen (spec 20 §4.3 / AC-03).
   *
   * The target is "the screen centre minus the player's RENDER position", and the
   * camera eases towards it with a first-order lerp (`CAMERA_LERP_FACTOR`) rather
   * than snapping. Both halves are deliberate:
   *
   *  - Reading the VIEW's `container.x/y` (not `TransformComponent`) means the camera
   *    tracks the INTERPOLATED position — the one the player actually sees — so the
   *    camera and the player view never disagree by half a frame (ADR-002).
   *  - Lerping rather than snapping gives the world a sense of weight; a hard lock
   *    would make the whole scene jitter with every one-pixel change in the player's
   *    position. The trade-off (a constant lag while the player moves fast) is
   *    registered in spec 20 T3.
   *
   * A dying player view is skipped (`!isDying`): once the death FX owns the view, its
   * position is no longer the player's, so following it would drag the camera across
   * the map as the corpse shrinks. With no live player view at all — a rig with no
   * player, or one mid-respawn — the camera is left exactly where it is and nothing
   * throws (spec 20 §4.3).
   */
  private syncCamera(_world: World): void {
    for (const view of this.views.values()) {
      if (view.kind !== 'player') continue;
      if (view.isDying) continue;

      const targetX = this.screenWidth() / 2 - view.container.x;
      const targetY = this.screenHeight() / 2 - view.container.y;
      this.cameraContainer.x += (targetX - this.cameraContainer.x) * CAMERA_LERP_FACTOR;
      this.cameraContainer.y += (targetY - this.cameraContainer.y) * CAMERA_LERP_FACTOR;

      // M14-T01: the shake is layered ON TOP of the follow lerp. `shakeIntensityAt()`
      // is EXACTLY 0 when no hit is active, so this branch is skipped and the camera
      // is byte-for-byte the pre-M14 follow — which is what keeps the frozen camera
      // convergence assertions (`toBeCloseTo(..., 6)`) exact (spec 22 §4.2).
      const shake = this.shakeIntensityAt();
      if (shake > 0) {
        this.cameraContainer.x += (Math.random() - 0.5) * shake;
        this.cameraContainer.y += (Math.random() - 0.5) * shake;
      }
      return;
    }
  }

  /**
   * The current shake amplitude in pixels, `0` when the shake has decayed out.
   *
   * Linear decay from `SHAKE_INTENSITY` at the instant of impact to `0` at
   * `SHAKE_DURATION_MS`. Returning a hard `0` at rest (rather than a tiny
   * residual) is what makes "no hit => no shake" a bit-exact contract.
   */
  private shakeIntensityAt(): number {
    if (this.shakeTimeMs <= 0) return 0;
    return this.shakeIntensity * (this.shakeTimeMs / SHAKE_DURATION_MS);
  }

  /**
   * Advance every transient effect by one rendered frame (M14-T01, spec 22 §4.2 /
   * §4.3): decay the shake, age the particles, spawn this frame's new sparks and
   * (re)trigger the shake from a landed hit, then mount/unmount the particle layer.
   *
   * Order is load-bearing:
   *  - the shake is DECAYED before this frame's hits re-arm it, so a fresh hit
   *    starts a full-length shake and an idle frame falls one step closer to zero;
   *  - the particles are AGED before this frame's are spawned, so a fresh spark
   *    starts at full alpha instead of losing a frame of life (same rule the
   *    floaters follow).
   */
  private syncEffects(deltaMs: number, frameEvents: FrameEvents | undefined): void {
    this.advanceShake(deltaMs);
    this.vfx.advance(deltaMs);

    if (frameEvents !== undefined) {
      for (const hit of frameEvents.hits) {
        // `HitEvent.position` is the HITBOX CENTRE in world units (spec 05 §3.1);
        // the sparks fly from there, converted to pixels (spec 22 §7 T3).
        this.vfx.spawnHitSparks(hit.position.x * PX_PER_UNIT, hit.position.y * PX_PER_UNIT);
        this.shakeTimeMs = SHAKE_DURATION_MS;
        this.shakeIntensity = SHAKE_INTENSITY;
      }
      for (const dash of frameEvents.dashes) {
        this.vfx.spawnDashBurst(
          dash.position.x * PX_PER_UNIT,
          dash.position.y * PX_PER_UNIT,
          dash.direction.x,
          dash.direction.y,
        );
      }
    }

    this.syncVfxLayer();
  }

  /** Decay the shake clock by one frame; a no-op once it has reached zero. */
  private advanceShake(deltaMs: number): void {
    if (this.shakeTimeMs <= 0) return;
    this.shakeTimeMs = Math.max(0, this.shakeTimeMs - deltaMs);
  }

  /**
   * Mount the particle layer while sparks are alive and detach it when they are
   * gone (M14-T01, spec 22 §4.3).
   *
   * LAZY MOUNT is the whole reason the frozen scene-graph contracts survive: the
   * layer is inserted just BELOW the render root (so it draws over the static
   * floor/walls but under the entity views, and the root stays the camera's LAST
   * child — spec 20 I13), and it exists only during the ~180ms a spark lives. An
   * idle frame therefore has exactly the pre-M14 camera children.
   */
  private syncVfxLayer(): void {
    if (this.vfx.hasParticles) {
      if (!this.vfxAttached) {
        const insertIndex = Math.max(0, this.cameraContainer.children.length - 1);
        this.cameraContainer.addChildAt(this.vfx.layer, insertIndex);
        this.vfxAttached = true;
      }
      return;
    }
    if (this.vfxAttached) {
      this.cameraContainer.removeChild(this.vfx.layer);
      this.vfxAttached = false;
    }
  }

  /**
   * The app's screen width in pixels, or `0` when it cannot be read.
   *
   * WHY THIS IS A GUARDED READ RATHER THAN `app.screen.width`: the render test rigs
   * use a DUCK-TYPED `Application` (`{ stage, ticker }`) — PixiJS v8 cannot be driven
   * from plain Node — so `app.screen` is `undefined` at runtime even though the type
   * says it is always present. Reading `app.renderer.*` (the other place a size might
   * live) would throw in those rigs, which is the one thing this must not do.
   * Returning `0` is the honest degradation: the camera then centres the player on
   * the screen ORIGIN (target = `-playerPx`), which is still a deterministic,
   * assertable value (spec 20 I12 / T4).
   */
  private screenWidth(): number {
    const screen: Rectangle | undefined = this.app.screen;
    if (screen === undefined) return 0;
    return Number.isFinite(screen.width) ? screen.width : 0;
  }

  /** The app's screen height in pixels, or `0`. See {@link screenWidth}. */
  private screenHeight(): number {
    const screen: Rectangle | undefined = this.app.screen;
    if (screen === undefined) return 0;
    return Number.isFinite(screen.height) ? screen.height : 0;
  }

  /**
   * Spawn a damage floater for every view whose HP dropped since the last sync
   * (spec 10 AC-02). The number is `-(lastHp - hp)` (e.g. `-10`) and it appears
   * just above the entity's CURRENT render position. Reads only; never writes HP.
   */
  private detectDamage(world: World): void {
    for (const [id, view] of this.views) {
      const health = world.getComponent(id, HealthComponent);
      if (health === undefined) {
        view.lastHp = undefined;
        continue;
      }
      const previousHp = view.lastHp;
      if (previousHp !== undefined && health.hp < previousHp) {
        this.spawnFloatingText(
          `-${previousHp - health.hp}`,
          view.container.x,
          view.container.y - FLOATING_TEXT_OFFSET_PX,
        );
      }
      view.lastHp = health.hp;
    }
  }

  /** Create a rising/fading damage floater and hand it to the FX layer. */
  private spawnFloatingText(text: string, x: number, y: number): void {
    // PixiJS v8 options-object form — the positional `new Text(text, style)` form
    // is deprecated and would spew warnings into the test output.
    const node = new Text({
      text,
      style: { fontFamily: 'monospace', fontSize: 16, fill: 0xffffff },
    });
    node.x = x;
    node.y = y;
    node.alpha = 1;
    this.fxLayer.addChild(node);
    this.floatingTexts.push({ node, elapsedMs: 0, startY: y });
  }

  /**
   * Advance every floater by real frame time, then destroy the expired ones. Pure
   * visual lifetime — it never touches the simulation (spec 09 §3.6).
   */
  private advanceFloatingTexts(deltaMs: number): void {
    for (let i = this.floatingTexts.length - 1; i >= 0; i -= 1) {
      const entry = this.floatingTexts[i];
      if (entry === undefined) continue;

      entry.elapsedMs += deltaMs;
      const t = Math.min(1, entry.elapsedMs / FLOATING_TEXT_LIFETIME_MS);
      entry.node.alpha = 1 - t;
      entry.node.y = entry.startY - FLOATING_TEXT_RISE_PX * t;

      if (entry.elapsedMs >= FLOATING_TEXT_LIFETIME_MS) {
        entry.node.destroy();
        this.floatingTexts.splice(i, 1);
      }
    }
  }

  /**
   * Step ③ — advance the death FX and RETIRE the id when it finishes.
   *
   * Retirement (not just `recycle`) is what stops the FX from looping: the corpse
   * stays in the world forever (spec 08 §4.4), so without it `createMissingViews`
   * would rebuild the view next frame.
   */
  private advanceDeaths(deltaMs: number): void {
    for (const [id, view] of this.views) {
      if (!view.isDying) continue;

      view.deathElapsedMs += deltaMs;
      const t = Math.min(1, view.deathElapsedMs / DEATH_FADE_MS);
      view.container.alpha = 1 - t;
      view.container.scale.set(1 - DEATH_SHRINK * t);

      if (view.deathElapsedMs >= DEATH_FADE_MS) {
        this.retired.add(id);
        this.recycle(id, view);
      }
    }
  }

  /**
   * Step ④ — recycle views whose entity has been destroyed (e.g. expired hitboxes).
   *
   * Deliberately does NOT retire: a destroyed entity already leaves `query`, so
   * this path is self-correcting, and retiring here would permanently hide a live
   * entity if ids were ever reused (see `retired`).
   */
  private recycleDestroyed(world: World): void {
    for (const [id, view] of this.views) {
      if (!world.isAlive(id)) {
        this.recycle(id, view);
      }
    }
  }

  private recycle(id: EntityId, view: EntityView): void {
    this.views.delete(id);
    view.container.destroy({ children: true });
  }

  /**
   * Classify and build the matching placeholder.
   *
   * Order is pickup -> hazard -> hitbox -> faction, and the two special branches
   * MUST come first: a pickup owns no `HitboxComponent` and no `FactionComponent`
   * (spec 15 I1), and a hazard telegraph owns neither either (spec 14 I1/I2). The
   * `faction` branch's early return means "no visual contract for this entity", so
   * without their own branches both would be silently invisible — which for a
   * warning, or for loot the player is meant to walk towards, is the worst possible
   * failure mode.
   *
   * M8-T01 added the hazard branch; M9-T01 prepended the pickup branch.
   */
  private createView(world: World, id: EntityId): EntityView | undefined {
    const pickup = world.getComponent(id, PickupComponent);
    if (pickup !== undefined) {
      return this.createPickupView(pickup);
    }

    const hazard = world.getComponent(id, HazardComponent);
    if (hazard !== undefined) {
      return this.createHazardView(hazard);
    }

    const hitbox = world.getComponent(id, HitboxComponent);
    let view: EntityView | undefined;
    if (hitbox !== undefined) {
      view = this.createHitboxView(hitbox);
    } else {
      const faction = world.getComponent(id, FactionComponent);
      if (faction === undefined) {
        // No visual contract for this entity (e.g. the room singleton) — skip it.
        return undefined;
      }
      view =
        faction.faction === Faction.Player
          ? this.createPlayerView(world, id)
          : this.createEnemyView(world, id);
    }

    // Seed `lastHp` from the live HP so the first sync reports no phantom hit.
    const health = world.getComponent(id, HealthComponent);
    view.lastHp = health !== undefined ? health.hp : undefined;
    return view;
  }

  /**
   * Build a hazard's warning (M8-T01, art since M16).
   *
   * The WARNING is the one thing on screen that must own the player's attention, so
   * its structure is unchanged: a translucent filled circle at the TRUE blast
   * radius, plus a ring marking its edge, animated by `syncHazards` through `alpha`
   * and `scale` so no geometry is rebuilt per frame.
   *
   * M16 swaps the RING for the `fx.hazard-ring` sprite when the atlas is available.
   * The ring's shape language is deliberately the opposite of a pickup's — hollow
   * and hard-edged versus solid and round — so "walk into this" and "run away from
   * this" are distinguishable with the colour channel removed (FR-017). The fill
   * stays a `Graphics`: it is a translucent AREA, and an area has no texture.
   */
  private createHazardView(hazard: HazardComponent): EntityView {
    const radiusPx = hazard.radius * PX_PER_UNIT;
    const container = new Container();

    const fill = new Graphics();
    fill.circle(0, 0, radiusPx).fill({ color: HAZARD_COLOR, alpha: HAZARD_FILL_ALPHA_MIN });
    container.addChild(fill);

    const ringFrames = this.art.animation(HAZARD_RING_FX_ID);
    let ring: Graphics | Sprite;
    if (ringFrames !== undefined && ringFrames[0] !== undefined) {
      const sprite = new Sprite(ringFrames[0]);
      sprite.anchor.set(0.5);
      // The ring art is a fixed-size decal; scaling it to the blast diameter keeps
      // the warning honest about the area it is warning about (FR-008's spirit).
      const natural = ringFrames[0].width;
      sprite.scale.set(radiusPx > 0 && natural > 0 ? (radiusPx * 2) / natural : 1);
      sprite.tint = HAZARD_COLOR;
      sprite.alpha = HAZARD_RING_ALPHA_MIN;
      ring = sprite;
    } else {
      const graphic = new Graphics();
      graphic
        .circle(0, 0, radiusPx)
        .stroke({ width: HAZARD_RING_WIDTH, color: HAZARD_COLOR, alpha: HAZARD_RING_ALPHA_MIN });
      ring = graphic;
    }
    container.addChild(ring);

    return {
      container,
      kind: 'hazard',
      isDying: false,
      deathElapsedMs: 0,
      lastHp: undefined,
      hazard: { fill, ring },
      sprite: null,
      animKey: null,
      animAction: 'idle',
      animElapsedMs: 0,
      spriteId: null,
      animState: null,
      animDead: false,
      animFacing: null,
      animFrameMs: ANIM_FRAME_MS.idle,
      animTotal: 0,
      animRot: Number.NaN,
    };
  }

  /**
   * Animate every hazard warning from its own fuse (M8-T01, spec 14 §4.6).
   *
   * Progress is `1 - delayTicks / totalDelayTicks`, clamped to `[0, 1]`; a
   * non-positive `totalDelayTicks` counts as "about to blow" (progress 1), which
   * is the honest reading of a zero-fuse hazard rather than a division by zero.
   *
   * The reading is deliberately the COMPONENT's remaining fuse, not a value the
   * renderer accumulates itself: the warning must agree with the logic tick that
   * will actually detonate, and only the logic layer knows that. `totalDelayTicks`
   * lives on the component for exactly this reason (spec 14 §3.1) — the render
   * layer never has to remember a hazard's initial length.
   *
   * Pure reads and pure visual writes: no logic state is touched, and nothing
   * here feeds back into `src/` (spec 09 AC-01).
   */
  private syncHazards(world: World): void {
    for (const [id, view] of this.views) {
      if (view.kind !== 'hazard') continue;
      if (view.isDying) continue;

      const hazard = world.getComponent(id, HazardComponent);
      if (hazard === undefined) continue;

      const total = hazard.totalDelayTicks;
      const raw = total > 0 ? 1 - hazard.delayTicks / total : 1;
      const t = Math.min(1, Math.max(0, raw));

      view.container.alpha = 1;
      view.container.scale.set(HAZARD_SCALE_MIN + (1 - HAZARD_SCALE_MIN) * t);

      const layers = view.hazard;
      if (layers === undefined) continue;
      layers.fill.alpha = HAZARD_FILL_ALPHA_MIN + (HAZARD_FILL_ALPHA_MAX - HAZARD_FILL_ALPHA_MIN) * t;
      layers.ring.alpha = HAZARD_RING_ALPHA_MIN + (HAZARD_RING_ALPHA_MAX - HAZARD_RING_ALPHA_MIN) * t;
    }
  }

  /**
   * Build a pickup's placeholder (M9-T01): a small filled disc at the pickup's true
   * radius, plus a thin ring so it reads against any background.
   *
   * Geometry is drawn ONCE from `PickupComponent.radius`, so a re-tuned pickup needs
   * no renderer change — and the drawn size is the same number the logic layer
   * measures its overlap test against, so "what you see is what you can touch".
   *
   * Colour is the only thing that differs between kinds, because gold, health and
   * darkness are different promises and the player has to be able to tell them apart
   * at a glance.
   *
   * No animation and no per-frame state: a pickup is a static object, and giving it
   * a pulse would make it compete visually with the hazard telegraph, which is the
   * one thing on the ground that must own the player's attention.
   */
  private createPickupView(pickup: PickupComponent): EntityView {
    const color = pickupColor(pickup.kind);
    const radiusPx = pickup.radius * PX_PER_UNIT;

    const container = new Container();

    // M16: the icon is looked up by KIND, so gold / heal / darkness are three
    // different SHAPES rather than three colours of the same disc (FR-017). When
    // the atlas is unavailable the pre-M16 disc is used, unchanged.
    const iconFrames = this.art.animation(pickupIconId(pickup.kind));
    if (iconFrames !== undefined && iconFrames[0] !== undefined) {
      const icon = new Sprite(iconFrames[0]);
      icon.anchor.set(0.5);
      const natural = iconFrames[0].width;
      const scale = hurtboxSpriteScale(pickup.radius, natural, PX_PER_UNIT);
      icon.scale.set(scale);
      container.addChild(icon);
      return {
        container,
        kind: 'pickup',
        isDying: false,
        deathElapsedMs: 0,
        lastHp: undefined,
        sprite: null,
        animKey: null,
        animAction: 'idle',
        animElapsedMs: 0,
        spriteId: pickupIconId(pickup.kind),
        animState: null,
        animDead: false,
        animFacing: null,
        animFrameMs: ANIM_FRAME_MS.idle,
        animTotal: 0,
        animRot: Number.NaN,
      };
    }

    const graphic = new Graphics();
    graphic
      .circle(0, 0, radiusPx)
      .fill({ color, alpha: PICKUP_FILL_ALPHA })
      .stroke({ width: PICKUP_RING_WIDTH, color: 0xffffff, alpha: 0.7 });
    container.addChild(graphic);

    return {
      container,
      kind: 'pickup',
      isDying: false,
      deathElapsedMs: 0,
      lastHp: undefined,
      sprite: null,
      animKey: null,
      animAction: 'idle',
      animElapsedMs: 0,
      spriteId: pickupIconId(pickup.kind),
      animState: null,
      animDead: false,
      animFacing: null,
      animFrameMs: ANIM_FRAME_MS.idle,
      animTotal: 0,
      animRot: Number.NaN,
    };
  }

  private createHitboxView(hitbox: HitboxComponent): EntityView {
    const color = hitbox.faction === Faction.Player ? HITBOX_PLAYER_COLOR : HITBOX_ENEMY_COLOR;
    const container = new Container();
    const graphic = new Graphics();
    graphic
      .circle(0, 0, hitbox.radius * PX_PER_UNIT)
      .fill({ color, alpha: HITBOX_ALPHA })
      .stroke({ width: 1, color, alpha: 0.9 });
    container.addChild(graphic);
    return {
      container,
      kind: 'hitbox',
      isDying: false,
      deathElapsedMs: 0,
      lastHp: undefined,
      sprite: null,
      animKey: null,
      animAction: 'idle',
      animElapsedMs: 0,
      spriteId: null,
      animState: null,
      animDead: false,
      animFacing: null,
      animFrameMs: ANIM_FRAME_MS.idle,
      animTotal: 0,
      animRot: Number.NaN,
    };
  }

  /**
   * The player's view (M16: a real animated character).
   *
   * The ART is a child node; the container keeps its world position, its rotation
   * and its tint, which is what keeps every frozen render assertion true. The
   * pre-M16 circle + facing line is kept verbatim as the fallback (FR-013) — a
   * missing atlas must degrade to "a blue dot", never to nothing.
   */
  private createPlayerView(world: World, id: EntityId): EntityView {
    const container = new Container();

    const hurtbox = world.getComponent(id, HurtboxComponent);
    const radiusUnits = hurtbox !== undefined ? hurtbox.radius : PLAYER_RADIUS;
    const sprite = this.buildAnimatedBody(PLAYER_SPRITE_ID, radiusUnits);
    if (sprite !== null) {
      container.addChild(sprite);
    } else {
      const body = new Graphics();
      body
        .circle(0, 0, PLAYER_RADIUS * PX_PER_UNIT)
        .fill({ color: PLAYER_COLOR })
        .stroke({ width: 1, color: 0xffffff, alpha: 0.6 });
      container.addChild(body);

      // Facing indicator: drawn along +x in LOCAL space; the container's rotation
      // (= facingRadians, no sign flip) aims it in world space (spec 09 §3.2).
      const facing = new Graphics();
      facing
        .moveTo(0, 0)
        .lineTo(PLAYER_FACING_LENGTH * PX_PER_UNIT, 0)
        .stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
      container.addChild(facing);
    }

    this.addHurtboxOutline(container, world, id);
    return {
      container,
      kind: 'player',
      isDying: false,
      deathElapsedMs: 0,
      lastHp: undefined,
      sprite,
      animKey: null,
      animAction: 'idle',
      animElapsedMs: 0,
      spriteId: PLAYER_SPRITE_ID,
      animState: null,
      animDead: false,
      animFacing: null,
      animFrameMs: ANIM_FRAME_MS.idle,
      animTotal: 0,
      animRot: Number.NaN,
    };
  }

  /**
   * An enemy's view (M16: five distinguishable monsters).
   *
   * The type is resolved ONCE, here, at view creation — never per frame. That is
   * not a micro-optimisation: an entity's capability components are mounted at
   * spawn and never change during its life (data-model E3), so re-deriving the
   * type every frame would be pure churn on a value that cannot move.
   *
   * The body is scaled from the entity's HURTBOX, so the drawn monster is exactly
   * the size the engine measures overlap against (FR-008): an elite's bigger body
   * is visibly bigger because it IS bigger.
   */
  private createEnemyView(world: World, id: EntityId): EntityView {
    const container = new Container();

    const hurtbox = world.getComponent(id, HurtboxComponent);
    const radiusUnits = hurtbox !== undefined ? hurtbox.radius : PLAYER_RADIUS;

    const selection = selectSprite(world, id);
    const sprite =
      selection === undefined ? null : this.buildAnimatedBody(selection.spriteId, radiusUnits);

    if (sprite !== null) {
      container.addChild(sprite);
    } else {
      const side = radiusUnits * 2 * PX_PER_UNIT;
      const half = side / 2;
      const body = new Graphics();
      body
        .rect(-half, -half, side, side)
        .fill({ color: ENEMY_COLOR })
        .stroke({ width: 1, color: 0x000000, alpha: 0.5 });
      container.addChild(body);
    }

    this.addHurtboxOutline(container, world, id);
    return {
      container,
      kind: 'enemy',
      isDying: false,
      deathElapsedMs: 0,
      lastHp: undefined,
      sprite,
      animKey: null,
      animAction: 'idle',
      animElapsedMs: 0,
      spriteId: selection === undefined ? null : selection.spriteId,
      animState: null,
      animDead: false,
      animFacing: null,
      animFrameMs: ANIM_FRAME_MS.idle,
      animTotal: 0,
      animRot: Number.NaN,
    };
  }

  /**
   * M16 · build an `AnimatedSprite` for `spriteId`, or `null` when the atlas cannot
   * provide even its `idle.down` clip.
   *
   * The sprite starts on the fallback key (`<spriteId>.idle.down`) and is re-keyed
   * on the first `syncTransforms`; starting it here means a view is never rendered
   * with an unset texture, which PixiJS draws as an empty quad.
   *
   * `autoUpdate` is off because {@link syncAnimations} owns the clock.
   */
  private buildAnimatedBody(spriteId: string, radiusUnits: number): AnimatedSprite | null {
    const frames = this.art.animation(`${spriteId}.idle.down`);
    if (frames === undefined || frames.length === 0) return null;

    const sprite = new AnimatedSprite([...frames]);
    sprite.anchor.set(0.5);
    sprite.scale.set(hurtboxSpriteScale(radiusUnits, TILE_NATURAL_PX, PX_PER_UNIT));
    sprite.autoUpdate = false;
    return sprite;
  }


  /** Optional thin hurtbox outline (spec 09 AC-04). */
  private addHurtboxOutline(container: Container, world: World, id: EntityId): void {
    const hurtbox = world.getComponent(id, HurtboxComponent);
    if (hurtbox === undefined) return;
    const outline = new Graphics();
    outline
      .circle(0, 0, hurtbox.radius * PX_PER_UNIT)
      .stroke({ width: 1, color: 0xffffff, alpha: HURTBOX_STROKE_ALPHA });
    container.addChild(outline);
  }
}

/**
 * The colour a pickup of `kind` is drawn in (M9-T01, extended by M13-T01).
 *
 * A total mapping over the enum, kept OUT of the view builder so "what colour is
 * this kind" is one lookup rather than a nested ternary that grows with every new
 * kind. The fallback is gold, so a kind added without a colour reads as the
 * baseline loot rather than as nothing.
 */
function pickupColor(kind: PickupKind): number {
  if (kind === PickupKind.HEAL) return HEAL_PICKUP_COLOR;
  if (kind === PickupKind.DARKNESS) return DARKNESS_PICKUP_COLOR;
  return GOLD_PICKUP_COLOR;
}
