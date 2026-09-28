/**
 * Headless Test Driver.
 *
 * Assembles a GameSimulator, injects scripted input, drives ticks, and exports
 * snapshots. Pure logic only — no DOM, no rendering. See specs/00_harness_spec.md §1.2.
 */

import { GameSimulator } from '../../src/core/GameSimulator';
import type { GameSimulatorOptions, Snapshot } from '../../src/core/GameSimulator';
import type { InputEvent, KeyDownEvent, KeyUpEvent, MoveEvent } from '../../src/core/input';
import type { Vec2 } from '../../src/core/math';
import type { System, SystemContext } from '../../src/ecs/System';
import type { World } from '../../src/ecs/World';

/** Records the input frame delivered on every tick (keyed by tick index). */
export class InputRecorder implements System {
  public readonly name = 'InputRecorder';
  public readonly frames = new Map<number, ReadonlyArray<InputEvent>>();

  public update(_world: World, ctx: SystemContext): void {
    this.frames.set(ctx.tick, [...ctx.input]);
  }

  public frameAt(tick: number): ReadonlyArray<InputEvent> {
    return this.frames.get(tick) ?? [];
  }
}

export class HeadlessHarness {
  public readonly sim: GameSimulator;
  private readonly snapshots: Snapshot[] = [];

  constructor(options: GameSimulatorOptions = {}) {
    this.sim = new GameSimulator(options);
  }

  public moveAt(tick: number, vector: Vec2): void {
    const event: MoveEvent = { kind: 'move', tick, vector };
    this.sim.inject(event);
  }

  public keyDownAt(tick: number, key: string): void {
    const event: KeyDownEvent = { kind: 'keyDown', tick, key };
    this.sim.inject(event);
  }

  public keyUpAt(tick: number, key: string): void {
    const event: KeyUpEvent = { kind: 'keyUp', tick, key };
    this.sim.inject(event);
  }

  public step(ticks = 1): void {
    this.sim.step(ticks);
  }

  public runTo(tick: number): void {
    this.sim.runTo(tick);
  }

  public captureSnapshot(): Snapshot {
    const snap = this.sim.snapshot();
    this.snapshots.push(snap);
    return snap;
  }

  public get capturedSnapshots(): ReadonlyArray<Snapshot> {
    return this.snapshots;
  }
}
