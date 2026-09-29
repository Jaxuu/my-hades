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
 * One-way dependency: this module imports `src/` (types + components) but `src/`
 * must never import it back (enforced by ESLint, spec 09 AC-01).
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { Application, Ticker } from 'pixi.js';

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

/**
 * The render layer's ONE constant contract: world units -> pixels (spec 09 C8).
 * The logic layer has no concept of pixels; this number lives only here.
 */
export const PX_PER_UNIT = 10;

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

const PLAYER_COLOR = 0x4da3ff;
const ENEMY_COLOR = 0xff4d4d;
const HITBOX_PLAYER_COLOR = 0xffe14d;
const HITBOX_ENEMY_COLOR = 0xff4d4d;
const HITBOX_ALPHA = 0.35;
const HURTBOX_STROKE_ALPHA = 0.35;

/** No tint — the neutral resting value (PixiJS multiplies by white = identity). */
const NO_TINT = 0xffffff;

/**
 * Hit-flash tint. PixiJS `tint` MULTIPLIES the fill, so it can only darken /
 * shift hue — it cannot brighten. Pure red is therefore the strongest, most
 * legible flash on both the blue player circle and the red enemy square.
 */
const HIT_FLASH_TINT = 0xff0000;

const TWO_PI = Math.PI * 2;

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
export type ViewKind = 'hitbox' | 'player' | 'enemy';

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
}

/** A live damage floater: a PixiJS `Text` plus the bookkeeping its lifetime needs. */
interface FloatingText {
  readonly node: Text;
  elapsedMs: number;
  readonly startY: number;
}

export class GameRenderer {
  private readonly app: Application;
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

  constructor(app: Application) {
    this.app = app;
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

  /** Attach the render root (and its FX layer) to the stage. Call once, after `app.init`. */
  public init(): void {
    this.app.stage.addChild(this.root);
    // fxLayer is added FIRST and stays the last child of the root: entity views are
    // always inserted just below it (see `createMissingViews`), so FX render on top
    // while the frozen M5-T01 child-index contract (root.children[0] = first entity
    // view) still holds.
    this.root.addChild(this.fxLayer);
  }

  /**
   * Sync one frame of the logic world into the scene graph. Steps, in order:
   * create missing views, sync transforms (interpolated by `alpha` + hit flash),
   * age existing damage floaters, spawn new ones, advance death FX, recycle
   * destroyed views.
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
   */
  public syncWorld(world: World, alpha = 1): void {
    const clampedAlpha = Math.min(1, Math.max(0, alpha));
    this.createMissingViews(world);
    this.syncTransforms(world, clampedAlpha);
    // Age the floaters that already exist BEFORE spawning this frame's, so a fresh
    // floater starts at full alpha instead of losing a frame of life immediately.
    this.advanceFloatingTexts(this.app.ticker.deltaMS);
    this.detectDamage(world);
    this.advanceDeaths(this.app.ticker.deltaMS);
    this.recycleDestroyed(world);
  }

  /** Tear down every view, every floater and the render root. */
  public destroy(): void {
    for (const view of this.views.values()) {
      view.container.destroy({ children: true });
    }
    this.views.clear();
    this.retired.clear();
    this.floatingTexts.length = 0;
    // Recursively destroys fxLayer and every floater still parented to it.
    this.root.destroy({ children: true });
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
  private syncTransforms(world: World, alpha: number): void {
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
      const state = world.getComponent(id, StateComponent);
      const hit =
        isFrozen(world, id) || (state !== undefined && state.state === ActionState.HITSTUN);
      view.container.tint = hit ? HIT_FLASH_TINT : NO_TINT;

      // Corpses are NEVER destroyed (spec 08 §4.4), so "play the death FX" must be
      // keyed on the DeadTag, not on the entity leaving the query (§3.3).
      if (isDead(world, id)) {
        view.isDying = true;
        view.deathElapsedMs = 0;
      }
    }
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

  /** Classify (hitbox FIRST, then faction) and build the matching placeholder. */
  private createView(world: World, id: EntityId): EntityView | undefined {
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

  private createHitboxView(hitbox: HitboxComponent): EntityView {
    const color = hitbox.faction === Faction.Player ? HITBOX_PLAYER_COLOR : HITBOX_ENEMY_COLOR;
    const container = new Container();
    const graphic = new Graphics();
    graphic
      .circle(0, 0, hitbox.radius * PX_PER_UNIT)
      .fill({ color, alpha: HITBOX_ALPHA })
      .stroke({ width: 1, color, alpha: 0.9 });
    container.addChild(graphic);
    return { container, kind: 'hitbox', isDying: false, deathElapsedMs: 0, lastHp: undefined };
  }

  private createPlayerView(world: World, id: EntityId): EntityView {
    const container = new Container();

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

    this.addHurtboxOutline(container, world, id);
    return { container, kind: 'player', isDying: false, deathElapsedMs: 0, lastHp: undefined };
  }

  private createEnemyView(world: World, id: EntityId): EntityView {
    const container = new Container();

    const hurtbox = world.getComponent(id, HurtboxComponent);
    const radiusUnits = hurtbox !== undefined ? hurtbox.radius : PLAYER_RADIUS;
    const side = radiusUnits * 2 * PX_PER_UNIT;
    const half = side / 2;

    const body = new Graphics();
    body
      .rect(-half, -half, side, side)
      .fill({ color: ENEMY_COLOR })
      .stroke({ width: 1, color: 0x000000, alpha: 0.5 });
    container.addChild(body);

    this.addHurtboxOutline(container, world, id);
    return { container, kind: 'enemy', isDying: false, deathElapsedMs: 0, lastHp: undefined };
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
