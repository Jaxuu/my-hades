/**
 * HazardSystem — the delayed area-of-effect lifecycle (M8-T01).
 * See specs/14_aoe_and_run_lifecycle_spec.md §4.1 / §4.2 (AC-01).
 *
 * Pipeline position: the M8-T01 INSERTION, index 4 — immediately AFTER `AISystem`
 * and BEFORE `MovementSystem` (the full 16-segment order lives in `pipeline.ts`).
 * Three slots are forced:
 *
 *  - AFTER `AISystem` because the `wantsToHazard` pulse is raised by the AI in
 *    THIS tick; a consumer that ran earlier would always be one tick late.
 *  - BEFORE `CollisionSystem` because the blast must be collision-tested on the
 *    very tick it is spawned. That is what makes `activeTicks = 1` mean "exactly
 *    one hit test" instead of "a silent no-op" (spec 14 §4.1).
 *  - BEFORE `MovementSystem` DELIBERATELY: the landing spot is the target's
 *    position at the START of the tick, i.e. "the ground you are standing on
 *    right now". The displacement this tick then becomes the player's dodge
 *    window, which is the entire fantasy of a telegraphed AoE. Running after
 *    `MovementSystem` would land the telegraph where the target ended up, which
 *    downgrades dodging into "get chased and still locked".
 *
 * TWO PHASES, in this order every tick:
 *
 *   A. `plantHazards`  — consume this tick's `wantsToHazard` pulses and spawn a
 *                        telegraph per pulse.
 *   B. `advanceHazards` — decrement every fuse; detonate the ones that reach zero.
 *
 * WHY A BEFORE B: B must see a hazard planted by A in the SAME tick, so that
 * "planted on tick `T` with `delayTicks = N`" means "detonates on tick `T + N`".
 * With B first, every planted hazard would silently gain one tick of fuse — and
 * the two ways of creating a hazard (a pulse, or a direct `spawnHazard`) would
 * disagree about their own timing (spec 14 §4.2).
 *
 * NOT GATED ON FREEZE, and that is the point of the mechanic (spec 14 I4): a
 * hazard's fuse is the ENVIRONMENT's clock, not an action's. Hitstop pauses
 * bodies; letting a frozen enemy stretch a bomb's fuse would couple two
 * orthogonal timelines. Nothing here reads `isFrozen`, for the hazard itself or
 * for its author.
 *
 * AC-03 COMPOSITE HAZARDS (M11-T01, spec 18 §4.3). `detonate` gains one optional
 * tail: a hazard whose `onExplodeConfigId` is non-null spawns one further hazard in
 * place (from the `hazards` config table) right after its blast, and RETURNS its id.
 * `advanceHazards` drains a WORK QUEUE rather than a fixed snapshot, so the child is
 * appended and its fuse starts on the very tick that spawned it — exactly like a
 * hazard planted by phase A. That keeps ONE rule for both phases: "planted on tick
 * `T` with `delayTicks = N` detonates on tick `T + N`". `MAX_HAZARD_CHAIN_PER_TICK`
 * bounds a single tick's detonations as defence in depth; a well-formed config can
 * never reach it, and `DataManager.loadAll` rejects a cyclic `onExplodeConfigId`
 * graph outright. The referenced id is guaranteed to exist by the load-time
 * cross-table check, so the runtime lookup never throws.
 *
 * Holds NO cross-tick hidden state: the entire lifecycle is `delayTicks` on the
 * component (spec 00 §6.1). The class owns only its name.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import type { Vec2 } from '../../core/math';
import { vec2 } from '../../core/math';
import {
  DEFAULT_HAZARD_BLAST_ACTIVE_TICKS,
  DEFAULT_HAZARD_BLAST_HITSTOP_TICKS,
  DEFAULT_HAZARD_BLAST_KNOCKBACK,
  HazardComponent,
  spawnHazard,
} from '../components/HazardComponent';
import { HazardCasterComponent } from '../components/HazardCasterComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import { IntentComponent } from '../components/IntentComponent';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent } from '../components/FactionComponent';
import { AIControllerComponent } from '../components/AIControllerComponent';
import { isDead } from '../components/DeadTagComponent';
import { DataManager } from '../../data/DataManager';

/**
 * 单 Tick 内最多引爆多少个 Hazard（含连锁）。
 *
 * 纵深防御（defence in depth），不是一条玩法规则：合法配置**永远**达不到它。
 * `DataManager.loadAll` 在加载期就把 `onExplodeConfigId` 引用图断言为 DAG，所以一条
 * 链的每一步都严格前进、单帧引爆数被「当前存活 Hazard 数」自然约束；这个上限只可能
 * 被**畸形配置**（一个绕过了加载期校验的环）触碰。触及后 `advanceHazards` 不再向队列
 * 追加子雷；已经生成的子雷不受影响，仍以正常引信在后续 Tick 被处理。
 */
