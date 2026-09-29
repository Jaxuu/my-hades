/**
 * DeathSystem — the death transition. See specs/08_encounter_and_death_spec.md §4.1.
 *
 * Pipeline position: AFTER `ModifierSystem`, BEFORE `LifespanSystem`. That slot is
 * the whole tick-phase contract of AC-01, so it is worth spelling out:
 *
 *  - It runs after EVERY damage source has resolved. Damage enters the world in
 *    exactly two places — `CollisionSystem` (hitbox settlements) and
 *    `StatusEffectSystem` (damage-over-time ticks) — and both sit upstream of this
 *    system. `ModifierSystem` sits between them and injects entities but deals no
 *    damage itself, so by the time we run, `HealthComponent.hp` is final for the
 *    tick. Death is therefore decided ONCE, on a settled value, and can never be
 *    decided on a half-resolved tick.
 *  - It runs after `ModifierSystem` deliberately: a hit that LANDED this tick is
 *    fully reacted to (boons, injected hitboxes) before the tick's dead are
 *    collected. "The tick plays out completely, then the dead are counted" is the
 *    literal reading of AC-01 ("HP 归零的当 Tick 末尾进入死亡状态"), and it means an
 *    entity that dies on the tick it lands a hit still gets credit for that hit.
 *  - It runs BEFORE `LifespanSystem` because `LifespanSystem` must stay LAST
 *    (spec 05 C7): if it ran after us it could destroy a hitbox that has not yet
 *    been collision-tested this tick, shortening every `activeTicks` window by one.
 *
 * What it does, per dying entity (ascending id — `World.query` guarantees it):
 *
 *   1. mount `DeadTagComponent` (`markDead` — idempotent)
 *   2. NEUTRALISE the corpse's intent
 *   3. publish one `EntityDeathEvent`
 *
 * Step 2 is not cosmetic. Every intent producer (`PlayerControllerSystem`,
 * `AISystem`) now SKIPS dead entities (spec 08 §4.2), which is precisely what
 * makes "a corpse produces no intent" true — but it also means nothing will ever
 * write the corpse's intent again, so whatever it held at the moment of death
 * would otherwise stay frozen in the snapshot forever. Zeroing it here makes
 * AC-01's "不再输出意图" a directly observable fact (`moveVector === (0,0)`,
 * `wantsToDash === false`, `wantsToAttack === false`, `wantsToCast === false`,
 * `aimRadians === null`) instead of an absence of writes that a test can only infer.
 *
 * It does NOT destroy the entity. The corpse is RETAINED (spec 08 §10 trade-off 1):
 * the encounter scheduler must be able to distinguish "my wave member is dead" from
 * "this id never existed", and it can only do that if the corpse keeps its
 * components. Recycling is a separate, opt-in concern for a later milestone.
 *
 * Holds NO cross-tick hidden state: the only field is the injected bus, and it is
 * CLEARED at the start of every update, so the bus can never accumulate events
 * across ticks (spec 08 §3.3). The death decision itself is read from
 * `HealthComponent.hp` + `DeadTagComponent` — both component data.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import { EventQueue } from '../events';
import type { EntityDeathEvent } from '../events';
import { vec2 } from '../../core/math';
import { HealthComponent } from '../components/HealthComponent';
import { DeadTagComponent, markDead } from '../components/DeadTagComponent';
import { IntentComponent } from '../components/IntentComponent';
import { PlayerInputComponent } from '../components/PlayerInputComponent';
import { markRunFailed } from '../components/GameStateComponent';

export class DeathSystem implements System {
  public readonly name = 'DeathSystem';

  /**
   * Death bus. Injected so a caller (or a test) can observe the deaths of a tick;
   * the default keeps the system usable standalone.
   */
  private readonly events: EventQueue<EntityDeathEvent>;

  constructor(events: EventQueue<EntityDeathEvent> = new EventQueue<EntityDeathEvent>()) {
    this.events = events;
  }

  public update(world: World, ctx: SystemContext): void {
    // Bound the bus to ONE tick. Unlike the hit bus there is no mandatory
    // consumer, so a `drain()` would be a no-op read: `clear()` is the honest
    // primitive here. Consequence (and it is the intended contract): after
    // `step()`, the bus holds exactly the deaths resolved on the tick just
    // processed — never a backlog.
    this.events.clear();

    for (const id of world.query(HealthComponent)) {
      const health = world.getComponent(id, HealthComponent);
      if (health === undefined) continue;

      // `hp` is already clamped at 0 by `applyDamage`, so `<= 0` is the exact
      // "out of hit points" predicate — no negative-hp edge case to handle.
      if (health.hp > 0) continue;

      // Already dead: the transition has been applied, and re-applying it would
      // publish a duplicate event. This is also what makes the bus hold exactly
      // one event per entity for the whole run.
      if (world.hasComponent(id, DeadTagComponent)) continue;

      markDead(world, id);
      this.neutraliseIntent(world, id);
      this.events.emit({ tick: ctx.tick, entityId: id });
      this.failRunIfPlayer(world, id);
    }
  }

  /**
   * Drop the tick-scoped death bus at a run boundary (M8-T01, spec 14 §4.5).
   *
   * `GameSimulator.restartRun` calls this through `Scheduler.reset`. The bus is
   * cleared at the START of every update anyway, so this is not what bounds it —
   * it is what stops a RESTART from leaving a bus full of events that reference
   * entities the restart just destroyed. Without it, a test that asserts "no
   * stale events survive a restart" would be asserting something false.
   */
  public reset(): void {
    this.events.clear();
  }

  /**
   * If the entity that just died is the PLAYER, the whole RUN is over
   * (M8-T01, spec 14 AC-02 / §4.4).
   *
   * The player predicate is `PlayerInputComponent`, not `Faction.Player`: the
   * hardware-input component is mounted on the player and ONLY on the player
   * (spec 01 §3.3), which makes "owns a device" a structural identity in this
   * engine rather than a gameplay label that future content could reassign.
   *
   * Written HERE, in the same iteration that mounts the death tag, because this
   * is the one place that knows "a death just resolved and this is who it was".
   * The transition is monotone: `markRunFailed` only ever moves
   * `PLAYING -> RUN_FAILED`, and the only way back is a full `restartRun`
   * (spec 14 I7). A world with no game-state singleton is a no-op — a world that
   * never assembled a run cannot fail one (spec 14 AC-11).
   *
   * Note it does NOT pause the simulation. `step()` keeps running so that a
   * replay containing a death stays replayable; what stops is the player's
   * intent (`PlayerControllerSystem`) and the encounter scheduler
   * (`EncounterSystem`).
   */
  private failRunIfPlayer(world: World, id: EntityId): void {
    if (!world.hasComponent(id, PlayerInputComponent)) return;
    markRunFailed(world);
  }

  /**
   * Zero the corpse's intent so "no intent output" is observable rather than
   * merely implied. Missing `IntentComponent` (a bare world entity, a hitbox) is a
   * silent no-op — the same opt-in shape every other component consumer follows.
   */
  private neutraliseIntent(world: World, id: EntityId): void {
    const intent = world.getComponent(id, IntentComponent);
    if (intent === undefined) return;
    intent.moveVector = vec2(0, 0);
    intent.wantsToDash = false;
    intent.wantsToAttack = false;
    intent.wantsToCast = false;
    // M8-T01: the hazard pulse too — a corpse must not be left holding a bomb it
    // never planted (spec 14 AC-04).
    intent.wantsToHazard = false;
    intent.aimRadians = null;
  }
}
