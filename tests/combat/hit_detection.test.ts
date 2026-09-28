/**
 * M2-T01 · Combat hit-detection acceptance tests.
 * See specs/03_combat_hitbox_spec.md §6 (tick-by-tick contract) and §7 (AC-01 .. AC-06),
 * and specs/04_combat_feedback_spec.md §6 for the M2-T02 hit-feedback additions.
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical pipeline (PlayerControllerSystem -> FreezeSystem -> AISystem ->
 * MovementSystem -> DashSystem -> StateSystem -> CombatActionSystem -> CollisionSystem ->
 * StatusEffectSystem -> ModifierSystem -> LifespanSystem) and REAL prefab-assembled entities (PlayerFactory /
 * EnemyFactory). Nothing is mocked, and ticks are advanced one at a time so the
 * timing contract is pinned per tick rather than only at the end.
 *
 * Geometry used throughout (see spec 03 §6 for the derivation):
 *   player at (0, 0) facing +x  ->  attack hitbox centred at (0.75, 0), radius 1.0
 *   enemy hurtbox radius 0.5    ->  overlap iff centre distance < 1.5
 *
 * M2-T02 revision: enemies no longer own a hardware input component, so the enemy
 * dash is driven DIRECTLY through its `IntentComponent` (see {@link armEnemyDash})
 * instead of a global key press. This is the decoupled way and removes the old
 * cross-response where one key press made BOTH player and enemy dash.
 *
 * Grouping:
 *   G0 · combatant assembly + faction rules          (AC-01 support)
 *   G1 · hit detection, dedup, expiry                (AC-02, AC-03, AC-05)
 *   G2 · invulnerability consumption                 (AC-04)
 *   G3 · deterministic replay                        (AC-06)
 */

import { describe, expect, it } from 'vitest';
import {
  ActionState,
  ATTACK_KEY,
  DASH_KEY,
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS,
  DEFAULT_ATTACK_HITBOX_RADIUS,
  DEFAULT_HITSTOP_TICKS,
  DEFAULT_HURTBOX_RADIUS,
  DEFAULT_MAX_HP,
  EnemyFactory,
  Faction,
  FactionComponent,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  HurtboxComponent,
  IntentComponent,
  INVULNERABLE_TAG,
  PlayerFactory,
  StateComponent,
  TransformComponent,
  areHostile,
  createDefaultSystems,
  hasTag,
  vec2,
} from '../../src';
import type { EntityId, Snapshot } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;

/** A hit connects iff the centre distance is strictly below this reach. */
const OVERLAP_REACH = DEFAULT_ATTACK_HITBOX_RADIUS + DEFAULT_HURTBOX_RADIUS; // 1.5

/** The enemy faces +x, i.e. its own attack hitbox spawns AWAY from the player. */
const ENEMY_FACING_AWAY = 0;
/** The enemy faces -y, so a dash carries it toward the player's forward hitbox. */
const ENEMY_FACING_BACK = -Math.PI / 2;

interface Rig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly enemy: EntityId;
}

function makeRig(enemyX: number, enemyY: number, enemyFacing: number): Rig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  const enemy = EnemyFactory.spawn(sim.world, {
    x: enemyX,
    y: enemyY,
    facingRadians: enemyFacing,
    maxSpeed: MAX_SPEED,
  });
  return { sim, player, enemy };
}

function hpOf(rig: Rig, id: EntityId): number {
  const health = rig.sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

function stateOf(rig: Rig, id: EntityId): StateComponent {
  const state = rig.sim.world.getComponent(id, StateComponent);
  if (state === undefined) throw new Error('QA: entity is missing StateComponent');
  return state;
}

function factionOf(rig: Rig, id: EntityId): Faction {
  const component = rig.sim.world.getComponent(id, FactionComponent);
  if (component === undefined) throw new Error('QA: entity is missing FactionComponent');
  return component.faction;
}

/** Ids of every live hitbox owned by the player, in ascending order. */
function playerHitboxes(rig: Rig): EntityId[] {
  return rig.sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
    const hitbox = rig.sim.world.getComponent(id, HitboxComponent);
    return hitbox !== undefined && hitbox.faction === Faction.Player;
  });
}

function onlyPlayerHitbox(rig: Rig): EntityId {
  const hitboxes = playerHitboxes(rig);
  const first = hitboxes[0];
  if (first === undefined) throw new Error('QA: expected exactly one player-owned hitbox');
  if (hitboxes.length !== 1) throw new Error(`QA: expected 1 player hitbox, found ${hitboxes.length}`);
  return first;
}

