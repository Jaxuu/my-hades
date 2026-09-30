/**
 * LevelLoader — the ONE translator from a room's tilemap to world entities
 * (M12-T01). See specs/19_room_topology_and_tilemaps_spec.md §4.1 / §4.4.
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * Before M12 a "room" was a wave table and nothing else. It had no shape: the arena
 * was the same unbounded plane every time, walls could only be placed by hand from
 * test code, the player always started at `(0, 0)` (hard-coded in `client/main.ts`)
 * and every enemy landed on the centre-line formation `formWaveRoster` derives. So
 * a run had no geography, and entering a room a second time was indistinguishable
 * from entering it the first time.
 *
 * This module is the missing half. It reads a `RoomConfig` (a 2D integer grid) and
 * turns it into the world: the `1` tiles MERGED into as few large `WallComponent`
 * AABBs as a greedy rectangle merge can manage, a player pose reset onto the `2`
 * tile's centre, and the `3` tiles collected into a spawn pool the encounter
 * scheduler draws landing spots from.
 *
 * M12-T02 — WHY THE WALLS ARE MERGED RATHER THAN ONE PER TILE
 * ----------------------------------------------------------
 * M12-T01 shipped "one wall entity per `1` tile" on purpose (spec 19 I2): it made
 * the wall entity ids correspond one-to-one with the grid read in row-major order,
 * which is a beautiful property for a test to assert against the JSON. Its cost,
 * registered as spec 19 R3, is that `resolveWalls` is `O(dynamic bodies x walls)` —
 * so a room's physical cost grew with its AREA even though a room's walls form a
 * handful of long straight runs.
 *
 * This milestone keeps the beautiful property's EVIDENCE and drops its cost. The
 * grid is still the one and only source of geometry (spec 19 I1), but consecutive
 * tiles are merged at LOAD time into large axis-aligned rectangles, so the wall
 * count becomes `O(runs)` instead of `O(tiles)`. The merge is a pure function of
 * the grid, so it can never drift from it, and it is applied in exactly one place
 * (the same load path every room already takes), so there is no second geometry
 * path to keep in step.
 *
 * The merge is EQUIVALENT, not approximate: the union of the merged rectangles is
 * exactly the union of the per-tile boxes, and — because a merged rectangle's edges
 * always fall on original tile lines — `resolveCircleAABB` pushes a body out along
 * the same face it would have chosen per-tile. A body cannot tell whether the wall
 * it hit was one long rectangle or three unit boxes (spec 20 AC-01 / I1 / I2).
 *
 * WHY IT LIVES IN `core/` AND WHY IT IS STATELESS
 * -----------------------------------------------
 * Every method is a STATIC, side-effect-scoped-on-the-world operation with no
 * fields and no cross-tick state (spec 00 §6.1). It is called from exactly two
 * places, both of them ROOM BOUNDARIES rather than per-tick phases:
 *
 *  - `runSetup` (a constructor option of `GameSimulator`), for the opening room and
 *    for every `restartRun`;
 *  - `RewardSystem.update`, when a settled reward descends the run.
 *
 * That is why this is NOT a pipeline segment. It has no per-tick work at all — a
 * wall is static, and the milestone's discipline is explicit: a static body must
 * never carry a component a system advances (spec 19 I3).
 *
 * WHY THE WHOLE TRANSITION IS SYNCHRONOUS
 * ---------------------------------------
 * `enterRoom` finishes inside the single system call that triggers it: old geometry
 * and transient entities are gone, the new walls exist, the player is at the new
 * spawn, and `enemySpawnPoints` is written. Nothing is deferred, queued or async —
 * `EncounterSystem` has already run for this tick, so the new room's first wave is
 * scheduled on the NEXT tick, which is the engine's existing one-tick phase
 * (spec 08 §6) rather than a new delay (spec 19 I8).
 *
 * WHY NOTHING HERE THROWS
 * -----------------------
 * `enterRoom` runs from inside `step()`, and a synchronous simulation loop can
 * neither await nor recover. Every grid that can reach this module was already
 * validated by `DataManager.loadAll` at Bootstrap (spec 19 I12), so a lookup here
 * is a plain table read. The single defensive branch is a hand-constructed
 * `RoomConfig` that declares no player spawn — a test fixture, for which the room's
 * geometric centre is an honest, predictable fallback rather than a mid-tick throw.
 */

