/**
 * PlayerControllerSystem — hardware input -> logical intent.
 * See specs/04_combat_feedback_spec.md §4.1 / §5.1.
 *
 * Pipeline position: FIRST, before FreezeSystem and every per-entity advance
 * system. It takes over the `bindInput` phase that used to live inside
 * MovementSystem (M2-T02 architecture refactor): the hardware layer is bound to
 * the PLAYER's `PlayerInputComponent` and then translated into an
 * `IntentComponent` that every gameplay system reads instead of the device.
 *
 * Two phases, executed in this order every tick:
 *
 *  1. `bindHardwareInput` — the former MovementSystem.bindInput, moved verbatim.
 *     Only entities owning `PlayerInputComponent` (i.e. the player) participate,
 *     so the old "one global input frame drives every entity" cross-response is
 *     gone (spec 03 §10 trade-off 4 — now root-fixed).
 *
 *  2. `deriveIntent` — for every entity owning BOTH `PlayerInputComponent` and
 *     `IntentComponent`, copy the persistent stick vector across and raise the
 *     single-tick dash / attack pulses from the rising-edge flags. Enemies own an
 *     `IntentComponent` but no `PlayerInputComponent`, so their intent is written
 *     by AI / scripts instead of being derived here.
 *
 * Holds NO cross-tick hidden state: the persistent bits live on
 * `PlayerInputComponent` (keysHeld / moveVector), the pulses live on
 * `IntentComponent` (spec 00 §6.1).
 *
 * DEAD entities are skipped in BOTH phases (M4-T02, spec 08 §4.2). Phase 2 is the
 * one that matters: `deriveIntent` copies the persistent stick vector onto the
 * intent every tick, so without the gate a player who dies while holding the stick
 * would have its intent RE-FILLED one tick after `DeathSystem` neutralised it —
 * leaving a corpse that visibly "still wants to walk". Skipping phase 1 as well
 * keeps a corpse's held-key set frozen instead of mutating state nothing can use.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { vec2 } from '../../core/math';
import { ATTACK_KEY, CAST_KEY, DASH_KEY, PlayerInputComponent } from '../components/PlayerInputComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isDead } from '../components/DeadTagComponent';
import { findRewardDraft } from '../components/EncounterStateComponent';
import { isRunFailed } from '../components/GameStateComponent';

export class PlayerControllerSystem implements System {
  public readonly name = 'PlayerControllerSystem';

  public update(world: World, ctx: SystemContext): void {
    this.bindHardwareInput(world, ctx);
    this.deriveIntent(world);
  }

  /**
   * Phase 1 — bind the tick's input frame onto the PLAYER's hardware component.
   * `move` overwrites the stick vector; `keyDown`/`keyUp` maintain the held-key set.
   *
   * Both LEVEL and EDGE flags are re-derived from the held-key set on EVERY tick,
   * including ticks with an empty input frame:
   *  - level (`buttonDash` / `buttonAttack` / `buttonCast`) mirrors `keysHeld`, so a
   *    held key keeps reading as pressed on empty ticks — the previous value is
   *    preserved because `keysHeld` is untouched when there are no events;
   *  - edge (`buttonDashJustPressed` / `buttonAttackJustPressed` /
   *    `buttonCastJustPressed`) is a transition of the held-key set:
   *    released-before AND held-after. It is therefore true for exactly one tick,
   *    which is what makes dash/attack/cast fire once per press
   *    (specs/03_combat_hitbox_spec.md §3.6, §4.3; specs/13 §3.5).
   */
  private bindHardwareInput(world: World, ctx: SystemContext): void {
    for (const id of world.query(PlayerInputComponent)) {
      // A corpse's device snapshot is frozen, not updated (spec 08 §4.2).
      if (isDead(world, id)) continue;

      const input = world.getComponent(id, PlayerInputComponent);
      if (input === undefined) continue;

      // Snapshot the held state BEFORE this tick's events, so the edge flags can
      // be derived from the "released -> held" transition.
      const wasDashHeld = input.keysHeld.includes(DASH_KEY);
      const wasAttackHeld = input.keysHeld.includes(ATTACK_KEY);
      const wasCastHeld = input.keysHeld.includes(CAST_KEY);

      if (ctx.input.length > 0) {
        let keysChanged = false;
        for (const event of ctx.input) {
          switch (event.kind) {
            case 'move':
              input.moveVector = event.vector;
              break;
            case 'keyDown':
              if (!input.keysHeld.includes(event.key)) {
                input.keysHeld.push(event.key);
                keysChanged = true;
              }
              break;
            case 'keyUp': {
              const at = input.keysHeld.indexOf(event.key);
              if (at !== -1) {
                input.keysHeld.splice(at, 1);
                keysChanged = true;
              }
              break;
            }
          }
        }
        // Keep the held-key set ordered so snapshots stay deterministic.
        if (keysChanged) input.keysHeld.sort();
      }

      const dashHeld = input.keysHeld.includes(DASH_KEY);
      const attackHeld = input.keysHeld.includes(ATTACK_KEY);
      const castHeld = input.keysHeld.includes(CAST_KEY);

      input.buttonDash = dashHeld;
      input.buttonDashJustPressed = dashHeld && !wasDashHeld;
      input.buttonAttack = attackHeld;
      input.buttonAttackJustPressed = attackHeld && !wasAttackHeld;
      input.buttonCast = castHeld;
      input.buttonCastJustPressed = castHeld && !wasCastHeld;
    }
  }

  /**
   * Phase 2 — translate the player's hardware snapshot into logical intent.
   *
   * `moveVector` is copied (persistent semantics); the dash / attack / cast pulses
   * are raised from the rising-edge flags only. Consumers clear the pulses after
   * their gate check, so they are one-tick wide unless a freeze suppresses the
   * consumer (in which case FreezeSystem clears them instead).
   *
   * M6-T01 adds the DRAFT HOLD (spec 11 AC-02): while the room has an unsettled
   * reward draft open, the player's intent is zeroed instead of derived, so the
   * player stands still and cannot dash or attack until the choice is made.
   *
   * Three things about that gate are deliberate:
   *  - It is here, at the SINGLE intent-generation choke point, rather than as a
   *    per-system gate in Movement / Dash / CombatAction. One write point cannot be
   *    half-applied, and no consumer needs to learn about encounters.
   *  - It suppresses ONLY phase 2. The device snapshot (phase 1) keeps tracking
   *    held keys, so releasing the stick mid-draft is still observed and the player
   *    does not lurch when the draft closes.
   *  - It is evaluated ONCE per tick, before the loop, so the verdict cannot differ
   *    between two entities within the same tick.
   *
   * The gate cannot deadlock the player: `pendingRewards` is cleared by
   * `RewardSystem` in the SAME tick it settles a selection, so the hold lasts
   * exactly as long as the draft is genuinely open.
   *
   * M8-T01 adds the SECOND suppression reason to the same boolean (spec 14
   * AC-05): a `RUN_FAILED` run holds the player's intent. The two are folded
   * into ONE `suppressed` verdict on purpose — this is the single intent
   * generation choke point, so "the player's input is dead" can only ever be
   * half-applied if it were checked in two places. Note the overlap with the
   * death gate below is deliberate rather than redundant: the death gate covers
   * the CORPSE, while this covers the RUN, so "no intent" holds at the choke
   * point instead of depending on a downstream system happening to consult the
   * death tag too.
   */
  private deriveIntent(world: World): void {
    const suppressed = findRewardDraft(world) !== undefined || isRunFailed(world);

    for (const id of world.query(PlayerInputComponent, IntentComponent)) {
      // A corpse must not have its neutralised intent re-derived from the device
      // (spec 08 §4.2) — otherwise "dead entities output no intent" would last
      // exactly one tick.
      if (isDead(world, id)) continue;

      const input = world.getComponent(id, PlayerInputComponent);
      const intent = world.getComponent(id, IntentComponent);
      if (input === undefined || intent === undefined) continue;

      if (suppressed) {
        intent.moveVector = vec2(0, 0);
        intent.wantsToDash = false;
        intent.wantsToAttack = false;
        intent.wantsToCast = false;
        intent.wantsToHazard = false;
        continue;
      }

      intent.moveVector = input.moveVector;
      intent.wantsToDash = input.buttonDashJustPressed;
      intent.wantsToAttack = input.buttonAttackJustPressed;
      intent.wantsToCast = input.buttonCastJustPressed;
      // The player has no hazard key in this milestone, so the pulse is always
      // cleared here rather than left to whatever a previous tick wrote. Keeping
      // it explicit means "the player cannot plant hazards" is a fact stated at
      // the intent producer, not an absence (spec 14 §3.4).
      intent.wantsToHazard = false;
    }
  }
}
