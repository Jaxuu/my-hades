/**
 * Barrel for the presentation layer's DOM-free models (M19).
 *
 * These modules carry the interface's LOGIC — quality mapping, the boon catalog,
 * description rendering, the HUD view and the status-panel view — with no DOM, no
 * pixi.js and no randomness, so they can be unit-tested in node (the test
 * environment has no jsdom). `client/UIManager.ts` is the only module that turns
 * their output into DOM.
 *
 * See specs/027-hud-boon-ui/design/engineering-architecture.md §1.2.
 */

export * from './quality';
export * from './boon-catalog';
export * from './boon-presentation';
export * from './hud-model';
export * from './status-panel';