import type { EntityId } from '../ecs/Entity';
import type { ComponentCtor } from '../ecs/Component';
import type { World } from '../ecs/World';
import { DataManager } from '../data/DataManager';
import { TILE_ENEMY_SPAWN, TILE_PLAYER_SPAWN, TILE_WALL } from '../data/schemas';
import type { RoomConfig } from '../data/schemas';
import { WallComponent, createWall } from '../ecs/components/WallComponent';
import type { WallSpawnOptions } from '../ecs/components/WallComponent';
import { HazardComponent } from '../ecs/components/HazardComponent';
import { HitboxComponent } from '../ecs/components/HitboxComponent';
import { PickupComponent } from '../ecs/components/PickupComponent';
import { TransformComponent } from '../ecs/components/TransformComponent';
import { PreviousTransformComponent } from '../ecs/components/PreviousTransformComponent';
import { VelocityComponent } from '../ecs/components/VelocityComponent';
import { ActionState, StateComponent } from '../ecs/components/StateComponent';
import { FreezeComponent } from '../ecs/components/FreezeComponent';
import { KnockbackComponent } from '../ecs/components/KnockbackComponent';
import { vec2 } from './math';
import type { EncounterStateComponent, SpawnPoint } from '../ecs/components/EncounterStateComponent';

/** One tile address in grid space. */
export interface TileCoord {
  readonly col: number;
  readonly row: number;
}

/** What loading one room produced, so a caller (or a test) can assert on it. */
export interface RoomLoadResult {
  /** The room's table id. */
  readonly roomId: string;
  /** Where the player is placed: the centre of the room's `2` tile. */
  readonly playerSpawn: SpawnPoint;
  /** Every `3` tile's centre, row-major order — the enemy landing pool. */
  readonly enemySpawnPoints: readonly SpawnPoint[];
  /**
   * How many `WallComponent` entities this load created.
   *
   * M12-T02 SEMANTIC CHANGE: this used to equal the grid's `1` count (one wall per
   * tile). It is now the MERGED rectangle count — the number of AABBs the greedy
   * merge produced, which is also the number of entities in the world and therefore
   * the number `resolveWalls` iterates. `wallTileCount` below is the pre-merge
   * count, and the two together are what make "the merge was correct" (areas sum to
   * the tile count) and "the merge did not over-merge" (every `1` tile is covered)
   * separately assertable.
   */
  readonly wallCount: number;
  /**
   * How many `1` tiles the grid holds — the pre-merge wall count.
   *
   * Kept alongside {@link wallCount} rather than folded into it because the two
   * answer different questions: `wallCount` is world state ("how many wall entities
   * exist"), `wallTileCount` is geometric truth ("how much terrain is there"). The
   * merge is exactly the gap between them, and a test asserting
   * `wallCount <= wallTileCount` plus "the merged rectangles' area sums to
   * `wallTileCount`" pins both correctness and the absence of over-merge.
   */
  readonly wallTileCount: number;
  /** How many transient entities the teardown step destroyed. */
  readonly clearedEntityCount: number;
}

/** Everything `enterRoom` needs. */
export interface EnterRoomOptions {
  /** Which room of `rooms.json` to build. */
  readonly roomId: string;
  /**
   * The player to hard-reset onto the room's spawn tile. Omit it and the room's
   * geometry is still built, but nothing is teleported — which is the honest shape
   * for a rig that has no player (several suites build a room without one).
   */
  readonly playerId?: EntityId;
  /**
   * The room singleton, which receives the new `enemySpawnPoints`. Omit it and the
   * pool is computed but not published, which is what a caller that only wants the
   * geometry does.
   */
  readonly encounter?: EncounterStateComponent;
}

/**
 * The components whose entities are TRANSIENT — i.e. belong to the fight that just
 * ended rather than to the room (M12-T01, spec 19 §4.4).
 *
 * `HitboxComponent` and not `ProjectileComponent` is the load-bearing choice: a
 * projectile is only one of three kinds of "会飞的/待判定的伤害圆" — the melee swing
 * `CombatActionSystem` spawns and the circle a boon injects are the other two, and
 * neither should follow the player into the next room. A combatant never carries a
 * `HitboxComponent` (it carries a `HurtboxComponent`), so this set can never
 * accidentally delete a body.
 *
 * Corpses are deliberately ABSENT: `death is a state, not a deletion` (spec 08 §4.4)
 * is the contract three milestones rest on, and `GameRenderer.retired` depends on it.
 * Giving that rule an exception for room transitions would be the beginning of its
 * end (spec 19 R2).
 */
const TRANSIENT_COMPONENTS: readonly ComponentCtor[] = [
  WallComponent,
  HitboxComponent,
  HazardComponent,
  PickupComponent,
];

