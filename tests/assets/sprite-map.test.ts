/**
 * Asset-mapping unit tests (specs/024-real-art-assets, US1–US6 + T009/T010).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * `client/assets/sprite-map.ts` is the ONLY place that turns read-only simulation
 * state into a sprite/animation choice. It is a PURE module (no DOM, no pixi.js),
 * so it can be tested in the node environment — and it MUST be, because two of its
 * guarantees are load-bearing contracts:
 *
 *  - **the enemy-type classifier** (contracts/renderer-asset-mapping.md §4) is the
 *    whole reason five enemy types can have five distinct sprites WITHOUT adding a
 *    type tag to `src/` (which would change the snapshot digest and break the
 *    "lossless" invariant). If it silently degrades, every enemy becomes the same
 *    blob and FR-005 fails with no test going red — hence the literal pins below.
 *  - **the facing quantiser** must be stable at the `±PI` seam, or a body walking
 *    straight left jitters between two facings (FR-003).
 *
 * Tests use the REAL factories and the REAL shipped config table (`EnemyFactory`,
 * `assets/data/enemies.json` via the harness bootstrap), never a mock.
 */

import { describe, expect, it } from 'vitest';

import { World } from '../../src/ecs/World';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { ActionState } from '../../src/ecs/components/StateComponent';
import { Faction, FactionComponent } from '../../src/ecs/components/FactionComponent';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { PickupKind } from '../../src/ecs/components/PickupComponent';
import { spawnCombatant } from '../../src/ecs/prefabs/spawn-helpers';
import { testElite } from '../harness/config-fixtures';

import {
  ANIMATION_STATES,
  ENEMY_SPRITE_IDS,
  GENERIC_ENEMY_SPRITE_ID,
  PLAYER_SPRITE_ID,
  animationCandidates,
  animationFromState,
  enemySpriteId,
  enemyTypeFromSignature,
  facingFromRadians,
  hurtboxSpriteScale,
  pickupIconId,
  selectSprite,
  spriteIdFor,
} from '../../client/assets/sprite-map';

/** A bare world with no systems — the classifier reads components, not ticks. */
function bareWorld(): World {
  return new World({ seed: 1 });
}

describe('facingFromRadians — 4-way quantisation (FR-003, contract §3.4)', () => {
  it('maps the four cardinal headings', () => {
    expect(facingFromRadians(0)).toBe('right');
    expect(facingFromRadians(Math.PI / 2)).toBe('down');
    expect(facingFromRadians(-Math.PI / 2)).toBe('up');
    expect(facingFromRadians(Math.PI)).toBe('left');
    expect(facingFromRadians(-Math.PI)).toBe('left');
  });

  it('does NOT jitter across the ±PI seam (the whole point of the quantiser)', () => {
    // A body walking straight left can report +PI or -PI from one tick to the
    // next (they are the same heading). Both ends — and a hair inside each — MUST
    // resolve to the SAME facing, or the sprite would flip every tick.
    const eps = 1e-9;
    expect(facingFromRadians(Math.PI)).toBe('left');
    expect(facingFromRadians(-Math.PI)).toBe('left');
    expect(facingFromRadians(Math.PI - eps)).toBe('left');
    expect(facingFromRadians(-Math.PI + eps)).toBe('left');
    // And a sweep just inside the seam stays put rather than flapping.
    for (let i = 0; i < 20; i += 1) {
      const angle = Math.PI - i * 0.01;
      expect(facingFromRadians(angle)).toBe('left');
      expect(facingFromRadians(-Math.PI + i * 0.01)).toBe('left');
    }
  });

  it('is a total function: non-finite input degrades instead of throwing', () => {
    expect(facingFromRadians(Number.NaN)).toBe('down');
    expect(facingFromRadians(Number.POSITIVE_INFINITY)).toBe('down');
  });

  it('agrees with the renderer convention: 0 rad points +x, +PI/2 points +y', () => {
    // The renderer sets `container.rotation = facingRadians` and draws the facing
    // indicator along LOCAL +x, so "right" must be 0 and "down" +PI/2 (y grows
    // downwards on screen). Asserting the literals keeps the two in step.
    expect(facingFromRadians(0.1)).toBe('right');
    expect(facingFromRadians(1.4)).toBe('down');
    expect(facingFromRadians(-1.4)).toBe('up');
    expect(facingFromRadians(3.0)).toBe('left');
  });
});

