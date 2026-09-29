/**
 * Modifier registry — the data-driven dispatch table of the boon engine.
 * See specs/06_status_effect_and_dot_spec.md §3.5 / §4.4.
 *
 * M3-T01 hard-coded every boon effect inside `ModifierSystem` (spec 05 §10
 * trade-off 5) so the PIPELINE (event bus / holder gate / anti-recursion / tick
 * phase) could be validated on its own. M3-T02 cashes that in: the effects move
 * into `IModifierHandler` implementations, and `ModifierSystem` becomes a pure
 * DISPATCHER — drain the bus, look the attacker's modifier ids up in the
 * registry, call `onHit`. Adding a boon is now "write a handler + register it",
 * with no edit to the system and no change to the pipeline.
 *
 * What did NOT change:
 *  - The ANTI-RECURSION gate (`sourceModifier !== null`) still runs FIRST, before
 *    any lookup and before any holder check. It is a property of the EVENT, not
 *    of a handler, so it belongs to the dispatcher (spec 05 §4.2 — the gate order
 *    is not exchangeable).
 *  - Dispatch order is the attacker's `modifiers` array order, which
 *    `addModifier` keeps sorted ascending, so the sequence of effects triggered
 *    by one hit is deterministic (spec 00 §6.1).
 *
 * `SystemContext` is NOT modified (spec 05 C6): handlers receive a
 * {@link ModifierContext}, a structural EXTENSION of `SystemContext` that adds the
 * `World` they must act on. Every consumer of `SystemContext` keeps working
 * unchanged, and `GameSimulator.step` stays untouched.
 */

import type { SystemContext } from '../System';
import type { World } from '../World';
import type { DashEvent, HitEvent } from '../events';

/**
 * The context a modifier handler acts in.
 *
 * A structural SUPERSET of `SystemContext` (`tick` / `elapsedSeconds` /
 * `fixedDeltaSeconds` / `input`), plus the `World` the handler needs in order to
 * observe and inject state. Extending rather than modifying keeps the harness
 * contract frozen (spec 05 C6) while still handing handlers everything they need
 * — an `onHit` hook that cannot touch the world would be useless.
 */
export interface ModifierContext extends SystemContext {
  /** The world the handler reads from and injects into. */
  readonly world: World;
}

/**
 * One boon behaviour, keyed by modifier id.
 *
 * Handlers are STATELESS with respect to ticks: everything a handler needs to
 * remember must live on a component (spec 00 §6.1). The shipped handlers are
 * therefore `const`-like classes with no fields other than their id.
 *
 * Two hooks, both about "a FACT just happened in the world this tick":
 *
 *  - `onHit`  — a hit landed, and the holder was the ATTACKER.
 *  - `onDash` — the holder entered `DASHING` (M6-T02).
 *
 * They are deliberately independent, and `onHit` stays REQUIRED while `onDash` is
 * optional: the two shipped hit-driven boons keep their contract untouched, and a
 * dash-only boon is expected to supply an explicit no-op `onHit` rather than have
 * the interface loosen a rule both existing implementations already honour
 * (spec 12 §10 trade-off 2).
 */
export interface IModifierHandler {
  /** Modifier id this handler serves (e.g. `'zeus_strike'`). */
  readonly id: string;
  /**
   * Called once per landed hit, for every modifier the ATTACKER holds.
   *
   * `event.sourceModifier` is guaranteed to be `null` here: a modifier-sourced hit
   * never reaches dispatch, which is what bounds nesting depth at 1.
   */
  onHit(event: HitEvent, context: ModifierContext): void;
  /**
   * Called once per DASH ENTRY, for every modifier the DASHING entity holds
   * (M6-T02, spec 12 AC-03). Optional: a boon that only reacts to hits simply does
   * not implement it, and the dispatcher skips it with a `?.` call.
   *
   * `event` describes the dash that JUST STARTED this tick — the very tick the
   * entity entered `DASHING`. `DashSystem` runs BEFORE `ModifierSystem` in the
   * pipeline, so the event reaches this hook within the SAME tick, and anything it
   * injects is collision-tested on the NEXT tick (never this one) — the identical
   * one-tick phase an `onHit` injection has, because `ModifierSystem` sits after
   * `CollisionSystem`.
   *
   * Unlike `onHit` there is NO anti-recursion gate here, and none is needed: a
   * `DashEvent` has no provenance field because a modifier-injected entity is
   * always a hitbox, and a hitbox owns no `IntentComponent`, so it can never enter
   * `DASHING`. Nesting depth is structurally 1 (spec 12 §4.3).
   */
  onDash?(event: DashEvent, context: ModifierContext): void;
}

/**
 * id -> handler table.
 *
 * Deliberately a tiny, explicit map rather than a module-level singleton: a fresh
 * registry is built per `createDefaultSystems()` call, so two simulators can never
 * share handler instances (the same isolation rule the `EventQueue` follows,
 * spec 05 §5.3).
 */
export class ModifierRegistry {
  private readonly handlers = new Map<string, IModifierHandler>();

  /**
   * Register `handler` under its own id.
   * @throws Error if the id is already taken — a duplicate registration is always
   *   a wiring bug, and failing loudly here keeps dispatch deterministic instead
   *   of silently letting the last writer win.
   */
  public register(handler: IModifierHandler): void {
    if (this.handlers.has(handler.id)) {
      throw new Error(`Modifier '${handler.id}' is already registered.`);
    }
    this.handlers.set(handler.id, handler);
  }

  /** Handler for `id`, or `undefined` when the boon has no behaviour attached. */
  public get(id: string): IModifierHandler | undefined {
    return this.handlers.get(id);
  }

  /** Whether a behaviour is registered for `id`. */
  public has(id: string): boolean {
    return this.handlers.has(id);
  }

  /** Number of registered behaviours. */
  public get size(): number {
    return this.handlers.size;
  }

  /**
   * Every registered id, sorted ascending (UTF-16 code-unit order, NOT
   * locale-sensitive) so the list is byte-for-byte stable for assertions and
   * snapshots.
   */
  public get ids(): readonly string[] {
    return [...this.handlers.keys()].sort(compareIds);
  }
}

/** Deterministic (locale-free) string ordering. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