export class LevelLoader {
  /**
   * The centre of tile `(col, row)` in world units (spec 19 I4).
   *
   * `(col + 0.5, row + 0.5)`, because tile `(col, row)` OCCUPIES
   * `[col, col + 1] x [row, row + 1]` and the room's top-left tile corner is the
   * world origin. Pure and exported so the mapping is testable on its own — and so
   * the render layer, the loader and the tests can never disagree about where a
   * tile is.
   */
  public static tileToWorldCentre(col: number, row: number): SpawnPoint {
    return { x: col + 0.5, y: row + 0.5 };
  }

  /** The AABB of tile `(col, row)`: a unit box whose top-left corner is the tile. */
  public static wallBoxForTile(col: number, row: number): WallSpawnOptions {
    return { x: col, y: row, width: 1, height: 1 };
  }

  /**
   * Every `1` tile, in ROW-MAJOR order.
   *
   * Row-major (not a `Map`/`Set` iteration) is what makes wall entity ids ascend in
   * exactly the order a human reads the grid, so a failing assertion can name a
   * tile and the corresponding entity id without a lookup table.
   */
  public static collectWallTiles(config: RoomConfig): readonly TileCoord[] {
    const tiles: TileCoord[] = [];
    for (let row = 0; row < config.height; row += 1) {
      for (let col = 0; col < config.width; col += 1) {
        if (config.grid[row * config.width + col] === TILE_WALL) tiles.push({ col, row });
      }
    }
    return tiles;
  }

  /**
   * The centre of the room's FIRST `2` tile in row-major order, or `undefined`.
   *
   * "First in row-major order" rather than "the only one": `parseRoomConfig`
   * guarantees a data-backed room declares at least one spawn tile, but it does not
   * forbid several, and a deterministic tie-break is the only honest way to read
   * them. Anything else (last, random) would make the player's start depend on a
   * detail no author wrote down.
   */
  public static findPlayerSpawn(config: RoomConfig): SpawnPoint | undefined {
    for (let row = 0; row < config.height; row += 1) {
      for (let col = 0; col < config.width; col += 1) {
        if (config.grid[row * config.width + col] === TILE_PLAYER_SPAWN) {
          return LevelLoader.tileToWorldCentre(col, row);
        }
      }
    }
    return undefined;
  }

  /** Every `3` tile's centre, in row-major order — the enemy landing pool. */
  public static collectEnemySpawnPoints(config: RoomConfig): readonly SpawnPoint[] {
    const points: SpawnPoint[] = [];
    for (let row = 0; row < config.height; row += 1) {
      for (let col = 0; col < config.width; col += 1) {
        if (config.grid[row * config.width + col] === TILE_ENEMY_SPAWN) {
          points.push(LevelLoader.tileToWorldCentre(col, row));
        }
      }
    }
    return points;
  }

  /** The geometric centre of the grid — the fallback pose for a spawn-less room. */
  public static roomCentre(config: RoomConfig): SpawnPoint {
    return { x: config.width / 2, y: config.height / 2 };
  }

  /**
   * Destroy every TRANSIENT entity — the old room's walls plus this tick's
   * leftovers — and return how many went (spec 19 AC-04).
   *
   * Ids are COLLECTED FIRST and destroyed second. `World.query` already returns a
   * fresh ascending array, so destroying during iteration would technically be safe,
   * but collecting makes the intent explicit and keeps the count meaningful even if
   * a future component's store were to react to destruction.
   *
   * Ordering note: `WallComponent` is destroyed before the others, but since the set
   * is disjoint in practice (a wall is not a hitbox, hazard or pickup) the order is
   * not observable — it is written this way so the "geometry first" reading matches
   * the docstring above it.
   */
  public static clearRoomEntities(world: World): number {
    let destroyed = 0;
    for (const ctor of TRANSIENT_COMPONENTS) {
      for (const id of world.query(ctor)) {
        world.destroyEntity(id);
        destroyed += 1;
      }
    }
    return destroyed;
  }

