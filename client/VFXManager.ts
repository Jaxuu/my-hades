/**
 * VFXManager — transient, presentation-only particle effects.
 * See specs/22_audio_and_juice_spec.md §3.2 / §4.3 (AC-03).
 *
 * WHAT IT IS
 * ----------
 * A tiny, self-contained particle pool for the "hit spark" (and a matching dash
 * burst) that makes a landed hit READ as an impact rather than as a silent HP
 * change. It owns ONE `Container` (`particleLayer`) holding a handful of short
 * `Graphics` streaks that scatter from an impact point, fade out and are
 * destroyed after ~180ms.
 *
 * WHERE IT LIVES
 * --------------
 * `GameRenderer` mounts `particleLayer` into the WORLD-SPACE camera subtree
 * (spec 22 §4.3), so the sparks carry world coordinates and ride the camera like
 * every other world object. It is mounted LAZILY — only while at least one
 * particle is alive — which is what keeps the frozen M5/M12 scene-graph
 * contracts (spec 20 I13) byte-for-byte intact in the idle case: a world with no
 * live sparks is a scene graph identical to the pre-M14 one.
 *
 * UNITS
 * -----
 * Every coordinate this manager accepts is in PIXELS, not world units. The
 * world-unit -> pixel conversion is the renderer's one constant
 * (`PX_PER_UNIT`), so keeping it OUT of here avoids a second copy of that
 * contract (and a `GameRenderer` <-> `VFXManager` import cycle).
 *
 * DETERMINISM
 * -----------
 * This is the PRESENTATION layer, so `Math.random` is legitimate here — it is
 * explicitly NOT imported by `src/` and the ESLint AST gate that forbids
 * `Math.random` is scoped to `src/**` only (spec 22 I1). The randomness never
 * reaches the simulation.
 *
 * PIXIJS v8 UNDER PLAIN NODE
 * --------------------------
 * `Graphics` constructs fine without a DOM, and `.x` / `.y` / `.rotation` /
 * `.alpha` / `.parent` are safe to touch. Nothing here reads `.width` / `.height`
 * / bounds (those trigger a lazy canvas measurement and throw).
 */

import { Container, Graphics } from 'pixi.js';

import { DASH_TRAIL_FX_ID, SPARK_FX_ID } from './assets/sprite-map';
import type { SpriteProvider } from './assets/AssetCatalog';

const TWO_PI = Math.PI * 2;

/** Spark colour: a warm yellow-white, per spec 22 §3.2. The FALLBACK tint. */
const SPARK_COLOR = 0xfff1a8;

/** How long a spark lives, in real milliseconds. */
export const SPARK_LIFETIME_MS = 180;

/** Sparks thrown by a landed hit. */
const SPARK_COUNT_HIT = 6;

/** Sparks thrown by a dash entry. */
const SPARK_COUNT_DASH = 5;

/** Initial spark speed range, in pixels per second. */
const SPARK_SPEED_MIN = 70;
const SPARK_SPEED_MAX = 160;

/** Dash sparks launch BACKWARD along the dash direction, within this half-angle (rad). */
const DASH_SPREAD_RADIANS = Math.PI / 3;

/**
 * Per-frame velocity retention (drag). Deliberately frame-rate coupled: the
 * effect lives ~180ms, so the small rate dependence is invisible, and a plain
 * multiply is cheaper and more predictable than an exponential damping.
 */
const SPARK_DRAG = 0.86;

/** Spark body: a short streak drawn along +x, rotated to its launch angle. */
const SPARK_LENGTH_PX = 5;
const SPARK_THICKNESS_PX = 1.5;

/**
 * M16 · the drawn size of the textured spark / trail (PIXELS).
 *
 * Small on purpose: at 10px per world unit a 10px particle would be a whole tile.
 * The art is a decal, not a body.
 */
const SPARK_ART_PX = 7;
const DASH_ART_W_PX = 11;
const DASH_ART_H_PX = 4;

/** One live spark: a PixiJS node plus the bookkeeping its motion needs. */
interface Spark {
  readonly node: Graphics;
  vx: number;
  vy: number;
  elapsedMs: number;
}

/**
 * The particle pool. Construct one per renderer; it holds no `World` reference
 * and never mutates the simulation.
 */
export class VFXManager {
  private readonly particleLayer = new Container();
  private readonly particles: Spark[] = [];
  /**
   * M16 · the art source. Optional: with no provider (or a degraded atlas) every
   * particle falls back to the pre-M16 streak, so a missing atlas costs the sparks
   * their texture and nothing else.
   */
  private readonly art: SpriteProvider | undefined;

  constructor(art?: SpriteProvider) {
    this.art = art;
  }

  /** The layer the renderer mounts/unmounts. Never null; may be detached. */
  public get layer(): Container {
    return this.particleLayer;
  }