/** Centre distance between a hitbox and a target — the quantity the circle test uses. */
function centreDistance(rig: Rig, hitboxId: EntityId, targetId: EntityId): number {
  const hitboxTransform = rig.sim.world.getComponent(hitboxId, TransformComponent);
  const targetTransform = rig.sim.world.getComponent(targetId, TransformComponent);
  if (hitboxTransform === undefined || targetTransform === undefined) {
    throw new Error('QA: expected a TransformComponent on both entities');
  }
  return Math.hypot(targetTransform.x - hitboxTransform.x, targetTransform.y - hitboxTransform.y);
}

/**
 * Centre distance from a target to a FIXED world point. Needed because a hitbox is
 * destroyed by LifespanSystem at the very end of its last active tick, so it can no
 * longer be looked up once the connecting tick has been processed.
 */
function distanceToPoint(rig: Rig, x: number, y: number, targetId: EntityId): number {
  const targetTransform = rig.sim.world.getComponent(targetId, TransformComponent);
  if (targetTransform === undefined) throw new Error('QA: target is missing TransformComponent');
  return Math.hypot(targetTransform.x - x, targetTransform.y - y);
}

/**
 * Arm the ENEMY's dash intent pulse for the NEXT tick.
 *
 * Since M2-T02 the enemy owns no `PlayerInputComponent`, so a test cannot drive it
 * with a key event any more. It must raise the logical intent directly — which is
 * exactly how an AI would drive the enemy, and which also removes the old
 * cross-response (a global key press used to make BOTH the player and the enemy
 * dash). The caller must first advance the clock to the tick BEFORE the intended
 * dash tick; the following `step` then lets DashSystem consume the pulse.
 */
function armEnemyDash(rig: Rig): void {
  const intent = rig.sim.world.getComponent(rig.enemy, IntentComponent);
  if (intent === undefined) throw new Error('QA: enemy is missing IntentComponent');
  intent.wantsToDash = true;
}

/* ------------------------------------------------------------------ *
 * G0 · combatant assembly + faction rules                             *
 * ------------------------------------------------------------------ */
