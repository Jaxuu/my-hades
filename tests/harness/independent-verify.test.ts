/**
 * QA-INDEPENDENT verification suite (task M0-T01-E).
 *
 * Authored by quality-lead (严守真) as a fresh-eyes adversarial net. It
 * deliberately does NOT copy the engineering suite's assertions; instead it
 * attacks the SPEC-00-HARNESS contract from a different angle:
 *   - clock precision boundaries (strict equality, drift comparison)
 *   - snapshot immutability attacks (push / nested write / top-level write)
 *   - snapshot <-> live-world zero reference sharing
 *   - input-timing windows (not early, exactly once, never re-delivered)
 *   - illegal-input rejection (RangeError matrix) + step(0) no-op
 *   - ECS ordering determinism + destroy semantics
 *   - deterministic replay across two independent simulator instances
 *
 * Kept as a permanent part of the regression net.
 */
import { describe, expect, it } from 'vitest';
import { GameSimulator } from '../../src/core/GameSimulator';
import type { EntitySnapshot, Snapshot } from '../../src/core/GameSimulator';
import type { InputEvent } from '../../src/core/input';
import { ComponentBase } from '../../src/ecs/Component';
import type { System, SystemContext } from '../../src/ecs/System';
import type { World } from '../../src/ecs/World';

/* ------------------------------------------------------------------ *
 * Independent fixtures (NOT shared with the engineering test suite).  *
 * ------------------------------------------------------------------ */
class Pos extends ComponentBase {
  constructor(public x = 0, public y = 0) {
    super();
  }
}

class Vel extends ComponentBase {
  constructor(public vx = 0, public vy = 0) {
    super();
  }
}

/** Moves every Pos+Vel entity by its velocity, then applies any move inputs. */
class Mover implements System {
  public readonly name = 'QaMover';
  public update(world: World, ctx: SystemContext): void {
    for (const id of world.query(Pos, Vel)) {
      const pos = world.getComponent(id, Pos);
      const vel = world.getComponent(id, Vel);
      if (pos === undefined || vel === undefined) continue;
      for (const ev of ctx.input) {
        if (ev.kind === 'move') {
          pos.x += ev.vector.x;
          pos.y += ev.vector.y;
        }
      }
      pos.x += vel.vx;
      pos.y += vel.vy;
    }
  }
}

/** Records the exact input frame handed to it on every tick. */
class Spy implements System {
  public readonly name = 'QaSpy';
  public readonly frames: { tick: number; events: InputEvent[] }[] = [];
  public update(_world: World, ctx: SystemContext): void {
    this.frames.push({ tick: ctx.tick, events: [...ctx.input] });
  }
  public total(): number {
    return this.frames.reduce((n, f) => n + f.events.length, 0);
  }
  public at(tick: number): InputEvent[] {
    return this.frames.find((f) => f.tick === tick)?.events ?? [];
  }
}

/* --------------------------- helpers ------------------------------ */
function firstEntity(snap: Snapshot): EntitySnapshot {
  const e = snap.entities[0];
  if (e === undefined) throw new Error('QA: expected at least one entity in snapshot');
  return e;
}

function compData(snap: Snapshot, type: string): Record<string, unknown> {
  const c = firstEntity(snap).components.find((x) => x.type === type);
  if (c === undefined) throw new Error(`QA: component ${type} not found in snapshot`);
  return c.data as Record<string, unknown>;
}

function twoComponentSim(): GameSimulator {
  const sim = new GameSimulator({ systems: [new Mover()] });
  const e = sim.world.createEntity();
  sim.world.addComponent(e.id, new Pos(1, 2));
  sim.world.addComponent(e.id, new Vel(0.5, 0.5));
  return sim;
}

/* ------------------------------------------------------------------ *
 * 1. Clock precision boundaries                                       *
 * ------------------------------------------------------------------ */
