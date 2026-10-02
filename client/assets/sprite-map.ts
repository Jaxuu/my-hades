/**
 * sprite-map — the PURE mapping from read-only simulation state to a sprite and an
 * animation. See specs/024-real-art-assets/contracts/renderer-asset-mapping.md.
 *
 * WHY THIS MODULE EXISTS, AND WHY IT IS NOT IN `src/`
 * --------------------------------------------------
 * The renderer must know "which enemy is this" to draw five distinct monsters, and
 * `src/` deliberately does not say: `spawnCombatant` mounts a `TagComponent` with an
 * EMPTY tag list, and `EnemyFactory.spawn` uses the type id only to look a config
 * up. Adding a type tag to the entity would put the id into `listComponents()`,
 * which feeds `snapshot()` — changing the snapshot digest and breaking the
 * "lossless" invariant (and the frozen-core rule) for a purely cosmetic need.
 *
 * So the type is INFERRED, read-only, from the capability components that
 * `spawnCombatant` mounts CONDITIONALLY. That component set is a faithful encoding
 * of the enemy type — it is not a hack, it is a legitimate read of an existing
 * assembly contract (research.md D3).
 *
 * HARD PROPERTIES (each one is asserted in `tests/assets/sprite-map.test.ts`)
 * ------------------------------------------------------------------------
 *  - **Pure.** No DOM, no pixi.js, no `World` write. The module imports only types
 *    and component CLASSES (for the `query`/`getComponent` lookups) from `src/`.
 *  - **Total.** Every function has an answer for every input, including missing
 *    components and non-finite angles. Nothing here throws — a renderer that can
 *    throw mid-frame is a black screen.
 *  - **Deterministic.** No time, no randomness, no iteration-order dependence.
 */

import type { EntityId } from '../../src/ecs/Entity';
import type { World } from '../../src/ecs/World';
import { ActionState, StateComponent } from '../../src/ecs/components/StateComponent';
import { PlayerInputComponent } from '../../src/ecs/components/PlayerInputComponent';
import { ArmorComponent } from '../../src/ecs/components/ArmorComponent';
import { HazardCasterComponent } from '../../src/ecs/components/HazardCasterComponent';
import { AIControllerComponent } from '../../src/ecs/components/AIControllerComponent';
import { Faction, FactionComponent } from '../../src/ecs/components/FactionComponent';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { PickupKind } from '../../src/ecs/components/PickupComponent';
import { isDead } from '../../src/ecs/components/DeadTagComponent';

/** The four quantised headings a sprite sheet is drawn for. */
export type Facing4 = 'down' | 'up' | 'left' | 'right';

/**
 * The animation names the sheets declare. `death` is NOT an `ActionState`: the
 * engine expresses "this body is dead" as a `DeadTagComponent`, not as a state
 * (data-model E4 lists it because the SHEET has it, not because the enum does).
 */
export type AnimationState = 'idle' | 'move' | 'dash' | 'attack' | 'hit' | 'death';

/** Every animation name, in sheet order. */
export const ANIMATION_STATES: readonly AnimationState[] = [
  'idle',
  'move',
  'dash',
  'attack',
  'hit',
  'death',
];

/**
 * The enemy categories a sheet declares. `unknown` is the total-function fallback
 * (a combatant with no recognisable capability set) — it is a real sprite, never
 * `undefined`, so an unrecognised enemy can never become invisible.
 */
export type EnemyType = 'grunt' | 'elite' | 'raider' | 'bomber' | 'gunner' | 'unknown';

/** Every enemy type, in the order the frozen signature table resolves them. */
export const ENEMY_SPRITE_IDS: readonly EnemyType[] = [
  'grunt',
  'elite',
  'raider',
  'bomber',
  'gunner',
  'unknown',
];

/** The player's one and only sprite id. */
export const PLAYER_SPRITE_ID = 'player.base';

/** The generic enemy sprite used when a signature is unrecognised. */
export const GENERIC_ENEMY_SPRITE_ID = 'enemy.unknown';