export const MAX_HAZARD_CHAIN_PER_TICK = 256;

export class HazardSystem implements System {
  public readonly name = 'HazardSystem';

  public update(world: World, _ctx: SystemContext): void {
    this.plantHazards(world);
    this.advanceHazards(world);
  }

  /**
   * Phase A — turn this tick's `wantsToHazard` pulses into telegraphs.
   *
   * The query is every COMBATANT (`Intent` + `Transform` + `Faction`), not only
   * entities that own a `HazardCasterComponent`. That is deliberate and mirrors
   * `CombatActionSystem`: the pulse is a one-tick wire, and the CONSUMER is
   * responsible for clearing it whether or not it can honour it. If only casters
   * were visited, a `wantsToHazard` written onto a non-caster would sit there
   * forever — a buffered input, which is exactly what the pulse contract forbids
   * (spec 03 §4.3). So: everyone reads and clears; only a caster plants.
   *
   * Gate order mirrors `CombatActionSystem` exactly, and for the same reasons:
   *
   *  1. DEATH first (`isDead`), BEFORE the read-and-clear. A corpse cannot plant
   *     a bomb, and — critically — its hand-written pulse must be neither
   *     executed nor buffered. (This still lets an enemy plant on the very tick
   *     it is killed by a later system: the tag is not written until
   *     `DeathSystem` runs, at index 12.)
   *  2. Read-and-clear the pulse UNCONDITIONALLY, before any other gate. A pulse
   *     the gate rejects is DROPPED, never buffered.
   */
  private plantHazards(world: World): void {
    const ids = world.query(IntentComponent, TransformComponent, FactionComponent);

    for (const id of ids) {
      // A corpse plants nothing (spec 08 §4.2).
      if (isDead(world, id)) continue;

      const intent = world.getComponent(id, IntentComponent);
      const transform = world.getComponent(id, TransformComponent);
      const faction = world.getComponent(id, FactionComponent);
      if (intent === undefined || transform === undefined || faction === undefined) continue;

      const wantsToHazard = intent.wantsToHazard;
      intent.wantsToHazard = false;
      if (!wantsToHazard) continue;

      // Not a planter: the pulse is consumed and dropped, exactly as an attack
      // pulse is dropped by an entity that cannot act on it.
      const caster = world.getComponent(id, HazardCasterComponent);
      if (caster === undefined) continue;

      const landing = this.resolveLandingSpot(world, id, transform);
      spawnHazard(world, {
        x: landing.x,
        y: landing.y,
        radius: caster.radius,
        damage: caster.damage,
        delayTicks: caster.delayTicks,
        faction: faction.faction,
        ownerEntityId: id,
      });
    }
  }