describe('QA-INDEP | clock precision boundaries', () => {
  it('step(1) yields elapsedSeconds STRICTLY === 1/60', () => {
    const sim = new GameSimulator();
    sim.step(1);
    expect(sim.elapsedSeconds).toBe(1 / 60);
  });

  it('step(60) yields elapsedSeconds STRICTLY === 1.0 (no tolerance required)', () => {
    const sim = new GameSimulator();
    sim.step(60);
    expect(sim.elapsedSeconds).toBe(1.0);
  });

  it('step(3600) is STRICTLY === 3600*(1/60) and === 60', () => {
    const sim = new GameSimulator();
    sim.step(3600);
    expect(sim.elapsedSeconds).toBe(3600 * (1 / 60));
    expect(sim.elapsedSeconds).toBe(60);
  });

  it('multiplicative clock has ZERO drift where naive accumulation drifts', () => {
    const sim = new GameSimulator();
    sim.step(3600);
    const multiplicative = sim.elapsedSeconds;

    let additive = 0;
    for (let i = 0; i < 3600; i += 1) additive += 1 / 60;

    expect(multiplicative).toBe(60);
    expect(Math.abs(multiplicative - 60)).toBe(0);
    // naive accumulation demonstrably drifts...
    expect(Math.abs(additive - 60)).toBeGreaterThan(0);
    // ...and the shipped implementation is strictly better.
    expect(Math.abs(multiplicative - 60)).toBeLessThan(Math.abs(additive - 60));
  });

  it('contract constants are exact (no 16.67 truncation)', () => {
    const sim = new GameSimulator();
    expect(sim.fixedDeltaSeconds).toBe(1 / 60);
    expect(sim.tickDurationMs).toBe(1000 / 60);
    expect(sim.tickDurationMs).toBe(sim.fixedDeltaSeconds * 1000);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Snapshot immutability attacks                                    *
 * ------------------------------------------------------------------ */
describe('QA-INDEP | snapshot immutability attacks', () => {
  it('rejects every mutation vector and leaves the graph unchanged', () => {
    const sim = twoComponentSim();
    sim.step(1);
    const snap = sim.snapshot();

    // frozen at every level
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.entities)).toBe(true);
    const ent = firstEntity(snap);
    expect(Object.isFrozen(ent)).toBe(true);
    expect(Object.isFrozen(ent.components)).toBe(true);
    const c = ent.components[0];
    if (c === undefined) throw new Error('QA: expected a component');
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.data)).toBe(true);

    const beforeX = compData(snap, 'Pos').x;

    // attack 1: array push
    expect(() => (snap.entities as unknown as unknown[]).push({})).toThrow(TypeError);
    // attack 2: nested component-data write
    expect(() => {
      compData(snap, 'Pos').x = 999;
    }).toThrow(TypeError);
    // attack 3: top-level write
    expect(() => {
      (snap as unknown as { tick: number }).tick = 1;
    }).toThrow(TypeError);
    // attack 4: component descriptor write
    expect(() => {
      (c as unknown as { type: string }).type = 'Hacked';
    }).toThrow(TypeError);

    // graph is untouched after the failed attacks
    expect(compData(snap, 'Pos').x).toBe(beforeX);
    expect(snap.tick).toBe(1);
    expect(firstEntity(snap).components[0]?.type).toBe('Pos');
  });

  it('shares ZERO mutable references with the live world', () => {
    const sim = new GameSimulator({ systems: [new Mover()] });
    const e = sim.world.createEntity();
    sim.world.addComponent(e.id, new Pos(5, 6));

    const snap = sim.snapshot();
    const frozenX = compData(snap, 'Pos').x;

    const live = sim.world.getComponent(e.id, Pos);
    if (live === undefined) throw new Error('QA: live Pos missing');
    live.x = 999; // mutate the LIVE component

    // the old snapshot must not observe the live mutation...
    expect(compData(snap, 'Pos').x).toBe(frozenX);
    // ...while a fresh snapshot does.
    expect(compData(sim.snapshot(), 'Pos').x).toBe(999);
  });

  it('two consecutive snapshots with no step between are deeply equal', () => {
    const sim = twoComponentSim();
    sim.step(3);
    expect(sim.snapshot()).toEqual(sim.snapshot());
  });
});

