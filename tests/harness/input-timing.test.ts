import { describe, expect, it } from 'vitest';
import { vec2 } from '../../src/core/math';
import { HeadlessHarness, InputRecorder } from './HeadlessHarness';

describe('Input timing (AC-03, AC-04, AC-05)', () => {
  it('captures a move event at exactly the specified tick and nowhere else', () => {
    const recorder = new InputRecorder();
    const harness = new HeadlessHarness({ systems: [recorder] });

    harness.moveAt(10, vec2(1, 0));
    harness.step(30);

    expect(recorder.frameAt(10)).toHaveLength(1);
    expect(recorder.frameAt(10)[0]).toEqual({ kind: 'move', tick: 10, vector: { x: 1, y: 0 } });

    for (let tick = 0; tick < 30; tick += 1) {
      if (tick !== 10) {
        expect(recorder.frameAt(tick)).toHaveLength(0);
      }
    }
  });

  it('captures a keyDown at exactly tick 20', () => {
    const recorder = new InputRecorder();
    const harness = new HeadlessHarness({ systems: [recorder] });

    harness.keyDownAt(20, 'attack');
    harness.step(25);

    expect(recorder.frameAt(20)).toEqual([{ kind: 'keyDown', tick: 20, key: 'attack' }]);
    expect(recorder.frameAt(19)).toHaveLength(0);
    expect(recorder.frameAt(21)).toHaveLength(0);
  });

  it('delivers a move at tick 10 and a keyDown at tick 20 independently', () => {
    const recorder = new InputRecorder();
    const harness = new HeadlessHarness({ systems: [recorder] });

    harness.moveAt(10, vec2(0, 1));
    harness.keyDownAt(20, 'dash');
    harness.step(30);

    expect(recorder.frameAt(10)).toEqual([{ kind: 'move', tick: 10, vector: { x: 0, y: 1 } }]);
    expect(recorder.frameAt(20)).toEqual([{ kind: 'keyDown', tick: 20, key: 'dash' }]);
    expect(recorder.frameAt(15)).toHaveLength(0);
  });

  it('supports injection at tick 0 (the very first tick)', () => {
    const recorder = new InputRecorder();
    const harness = new HeadlessHarness({ systems: [recorder] });

    harness.moveAt(0, vec2(1, 1));
    harness.step(1);

    expect(recorder.frameAt(0)).toEqual([{ kind: 'move', tick: 0, vector: { x: 1, y: 1 } }]);
  });

  it('consumes same-tick events in FIFO (enqueue) order', () => {
    const recorder = new InputRecorder();
    const harness = new HeadlessHarness({ systems: [recorder] });

    harness.moveAt(5, vec2(1, 0));
    harness.keyDownAt(5, 'attack');
    harness.keyUpAt(5, 'attack');
    harness.step(6);

    const kinds = recorder.frameAt(5).map((event) => event.kind);
    expect(kinds).toEqual(['move', 'keyDown', 'keyUp']);
  });

  it('rejects out-of-range ticks: negative, non-integer, and past ticks', () => {
    const harness = new HeadlessHarness();

    expect(() => harness.moveAt(-1, vec2(1, 0))).toThrow(RangeError);
    expect(() => harness.moveAt(1.5, vec2(1, 0))).toThrow(RangeError);
    expect(() => harness.moveAt(Number.NaN, vec2(1, 0))).toThrow(RangeError);

    harness.step(5);
    expect(() => harness.moveAt(3, vec2(1, 0))).toThrow(RangeError);
    // a future tick is still allowed
    expect(() => harness.moveAt(6, vec2(1, 0))).not.toThrow();
  });
});
