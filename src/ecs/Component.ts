/**
 * Component base. Components are plain-data (POD) markers; they hold no behaviour.
 * See specs/00_harness_spec.md §6.
 */

export interface Component {
  readonly __component: true;
}

/** Convenience base class so concrete components are auto-tagged. */
export abstract class ComponentBase implements Component {
  public readonly __component = true as const;
}

/**
 * A component constructor, used purely as a type-key for lookups.
 * Declared with `never[]` params so any concrete constructor is assignable.
 */
export type ComponentCtor<T extends Component = Component> = new (...args: never[]) => T;