/* ------------------------------------------------------------------ *
 * 3. Input timing attacks                                             *
 * ------------------------------------------------------------------ */
describe('QA-INDEP | input timing attacks', () => {
  it('a tick-10 event is invisible before tick 10 and delivered exactly once', () => {
    const spy = new Spy();
    const sim = new GameSimulator({ systems: [spy] });
    sim.inject({ kind: 'move', tick: 10, vector: { x: 1, y: 0 } });

    sim.step(9); // ticks 0..8
    expect(spy.total()).toBe(0);
    expect(spy.frames.every((f) => f.events.length === 0)).toBe(true);

    sim.step(1); // tick 9 — still not due
    expect(spy.at(9)).toHaveLength(0);
    expect(spy.total()).toBe(0);

    sim.step(1); // tick 10 — exactly now
    expect(spy.at(10)).toHaveLength(1);
    expect(spy.at(10)[0]).toEqual({ kind: 'move', tick: 10, vector: { x: 1, y: 0 } });

    sim.step(10); // ticks 11..20 — must NOT be re-delivered
    expect(spy.total()).toBe(1);
  });

  it('same-tick events are delivered in FIFO (enqueue) order', () => {
    const spy = new Spy();
    const sim = new GameSimulator({ systems: [spy] });
    sim.inject({ kind: 'move', tick: 3, vector: { x: 1, y: 0 } });
    sim.inject({ kind: 'keyDown', tick: 3, key: 'a' });
    sim.inject({ kind: 'keyUp', tick: 3, key: 'a' });
    sim.step(4);

    expect(spy.at(3).map((e) => e.kind)).toEqual(['move', 'keyDown', 'keyUp']);
  });

  it('injecting at the CURRENT tick is allowed (boundary, not past)', () => {
    const spy = new Spy();
    const sim = new GameSimulator({ systems: [spy] });
    sim.step(5); // now at tick 5
    expect(() => sim.inject({ kind: 'keyDown', tick: 5, key: 'x' })).not.toThrow();
    sim.step(1);
    expect(spy.at(5)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Illegal-input rejection matrix                                   *
 * ------------------------------------------------------------------ */
describe('QA-INDEP | illegal input rejection', () => {
  it('rejects illegal step counts; step(0) is a legal no-op', () => {
    const spy = new Spy();
    const sim = new GameSimulator({ systems: [spy] });
    expect(() => sim.step(-1)).toThrow(RangeError);
    expect(() => sim.step(1.5)).toThrow(RangeError);
    expect(() => sim.step(Number.NaN)).toThrow(RangeError);
    expect(() => sim.step(0)).not.toThrow();
    expect(sim.tick).toBe(0);
    expect(spy.frames).toHaveLength(0);
  });

  it('rejects past-tick, negative and non-integer injections', () => {
    const sim = new GameSimulator();
    sim.step(5);

    expect(() => sim.inject({ kind: 'move', tick: 4, vector: { x: 0, y: 0 } })).toThrow(RangeError);
    expect(() => sim.injectAt(4, { kind: 'keyDown', tick: 0, key: 'a' })).toThrow(RangeError);
    expect(() => sim.injectAt(-1, { kind: 'keyDown', tick: 0, key: 'a' })).toThrow(RangeError);
    expect(() => sim.inject({ kind: 'keyDown', tick: -3, key: 'a' })).toThrow(RangeError);

    const fresh = new GameSimulator();
    expect(() => fresh.inject({ kind: 'keyDown', tick: 2.5, key: 'a' })).toThrow(RangeError);
    expect(() => fresh.inject({ kind: 'keyDown', tick: Number.NaN, key: 'a' })).toThrow(RangeError);
  });

  it('runTo advances forward and rejects backward / malformed targets', () => {
    const sim = new GameSimulator();
    sim.runTo(10);
    expect(sim.tick).toBe(10);
    expect(() => sim.runTo(5)).toThrow(RangeError);
    expect(() => sim.runTo(10)).not.toThrow();
    expect(() => sim.runTo(-1)).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ *
 * 5. ECS ordering determinism                                         *
 * ------------------------------------------------------------------ */
describe('QA-INDEP | ECS ordering determinism', () => {
  it('listEntities/query are ascending & stable; destroyed entities vanish', () => {
    const sim = new GameSimulator();
    for (let i = 0; i < 5; i += 1) {
      const e = sim.world.createEntity();
      sim.world.addComponent(e.id, new Pos(i, i));
    }
    expect(sim.world.listEntities()).toEqual([0, 1, 2, 3, 4]);
    expect(sim.world.query(Pos)).toEqual([0, 1, 2, 3, 4]);

    sim.world.destroyEntity(2);
    expect(sim.world.listEntities()).toEqual([0, 1, 3, 4]);
    expect(sim.world.query(Pos)).toEqual([0, 1, 3, 4]);

    const snap = sim.snapshot();
    expect(snap.entities.map((e) => e.id)).toEqual([0, 1, 3, 4]);
  });

  it('identical construction order yields identical ordering across instances', () => {
    const build = (): number[] => {
      const sim = new GameSimulator();
      for (let i = 0; i < 6; i += 1) {
        const e = sim.world.createEntity();
        sim.world.addComponent(e.id, new Pos(i, i));
        sim.world.addComponent(e.id, new Vel(i, i));
      }
      return sim.world.query(Pos, Vel);
    };
    expect(build()).toEqual(build());
    expect(build()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

/* ------------------------------------------------------------------ *
 * 6. System execution order (spec §6.3)                               *
 * ------------------------------------------------------------------ */
describe('QA-INDEP | system execution order', () => {
  it('runs registered systems once per tick, in registration order', () => {
    const log: string[] = [];
    const mk = (name: string): System => ({
      name,
      update(_w: World, ctx: SystemContext): void {
        log.push(`${ctx.tick}:${name}`);
      },
    });
    const sim = new GameSimulator({ systems: [mk('A'), mk('B'), mk('C')] });
    sim.step(2);
    expect(log).toEqual(['0:A', '0:B', '0:C', '1:A', '1:B', '1:C']);
  });

  it('rejects duplicate system names', () => {
    const mk = (name: string): System => ({ name, update(): void {} });
    const sim = new GameSimulator({ systems: [mk('dup')] });
    expect(() => sim.registerSystem(mk('dup'))).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 7. Deterministic replay across independent instances                *
 * ------------------------------------------------------------------ */
function runScript(): Snapshot[] {
  const sim = new GameSimulator({ systems: [new Mover()] });
  const e = sim.world.createEntity();
  sim.world.addComponent(e.id, new Pos(0, 0));
  sim.world.addComponent(e.id, new Vel(0.1, -0.2));

  sim.inject({ kind: 'move', tick: 0, vector: { x: 1, y: 0 } });
  sim.inject({ kind: 'move', tick: 7, vector: { x: 0, y: 2 } });
  sim.inject({ kind: 'keyDown', tick: 13, key: 'dash' });
  sim.inject({ kind: 'move', tick: 13, vector: { x: -0.5, y: 0 } });
  sim.inject({ kind: 'keyUp', tick: 25, key: 'dash' });

  const out: Snapshot[] = [];
  for (let i = 0; i < 30; i += 1) {
    sim.step(1);
    out.push(sim.snapshot());
  }
  return out;
}

describe('QA-INDEP | deterministic replay', () => {
  it('two independent instances replay identically, tick by tick', () => {
    const a = runScript();
    const b = runScript();
    expect(a).toHaveLength(30);
    for (let i = 0; i < 30; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
    expect(a).toEqual(b);
  });
});