  /**
   * Where a pulse's hazard lands: the caster's current AI target if it has a
   * live one, otherwise the caster's own feet.
   *
   * `AIControllerComponent.targetEntityId` is the engine's ONE authoritative
   * answer to "what is this enemy aiming at" (spec 14 §4.2). Reusing it avoids
   * inventing a second position field on `IntentComponent` — which would make
   * the intent layer hold spatial data, contradicting "intent is pure logic"
   * (spec 04 §3.1). A script-driven caster (no AI component) falls back to its
   * own origin, which is a documented, testable rule rather than an accident.
   */
  private resolveLandingSpot(
    world: World,
    casterId: EntityId,
    casterTransform: TransformComponent,
  ): Vec2 {
    const ai = world.getComponent(casterId, AIControllerComponent);
    const targetId = ai?.targetEntityId ?? null;
    if (targetId !== null && world.isAlive(targetId)) {
      const targetTransform = world.getComponent(targetId, TransformComponent);
      if (targetTransform !== undefined) {
        return vec2(targetTransform.x, targetTransform.y);
      }
    }
    return vec2(casterTransform.x, casterTransform.y);
  }

  /**
   * Phase B — advance every fuse, and detonate the ones that reach zero.
   *
   * JUDGE THEN DECREMENT (`if (delayTicks > 0) { delayTicks -= 1; continue; }`),
   * never the other way round. `delayTicks = N` must read as "N ticks of
   * warning": a hazard planted on tick `T` is decremented on tick `T` (phase A
   * runs first), reaches `0` at the end of tick `T + N - 1`, and therefore
   * detonates on tick `T + N`. Decrementing first would blow it one tick early
   * and make the constant lie by one (spec 14 §4.1).
   *
   * WORK QUEUE, not a fixed snapshot (M11-T01, spec 18 §4.3). The queue starts as
   * every hazard alive at the START of this tick; a hazard detonated during this
   * same drain APPENDS its child (via `detonate`'s return value) to the queue. The
   * child is therefore processed by THIS tick's loop, so its fuse is decremented on
   * the tick it was born — which is what makes "planted on tick `T` with
   * `delayTicks = N` detonates on tick `T + N`" hold for phase-A and phase-B hazards
   * alike. (A fixed snapshot would let the child slip one tick — the exact off-by-one
   * this queue removes.)
   *
   * DETERMINISM: the queue is id-ascending to begin with (`World.query` returns a
   * fresh ascending array), and every child id is GREATER than every id already in
   * the queue (`nextId` is monotonic), so appends preserve the ascending order and
   * the drain order is byte-for-byte reproducible.
   *
   * BOUNDED: `MAX_HAZARD_CHAIN_PER_TICK` stops appends after that many detonations in
   * one tick (defence in depth — see the constant). The load-time DAG check in
   * `DataManager.loadAll` makes the cap unreachable for a well-formed config.
   *
   * No freeze gate and no death gate — see the class docstring and spec 14 I4.
   * Destroying entities while iterating is safe: the loop indexes a plain array and
   * simply never revisits an id it has already consumed.
   */
  private advanceHazards(world: World): void {
    // 工作队列：Tick 开始时的全部 Hazard，外加本次排空过程中被引爆者新生成的子雷。
    // 这样"在 Tick T 播种、delayTicks = N ⇒ 在 T + N 爆炸"对相位 A 与相位 B 一律成立。
    const queue: EntityId[] = [...world.query(HazardComponent)];
    let detonationsThisTick = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      if (id === undefined) continue;

      const hazard = world.getComponent(id, HazardComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (hazard === undefined || transform === undefined) continue;

      if (hazard.delayTicks > 0) {
        hazard.delayTicks -= 1; // 判减顺序不变：先判后减
        continue;
      }

      const childId = this.detonate(world, id, hazard, transform);
      detonationsThisTick += 1;
      if (childId !== null && detonationsThisTick < MAX_HAZARD_CHAIN_PER_TICK) {
        queue.push(childId);
      }
    }
  }