describe('animationFromState — total over ActionState (E4)', () => {
  it('maps every declared state to a literal animation name', () => {
    expect(animationFromState(ActionState.IDLE)).toBe('idle');
    expect(animationFromState(ActionState.MOVING)).toBe('move');
    expect(animationFromState(ActionState.DASHING)).toBe('dash');
    expect(animationFromState(ActionState.ATTACKING)).toBe('attack');
    expect(animationFromState(ActionState.HITSTUN)).toBe('hit');
  });

  it('covers EVERY member of ActionState (no enum member left undefined)', () => {
    const members = Object.values(ActionState);
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      const anim = animationFromState(member);
      expect(ANIMATION_STATES).toContain(anim);
    }
  });

  it('falls back to idle for a missing state rather than throwing', () => {
    expect(animationFromState(undefined)).toBe('idle');
  });
});

describe('enemyTypeFromSignature — the frozen capability table (E3 / contract §4)', () => {
  it('classifies all five DECLARED enemy types correctly (5/5)', () => {
    const world = bareWorld();
    // The five categories declared in assets/data/enemies.json, spawned the way
    // production spawns them: `spawn` for the four ordinary types, and
    // `spawnElite` for `elite` (the base `elite` config declares no capability of
    // its own — see the limitation test below).
    const grunt = EnemyFactory.spawn(world, 'grunt', { x: 0, y: 0 });
    const raider = EnemyFactory.spawn(world, 'raider', { x: 1, y: 0 });
    const bomber = EnemyFactory.spawn(world, 'bomber', { x: 2, y: 0 });
    const gunner = EnemyFactory.spawn(world, 'gunner', { x: 3, y: 0 });
    const elite = EnemyFactory.spawnElite(world, 'elite', { x: 4, y: 0 });

    expect(enemyTypeFromSignature(world, grunt)).toBe('grunt');
    expect(enemyTypeFromSignature(world, raider)).toBe('raider');
    expect(enemyTypeFromSignature(world, bomber)).toBe('bomber');
    expect(enemyTypeFromSignature(world, gunner)).toBe('gunner');
    expect(enemyTypeFromSignature(world, elite)).toBe('elite');
  });

  it('classifies an elite of a grunt-shaped base as elite (armor, no hazard)', () => {
    const world = bareWorld();
    // contracts/renderer-asset-mapping.md §5 pins `spawnElite(world, 'grunt')`.
    // The SHIPPED table only gives `elite` an `elite` variant block, so
    // `spawnElite(world, 'grunt')` is rejected by the engine (`SchemaError`) —
    // correctly, since there is no elite grunt to spawn. The harness fixture
    // registers an elite-capable grunt-shaped type, which is the faithful
    // translation of that pin against real data.
    const eliteGrunt = EnemyFactory.spawnElite(world, ...testElite({ x: 0, y: 0 }));
    expect(enemyTypeFromSignature(world, eliteGrunt)).toBe('elite');
  });

  it('REGRESSION (documented limitation): a base `elite` spawn carries no capability', () => {
    // `assets/data/enemies.json`'s `elite` entry puts armor ONLY in its `elite`
    // variant block, so `EnemyFactory.spawn(world, 'elite')` assembles a body whose
    // component set is byte-for-byte a grunt's. No read-only signal can tell them
    // apart, and inventing one would mean writing a type tag into `src/` — which
    // would change the snapshot digest and break the lossless invariant.
    //
    // This assertion exists so the boundary is VISIBLE rather than surprising: the
    // elite sprite is reached through `spawnElite`, which is the documented way to
    // make an elite (and what contract §5 pins).
    const world = bareWorld();
    const plainElite = EnemyFactory.spawn(world, 'elite', { x: 0, y: 0 });
    expect(enemyTypeFromSignature(world, plainElite)).toBe('grunt');
  });

  it('returns unknown for an entity that is not a combatant at all', () => {
    const world = bareWorld();
    const orphan = world.createEntity();
    world.addComponent(orphan.id, new TransformComponent(0, 0, 0));
    expect(enemyTypeFromSignature(world, orphan.id)).toBe('unknown');
  });

  it('returns unknown for the PLAYER rather than mislabelling it an enemy', () => {
    const world = bareWorld();
    const player = spawnCombatant(world, Faction.Player, { x: 0, y: 0 }, true);
    expect(enemyTypeFromSignature(world, player)).toBe('unknown');
  });

  it('is total: every combination of the three capabilities yields a known type', () => {
    const world = bareWorld();
    for (const armor of [false, true]) {
      for (const hazard of [false, true]) {
        for (const ai of [false, true]) {
          const id = spawnCombatant(world, Faction.Enemy, {
            x: 0,
            y: 0,
            ...(armor ? { armor: 10 } : {}),
            ...(hazard ? { hazard: { radius: 1, damage: 1, delayTicks: 10 } } : {}),
            ...(ai ? { ai: {} } : {}),
          });
          const type = enemyTypeFromSignature(world, id);
          expect(ENEMY_SPRITE_IDS).toContain(type);
        }
      }
    }
  });
});

