/**
 * Modifier (boon) behaviour table. See specs/06_status_effect_and_dot_spec.md §3.5.
 *
 * `createDefaultModifierRegistry()` is the single place that knows which boons
 * exist. `createDefaultSystems()` calls it once per pipeline, so the registry —
 * like the `EventQueue` — is never shared between two simulators (spec 05 §5.3).
 */

import { ModifierRegistry } from './ModifierRegistry';
import { ZeusStrikeModifier } from './ZeusStrikeModifier';
import { DionysusBlightModifier } from './DionysusBlightModifier';

export * from './ModifierRegistry';
export * from './ZeusStrikeModifier';
export * from './DionysusBlightModifier';

/**
 * A registry holding every shipped boon behaviour.
 *
 * Handlers are stateless, but a FRESH instance is built per call anyway: sharing
 * one table across simulators would be a latent cross-instance coupling, and the
 * cost of rebuilding it is a handful of object allocations per pipeline.
 */
export function createDefaultModifierRegistry(): ModifierRegistry {
  const registry = new ModifierRegistry();
  registry.register(new ZeusStrikeModifier());
  registry.register(new DionysusBlightModifier());
  return registry;
}