  /** True while at least one spark is alive (drives the lazy mount). */
  public get hasParticles(): boolean {
    return this.particles.length > 0;
  }

  /** Live spark count (diagnostics / assertions). */
  public get particleCount(): number {
    return this.particles.length;
  }

  /**
   * Throw `SPARK_COUNT_HIT` sparks outward from `(x, y)` in a full circle.
   * `(x, y)` is the impact point in PIXELS (the hitbox centre, per spec 22 §7 T3).
   */
  public spawnHitSparks(x: number, y: number): void {
    for (let i = 0; i < SPARK_COUNT_HIT; i += 1) {
      this.spawnSpark(x, y, Math.random() * TWO_PI, randomSpeed(), 'hit');
    }
  }

  /**
   * Throw `SPARK_COUNT_DASH` sparks BACKWARD from `(x, y)` around the dash
   * direction `(dirX, dirY)`, reading as a small dust kick behind the dash.
   * `(x, y)` is in PIXELS.
   */
  public spawnDashBurst(x: number, y: number, dirX: number, dirY: number): void {
    const base = Math.atan2(dirY, dirX) + Math.PI;
    for (let i = 0; i < SPARK_COUNT_DASH; i += 1) {
      const angle = base + (Math.random() - 0.5) * DASH_SPREAD_RADIANS;
      this.spawnSpark(x, y, angle, randomSpeed(), 'dash');
    }
  }

  /**
   * Advance every spark by real frame time and destroy the expired ones. Pure
   * visual lifetime — it never touches the simulation (spec 22 I1).
   */
  public advance(deltaMs: number): void {
    const dtSeconds = deltaMs / 1000;
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      if (particle === undefined) continue;

      particle.elapsedMs += deltaMs;
      const t = Math.min(1, particle.elapsedMs / SPARK_LIFETIME_MS);

      particle.node.x += particle.vx * dtSeconds;
      particle.node.y += particle.vy * dtSeconds;
      particle.vx *= SPARK_DRAG;
      particle.vy *= SPARK_DRAG;
      particle.node.alpha = 1 - t;

      if (particle.elapsedMs >= SPARK_LIFETIME_MS) {
        particle.node.destroy();
        this.particles.splice(i, 1);
      }
    }
  }

  /**
   * Destroy every live spark and empty the layer, WITHOUT destroying the layer
   * itself (so it can be re-mounted on the next hit). Used by
   * `GameRenderer.reset()` at a run boundary.
   */
  public clear(): void {
    this.particles.length = 0;
    this.particleLayer.removeChildren().forEach((child) => {
      child.destroy();
    });
  }

  /** Terminal teardown: clear, detach from any parent and destroy the layer. */
  public destroy(): void {
    this.clear();
    this.particleLayer.removeFromParent();
    this.particleLayer.destroy();
  }

  /**
   * Build one spark node at `(x, y)` flying at `angle` / `speed`, and pool it.
   *
   * M16 · the node is a `Graphics` filled with the fx atlas texture rather than a
   * `Sprite`. That is a CONTRACT, not a preference: the frozen `juice_m14` suite
   * asserts `spark instanceof Graphics` for every child of the particle layer (its
   * "no Text leaked into the particle layer" guard). A `Graphics` with a texture
   * fill gives the art without weakening that assertion — and the pre-M16 colour
   * fill remains as the fallback when the atlas is unavailable.
   */
  private spawnSpark(
    x: number,
    y: number,
    angle: number,
    speed: number,
    kind: 'hit' | 'dash',
  ): void {
    const node = new Graphics();
    const texture = this.art?.texture(kind === 'hit' ? SPARK_FX_ID : DASH_TRAIL_FX_ID);
    if (texture !== undefined) {
      if (kind === 'hit') {
        // A square decal: the spark art is a star, so it is not stretched into a
        // streak (FR-009's no-stretch rule reads the same for a particle).
        node
          .rect(-SPARK_ART_PX / 2, -SPARK_ART_PX / 2, SPARK_ART_PX, SPARK_ART_PX)
          .fill({ texture });
      } else {
        node
          .rect(-DASH_ART_W_PX / 2, -DASH_ART_H_PX / 2, DASH_ART_W_PX, DASH_ART_H_PX)
          .fill({ texture });
        node.rotation = angle;
      }
    } else {
      node.rect(0, 0, SPARK_LENGTH_PX, SPARK_THICKNESS_PX).fill({ color: SPARK_COLOR });
      node.rotation = angle;
    }
    node.x = x;
    node.y = y;
    node.alpha = 1;
    this.particleLayer.addChild(node);
    this.particles.push({
      node,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      elapsedMs: 0,
    });
  }
}

/** A random speed in `[SPARK_SPEED_MIN, SPARK_SPEED_MAX)`. */
function randomSpeed(): number {
  return SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
}
