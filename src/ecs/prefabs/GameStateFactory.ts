/**
 * Run-state assembly (M8-T01).
 * See specs/14_aoe_and_run_lifecycle_spec.md §3.3.
 *
 * `GameStateFactory.spawn` mounts the run's whole state onto ONE bare "world
 * entity" and returns its id — the same `EntityId`-returning prefab shape
 * `EncounterFactory` follows. The entity is deliberately component-poor (a single
 * `GameStateComponent`): a run has no position, no hurtbox and no lifespan, so
 * giving it a `TransformComponent` would be inventing data that means nothing —
 * and would additionally drag it into every `(Transform, …)` query in the engine.
 *
 * WHY A FACTORY RATHER THAN THE SIMULATOR DOING IT: `GameSimulator` must stay
 * free of game concepts (spec 00 §6). It cannot know that a "run" exists, let
 * alone that one of the world's entities represents it. Making the assembly a
 * prefab keeps that boundary intact: the composition root decides that a run has
 * state, and `GameSimulator.restartRun` merely re-runs whatever `runSetup` the
 * caller handed it.
 */

import type { EntityId } from '../Entity';
import type { World } from '../World';
import { GameStateComponent, GameStatus } from '../components/GameStateComponent';

export class GameStateFactory {
  /**
   * Create the run's singleton entity, carrying `status` (default `PLAYING`).
   *
   * The caller owns the "exactly one" invariant: nothing in the ECS layer can
   * forbid a second one, so `findGameState` resolves by ascending id and the
   * FIRST one always wins (deterministic rather than merely documented).
   */
  public static spawn(world: World, status: GameStatus = GameStatus.PLAYING): EntityId {
    const entity = world.createEntity();
    world.addComponent(entity.id, new GameStateComponent(status));
    return entity.id;
  }
}