  /**
   * The greedy rectangle merge (M12-T02, spec 20 §3.1 / AC-01).
   *
   * Scans the grid in ROW-MAJOR order and, at the first unvisited `1` tile it
   * finds, grows a rectangle: first RIGHT along the row (eating consecutive
   * unvisited `1` tiles), then DOWN (eating rows whose entire span is unvisited
   * `1` tiles), marks the whole rectangle visited, and emits it. Every `1` tile is
   * therefore either a rectangle's top-left corner or inside exactly one rectangle,
   * which is what makes the union exact and the rectangles non-overlapping.
   *
   * WHY `visited` IS LOAD-BEARING rather than an optimisation: without it, the
   * downward growth would re-cover tiles a later row-major scan will also start a
   * rectangle on, producing OVERLAPPING rectangles. Overlap would (a) break "area
   * sums to the tile count" — the one equation that proves the merge conserved the
   * geometry — and (b) make `resolveWalls` push a body out of the same wall twice.
   *
   * WHY ROW-MAJOR OUTPUT ORDER: a rectangle is emitted at the moment its TOP-LEFT
   * tile is reached, and the scan is row-major, so the output is sorted by
   * top-left tile in reading order. That makes a failing assertion able to name a
   * rectangle and the grid cell it came from without a lookup table — the same
   * reason `collectWallTiles` is row-major.
   *
   * WHY RIGHT-THEN-DOWN RATHER THAN DOWN-THEN-RIGHT: both are legal greedy merges
   * and produce the SAME union (and the same resolution behaviour), but they can
   * differ in rectangle count. Right-first collapses a room's top and bottom edges
   * — the most common shape in practice — into single rectangles, which keeps the
   * output small and, just as usefully, human-checkable in a test.
   *
   * Pure, stateless, and TOTAL: it allocates its own `visited` array, reads only
   * `config`, and never throws. It is called from inside `step()` (via
   * `spawnWalls`), so a throw here would be unrecoverable (spec 19 I12 / spec 20
   * I4).
   */
  public static mergeWallRects(config: RoomConfig): readonly WallSpawnOptions[] {
    const { width, height, grid } = config;
    const visited = new Array<boolean>(width * height).fill(false);
    const rects: WallSpawnOptions[] = [];

    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        if (grid[row * width + col] !== TILE_WALL) continue;
        if (visited[row * width + col] === true) continue;

        // 1. Grow RIGHT while the next tile is an unvisited wall on this row.
        let rectWidth = 1;
        while (
          col + rectWidth < width &&
          grid[row * width + (col + rectWidth)] === TILE_WALL &&
          visited[row * width + (col + rectWidth)] !== true
        ) {
          rectWidth += 1;
        }

        // 2. Grow DOWN while EVERY tile of the span is an unvisited wall. The whole
        //    span must qualify: a rectangle is axis-aligned, so a single gap forbids
        //    the row entirely rather than shrinking the span.
        let rectHeight = 1;
        while (
          row + rectHeight < height &&
          LevelLoader.spanIsUnvisitedWall(grid, visited, width, col, rectWidth, row + rectHeight)
        ) {
          rectHeight += 1;
        }

        // 3. Mark the whole rectangle visited, then emit it.
        for (let r = row; r < row + rectHeight; r += 1) {
          for (let c = col; c < col + rectWidth; c += 1) {
            visited[r * width + c] = true;
          }
        }
        rects.push({ x: col, y: row, width: rectWidth, height: rectHeight });
      }
    }
    return rects;
  }

  /**
   * Whether `[col, col + span)` on `row` is entirely unvisited `1` tiles.
   *
   * Split out of {@link mergeWallRects} so the "a single gap forbids the row"
   * predicate reads as one sentence instead of a nested `while` condition. Private
   * and static — it is an implementation detail of the merge, not part of the
   * loader's contract.
   */
  private static spanIsUnvisitedWall(
    grid: readonly number[],
    visited: readonly boolean[],
    width: number,
    col: number,
    span: number,
    row: number,
  ): boolean {
    for (let c = col; c < col + span; c += 1) {
      const index = row * width + c;
      if (grid[index] !== TILE_WALL || visited[index] === true) return false;
    }
    return true;
  }

  /**
   * Build one room's geometry: one wall entity per MERGED rectangle (M12-T02,
   * spec 20 AC-01).
   *
   * Returns the rectangle count — the number of AABBs `resolveWalls` will iterate,
   * and the number of `WallComponent` entities in the world. The pre-merge tile
   * count is `collectWallTiles(config).length` and is surfaced to callers as
   * `RoomLoadResult.wallTileCount`; the two together are the "the merge was
   * equivalent" assertion.
   *
   * Walls are still created through `createWall`, the one assembly seam for static
   * geometry (spec 13 §3.2), so its validation and its "no `TransformComponent`"
   * contract apply here for free rather than being restated — and a merged
   * rectangle is the same `WallSpawnOptions` shape a unit box was, so the seam
   * needs no change to accept it.
   */
  public static spawnWalls(world: World, config: RoomConfig): number {
    const rects = LevelLoader.mergeWallRects(config);
    for (const rect of rects) {
      createWall(world, rect);
    }
    return rects.length;
  }

  /**
   * Hard-reset a combatant's POSE onto `spawn` (spec 19 I5).
   *
   * "Hard reset" is the whole point of the acceptance criterion, so this writes
   * EVERY piece of state that could carry the old room's motion across the seam:
   *
   *  - `TransformComponent.x/y` — the position itself;
   *  - `PreviousTransformComponent` — the render-interpolation anchor. Leaving it
   *    stale would make the renderer blend from the OLD room's coordinates to the
   *    new ones for one frame, i.e. the player would visibly slide across the map;
   *  - `VelocityComponent` — speed, heading and the dash multiplier, so the player
   *    does not arrive still dashing;
   *  - `StateComponent` — back to `IDLE` with a zeroed counter, so a `HITSTUN` or
   *    `ATTACKING` commitment does not survive the transition;
   *  - `KnockbackComponent` — a knockback aimed at the old room's walls would
   *    otherwise fling the player across the new one;
   *  - `FreezeComponent` — hitstop is a hit reaction, and there was no hit here.
   *
   * `facingRadians` is deliberately PRESERVED: a heading is the player's own, not a
   * property of the room, and keeping it makes the transition read as "walked
   * through a door" rather than "was respawned".
   *
   * Statuses are deliberately NOT cleared either: a timed debuff legitimately spans
   * rooms, and clearing it would silently hand the player a free cleanse.
   *
   * @returns `false` when the entity is gone or has no `TransformComponent` — the
   *   honest answer for "there was nobody to place", and never a throw, because this
   *   runs inside `step()`.
   */
  public static resetPlayerPose(world: World, playerId: EntityId, spawn: SpawnPoint): boolean {
    if (!world.isAlive(playerId)) return false;

    const transform = world.getComponent(playerId, TransformComponent);
    if (transform === undefined) return false;
    transform.x = spawn.x;
    transform.y = spawn.y;

    const previous = world.getComponent(playerId, PreviousTransformComponent);
    if (previous !== undefined) {
      previous.prevX = spawn.x;
      previous.prevY = spawn.y;
    }

    const velocity = world.getComponent(playerId, VelocityComponent);
    if (velocity !== undefined) {
      velocity.currentSpeed = 0;
      velocity.directionVector = vec2(0, 0);
      velocity.speedMultiplier = 1;
    }

    const state = world.getComponent(playerId, StateComponent);
    if (state !== undefined) {
      state.state = ActionState.IDLE;
      state.ticksInState = 0;
    }

    const knockback = world.getComponent(playerId, KnockbackComponent);
    if (knockback !== undefined) knockback.velocity = vec2(0, 0);

    const freeze = world.getComponent(playerId, FreezeComponent);
    if (freeze !== undefined) freeze.remainingTicks = 0;

    return true;
  }

  /**
   * THE room-transition entry point (spec 19 §4.1).
   *
   * Order is the contract, and none of the five steps can move:
   *
   *  1. tear the previous room down;
   *  2. build this room's walls — necessarily at HIGHER entity ids than the ones
   *     step 1 destroyed, which is what lets "the old walls are gone" and "the new
   *     count is right" be asserted independently rather than cancelling out;
   *  3. derive the player's spawn and the enemy landing pool from the grid;
   *  4. hard-reset the player's pose onto the spawn;
   *  5. publish the landing pool on the room singleton.
   *
   * Steps 4 and 5 are independent of each other (one writes the player, one writes
   * the room) and are done in this order so that by the time the pool becomes
   * visible, the scene it describes already exists.
   */
  public static enterRoom(world: World, options: EnterRoomOptions): RoomLoadResult {
    const config = DataManager.getRoomConfig(options.roomId);

    const clearedEntityCount = LevelLoader.clearRoomEntities(world);
    const wallCount = LevelLoader.spawnWalls(world, config);
    // The pre-merge count is derived here, next to the post-merge one, so the two
    // numbers a caller compares come from the same call and the same config — the
    // merge's "area is conserved" claim is then a property of one room, not of two
    // reads that might have raced a reload.
    const wallTileCount = LevelLoader.collectWallTiles(config).length;

    const playerSpawn = LevelLoader.findPlayerSpawn(config) ?? LevelLoader.roomCentre(config);
    const enemySpawnPoints = LevelLoader.collectEnemySpawnPoints(config);

    if (options.playerId !== undefined) {
      LevelLoader.resetPlayerPose(world, options.playerId, playerSpawn);
    }
    if (options.encounter !== undefined) {
      options.encounter.enemySpawnPoints = enemySpawnPoints;
    }

    return {
      roomId: options.roomId,
      playerSpawn,
      enemySpawnPoints,
      wallCount,
      wallTileCount,
      clearedEntityCount,
    };
  }
}