describe('sprite ids (contract asset-manifest.md §2)', () => {
  it('uses the frozen namespace spellings', () => {
    expect(PLAYER_SPRITE_ID).toBe('player.base');
    expect(GENERIC_ENEMY_SPRITE_ID).toBe('enemy.unknown');
    expect(enemySpriteId('gunner')).toBe('enemy.gunner');
    expect(spriteIdFor('player')).toBe('player.base');
    expect(spriteIdFor('bomber')).toBe('enemy.bomber');
  });

  it('declares exactly the six enemy sprite ids, all under the `enemy.` prefix', () => {
    expect([...ENEMY_SPRITE_IDS].sort()).toEqual([
      'bomber',
      'elite',
      'grunt',
      'gunner',
      'raider',
      'unknown',
    ]);
    for (const type of ENEMY_SPRITE_IDS) {
      expect(enemySpriteId(type).startsWith('enemy.')).toBe(true);
    }
  });
});

describe('animationCandidates — the documented fallback chain (contract §3.6)', () => {
  it('tries the exact key, then `<action>.down`, then `idle.down`', () => {
    expect(
      animationCandidates({ spriteId: 'enemy.gunner', action: 'dash', facing: 'up' }),
    ).toEqual(['enemy.gunner.dash.up', 'enemy.gunner.dash.down', 'enemy.gunner.idle.down']);
  });

  it('does not repeat itself when the exact key already IS the fallback', () => {
    expect(animationCandidates({ spriteId: 'player.base', action: 'idle', facing: 'down' })).toEqual([
      'player.base.idle.down',
    ]);
  });
});

