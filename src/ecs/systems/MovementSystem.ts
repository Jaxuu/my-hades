/**
 * MovementSystem — Intent -> Velocity -> Transform, plus static-geometry
 * resolution. See specs/01_character_controller_spec.md §5,
 * specs/02_dash_and_state_spec.md §5, specs/04_combat_feedback_spec.md §4.6 and
 * specs/13_arena_and_projectiles_spec.md §4.1 / §4.2 (M7-T01 AC-01 / AC-02).
 *
 * Three phases, executed in this order every tick:
 *
 *  1. `integrate` — the M1/M2 locomotion integrator (UNCHANGED).
 *  2. `integrateKinematic` — the M7-T01 addition: entities that fly under their own
 *     power rather than from an intent (`ProjectileComponent`). Kept as a SEPARATE
 *     query rather than folded into phase 1, because a projectile owns no
 *     `IntentComponent` at all: the two sets are disjoint by construction, so phase 1
 *     keeps its exact pre-M7 meaning and phase 2 is pure addition (spec 13 I7).
 *  3. `resolveWalls` — the M7-T01 addition: push every dynamic circle body out of
 *     every wall, then settle the two consequences (wall-slam damage, projectile
 *     retirement). It runs LAST, which is what makes it "after this tick's
 *     displacement" — and, because `CollisionSystem` is a later pipeline segment, it
 *     also makes wall retirement happen strictly BEFORE this tick's collision test
 *     (spec 13 I6).
 *
 * WHY WALL RESOLUTION LIVES HERE rather than in a new pipeline segment: the tail of
 * this system is the one and only place where "all of this tick's displacement is
 * done, and no collision test has run yet" is true. Adding a 16th segment would
 * change the pipeline hard contract (and its six pinning tests) for zero behavioural
 * gain — see spec 13 §10 trade-off 1.
 *
 * AC-01 BOUNCE (M11-T01, spec 18 §4.1). Consequence 2 of wall resolution is now a
 * branch: a `destroyOnWall` body that is ALSO a projectile with `bounceCount > 0` is
 * REFLECTED instead of destroyed. The reflection is the Householder mirror
 *
 *     V' = V - 2 * (V · N) * N
 *
 * where `N` is the unit normal — and the normal is the NORMALIZED accumulated push
 * `(pushX, pushY)` of this tick's pass. That push is exactly the outward normal of
 * the geometry the body is being extruded from, so a single normalization yields it
 * without any second geometry query. Reflecting ONCE per entity per tick (never in a
 * `while`/retry loop) is what keeps the pass a single finite traversal: the loop is
 * `for (const id of ...)` over a fixed snapshot, and each body is touched once, so a
 * wall-bouncing projectile can never spin the tick.
 *
 * With `bounceCount === 0` (every pre-M11 projectile) — or for any non-projectile
 * `destroyOnWall` body — the branch is not taken and the historic destroy-on-contact
 * path runs unchanged.
 *
 * --- phase 1: per-entity dispatch inside `integrate`, in priority order ---
 *
 *   0. DEAD (death tag)    -> skip entirely: a corpse is not displaced, not even by
 *                             an in-flight knockback (M4-T02, spec 08 §4.2). This is
 *                             the gate that stops a knocked-back body from sliding
 *                             across the arena after it dies.
 *   1. FROZEN  (hitstop)   -> skip entirely: no displacement, no intent read.
 *   2. HITSTUN             -> forced knockback displacement: `knockback.velocity`
 *                             integrated directly, NOT clamped by maxSpeed, NOT
 *                             scaled by speedMultiplier, NOT steered by intent
 *                             (spec 04 AC-03).
 *   3. DASHING             -> direction locked by DashSystem; intent ignored.
 *   4. otherwise           -> normal locomotion from `intent.moveVector`. While
 *                             rooted, a non-null `intent.aimRadians` still steers
 *                             the facing (M4-T01 telegraph lock — spec 07 §3.3).
 *
 * Death outranks hitstop and hitstun: a corpse frozen mid-knockback must stay put
 * whether or not its freeze has lapsed, so the dead gate is the only one that is
 * independent of a counter's phase.
 *
 * The tick length is READ FROM THE SIMULATION CLOCK (`ctx.fixedDeltaSeconds`) and
 * never hard-coded, so behaviour is identical at any fps (spec 01 §5.2 / AC-05).
 * That holds for the kinematic phase too: a projectile's flight is fps-independent
 * for exactly the same reason.
 *
 * Pipeline position: AFTER FreezeSystem (so a freeze granted last tick already
 * suppressed this tick) and BEFORE DashSystem / StateSystem, so it integrates
 * against the state decided on the previous tick (spec 02 §5, hard timing contract).
 */

