/**
 * MovementSystem — Intent -> Velocity -> Transform, plus static-geometry
 * resolution. See specs/01_character_controller_spec.md §5,
 * specs/02_dash_and_state_spec.md §5, specs/04_combat_feedback_spec.md §4.6 and
 * specs/13_arena_and_projectiles_spec.md §4.1 / §4.2 (M7-T01 AC-01 / AC-02).
 *
 * Four phases, executed in this order every tick:
 *
 *  1. `integrate` — the M1/M2 locomotion integrator (UNCHANGED).
 *  2. `integrateKinematic` — the M7-T01 addition: entities that fly under their own
 *     power rather than from an intent (`ProjectileComponent`). Kept as a SEPARATE
 *     query rather than folded into phase 1, because a projectile owns no
 *     `IntentComponent` at all: the two sets are disjoint by construction, so phase 1
 *     keeps its exact pre-M7 meaning and phase 2 is pure addition (spec 13 I7).
 *  3. `separateBodies` — the M12-T02 addition: same-faction dynamic circle bodies
 *     that OVERLAP each other are pushed apart along their overlap depth. A
 *     deterministic, entropy-free position correction (spec 20 AC-02).
 *  4. `resolveWalls` — the M7-T01 addition: push every dynamic circle body out of
 *     every wall, then settle the two consequences (wall-slam damage, projectile
 *     retirement). It runs LAST, which is what makes it "after this tick's
 *     displacement" — and, because `CollisionSystem` is a later pipeline segment, it
 *     also makes wall retirement happen strictly BEFORE this tick's collision test
 *     (spec 13 I6).
 *
 * WHY THE SEPARATION PHASE LIVES HERE, AND WHY IT SITS EXACTLY WHERE IT DOES
 * ------------------------------------------------------------------------
 * Same reason wall resolution does: the tail of this system is the one place where
 * "all of this tick's displacement is done, and no collision test has run yet" is
 * true. Separation is a same-entity physical phase, not a new lifecycle with its own
 * event source, so it belongs to `MovementSystem`'s tail rather than a new pipeline
 * segment — the engine's rule is that only "independent lifecycle + independent event
 * source" earns a new segment (spec 20 §4.4).
 *
 * The ORDER `separateBodies -> resolveWalls` is the contract, not a detail (spec 20
 * I9). Separation knows only about the distance between two bodies; it does not know
 * about walls. If it ran AFTER wall resolution it could push a pair of bodies INTO a
 * wall and nothing later in the tick would push them back out — they would clip
 * through geometry. Running it BEFORE wall resolution makes the wall pass the final
 * arbiter: the worst case is "separation moved a body, the wall moved it back", and
 * the body is still outside the wall. Geometry always gets the last word.
 *
 * WHY SEPARATION IS SAME-FACTION ONLY (spec 20 I5 / §4.2)
 * ------------------------------------------------------
 * The acceptance criterion asks for same-faction separation, and the narrower scope
 * is also the safer one: the existing `status_effects` and `walls_and_projectiles`
 * rigs deliberately place the player and an enemy at very close — sometimes
 * identical — positions (a melee swing, a knockback), and a cross-faction push would
 * silently shift the expected coordinates those suites pin. Restricting the phase to
 * same-faction pairs keeps the blast radius of this optimisation inside the one gap
 * it was written to close: enemies that converge on the same line and stack.
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
import { HurtboxComponent } from '../components/HurtboxComponent';
import { FactionComponent } from '../components/FactionComponent';
import { ProjectileComponent } from '../components/ProjectileComponent';
import { DEFAULT_WALL_SLAM_DAMAGE, WallComponent, circleBodyRadius } from '../components/WallComponent';
import { applyDamageWithArmor } from '../components/ArmorComponent';
import { isDead } from '../components/DeadTagComponent';

/**
 * How many equally-spaced directions the fully-coincident tie-break can choose from
 * (M12-T02, spec 20 §3.3).
 *
 * 16 is a power of two, so the slot is `mixed % 16` — a mask, not a division — and
 * the resulting angle is an exact multiple of `PI / 8`. It is large enough that a
 * crowd of coincident bodies fans out into visibly different directions and small
 * enough that the angle is cheap and the pattern is human-checkable.
 */
const SEPARATION_DIRECTION_SLOTS = 16;

/**
 * A deterministic direction for two FULLY COINCIDENT entities (M12-T02, spec 20 §3.3).
 *
 * When two bodies occupy the exact same point, the "vector from A to B" they would
 * normally separate along has zero length and no direction. Rather than divide by
 * zero, this derives a fixed direction from the two `EntityId`s alone.
 *
 * WHY IT IS A PURE FUNCTION OF THE IDS, AND WHY `Math.imul`
 * --------------------------------------------------------
 * It must be reproducible: the same pair of ids must pick the same direction on
 * every tick and every machine, or a fully-coincident pair would jitter. `Math.imul`
 * is the 32-bit integer multiply that keeps the mix exact for any id (a plain `*`
 * loses precision past 2^53), and `>>> 0` folds the result into `[0, 2^32)` — the
 * same discipline the seeded PRNG follows (ADR-004). There is NO entropy here: not
 * `Math.random`, not the wall clock, nothing environment-dependent (spec 20 I6).
 *
 * NOTE the pair is deliberately NOT symmetric: `separationAngle(a, b)` need not equal
 * `separationAngle(b, a)`. Two coincident bodies only need to be pushed in OPPOSITE
 * directions (A along `-n`, B along `+n`), and which slot `n` lands in is
 * immaterial — what matters is that a given pair always lands in the same one.
 *
 * @returns an angle in `[0, 2*PI)`.
 */