describe('selectSprite — the read-only projection used by the renderer', () => {
  it('returns the player sprite with the state-derived action and quantised facing', () => {
    const world = bareWorld();
    const player = spawnCombatant(world, Faction.Player, { x: 0, y: 0, facingRadians: -Math.PI / 2 }, true);
    const selection = selectSprite(world, player);
    expect(selection).toEqual({ spriteId: 'player.base', action: 'idle', facing: 'up' });
  });

  it('returns undefined for an entity with no faction (nothing to draw)', () => {
    const world = bareWorld();
    const orphan = world.createEntity();
    expect(selectSprite(world, orphan.id)).toBeUndefined();
  });

  it('maps an enemy to its type sprite', () => {
    const world = bareWorld();
    const gunner = EnemyFactory.spawn(world, 'gunner', { x: 0, y: 0, facingRadians: Math.PI / 2 });
    expect(selectSprite(world, gunner)).toEqual({
      spriteId: 'enemy.gunner',
      action: 'idle',
      facing: 'down',
    });
  });

  it('never writes to the world (read-only contract §3.1)', () => {
    const world = bareWorld();
    const grunt = EnemyFactory.spawn(world, 'grunt', { x: 2, y: 3, facingRadians: 0.5 });
    // The world's OWN observable shape, spelled out rather than a count: a
    // component added or removed by a "read" would change this string while
    // leaving `entityCount` untouched.
    const digest = (): string =>
      world
        .listEntities()
        .map((id) => `${String(id)}:${world.listComponents(id).join(',')}`)
        .join('|');
    const before = digest();
    selectSprite(world, grunt);
    expect(digest()).toBe(before);
  });

  it('does not consume randomness (determinism contract §3.3)', () => {
    const world = bareWorld();
    const grunt = EnemyFactory.spawn(world, 'grunt', { x: 0, y: 0 });
    // The honest way to prove "no draw": compare the generator's NEXT value
    // against an untouched twin. Asserting "the result is null" would pass for a
    // function that consumed a number and threw it away.
    const twin = new World({ seed: 1 });
    EnemyFactory.spawn(twin, 'grunt', { x: 0, y: 0 });
    selectSprite(world, grunt);
    expect(world.rng.nextUint32()).toBe(twin.rng.nextUint32());
  });
});

describe('pickupIconId — three kinds, three distinct icons (FR-030)', () => {
  it('maps each kind to its own icon', () => {
    // M18 (research.md D4): the in-world pickup decals moved from the `ui.` namespace
    // to `fx.pickup.*`. A pickup renders in WORLD space; `ui.` is the HUD's
    // screen-space skin, so mixing them would make FR-030 unverifiable.
    expect(pickupIconId(PickupKind.GOLD)).toBe('fx.pickup.gold');
    expect(pickupIconId(PickupKind.HEAL)).toBe('fx.pickup.heal');
    expect(pickupIconId(PickupKind.DARKNESS)).toBe('fx.pickup.darkness');
  });

  it('gives the three kinds three DISTINCT ids', () => {
    const ids = [PickupKind.GOLD, PickupKind.HEAL, PickupKind.DARKNESS].map(pickupIconId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('hurtboxSpriteScale — visual body size tracks the collision body (FR-008)', () => {
  it('scales the sprite so its drawn size equals the hurtbox diameter in pixels', () => {
    // radius 0.5 world units, PX_PER_UNIT = 10 -> 10px diameter; a 16px sprite
    // therefore draws at 0.625.
    expect(hurtboxSpriteScale(0.5, 16, 10)).toBeCloseTo(0.625, 9);
    // An elite's bigger body (0.8) draws bigger — the visible body IS the hitbox.
    expect(hurtboxSpriteScale(0.8, 16, 10)).toBeCloseTo(1, 9);
  });

  it('never returns a non-finite or non-positive scale', () => {
    expect(hurtboxSpriteScale(0, 16, 10)).toBeGreaterThan(0);
    expect(Number.isFinite(hurtboxSpriteScale(Number.NaN, 16, 10))).toBe(true);
    expect(hurtboxSpriteScale(0.5, 0, 10)).toBeGreaterThan(0);
  });
});

describe('FactionComponent is still the only thing that decides "player vs enemy"', () => {
  it('agrees with the faction enum for both sides', () => {
    const world = bareWorld();
    const player = spawnCombatant(world, Faction.Player, { x: 0, y: 0 }, true);
    const enemy = spawnCombatant(world, Faction.Enemy, { x: 1, y: 0 });
    expect(world.getComponent(player, FactionComponent)?.faction).toBe(Faction.Player);
    expect(world.getComponent(enemy, FactionComponent)?.faction).toBe(Faction.Enemy);
    expect(selectSprite(world, player)?.spriteId).toBe(PLAYER_SPRITE_ID);
    expect(selectSprite(world, enemy)?.spriteId).not.toBe(PLAYER_SPRITE_ID);
  });
});