import { resolveCircleAABB, clampMagnitude, normalizeVec2, reflectVec2, vec2 } from '../../core/math';
import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import { ActionState, StateComponent } from '../components/StateComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isFrozen } from '../components/FreezeComponent';
import { KnockbackComponent } from '../components/KnockbackComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';
import { HitboxComponent } from '../components/HitboxComponent';
import { ProjectileComponent } from '../components/ProjectileComponent';
import { DEFAULT_WALL_SLAM_DAMAGE, WallComponent, circleBodyRadius } from '../components/WallComponent';
import { applyDamageWithArmor } from '../components/ArmorComponent';
import { isDead } from '../components/DeadTagComponent';

export class MovementSystem implements System {
  public readonly name = 'MovementSystem';

  public update(world: World, ctx: SystemContext): void {
    this.integrate(world, ctx.fixedDeltaSeconds);
    this.integrateKinematic(world, ctx.fixedDeltaSeconds);
    this.resolveWalls(world);
  }

  /**
   * Integrate. Only entities owning all three components participate; ids are
   * visited in ascending order (World.query guarantees it).
   */
  private integrate(world: World, fixedDeltaSeconds: number): void {
    for (const id of world.query(IntentComponent, VelocityComponent, TransformComponent)) {
      const intent = world.getComponent(id, IntentComponent);
      const velocity = world.getComponent(id, VelocityComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (intent === undefined || velocity === undefined || transform === undefined) continue;

      // 0. Death: a corpse is not displaced at all (M4-T02, spec 08 §4.2).
      if (isDead(world, id)) continue;

      // 1. Hitstop: a frozen entity neither moves nor responds to intent.
      if (isFrozen(world, id)) continue;

      const state = world.getComponent(id, StateComponent);

      // 2. Hitstun: forced knockback displacement, ignoring maxSpeed and intent.
      if (state !== undefined && state.state === ActionState.HITSTUN) {
        const knockback = world.getComponent(id, KnockbackComponent);
        if (knockback !== undefined) {
          transform.x += knockback.velocity.x * fixedDeltaSeconds;
          transform.y += knockback.velocity.y * fixedDeltaSeconds;
        }
        velocity.currentSpeed = 0;
        continue;
      }

      // 3. Dashing: direction was locked by DashSystem onto velocity.directionVector.
      // Intent and facing are intentionally ignored (spec 02 AC-02).
      if (state !== undefined && state.state === ActionState.DASHING) {
        const direction = velocity.directionVector;
        velocity.currentSpeed = velocity.maxSpeed * velocity.speedMultiplier;
        transform.x += direction.x * velocity.currentSpeed * fixedDeltaSeconds;
        transform.y += direction.y * velocity.currentSpeed * fixedDeltaSeconds;
        continue;
      }

      // 4. Locomotion: direction comes from the logical intent.
      const direction = clampMagnitude(intent.moveVector, 1);
      const moving = direction.x !== 0 || direction.y !== 0;

      velocity.directionVector = direction;
      velocity.currentSpeed = moving ? velocity.maxSpeed : 0;

      if (!moving) {
        // A ROOTED entity can still steer its facing through the aim intent
        // (M4-T01, spec 07 §3.3 / AC-04): the telegraph locks the attack
        // direction without displacing the enemy. `null` means "no facing of my
        // own", so every pre-M4 entity keeps its facing untouched here and this
        // branch is behaviourally identical to the pre-M4 early `continue`.
        if (intent.aimRadians !== null) {
          transform.facingRadians = intent.aimRadians;
        }
        continue;
      }

      transform.x += direction.x * velocity.currentSpeed * fixedDeltaSeconds;
      transform.y += direction.y * velocity.currentSpeed * fixedDeltaSeconds;
      transform.facingRadians = Math.atan2(direction.y, direction.x);
    }
  }

  /**
   * Phase 2 (M7-T01) — integrate SELF-PROPELLED bodies.
   *
   * A projectile has no `IntentComponent`: nothing steers it, so there is no
   * direction to derive and no state machine to consult. It simply flies along its
   * own `VelocityComponent`:
   *
   *   transform += directionVector * maxSpeed * fixedDeltaSeconds
   *
   * `maxSpeed` (not `currentSpeed`) is the integration source because a projectile's
   * flight speed is a PROPERTY of the thing, not a per-tick value some other system
   * writes; `currentSpeed` is still stamped at spawn by `spawnProjectile` so a
   * snapshot reads sensibly. `speedMultiplier` is deliberately not applied — there is
   * no dash for a projectile to inherit, and leaving it out means the arithmetic has
   * exactly one term.
   *
   * NO death / freeze gate, and this is structural rather than an omission: a
   * projectile owns no `HealthComponent`, so `DeathSystem` (whose query is exactly
   * that) can never tag it dead, and no `FreezeComponent`, so `isFrozen` can never be
   * true for it. Adding gates that cannot fire would be dead code that hides a future
   * wiring mistake (spec 13 §10 trade-off 4).
   */
  private integrateKinematic(world: World, fixedDeltaSeconds: number): void {
    for (const id of world.query(ProjectileComponent, VelocityComponent, TransformComponent)) {
      const velocity = world.getComponent(id, VelocityComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (velocity === undefined || transform === undefined) continue;

      transform.x += velocity.directionVector.x * velocity.maxSpeed * fixedDeltaSeconds;
      transform.y += velocity.directionVector.y * velocity.maxSpeed * fixedDeltaSeconds;
    }
  }

  /**
   * Phase 3 (M7-T01) — push every dynamic circle body out of every wall, then
   * settle the consequences.
   *
   * The target set is exactly "circle bodies that move": `TransformComponent` +
   * `VelocityComponent` + a body radius. A static melee/boon hitbox has no
   * `VelocityComponent`, so it is never wall-resolved — it cannot "walk" into a wall,
   * so there is no penetration to resolve. Combatants (hurtbox radius) and
   * projectiles (hitbox radius) are both covered by {@link circleBodyRadius}.
   *
   * ORDER IS THE CONTRACT (spec 13 I3): entity ids ascending, walls ascending, and
   * one wall at a time — each wall re-reads the ALREADY-UPDATED position, so a body
   * wedged into a corner converges in a single pass with no iteration and no
   * order-dependent residue. Summing all pushes and applying them once would leave
   * residual penetration wherever two perpendicular pushes partially cancel.
   *
   * The pass is deliberately NOT gated on freeze or hitstun: depenetration is a
   * GEOMETRIC invariant, not an action. And the freeze phase already guarantees a
   * frozen body cannot newly penetrate — `integrate` returns before touching a frozen
   * entity, and knockback is only ever integrated after the freeze lapses.
   *
   * DEAD entities are skipped (spec 13 I10): a corpse is not displaced, so it is not
   * de-penetrated either. A body that dies inside a wall therefore stays inside it —
   * deliberate, and the same "death is an absolute skip" rule every other system
   * follows.
   *
   * BOUNCE (M11-T01, spec 18 §4.1). When a pushed body is a `destroyOnWall` hitbox
   * that ALSO carries a `ProjectileComponent` with `bounceCount > 0`, it is not
   * destroyed: the allowance is spent and its `VelocityComponent.directionVector` is
   * mirrored about the normalized accumulated push. Exactly one reflection per body
   * per tick — no `while`, no retry — so the pass stays a single finite traversal and
   * a corner can never make a projectile ping-pong within one tick. A body that is
   * not a projectile, or whose allowance is exhausted, falls through to the historic
   * `destroyOnWall` destruction.
   */
  private resolveWalls(world: World): void {
    const wallIds = world.query(WallComponent);
    if (wallIds.length === 0) return;

    const walls: WallComponent[] = [];
    for (const wallId of wallIds) {
      const wall = world.getComponent(wallId, WallComponent);
      if (wall !== undefined) walls.push(wall);
    }
    if (walls.length === 0) return;

    for (const id of world.query(TransformComponent, VelocityComponent)) {
      if (isDead(world, id)) continue;

      const transform = world.getComponent(id, TransformComponent);
      if (transform === undefined) continue;

      const radius = circleBodyRadius(world, id);
      if (radius === undefined) continue;

      let pushed = false;
      let pushX = 0;
      let pushY = 0;
      for (const wall of walls) {
        const [px, py] = resolveCircleAABB(
          transform.x,
          transform.y,
          radius,
          wall.x,
          wall.y,
          wall.width,
          wall.height,
        );
        if (px === 0 && py === 0) continue;
        transform.x += px;
        transform.y += py;
        pushX += px;
        pushY += py;
        pushed = true;
      }
      if (!pushed) continue;

      // Consequence 1 — a knockback that the wall just stopped is a WALL-SLAM.
      this.applyWallSlam(world, id, pushX, pushY);

      // Consequence 2 — a projectile never passes through geometry. Checked after the
      // slam (which needs the components) and guarded on liveness (the slam deals
      // damage, and a body reduced to 0 hp is still ALIVE here — death is a state —
      // but a future change must not be able to destroy it out from under us).
      if (!world.isAlive(id)) continue;
      const hitbox = world.getComponent(id, HitboxComponent);
      if (hitbox !== undefined && hitbox.destroyOnWall) {
        const projectile = world.getComponent(id, ProjectileComponent);
        if (projectile !== undefined && projectile.bounceCount > 0) {
          // M11-T01 AC-01 — 镜面反射：法线 = 本 Tick 累积推力的归一化方向。
          projectile.bounceCount -= 1;
          const velocity = world.getComponent(id, VelocityComponent);
          if (velocity !== undefined) {
            velocity.directionVector = reflectVec2(
              velocity.directionVector,
              normalizeVec2(vec2(pushX, pushY)),
            );
          }
        } else {
          world.destroyEntity(id);
        }
      }
    }
  }

  /**
   * Wall-Slam (M7-T01 AC-02, spec 13 §4.2).
   *
   * Fires only for an entity that is genuinely BEING KNOCKED BACK — in `HITSTUN`
   * with a non-zero `KnockbackComponent` — and only when the wall's push actually
   * OPPOSES that knockback (`dot(push, kb) < 0`).
   *
   *  - The `HITSTUN` requirement is not decoration. `KnockbackComponent` is a
   *    last-writer-wins component that is NEVER removed (spec 04 §4.4), so a stale
   *    one survives long after the stun that owned it. Testing only "has a
   *    KnockbackComponent" would let an ordinary walk into a wall re-slam a body that
   *    stopped being knocked back seconds ago.
   *  - The dot-product test is what "blocked BY the wall" means. A body knocked back
   *    while SLIDING along a wall face gets a push perpendicular to its motion
   *    (`dot ≈ 0`): it was not slammed, and must not be charged for it.
   *
   * Three writes, in this order, and all three matter:
   *
   *  1. damage through `applyDamageWithArmor` — the ONE settlement entry point, so
   *     armor semantics hold without a second damage path. (In practice this always
   *     lands on HP: standing armor suppresses `HITSTUN`, and `HITSTUN` is a
   *     precondition here, so the body's armor must already be broken. See spec 13
   *     §4.2.)
   *  2. REFRESH the stun by zeroing `ticksInState`. Zero, not one, because this
   *     system runs BEFORE `StateSystem`: this tick IS counted, so seeding 0 makes
   *     `StateSystem` advance it to 1 and the observable span come out exactly
   *     `DEFAULT_HITSTUN_TICKS`. (`CollisionSystem` seeds 1 for the mirror-image
   *     reason — it runs AFTER `StateSystem`, so its entry tick is not counted.)
   *  3. ABSORB the knockback (`velocity = 0`). Without this the body would re-enter
   *     the wall on every remaining stun tick and settle the slam again and again.
   *     Zeroing is the honest model — the wall stopped it — and it needs no extra
   *     "already slammed" bookkeeping (spec 13 I4).
   */
  private applyWallSlam(world: World, id: EntityId, pushX: number, pushY: number): void {
    const state = world.getComponent(id, StateComponent);
    if (state === undefined || state.state !== ActionState.HITSTUN) return;

    const knockback = world.getComponent(id, KnockbackComponent);
    if (knockback === undefined) return;

    const kb = knockback.velocity;
    if (kb.x === 0 && kb.y === 0) return;

    // The wall must have pushed AGAINST the knockback, not merely sideways to it.
    if (pushX * kb.x + pushY * kb.y >= 0) return;

    applyDamageWithArmor(world, id, DEFAULT_WALL_SLAM_DAMAGE);
    state.ticksInState = 0;
    knockback.velocity = vec2(0, 0);
  }
}
