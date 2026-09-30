/**
 * Pure math utilities. No DOM, no browser globals — headless-safe.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function addVec2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scaleVec2(v: Vec2, scalar: number): Vec2 {
  return { x: v.x * scalar, y: v.y * scalar };
}

export function lengthVec2(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function normalizeVec2(v: Vec2): Vec2 {
  const len = lengthVec2(v);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

/**
 * Clamp a vector's magnitude to `maxLength`, preserving its direction.
 *
 * Analog-stick semantics (specs/01_character_controller_spec.md §4.2, rev.2):
 * - zero vector            -> `(0, 0)`
 * - `|v| <= maxLength`     -> returned as-is, so a partial stick tilt keeps its
 *                             (smaller) magnitude — "half-push walks slowly"
 * - `|v| > maxLength`      -> scaled so the magnitude is exactly `maxLength`
 *
 * @throws RangeError if `maxLength` is not a positive finite number.
 */
export function clampMagnitude(v: Vec2, maxLength: number): Vec2 {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    throw new RangeError(`maxLength must be a positive finite number, received: ${String(maxLength)}`);
  }
  const len = lengthVec2(v);
  if (len === 0) return { x: 0, y: 0 };
  if (len <= maxLength) return { x: v.x, y: v.y };
  const scale = maxLength / len;
  return { x: v.x * scale, y: v.y * scale };
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Shortest translation that pushes a CIRCLE out of an axis-aligned box.
 * See specs/13_arena_and_projectiles_spec.md §3.1 (M7-T01 AC-01).
 *
 * Pure arithmetic — no physics engine, no iteration, no randomness, no DOM. The
 * whole of the arena's static geometry resolution is this one function plus a loop
 * over the walls, which is what keeps the headless core deterministic (ADR-001 R2).
 *
 * The box is given by its top-left corner `(aabbX, aabbY)` and its positive extent
 * `(aabbW, aabbH)`, so its four edges are `left = aabbX`, `top = aabbY`,
 * `right = aabbX + aabbW`, `bottom = aabbY + aabbH`.
 *
 * Three cases, in this order:
 *
 *  1. **No overlap** — `dist² >= radius²` where `dist` is the distance from the
 *     circle centre to the CLOSEST point of the box. Returns `[0, 0]`. The
 *     comparison is deliberately the strict `<` of the overlap test (the same
 *     predicate `CollisionSystem` uses for circle-vs-circle): a circle that merely
 *     TOUCHES an edge is not overlapping, so a body sliding along a wall is left
 *     exactly where it is instead of being nudged every tick.
 *  2. **Centre outside the box** — push along the vector from the closest point to
 *     the centre, far enough that the circle ends up exactly touching:
 *     `push = radius - dist`. Because `dist > 0` here, no division guard is needed.
 *  3. **Centre inside (or exactly on the boundary of) the box** — `dist === 0`, so
 *     the closest-point vector carries no direction. Exit by the NEAREST FACE: the
 *     four candidates are `-x`, `+x`, `-y`, `+y` with magnitudes
 *     `(cx - left + radius)`, `(right - cx + radius)`, `(cy - top + radius)`,
 *     `(bottom - cy + radius)`. The smallest wins; ties resolve in the fixed order
 *     `-x, +x, -y, +y` so the result is byte-for-byte reproducible.
 *
 * Degenerate inputs (a non-finite centre, `radius <= 0`, `aabbW <= 0`, `aabbH <= 0`,
 * or any `NaN`) return `[0, 0]`: there is no penetration to resolve, and refusing to
 * guess keeps the function TOTAL — every `number` input has a defined answer. The
 * finiteness guard is not belt-and-braces: with a `NaN` centre the closest-point
 * vector is `NaN`, `NaN >= radius²` is `false`, and the function would otherwise fall
 * through to the containment branch and return `NaN` — a poison value that would
 * silently corrupt every position it touched. This is also what makes a zero-width
 * wall mathematically incapable of pushing anything to infinity.
 *
 * @returns `[pushX, pushY]` — add it to the centre to exit the box. `[0, 0]` when
 *   there is nothing to resolve.
 */