  /**
   * Blow up a hazard: spawn the blast hitbox in place, then destroy the
   * telegraph.
   *
   * The blast is a plain `HitboxComponent` entity — the SAME settlement path
   * every other damage source uses, so armor, i-frames, the feedback gate and
   * the `HitEvent` bus all apply without a single special case here.
   *
   * `ownerEntityId` is the HAZARD ITSELF, not the enemy that planted it, and
   * that is a correctness decision rather than a shortcut (spec 14 §4.1 /
   * risk R3). `CollisionSystem`'s owner gate skips a swing whose owner is DEAD —
   * so a blast owned by the thrower would silently become inert whenever the
   * player killed the thrower during the telegraph window, which is exactly the
   * situation a delayed AoE exists to punish. The hazard is destroyed
   * immediately after this call, and `isDead` reports `false` for a destroyed
   * id (spec 08 §3.1), so the owner gate can never retire the blast. This is the
   * same "a hitbox is an independent entity that outlives its author" design the
   * M2/M3 hitboxes already use.
   *
   * Order matters: create the blast BEFORE destroying the telegraph, so the
   * owner id is still a real (if doomed) entity at creation time.
   *
   * AC-03 COMPOSITE / CHAINED EXPLOSIONS (M11-T01, spec 18 §4.3). When the hazard
   * carries a non-null `onExplodeConfigId`, one more hazard is spawned IN PLACE —
   * after the blast, before this telegraph is destroyed — from the referenced
   * `hazards` config template, and its id is RETURNED so `advanceHazards` can append
   * it to THIS tick's drain queue (so the child's fuse starts on the tick it was
   * born). Two properties make this safe and terminating:
   *
   *  - The id's EXISTENCE is guaranteed by the load-time cross-table check in
   *    `DataManager.loadAll`, so the `getHazardConfig` lookup here can never throw
   *    (runtime stays validation-free, spec 18 I5).
   *  - The `onExplodeConfigId` reference graph is asserted ACYCLIC at load time
   *    (`DataManager.loadAll`), so following the chain can never revisit a template;
   *    combined with `MAX_HAZARD_CHAIN_PER_TICK`, a single `step()` cannot explode
   *    without bound (spec 18 risk R1).
   *
   * Order matters and is unchanged: create the blast BEFORE destroying the telegraph
   * (so the owner id is still a real entity at creation time), and spawn the child
   * AFTER the blast but BEFORE the destroy (so the child is never the blast's owner).
   *
   * @returns the child hazard's id when one was spawned, otherwise `null`.
   */
  private detonate(
    world: World,
    hazardId: EntityId,
    hazard: HazardComponent,
    transform: TransformComponent,
  ): EntityId | null {
    const blast = world.createEntity();
    world.addComponent(blast.id, new TransformComponent(transform.x, transform.y, 0));
    world.addComponent(
      blast.id,
      new HitboxComponent(
        hazard.radius,
        hazard.damage,
        DEFAULT_HAZARD_BLAST_ACTIVE_TICKS,
        hazard.faction,
        hazardId,
        DEFAULT_HAZARD_BLAST_HITSTOP_TICKS,
        DEFAULT_HAZARD_BLAST_KNOCKBACK,
        [], // hitEntities — nothing struck yet
        null, // sourceModifier — a hazard is a BASE hit, never a boon-injected one
        false, // destroyOnHit — an AoE must reach EVERY hostile inside it
        false, // destroyOnWall — a static blast is never wall-resolved anyway
      ),
    );

    // M11-T01 AC-03 — 复合危险地形：爆炸后按模板原地再生成一个次级 Hazard。
    let childId: EntityId | null = null;
    if (hazard.onExplodeConfigId !== null) {
      const child = DataManager.getHazardConfig(hazard.onExplodeConfigId);
      childId = spawnHazard(world, {
        x: transform.x,
        y: transform.y,
        radius: child.radius,
        damage: child.damage,
        delayTicks: child.delayTicks,
        faction: hazard.faction,
        ownerEntityId: hazard.ownerEntityId,
        ...(child.onExplodeConfigId === undefined ? {} : { onExplodeConfigId: child.onExplodeConfigId }),
      });
    }

    world.destroyEntity(hazardId);
    return childId;
  }
}
