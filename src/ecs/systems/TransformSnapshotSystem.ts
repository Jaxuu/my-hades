/**
 * TransformSnapshotSystem — records the previous tick's transform so the render
 * layer can interpolate between two logic ticks. See
 * specs/10_render_juice_spec.md §4 and
 * docs/architecture/ADR-002-render-interpolation.md.
 *
 * PIPELINE POSITION: this system MUST be the FIRST segment of the canonical
 * pipeline (index 0, ahead of `PlayerControllerSystem`). The reason is not
 * cosmetic — it is the whole correctness argument for interpolation:
 *
 *   `PreviousTransformComponent` is the ONLY authority on "where the entity was
 *   at the start of this tick". Every system that moves an entity (Movement,
 *   Dash, and any future displacement writer) must run AFTER this snapshot, so
 *   that the value it captured is genuinely the pre-movement state. Snapshotting
 *   anywhere later would record a partially-advanced position and the render
 *   layer would interpolate between two already-moved points — reintroducing the
 *   very judder ADR-002 exists to remove.
 *
 * Running first does NOT disturb the M1–M4 relative order: it writes a component
 * no gameplay system reads, and it reads `TransformComponent` without mutating
 * it, so every downstream system observes exactly the world it saw before this
 * segment existed. It is a pure observer prepended to the front, not an
 * insertion between two existing systems.
 *
 * LAZY MOUNTING is deliberate. Rather than teaching `spawnCombatant` (and every
 * future spawn site) to carry this render-support component, the system attaches
 * it on first sight. That means the entities `CombatActionSystem` creates
 * mid-tick (hitbox circles) and any entity added by a future milestone are
 * covered automatically, with zero change to the prefab component contract.
 * An entity spawned mid-tick is snapshotted on the FOLLOWING tick — correct,
 * because it did not exist at the start of its spawn tick.
 *
 * Holds NO cross-tick hidden state: the previous position lives entirely on the
 * component, exactly like every other system in this pipeline.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { TransformComponent } from '../components/TransformComponent';
import { PreviousTransformComponent } from '../components/PreviousTransformComponent';

export class TransformSnapshotSystem implements System {
  public readonly name = 'TransformSnapshotSystem';

  public update(world: World, _ctx: SystemContext): void {
    // `world.query` guarantees ascending-id order, so the write order is
    // deterministic (ADR-001 R5).
    for (const id of world.query(TransformComponent)) {
      const transform = world.getComponent(id, TransformComponent);
      if (transform === undefined) continue;

      const previous = world.getComponent(id, PreviousTransformComponent);
      if (previous === undefined) {
        // First sight: seed the previous state from the CURRENT transform. An
        // entity that has never stepped renders at its spawn position (prev ==
        // curr), so the render layer never sees a phantom one-tick jump.
        world.addComponent(
          id,
          new PreviousTransformComponent(transform.x, transform.y, transform.facingRadians),
        );
        continue;
      }

      // Steady state: hard-copy the three interpolated quantities.
      previous.prevX = transform.x;
      previous.prevY = transform.y;
      previous.prevFacingRadians = transform.facingRadians;
    }
  }
}
