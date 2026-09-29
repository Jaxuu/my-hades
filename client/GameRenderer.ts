/**
 * GameRenderer — the read-only bridge from the headless ECS world to PixiJS.
 * See specs/09_renderer_bridge_spec.md §3.2–§4.5.
 *
 * The render layer is a pure CONSUMER of `World`. It never calls a mutating API
 * (`addComponent` / `removeComponent` / `destroyEntity` / `applyDamage` / …) and
 * never advances the simulation. The only thing it owns is a
 * `Map<EntityId, EntityView>` — a disposable cache that can be dropped and
 * rebuilt without affecting logic (spec 09 §10 trade-off 4).
 *
 * One-way dependency: this module imports `src/` (types + components) but `src/`
 * must never import it back (enforced by ESLint, spec 09 AC-01).
 */

import { Container, Graphics } from 'pixi.js';
import type { Application, Ticker } from 'pixi.js';

import type { EntityId } from '../src/ecs/Entity';
import type { World } from '../src/ecs/World';
import { TransformComponent } from '../src/ecs/components/TransformComponent';
import { HitboxComponent } from '../src/ecs/components/HitboxComponent';
import { HurtboxComponent } from '../src/ecs/components/HurtboxComponent';
import { Faction, FactionComponent } from '../src/ecs/components/FactionComponent';
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

const PLAYER_COLOR = 0x4da3ff;
const ENEMY_COLOR = 0xff4d4d;
const HITBOX_PLAYER_COLOR = 0xffe14d;
const HITBOX_ENEMY_COLOR = 0xff4d4d;
const HITBOX_ALPHA = 0.35;
const HURTBOX_STROKE_ALPHA = 0.35;

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
}

export class GameRenderer {
  private readonly app: Application;
  private readonly root = new Container();
  private readonly views = new Map<EntityId, EntityView>();

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

  /** Attach the render root to the stage. Call once, after `app.init`. */
  public init(): void {
    this.app.stage.addChild(this.root);
  }

  /**
   * Sync one frame of the logic world into the scene graph. Four steps, in order
   * (spec 09 §3.3): create missing views, sync transforms, advance death FX,
   * recycle destroyed views.
   *
   * Real frame time for the death FX is read from the app ticker: it is a VISUAL
   * concern and must not feed back into the simulation (spec 09 §3.6).
   */
  public syncWorld(world: World): void {
    this.createMissingViews(world);
    this.syncTransforms(world);
    this.advanceDeaths(this.app.ticker.deltaMS);
    this.recycleDestroyed(world);
  }

  /** Tear down every view and the render root. */
  public destroy(): void {
    for (const view of this.views.values()) {
      view.container.destroy({ children: true });
    }
    this.views.clear();
    this.retired.clear();
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
      this.root.addChild(view.container);
    }
  }

  /** Step ② — project the transform, and detect a freshly-tagged corpse. */
  private syncTransforms(world: World): void {
    for (const [id, view] of this.views) {
      // A dying view is only driven by the death FX, never by the world (§4.4).
      if (view.isDying) continue;

      const transform = world.getComponent(id, TransformComponent);
      if (transform !== undefined) {
        view.container.x = transform.x * PX_PER_UNIT;
        view.container.y = transform.y * PX_PER_UNIT;
        // atan2 convention with screen y down => rotation is used AS-IS (§3.2).
        view.container.rotation = transform.facingRadians;
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
    if (hitbox !== undefined) {
      return this.createHitboxView(hitbox);
    }

    const faction = world.getComponent(id, FactionComponent);
    if (faction === undefined) {
      // No visual contract for this entity (e.g. the room singleton) — skip it.
      return undefined;
    }
    if (faction.faction === Faction.Player) {
      return this.createPlayerView(world, id);
    }
    return this.createEnemyView(world, id);
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
    return { container, kind: 'hitbox', isDying: false, deathElapsedMs: 0 };
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
    return { container, kind: 'player', isDying: false, deathElapsedMs: 0 };
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
    return { container, kind: 'enemy', isDying: false, deathElapsedMs: 0 };
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
