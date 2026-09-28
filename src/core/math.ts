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