export function separationAngle(a: EntityId, b: EntityId): number {
  const mixed = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  return ((mixed % SEPARATION_DIRECTION_SLOTS) / SEPARATION_DIRECTION_SLOTS) * Math.PI * 2;
}

export class MovementSystem implements System {
  public readonly name = 'MovementSystem';

  public update(world: World, ctx: SystemContext): void {
    this.integrate(world, ctx.fixedDeltaSeconds);
    this.integrateKinematic(world, ctx.fixedDeltaSeconds);
    this.separateBodies(world);
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
   * Phase 3 (M12-T02) — push SAME-FACTION dynamic circle bodies apart (spec 20 §4.2).
   *
   * The target set is "circle bodies that move, and have a side": `Transform` +
   * `Velocity` + `Hurtbox` + `Faction`. `Velocity` is required because separation is
   * about BODIES — a static melee/boon hitbox owns no `VelocityComponent` and is not
   * a body, so it never separates (the same reason it is never wall-resolved). The
   * `Hurtbox` supplies the radius, and `Faction` supplies the "only same side"
   * constraint.
   *
   * DEAD entities are skipped on BOTH sides of a pair (spec 20 I5): a corpse is not
   * displaced by anything else in this engine (spec 08 §4.2 / spec 13 I10), and a
   * live body must not be shoved by a corpse either.
   *
   * ORDER IS THE CONTRACT. `World.query` returns ascending ids, and the pair loop is
   * `i < j`, so every pair is visited exactly once in a fixed order and the writes
   * land in a fixed order — which is what makes the pass deterministic. The
   * displacement itself is a POSITION CORRECTION and is therefore NOT scaled by
   * `fixedDeltaSeconds` (spec 20 I8): scaling by the tick length would mean "fix only
   * a fraction of the overlap per tick", leaving a coincident pair to jitter for
   * several ticks instead of settling in one. With no `dt`, a fully-coincident pair
   * lands exactly tangent in a single pass and stays there (`distSq >= minDist^2` on
   * every later tick).
   *
   * The overlap predicate is the strict `<` that `CollisionSystem` and `PickupSystem`
   * already use (spec 20 I7): a pair that is merely TOUCHING is not overlapping, so
   * two bodies resting tangent are left exactly where they are rather than being
   * nudged every tick.
   *
   * The `< 2` early return is a real guard rather than a micro-optimisation: it makes
   * a one-body world's separation phase a bit-for-bit no-op, which is what keeps the
   * M1–M11 single-player rigs (and every snapshot comparison taken against them)
   * untouched (spec 20 I10).
   */
  private separateBodies(world: World): void {
    const ids = world.query(
      TransformComponent,
      VelocityComponent,
      HurtboxComponent,
      FactionComponent,
    );
    if (ids.length < 2) return;

    for (let i = 0; i < ids.length; i += 1) {
      const idA = ids[i];
      if (idA === undefined) continue;
      if (isDead(world, idA)) continue;

      const transformA = world.getComponent(idA, TransformComponent);
      const hurtboxA = world.getComponent(idA, HurtboxComponent);
      const factionA = world.getComponent(idA, FactionComponent);
      if (transformA === undefined || hurtboxA === undefined || factionA === undefined) continue;

      for (let j = i + 1; j < ids.length; j += 1) {
        const idB = ids[j];
        if (idB === undefined) continue;
        if (isDead(world, idB)) continue;

        const transformB = world.getComponent(idB, TransformComponent);
        const hurtboxB = world.getComponent(idB, HurtboxComponent);
        const factionB = world.getComponent(idB, FactionComponent);
        if (transformB === undefined || hurtboxB === undefined || factionB === undefined) continue;

        // Only same-faction pairs separate (spec 20 I5): a player and an enemy may
        // legitimately overlap (a swing, a shove) and must be left alone.
        if (factionA.faction !== factionB.faction) continue;

        const minDist = hurtboxA.radius + hurtboxB.radius;
        const dx = transformB.x - transformA.x;
        const dy = transformB.y - transformA.y;
        const distSq = dx * dx + dy * dy;
        // Touching (==) or separated (>) is not overlapping (spec 20 I7).
        if (distSq >= minDist * minDist) continue;

        let nx: number;
        let ny: number;
        let overlap: number;
        if (distSq === 0) {
          // Fully coincident: no direction to derive, so take the deterministic
          // id-derived one and push them all the way to tangent.
          const angle = separationAngle(idA, idB);
          nx = Math.cos(angle);
          ny = Math.sin(angle);
          overlap = minDist;
        } else {
          const dist = Math.sqrt(distSq);
          nx = dx / dist;
          ny = dy / dist;
          overlap = minDist - dist;
        }

        // Symmetric correction: each body takes half the overlap, along the unit
        // direction. Not scaled by dt — this is a position fix, not a velocity
        // integration (spec 20 I8).
        const half = overlap * 0.5;
        transformA.x -= nx * half;
        transformA.y -= ny * half;
        transformB.x += nx * half;
        transformB.y += ny * half;
      }
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