describe('G0 · combatant assembly and faction rules (AC-01 support)', () => {
  it('assembles player and enemy on opposite factions, both with health + hurtbox', () => {
    const rig = makeRig(1.5, 0, ENEMY_FACING_AWAY);

    expect(factionOf(rig, rig.player)).toBe(Faction.Player);
    expect(factionOf(rig, rig.enemy)).toBe(Faction.Enemy);
    expect(rig.sim.world.hasComponent(rig.player, HealthComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.player, HurtboxComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.enemy, HealthComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.enemy, HurtboxComponent)).toBe(true);
    expect(hpOf(rig, rig.player)).toBe(DEFAULT_MAX_HP);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP);
  });

  it('treats cross-faction pairs as hostile and same-faction pairs as friendly', () => {
    expect(areHostile(Faction.Player, Faction.Enemy)).toBe(true);
    expect(areHostile(Faction.Enemy, Faction.Player)).toBe(true);
    expect(areHostile(Faction.Player, Faction.Player)).toBe(false);
    expect(areHostile(Faction.Enemy, Faction.Enemy)).toBe(false);
  });

  it('rejects combatant configurations that cannot be valid', () => {
    const sim = new GameSimulator();
    expect(() => EnemyFactory.spawn(sim.world, { hurtboxRadius: 0 })).toThrow(RangeError);
    expect(() => EnemyFactory.spawn(sim.world, { maxHp: 0 })).toThrow(RangeError);
    expect(() => EnemyFactory.spawn(sim.world, { hp: 200, maxHp: 100 })).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ *
 * G1 · hit detection, dedup and expiry                                *
 * ------------------------------------------------------------------ */
describe('G1 · hit detection, multi-hit guard and lifespan (AC-02, AC-03, AC-05)', () => {
  it('AC-02/AC-03 · an attack spawns one forward hitbox that damages the enemy in front', () => {
    const rig = makeRig(1.5, 0, ENEMY_FACING_AWAY);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    rig.sim.step(1); // tick 0

    expect(stateOf(rig, rig.player).state).toBe(ActionState.ATTACKING);
    expect(playerHitboxes(rig)).toHaveLength(1);
    expect(centreDistance(rig, onlyPlayerHitbox(rig), rig.enemy)).toBeLessThan(OVERLAP_REACH);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
  });

  it('AC-01 · never damages a same-faction target (no self-damage, no friendly fire)', () => {
    const rig = makeRig(1.5, 0, ENEMY_FACING_AWAY);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    rig.sim.step(3);

    // The player's own hitbox genuinely overlaps the player's own hurtbox ...
    const hitbox = onlyPlayerHitbox(rig);
    expect(centreDistance(rig, hitbox, rig.player)).toBeLessThan(OVERLAP_REACH);
    // ... yet the player is untouched, because both sides are Faction.Player.
    expect(hpOf(rig, rig.player)).toBe(DEFAULT_MAX_HP);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
  });

  it('AC-03 · a single hitbox deals damage at most once per target', () => {
    const rig = makeRig(1.5, 0, ENEMY_FACING_AWAY);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the hit lands
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);

    // The circle keeps overlapping the hitstop-frozen enemy for the whole freeze
    // (M2-T02: the enemy cannot move while frozen).
    const hitbox = onlyPlayerHitbox(rig);
    rig.sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..4 — frozen, so the enemy has not moved
    expect(centreDistance(rig, hitbox, rig.enemy)).toBeLessThan(OVERLAP_REACH);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);

    // Knockback then carries the enemy out of reach, but the hp never drops a
    // second time: the multi-hit guard is per (hitbox, target).
    rig.sim.step(10);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
  });

  it('AC-05 · the hitbox is destroyed once its lifespan lapses', () => {
    const rig = makeRig(1.5, 0, ENEMY_FACING_AWAY);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1);
    expect(playerHitboxes(rig)).toHaveLength(1);

    rig.sim.step(DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS - 1); // ticks 1..14

    expect(rig.sim.tick).toBe(DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS);
    expect(playerHitboxes(rig)).toHaveLength(0);
  });

  it('AC-02 · the hitbox is placed forward along the attacker facing, not on top of it', () => {
    const rig = makeRig(1.5, 0, ENEMY_FACING_AWAY);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1);

    const hitboxTransform = rig.sim.world.getComponent(onlyPlayerHitbox(rig), TransformComponent);
    if (hitboxTransform === undefined) throw new Error('QA: hitbox has no transform');
    const playerTransform = rig.sim.world.getComponent(rig.player, TransformComponent);
    if (playerTransform === undefined) throw new Error('QA: player has no transform');

    expect(hitboxTransform.x).toBeGreaterThan(playerTransform.x);
    expect(Math.abs(hitboxTransform.y - playerTransform.y)).toBeLessThan(1e-9);
  });
});

/* ------------------------------------------------------------------ *
 * G2 · invulnerability consumption (the M1 <-> M2 integration point)  *
 * ------------------------------------------------------------------ */