/** Scene tile ids (contract §2 `tile.` namespace). */
export const FLOOR_TILE_ID = 'tile.floor';
export const WALL_TILE_ID = 'tile.wall';

/** FX ids (contract §2 `fx.` namespace). */
export const SPARK_FX_ID = 'fx.spark';
export const DASH_TRAIL_FX_ID = 'fx.dash-trail';
export const HAZARD_RING_FX_ID = 'fx.hazard-ring';

const TWO_PI = Math.PI * 2;
const QUARTER_PI = Math.PI / 4;
const THREE_QUARTER_PI = (3 * Math.PI) / 4;

/** What the renderer draws for one entity, in the contract's own vocabulary. */
export interface SpriteSelection {
  readonly spriteId: string;
  readonly action: AnimationState;
  readonly facing: Facing4;
}

/**
 * Normalise an angle into `[-PI, PI)`.
 *
 * `PI` itself normalises to `-PI` — the two denote the same heading, and collapsing
 * them onto ONE representative is what makes the seam stable rather than "stable
 * except exactly at the boundary".
 */
function normalizeAngle(radians: number): number {
  let angle = radians % TWO_PI;
  if (angle >= Math.PI) angle -= TWO_PI;
  else if (angle < -Math.PI) angle += TWO_PI;
  return angle;
}

/**
 * Quantise a heading to the four sheet facings.
 *
 * The convention is the renderer's: `container.rotation = facingRadians` and the
 * facing indicator is drawn along LOCAL +x, so `0` is right and `+PI/2` is down
 * (screen y grows downwards).
 *
 * Each facing owns a closed 90° sector centred on its cardinal direction, so the
 * decision boundaries are at ±45° and ±135° — far from the `±PI` seam, which is
 * why a body walking straight left cannot flip between two facings from one tick
 * to the next (FR-003, spec 10 §10 trade-off 1).
 *
 * Non-finite input (a component that was never written) degrades to `down`, the
 * sheet's default pose, rather than producing `NaN` comparisons.
 */
export function facingFromRadians(radians: number): Facing4 {
  if (!Number.isFinite(radians)) return 'down';
  const angle = normalizeAngle(radians);
  const magnitude = Math.abs(angle);
  if (magnitude <= QUARTER_PI) return 'right';
  if (magnitude >= THREE_QUARTER_PI) return 'left';
  return angle > 0 ? 'down' : 'up';
}

/**
 * Map an action state to its animation name.
 *
 * A TOTAL function: `undefined` (no `StateComponent`, e.g. an entity that is not a
 * combatant) reads as `idle`. There is deliberately no `death` arm — death is a tag
 * on the entity, not a state, and {@link selectSprite} folds it in.
 */
export function animationFromState(state: ActionState | undefined): AnimationState {
  switch (state) {
    case ActionState.MOVING:
      return 'move';
    case ActionState.DASHING:
      return 'dash';
    case ActionState.ATTACKING:
      return 'attack';
    case ActionState.HITSTUN:
      return 'hit';
    case ActionState.IDLE:
      return 'idle';
    default:
      return 'idle';
  }
}

/**
 * Infer an enemy's category from its read-only component set.
 *
 * This is the frozen table of contracts/renderer-asset-mapping.md §4, evaluated in
 * priority order. The order matters exactly once — `armor + hazard` must be tested
 * before `armor` alone, or a `gunner` would read as an `elite`.
 *
 * Returns `unknown` for anything that is not an enemy combatant (no
 * `FactionComponent`, or the player), which the renderer never asks about — but a
 * total function must still have an answer.
 */