export function resolveCircleAABB(
  cx: number,
  cy: number,
  radius: number,
  aabbX: number,
  aabbY: number,
  aabbW: number,
  aabbH: number,
): [number, number] {
  // Degenerate geometry: nothing to resolve. `!(x > 0)` also rejects `NaN`;
  // `Number.isFinite` on the centre is what keeps `NaN` from reaching the arithmetic.
  if (
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(aabbX) ||
    !Number.isFinite(aabbY) ||
    !(radius > 0) ||
    !(aabbW > 0) ||
    !(aabbH > 0)
  ) {
    return [0, 0];
  }

  const left = aabbX;
  const top = aabbY;
  const right = aabbX + aabbW;
  const bottom = aabbY + aabbH;

  // Closest point on the box to the circle centre.
  const nx = clamp(cx, left, right);
  const ny = clamp(cy, top, bottom);
  const dx = cx - nx;
  const dy = cy - ny;
  const distSq = dx * dx + dy * dy;

  // Case 1 — separated (or exactly touching): the strict `<` matches the
  // circle-vs-circle overlap predicate, so "touching" is never a collision.
  if (distSq >= radius * radius) return [0, 0];

  // Case 2 — centre outside: push straight out along the closest-point vector.
  if (distSq > 0) {
    const dist = Math.sqrt(distSq);
    const push = radius - dist;
    return [(dx / dist) * push, (dy / dist) * push];
  }

  // Case 3 — centre inside (or on the boundary): exit by the nearest face.
  const pushLeft = -(cx - left + radius);
  const pushRight = right - cx + radius;
  const pushUp = -(cy - top + radius);
  const pushDown = bottom - cy + radius;

  // First-wins over the fixed order (-x, +x, -y, +y): deterministic tie-break.
  let bestX = pushLeft;
  let bestY = 0;
  let bestAbs = Math.abs(pushLeft);

  const absRight = Math.abs(pushRight);
  if (absRight < bestAbs) {
    bestX = pushRight;
    bestY = 0;
    bestAbs = absRight;
  }

  const absUp = Math.abs(pushUp);
  if (absUp < bestAbs) {
    bestX = 0;
    bestY = pushUp;
    bestAbs = absUp;
  }

  const absDown = Math.abs(pushDown);
  if (absDown < bestAbs) {
    bestX = 0;
    bestY = pushDown;
  }

  return [bestX, bestY];
}

/**
 * The scalar (dot) product of two 2-D vectors: `a.x * b.x + a.y * b.y`.
 *
 * Pure arithmetic, no side effects — the same "no DOM, no wall clock, no
 * randomness" family as `clamp` / `normalizeVec2` (ADR-001 R1/R2). It exists as a
 * named function rather than an inline expression because it is the primitive both
 * {@link reflectVec2} and the wall-slam predicate are stated in terms of, and a
 * single spelling cannot drift between its callers.
 */
export function dotVec2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Mirror reflection of `v` about the plane whose (outward) normal is `normal`
 * (M11-T01 AC-01). See specs/18_advanced_ballistics_and_hazards_spec.md §4.1.
 *
 * The formula is the standard Householder reflection
 *
 *     V' = V - 2 * (V · N) * N
 *
 * where `N` is the UNIT normal `normalizeVec2(normal)`. The normal is normalized
 * here rather than trusted, so a caller may pass a raw push vector (any magnitude)
 * and still get a correct reflection — which is exactly how `MovementSystem` uses
 * it: the accumulated wall push of one tick IS the outward normal, up to length.
 *
 * ZERO-NORMAL DEGENERACY: if `normal` has zero length, `normalizeVec2` returns
 * `(0, 0)` and there is no plane to reflect about; the function returns `v`
 * UNCHANGED (a copy, `{ x: v.x, y: v.y }`). This keeps it a TOTAL function — every
 * `number` input has a defined answer — and makes a degenerate normal a documented
 * no-op rather than a `NaN` poison.
 *
 * Pure: no side effects, and identical inputs always yield bit-identical output.
 * A `NaN` component propagates as `NaN` (ordinary arithmetic semantics) and never
 * throws.
 */
export function reflectVec2(v: Vec2, normal: Vec2): Vec2 {
  const n = normalizeVec2(normal);
  if (n.x === 0 && n.y === 0) return { x: v.x, y: v.y };
  const factor = 2 * dotVec2(v, n);
  return { x: v.x - factor * n.x, y: v.y - factor * n.y };
}