describe('G2 · invulnerability consumption (AC-04)', () => {
  it('AC-04 · an i-frame target ignores the hit: no damage while the tag is held', () => {
    // Enemy starts 1.9 units up-field and dashes DOWN into the player's hitbox.
    const rig = makeRig(0, 1.9, ENEMY_FACING_BACK);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the player's hitbox spawns
    armEnemyDash(rig); // the enemy dash starts on tick 1

    rig.sim.step(5); // ticks 1..5 — mid-dash, inside the i-frame window
    expect(rig.sim.tick).toBe(6);
    expect(hasTag(rig.sim.world, rig.enemy, INVULNERABLE_TAG)).toBe(true);
    expect(stateOf(rig, rig.enemy).state).toBe(ActionState.DASHING);
    const hitbox = onlyPlayerHitbox(rig);
    expect(centreDistance(rig, hitbox, rig.enemy)).toBeLessThan(OVERLAP_REACH);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP);

    rig.sim.step(7); // ticks 6..12 — through the LAST i-frame tick, still overlapping
    expect(rig.sim.tick).toBe(13);
    expect(hasTag(rig.sim.world, rig.enemy, INVULNERABLE_TAG)).toBe(true);
    expect(centreDistance(rig, hitbox, rig.enemy)).toBeLessThan(OVERLAP_REACH);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP);
  });

  it('AC-04 · the very same overlap does damage once the i-frame window has lapsed', () => {
    // Further up-field: the enemy only reaches the hitbox AFTER the window closes,
    // so the first overlap of the whole scenario is a damaging one.
    const rig = makeRig(0, 4.4, ENEMY_FACING_BACK);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the player's hitbox spawns
    armEnemyDash(rig); // the enemy dash starts on tick 1

    rig.sim.step(13); // ticks 1..13 — the tag is dropped ON tick 13, enemy still out of reach
    expect(hasTag(rig.sim.world, rig.enemy, INVULNERABLE_TAG)).toBe(false);
    expect(stateOf(rig, rig.enemy).state).toBe(ActionState.DASHING); // still in dash recovery
    const hitboxTransform = rig.sim.world.getComponent(onlyPlayerHitbox(rig), TransformComponent);
    if (hitboxTransform === undefined) throw new Error('QA: hitbox has no transform');
    expect(distanceToPoint(rig, hitboxTransform.x, hitboxTransform.y, rig.enemy)).toBeGreaterThan(
      OVERLAP_REACH,
    );
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP);

    rig.sim.step(1); // tick 14 — dashes into the still-live hitbox
    expect(hasTag(rig.sim.world, rig.enemy, INVULNERABLE_TAG)).toBe(false);
    expect(distanceToPoint(rig, hitboxTransform.x, hitboxTransform.y, rig.enemy)).toBeLessThan(
      OVERLAP_REACH,
    );
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
  });

  it('AC-04 · an i-frame hit is ignored entirely, so the SAME hitbox still connects later', () => {
    const rig = makeRig(0, 1.9, ENEMY_FACING_BACK);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the player's hitbox spawns
    armEnemyDash(rig); // the enemy dash starts on tick 1

    rig.sim.step(12); // ticks 1..12 — the WHOLE i-frame window is overlapped
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP);

    const hitboxId = onlyPlayerHitbox(rig);
    const ledger = rig.sim.world.getComponent(hitboxId, HitboxComponent);
    if (ledger === undefined) throw new Error('QA: hitbox has no HitboxComponent');
    // The invulnerable target must NOT have been recorded in the hit ledger,
    // otherwise it could never be hit by this hitbox once the window lapsed.
    expect(ledger.hitEntities).not.toContain(rig.enemy);

    rig.sim.step(1); // tick 13 — the tag drops, and the very same hitbox connects
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(ledger.hitEntities).toContain(rig.enemy);
  });
});

/* ------------------------------------------------------------------ *
 * G3 · deterministic replay                                           *
 * ------------------------------------------------------------------ */
describe('G3 · deterministic replay (AC-06)', () => {
  it('replays a full combat script identically, tick by tick', () => {
    const runScript = (): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
      const enemy = EnemyFactory.spawn(sim.world, {
        x: 0,
        y: 1.9,
        facingRadians: ENEMY_FACING_BACK,
        maxSpeed: MAX_SPEED,
      });

      sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      // Dash entry is gated to IDLE/MOVING (spec 02 §4.1), so a dash pressed while
      // the player is ATTACKING is dropped. The attack opened on tick 0 exits on
      // tick 17 (12 counts + 4 frozen + the entry tick), so press the dash at the
      // first legal tick afterwards — keeping the script a REAL dash replay.
      sim.inject({ kind: 'keyDown', tick: 18, key: DASH_KEY }); // player dash starts on tick 18
      sim.inject({ kind: 'move', tick: 4, vector: vec2(0, -1) });
      sim.inject({ kind: 'keyUp', tick: 28, key: DASH_KEY });
      sim.inject({ kind: 'keyDown', tick: 20, key: ATTACK_KEY });
      sim.inject({ kind: 'keyUp', tick: 22, key: ATTACK_KEY });
      sim.inject({ kind: 'keyDown', tick: 24, key: ATTACK_KEY });

      const frames: Snapshot[] = [];
      sim.step(1); // tick 0
      frames.push(sim.snapshot());
      // M2-T02: drive the enemy through its intent (it owns no hardware input).
      const intent = sim.world.getComponent(enemy, IntentComponent);
      if (intent === undefined) throw new Error('QA: enemy is missing IntentComponent');
      intent.wantsToDash = true; // enemy dash starts on tick 1
      for (let i = 1; i < 40; i += 1) {
        sim.step(1);
        frames.push(sim.snapshot());
      }
      return frames;
    };

    const a = runScript();
    const b = runScript();
    expect(a).toHaveLength(40);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
    expect(a).toEqual(b);
  });
});
