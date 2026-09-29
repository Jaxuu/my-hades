/**
 * Encounter (room) assembly. See specs/08_encounter_and_death_spec.md §3.4.
 *
 * `EncounterFactory.spawn` mounts the room's whole configuration onto ONE bare
 * "world entity" and returns its id — the same `EntityId`-returning prefab shape
 * `PlayerFactory` / `EnemyFactory` follow. The entity is deliberately component-poor
 * (a single `EncounterStateComponent`): a room has no position, no hurtbox and no
 * lifespan, so giving it a `TransformComponent` would be inventing data that means
 * nothing.
 *
 * `resolveEncounterConfig` is the assembly layer's validation, and it validates by
 * DRY-RUNNING the assembly (see below). Keeping validation at load time is what
 * makes the scheduler crash-free: `EncounterSystem` calls `EnemyFactory.spawn`
 * from inside `step()`, so a bad enemy spec surfacing at spawn time would abort a
 * simulation mid-tick. Here it aborts the LOAD instead, before a single tick has
 * run — the same "fail loudly at the seam" discipline `resolveDashTuning` /
 * `resolveAITuning` established (spec 08 AC-05).
 */

import type { EntityId } from '../Entity';
import { World } from '../World';
import { EncounterStateComponent } from '../components/EncounterStateComponent';
import type { EncounterWaveConfig } from '../components/EncounterStateComponent';
import { EnemyFactory } from './EnemyFactory';
import { assertNonNegativeInteger } from './spawn-helpers';

/** A room's full configuration, as handed to `EncounterFactory.spawn`. */
export interface EncounterRoomConfig {
  /** Ordered, non-empty list of waves. Index 0 is the opening wave. */
  readonly waves: readonly EncounterWaveConfig[];
}

/**
 * Validate a room configuration and return its waves.
 *
 * Structural rules (all `@throws RangeError`):
 *  - at least one wave;
 *  - every `delayTicks` a non-negative integer;
 *  - every wave declaring at least one enemy.
 *
 * The last rule is load-bearing rather than cosmetic: the scheduler uses an EMPTY
 * `trackedEntityIds` list as its "this wave has not spawned yet" marker
 * (spec 08 §3.2), so a wave with no enemies would be indistinguishable from an
 * unspawned one and would wedge the room in `WAVE_CLEAR` forever.
 *
 * Per-enemy validation is NOT duplicated here. Instead every enemy spec is
 * assembled once on a THROWAWAY `World` and the result discarded, so the exact
 * rules `spawnCombatant` will apply at spawn time are the rules that run here.
 * Copying those rules would be a second source of truth that silently drifts the
 * moment combatant assembly changes; a scratch world cannot drift.
 */
export function resolveEncounterConfig(config: EncounterRoomConfig): readonly EncounterWaveConfig[] {
  const waves = config.waves;
  if (waves.length === 0) {
    throw new RangeError('encounter.waves must contain at least one wave.');
  }

  for (let index = 0; index < waves.length; index += 1) {
    const wave = waves[index];
    if (wave === undefined) continue;

    const label = `encounter.waves[${String(index)}]`;
    assertNonNegativeInteger(wave.delayTicks, `${label}.delayTicks`);

    if (wave.enemies.length === 0) {
      throw new RangeError(`${label}.enemies must contain at least one enemy spec.`);
    }

    // Dry-run assembly: no side effect on the caller's world, full validation.
    const scratch = new World();
    for (const enemy of wave.enemies) {
      EnemyFactory.spawn(scratch, enemy);
    }
  }

  return waves;
}

export class EncounterFactory {
  /**
   * Create the room's singleton entity, carrying the validated configuration in its
   * initial state (`IN_PROGRESS`, wave `0`, no spawn scheduled, nothing tracked).
   *
   * The room does NOT spawn its opening wave here: spawning is a per-tick decision
   * and belongs to `EncounterSystem`, which runs inside `step()` (spec 08 §4.3).
   * Consequence, and it is the documented contract: wave 0 appears on the first
   * processed tick (`waves[0].delayTicks = 0`), so a caller must `step()` at least
   * once before the room has any enemies.
   *
   * @throws RangeError under the conditions listed on {@link resolveEncounterConfig}.
   */
  public static spawn(world: World, config: EncounterRoomConfig): EntityId {
    const waves = resolveEncounterConfig(config);
    const entity = world.createEntity();
    world.addComponent(entity.id, new EncounterStateComponent(waves));
    return entity.id;
  }
}
