/**
 * Modifier (boon) behaviour table. See specs/06_status_effect_and_dot_spec.md §3.5,
 * specs/12_armor_and_dash_boons_spec.md §3.5 and
 * specs/16_data_driven_pipeline_spec.md §4.2 (M10-T01).
 *
 * `createDefaultModifierRegistry()` is the single place that knows which boons
 * exist. `createDefaultSystems()` calls it once per pipeline, so the registry —
 * like the `EventQueue` — is never shared between two simulators (spec 05 §5.3).
 *
 * M10-T01: this function is also where each boon's NUMBERS are resolved. It reads
 * `assets/data/modifiers.json` through `DataManager` and hands each handler its
 * own `ModifierConfig`, so the handler is constructed with known-good data and the
 * simulation loop never performs a lookup. That is the whole point of the split:
 * config is read at Bootstrap, the pipeline only ever runs.
 *
 * A boon that injects no hitbox — `dionysus_strike`, which stamps a status whose
 * numbers live on `POISON_STATUS_SPEC` — is constructed without a config and asks
 * for none, so the data table is not padded with entries nothing reads.
 */

import { DataManager } from '../../data/DataManager';
import { ModifierRegistry } from './ModifierRegistry';
import { ZeusStrikeModifier } from './ZeusStrikeModifier';
import { DionysusBlightModifier } from './DionysusBlightModifier';
import { PoseidonDashModifier } from './PoseidonDashModifier';
import { POSEIDON_DASH_MODIFIER, ZEUS_STRIKE_MODIFIER } from '../components/ModifierComponent';

export * from './ModifierRegistry';
export * from './ZeusStrikeModifier';
export * from './DionysusBlightModifier';
export * from './PoseidonDashModifier';

/**
 * A registry holding every shipped boon behaviour, each parameterised from the
 * config table.
 *
 * Handlers are stateless, but a FRESH instance is built per call anyway: sharing
 * one table across simulators would be a latent cross-instance coupling, and the
 * cost of rebuilding it is a handful of object allocations per pipeline.
 *
 * @throws SchemaError when the requested boon has no entry in the loaded modifier
 *   table — including the case where Bootstrap never ran (spec 16 AC-03). Failing
 *   here, at pipeline construction, is deliberate: a boon whose numbers are
 *   missing must stop the boot, not silently do nothing on the first dash.
 */
export function createDefaultModifierRegistry(): ModifierRegistry {
  const registry = new ModifierRegistry();
  registry.register(new ZeusStrikeModifier(DataManager.getModifierConfig(ZEUS_STRIKE_MODIFIER)));
  registry.register(new DionysusBlightModifier());
  registry.register(new PoseidonDashModifier(DataManager.getModifierConfig(POSEIDON_DASH_MODIFIER)));
  return registry;
}