export function enemyTypeFromSignature(world: World, id: EntityId): EnemyType {
  const faction = world.getComponent(id, FactionComponent);
  if (faction === undefined) return 'unknown';
  // The player has its own single sprite; "which enemy is this" is not a question
  // about the player, so the honest answer is the fallback rather than a guess.
  if (faction.faction === Faction.Player) return 'unknown';
  if (world.getComponent(id, PlayerInputComponent) !== undefined) return 'unknown';

  const armored = world.getComponent(id, ArmorComponent) !== undefined;
  const caster = world.getComponent(id, HazardCasterComponent) !== undefined;

  if (armored && caster) return 'gunner';
  if (armored) return 'elite';
  if (caster) return 'bomber';
  if (world.getComponent(id, AIControllerComponent) !== undefined) return 'raider';
  return 'grunt';
}

/** The sprite id for an enemy category. Total: `unknown` has its own sheet entry. */
export function enemySpriteId(type: EnemyType): string {
  return `enemy.${type}`;
}

/** The sprite id for a known target — the player, or an enemy category. */
export function spriteIdFor(target: EnemyType | 'player'): string {
  return target === 'player' ? PLAYER_SPRITE_ID : enemySpriteId(target);
}

/**
 * Project an entity onto the sprite the renderer should draw, or `undefined` when
 * the entity has no visual contract (no `FactionComponent` — e.g. the room
 * singleton), which the renderer treats as "skip", exactly as it does today.
 */
export function selectSprite(world: World, id: EntityId): SpriteSelection | undefined {
  const faction = world.getComponent(id, FactionComponent);
  if (faction === undefined) return undefined;

  const transform = world.getComponent(id, TransformComponent);
  const facing = facingFromRadians(transform === undefined ? 0 : transform.facingRadians);

  const action: AnimationState = isDead(world, id)
    ? 'death'
    : animationFromState(world.getComponent(id, StateComponent)?.state);

  const spriteId =
    faction.faction === Faction.Player
      ? PLAYER_SPRITE_ID
      : enemySpriteId(enemyTypeFromSignature(world, id));

  return { spriteId, action, facing };
}

/**
 * The animation keys to try, most specific first (contract §3.6).
 *
 * A sheet is not required to carry all 24 action×facing combinations, so a lookup
 * degrades along a fixed chain rather than failing. Duplicates are removed, so a
 * caller can iterate the result without re-assigning the same textures.
 */
export function animationCandidates(selection: SpriteSelection): readonly string[] {
  const exact = `${selection.spriteId}.${selection.action}.${selection.facing}`;
  const actionDown = `${selection.spriteId}.${selection.action}.down`;
  const idleDown = `${selection.spriteId}.idle.down`;
  const chain: string[] = [];
  for (const key of [exact, actionDown, idleDown]) {
    if (!chain.includes(key)) chain.push(key);
  }
  return chain;
}

/** The pickup icon id for a kind (FR-017: three kinds, three distinct shapes). */
export function pickupIconId(kind: PickupKind): string {
  if (kind === PickupKind.HEAL) return 'ui.icon.heal';
  if (kind === PickupKind.DARKNESS) return 'ui.icon.darkness';
  return 'ui.icon.gold';
}

/**
 * The scale that draws a `naturalPx`-wide sprite at the entity's TRUE body size.
 *
 * FR-008 asks the visible body to match the collision body, so the sprite is scaled
 * from the hurtbox the engine actually measures overlap against — not from a
 * hand-tuned number that would drift the moment a config is re-balanced.
 *
 * Guards keep the result finite and positive: a zero radius or a zero-sized texture
 * must degrade to "draw at natural size" rather than to `Infinity`/`NaN`, which
 * PixiJS would turn into an invisible or exploding sprite.
 */
export function hurtboxSpriteScale(
  radiusUnits: number,
  naturalPx: number,
  pxPerUnit: number,
): number {
  if (!Number.isFinite(radiusUnits) || radiusUnits <= 0) return 1;
  if (!Number.isFinite(naturalPx) || naturalPx <= 0) return 1;
  const targetPx = radiusUnits * 2 * pxPerUnit;
  if (!Number.isFinite(targetPx) || targetPx <= 0) return 1;
  return targetPx / naturalPx;
}
