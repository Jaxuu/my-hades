/**
 * M7-T01 · `resolveCircleAABB` unit suite.
 * See specs/13_arena_and_projectiles_spec.md §3.1 (algorithm), §7 AC-05 and §9
 * (test plan M0 .. M5).
 *
 * This is the STANDALONE suite for the one piece of real geometry in the arena:
 * the whole of static-geometry resolution is this function plus a loop, so it is
 * tested directly, exhaustively and with no `World` / `GameSimulator` in the way.
 * The harness suite (`tests/physics/walls_and_projectiles.test.ts`) then covers the
 * integration, and never re-derives the arithmetic.
 *
 * The box under test is almost always the unit-ish square `(0, 0, 2, 2)` — i.e.
 * `left = 0`, `top = 0`, `right = 2`, `bottom = 2` — so every expected number below
 * can be checked by hand from the docstring's four candidate pushes.
 */

import { describe, expect, it } from 'vitest';
import { resolveCircleAABB } from '../../src';

/** The reference box: left = 0, top = 0, right = 2, bottom = 2. */
const BOX = { x: 0, y: 0, w: 2, h: 2 } as const;

/** Per-tick float arithmetic drifts; measured error here is ~1e-16. */
const TOLERANCE = 1e-9;

/** Solve against the reference box, for readability at the call sites. */
function solve(cx: number, cy: number, radius: number): [number, number] {
  return resolveCircleAABB(cx, cy, radius, BOX.x, BOX.y, BOX.w, BOX.h);
}

/** Distance from the circle centre to the closest point of the reference box. */
function distanceToBox(cx: number, cy: number): number {
  const nx = Math.min(Math.max(cx, BOX.x), BOX.x + BOX.w);
  const ny = Math.min(Math.max(cy, BOX.y), BOX.y + BOX.h);
  return Math.hypot(cx - nx, cy - ny);
}

describe('M0 · separation is not a collision', () => {
  it('returns [0, 0] for a circle clear of every one of the four sides', () => {
    expect(solve(-2, 1, 1)).toEqual([0, 0]); // left of the box
    expect(solve(4, 1, 1)).toEqual([0, 0]); // right of the box
    expect(solve(1, -2, 1)).toEqual([0, 0]); // above the box
    expect(solve(1, 4, 1)).toEqual([0, 0]); // below the box
  });

  it('returns [0, 0] for a circle clear of a corner', () => {
    expect(solve(-2, -2, 1)).toEqual([0, 0]);
    expect(solve(4, 4, 1)).toEqual([0, 0]);
  });

  it('treats EXACTLY touching as separated — the same strict predicate circle-vs-circle uses', () => {
    // Face touches: centre is exactly `radius` away from the closest point.
    expect(solve(-1, 1, 1)).toEqual([0, 0]); // touching the left face
    expect(solve(3, 1, 1)).toEqual([0, 0]); // touching the right face
    expect(solve(1, -1, 1)).toEqual([0, 0]); // touching the top face
    expect(solve(1, 3, 1)).toEqual([0, 0]); // touching the bottom face

    // Corner: a circle just clear of the corner is separated. The offset is nudged
    // out by 0.01% rather than being the exact 1/sqrt(2), because `dist² === radius²`
    // is not reachable in binary floating point for a diagonal — pinning the exact
    // value would be pinning a rounding artefact, not the contract.
    const justClear = 1.0001 / Math.SQRT2;
    expect(solve(-justClear, -justClear, 1)).toEqual([0, 0]);
    expect(solve(2 + justClear, 2 + justClear, 1)).toEqual([0, 0]);
  });

  it('is a no-op for a circle that merely grazes (dist just over the radius)', () => {
    expect(solve(-1.0000001, 1, 1)).toEqual([0, 0]);
    expect(solve(3.0000001, 1, 1)).toEqual([0, 0]);
  });
});

describe('M1 · the four faces push straight out', () => {
  it('pushes left off the right face, landing exactly touching', () => {
    const [px, py] = solve(2.5, 1, 1);
    expect(px).toBeCloseTo(0.5, 12); // radius (1) - dist (0.5)
    expect(py).toBe(0);
    expect(distanceToBox(2.5 + px, 1 + py)).toBeCloseTo(1, 12);
    expect(2.5 + px).toBeCloseTo(3, 12); // right face (2) + radius (1)
  });

  it('pushes right off the left face', () => {
    const [px, py] = solve(-0.5, 1, 1);
    expect(px).toBeCloseTo(-0.5, 12);
    expect(py).toBe(0);
    expect(distanceToBox(-0.5 + px, 1)).toBeCloseTo(1, 12);
    expect(-0.5 + px).toBeCloseTo(-1, 12); // left face (0) - radius (1)
  });

  it('pushes up off the bottom face', () => {
    const [px, py] = solve(1, 2.5, 1);
    expect(px).toBe(0);
    expect(py).toBeCloseTo(0.5, 12);
    expect(distanceToBox(1, 2.5 + py)).toBeCloseTo(1, 12);
    expect(2.5 + py).toBeCloseTo(3, 12);
  });

  it('pushes down off the top face', () => {
    const [px, py] = solve(1, -0.5, 1);
    expect(px).toBe(0);
    expect(py).toBeCloseTo(-0.5, 12);
    expect(distanceToBox(1, -0.5 + py)).toBeCloseTo(1, 12);
    expect(-0.5 + py).toBeCloseTo(-1, 12);
  });

  it('scales the push with the penetration depth (deeper overlap, longer push)', () => {
    // dist 0.8 -> push 0.2;  dist 0.5 -> push 0.5;  dist 0.1 -> push 0.9.
    expect(solve(2.8, 1, 1)[0]).toBeCloseTo(0.2, 12);
    expect(solve(2.5, 1, 1)[0]).toBeCloseTo(0.5, 12);
    expect(solve(2.1, 1, 1)[0]).toBeCloseTo(0.9, 12);
  });
});

describe('M2 · the four corners push diagonally', () => {
  it('resolves each corner so the circle ends up exactly `radius` from the corner', () => {
    const radius = 1;
    // cx, cy, cornerX, cornerY, outward sign of pushX, outward sign of pushY
    const cases: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
      [-0.5, -0.5, 0, 0, -1, -1], // top-left
      [2.5, -0.5, 2, 0, 1, -1], // top-right
      [-0.5, 2.5, 0, 2, -1, 1], // bottom-left
      [2.5, 2.5, 2, 2, 1, 1], // bottom-right
    ];

    for (const [cx, cy, cornerX, cornerY, signX, signY] of cases) {
      const [px, py] = solve(cx, cy, radius);
      // The push is non-trivial on BOTH axes — a corner is not a face.
      expect(Math.abs(px)).toBeGreaterThan(0);
      expect(Math.abs(py)).toBeGreaterThan(0);

      const newCx = cx + px;
      const newCy = cy + py;
      expect(Math.hypot(newCx - cornerX, newCy - cornerY)).toBeCloseTo(radius, 12);
      expect(distanceToBox(newCx, newCy)).toBeCloseTo(radius, 12);

      // And the push really points AWAY from the box, along the corner's diagonal.
      expect(Math.sign(px)).toBe(signX);
      expect(Math.sign(py)).toBe(signY);
    }
  });

  it('keeps the diagonal direction: the push is anti-parallel to the closest-point vector', () => {
    const [px, py] = solve(-0.5, -0.5, 1);
    // Closest point is the corner (0, 0); the push must be along (-1, -1).
    expect(px).toBeCloseTo(py, 12);
    expect(px).toBeLessThan(0);
    expect(px / py).toBeCloseTo(1, 12);
  });

  it('resolves a corner overlap with a SMALLER radius (a projectile-sized body)', () => {
    // Centre is OUTSIDE the box (2.1 > right edge 2), diagonally past the corner.
    const [px, py] = solve(2.1, 2.1, 0.4);
    expect(px).toBeGreaterThan(0);
    expect(py).toBeGreaterThan(0);
    expect(Math.hypot(2.1 + px - 2, 2.1 + py - 2)).toBeCloseTo(0.4, 12);
  });
});

describe('M3 · a centre inside the box exits by the nearest face', () => {
  it('exits -x when all four faces are equidistant (dead centre)', () => {
    // Every candidate push has magnitude 1.5; the fixed order (-x, +x, -y, +y)
    // makes -x win. This is the deterministic tie-break, not an accident.
    expect(solve(1, 1, 0.5)).toEqual([-1.5, 0]);
    expect(1 + -1.5).toBeCloseTo(-0.5, 12); // left face (0) - radius (0.5)
  });

  it('exits through the nearest face, not the nearest corner', () => {
    expect(solve(0.2, 1, 0.5)).toEqual([-0.7, 0]); // near the left face
    expect(solve(1.8, 1, 0.5)).toEqual([0.7, 0]); // near the right face
    expect(solve(1, 0.2, 0.5)).toEqual([0, -0.7]); // near the top face
    expect(solve(1, 1.8, 0.5)).toEqual([0, 0.7]); // near the bottom face
  });

  it('lands the centre exactly `radius` outside the chosen face', () => {
    const [px] = solve(0.2, 1, 0.5);
    expect(0.2 + px).toBeCloseTo(-0.5, 12);
    const [, py] = solve(1, 1.8, 0.5);
    expect(1.8 + py).toBeCloseTo(2.5, 12);
  });

  it('treats a centre exactly ON a boundary as contained (dist === 0)', () => {
    // cx === left: the closest-point vector is degenerate, so the containment
    // branch must handle it — and it exits the face it is standing on.
    expect(solve(0, 1, 0.5)).toEqual([-0.5, 0]);
    expect(solve(2, 1, 0.5)).toEqual([0.5, 0]);
    expect(solve(1, 0, 0.5)).toEqual([0, -0.5]);
    expect(solve(1, 2, 0.5)).toEqual([0, 0.5]);
  });

  it('handles a deeply contained circle (larger than the box)', () => {
    const [px, py] = solve(1, 1, 3);
    // The nearest face is still the answer; the push is `distanceToFace + radius`.
    expect(px).toBe(-4); // -(1 + 3)
    expect(py).toBe(0);
    expect(1 + px).toBeCloseTo(-3, 12);
  });
});

describe('M4 · degenerate input is a total no-op', () => {
  it('returns [0, 0] for a non-positive or NaN radius', () => {
    expect(solve(1, 1, 0)).toEqual([0, 0]);
    expect(solve(1, 1, -1)).toEqual([0, 0]);
    expect(solve(1, 1, Number.NaN)).toEqual([0, 0]);
  });

  it('returns [0, 0] for a zero / negative / NaN box extent', () => {
    expect(resolveCircleAABB(1, 1, 1, 0, 0, 0, 2)).toEqual([0, 0]);
    expect(resolveCircleAABB(1, 1, 1, 0, 0, -2, 2)).toEqual([0, 0]);
    expect(resolveCircleAABB(1, 1, 1, 0, 0, 2, 0)).toEqual([0, 0]);
    expect(resolveCircleAABB(1, 1, 1, 0, 0, Number.NaN, 2)).toEqual([0, 0]);
  });

  it('returns [0, 0] for a non-finite centre', () => {
    expect(resolveCircleAABB(Number.NaN, 1, 1, 0, 0, 2, 2)).toEqual([0, 0]);
    expect(resolveCircleAABB(1, Number.POSITIVE_INFINITY, 1, 0, 0, 2, 2)).toEqual([0, 0]);
  });
});

describe('M5 · determinism and the tie-break order', () => {
  it('prefers -x, then +x, then -y, then +y when magnitudes tie', () => {
    // Dead centre of a square: four-way tie -> -x.
    expect(solve(1, 1, 0.5)).toEqual([-1.5, 0]);

    // A 4x2 box with the centre on the horizontal midline: -x, -y and +y all tie
    // at 1.5, so the earliest in the fixed order (-x) still wins.
    expect(resolveCircleAABB(1, 1, 0.5, 0, 0, 4, 2)).toEqual([-1.5, 0]);

    // Move it so that -x is clearly worst: now only +y is nearest, and it wins.
    expect(resolveCircleAABB(2, 1.8, 0.5, 0, 0, 4, 2)).toEqual([0, 0.7]);
  });

  it('is a pure function: identical input yields bit-identical output', () => {
    const samples: ReadonlyArray<readonly [number, number, number]> = [
      [-0.5, -0.5, 1],
      [2.5, 1, 1],
      [1, 1, 0.5],
      [0.2, 1, 0.5],
      [1.9, 1.9, 0.4],
    ];
    for (const [cx, cy, radius] of samples) {
      const first = solve(cx, cy, radius);
      const second = solve(cx, cy, radius);
      expect(second).toEqual(first);
      expect(Object.is(second[0], first[0])).toBe(true);
      expect(Object.is(second[1], first[1])).toBe(true);
    }
  });

  it('never moves a circle FURTHER into the box', () => {
    // Sweep a grid of centres around/inside the box and assert the push always
    // reduces the overlap (or leaves a separated circle untouched).
    for (let cx = -1.5; cx <= 3.5; cx += 0.25) {
      for (let cy = -1.5; cy <= 3.5; cy += 0.25) {
        const radius = 0.5;
        const [px, py] = solve(cx, cy, radius);
        const before = distanceToBox(cx, cy);
        const after = distanceToBox(cx + px, cy + py);
        if (before < radius) {
          expect(after).toBeGreaterThanOrEqual(radius - TOLERANCE);
        } else {
          expect(px).toBe(0);
          expect(py).toBe(0);
        }
      }
    }
  });
});
