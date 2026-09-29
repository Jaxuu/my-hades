/**
 * UIManager — the DOM half of the run: the boon draft (M6-T01), the gold read-out
 * (M9-T01), and the two terminal overlays — death (M8-T01) and victory (M9-T01).
 * See specs/11_roguelike_loop_spec.md §4.3 / §4.5,
 * specs/14_aoe_and_run_lifecycle_spec.md §4.6 (AC-02) and
 * specs/15_economy_and_victory_spec.md §4.6 (AC-02 / AC-04).
 *
 * The presentation layer's contract, unchanged from M5 (spec 09 AC-01):
 *
 *   - it READS `World` and never writes it — no `addComponent`, no `applyDamage`,
 *     no `grantReward`, no `sim.step`;
 *   - it is a ONE-WAY consumer of `src/`: it imports the logic layer's types and
 *     data, and `src/` never imports it back (enforced by ESLint);
 *   - **it never rolls a die.** The draft is drawn inside `src/` with the world's
 *     seeded PRNG; this class only displays the ids it was handed. Putting any
 *     randomness here would make the run unreproducible AND invisible to a replay.
 *
 * THREE surfaces share the one overlay root, and at most one overlay can be on
 * screen at a time:
 *
 *   - the REWARD DRAFT (`#ui-layer.is-visible`), driven by `findRewardDraft`;
 *   - the DEATH OVERLAY (`#ui-layer.is-visible.is-death`), driven by
 *     `isRunFailed`;
 *   - the VICTORY OVERLAY (`#ui-layer.is-visible.is-win`), driven by `isRunWon`.
 *
 * The two terminal overlays take precedence, because a run that has ENDED is over
 * regardless of what else was on screen. They are mutually exclusive by
 * construction (a run cannot be both won and lost) and share one rendering path
 * with two skins, so `R` behaves identically in both.
 *
 * The gold read-out is the fourth surface, and the only one that is not an overlay:
 * a small always-on element (`#gold`, injected as `hud`) that is updated on every
 * sync regardless of what is on screen. It reads `readGold`, which answers `0` for a
 * world with no wallet — so the HUD never has to encode the logic layer's shape.
 *
 * No surface touches a component. A reward click calls the injected `onSelect` with
 * the reward ID, and the composition root turns that into a `selectReward` input
 * event; the `R` key calls the injected `onRestart`, and the composition root calls
 * `sim.restartRun()` (spec 14 §4.6). This class is not trusted — it is merely
 * convenient, which is exactly why the logic layer re-validates everything it is
 * handed.
 *
 * The only state it owns is "what am I currently showing", used to avoid rebuilding
 * the DOM on every rendered frame (a fresh button per frame would drop the hover
 * state and make clicks feel unreliable), plus the lifetime of the restart key
 * listener, which is attached exactly while a terminal overlay is up and removed the
 * moment it goes away — a listener that outlived its overlay would fire `onRestart`
 * on a live run.
 */

import type { World } from '../src/ecs/World';
import { findRewardDraft } from '../src/ecs/components/EncounterStateComponent';
import { isRunFailed, isRunWon } from '../src/ecs/components/GameStateComponent';
import { readGold } from '../src/ecs/components/InventoryComponent';
import { getRewardDefinition } from '../src/ecs/rewards/RewardPool';

export interface UIManagerOptions {
  /** The `#ui-layer` element to render the overlays into. */
  readonly root: HTMLElement;
  /** Called with the chosen reward id when a button is clicked. */
  readonly onSelect: (rewardId: string) => void;
  /** Heading shown above the buttons. */
  readonly title?: string;
  /**
   * Called when the player presses `R` on a terminal overlay. The composition root
   * wires this to `GameSimulator.restartRun` — the UI never holds the simulator
   * (spec 14 §4.6).
   */
  readonly onRestart?: () => void;
  /** Heading shown on the death overlay. */
  readonly deathTitle?: string;
  /** Hint shown under the death heading. */
  readonly deathHint?: string;
  /** Heading shown on the victory overlay (M9-T01). */
  readonly winTitle?: string;
  /** Hint shown under the victory heading (M9-T01). */
  readonly winHint?: string;
  /**
   * The always-on gold read-out element (M9-T01), or `null`/omitted to render no
   * HUD. Optional so a caller that only wants the overlays needs no extra markup.
   */
  readonly hud?: HTMLElement | null;
}

/** Default heading for the draft overlay. */
export const DEFAULT_DRAFT_TITLE = '选择祝福';

/** Default heading for the death overlay. */
export const DEFAULT_DEATH_TITLE = 'YOU DIED';

/** Default hint under the death heading. */
export const DEFAULT_DEATH_HINT = 'Press [R] to Restart';

/** Default heading for the victory overlay (M9-T01, spec 15 AC-04). */
export const DEFAULT_WIN_TITLE = 'ESCAPED!';

/** Default hint under the victory heading. */
export const DEFAULT_WIN_HINT = 'Press [R] to Restart';

/** Physical key code that restarts the run on a terminal screen. */
export const RESTART_KEY_CODE = 'KeyR';

/** Which terminal overlay is currently mounted, if any. */
type TerminalKind = 'none' | 'death' | 'win';

export class UIManager {
  private readonly root: HTMLElement;
  private readonly onSelect: (rewardId: string) => void;
  private readonly title: string;
  private readonly onRestart: (() => void) | undefined;
  private readonly deathTitle: string;
  private readonly deathHint: string;
  private readonly winTitle: string;
  private readonly winHint: string;
  private readonly hud: HTMLElement | null;

  /**
   * The draft currently on screen (`null` = nothing rendered). Compared by VALUE
   * against the live draft so an unchanged draft is not re-rendered.
   */
  private rendered: readonly string[] | null = null;

  /** Which terminal overlay is mounted (and whether its key listener is live). */
  private terminal: TerminalKind = 'none';

  /** The gold value last written to the HUD, so an unchanged value is a no-op. */
  private renderedGold: number | null = null;

  constructor(options: UIManagerOptions) {
    this.root = options.root;
    this.onSelect = options.onSelect;
    this.title = options.title ?? DEFAULT_DRAFT_TITLE;
    this.onRestart = options.onRestart;
    this.deathTitle = options.deathTitle ?? DEFAULT_DEATH_TITLE;
    this.deathHint = options.deathHint ?? DEFAULT_DEATH_HINT;
    this.winTitle = options.winTitle ?? DEFAULT_WIN_TITLE;
    this.winHint = options.winHint ?? DEFAULT_WIN_HINT;
    this.hud = options.hud ?? null;
  }

  /**
   * One render-frame sync. Called once per frame with the live world.
   *
   * The HUD is updated FIRST and unconditionally: it is not an overlay, so it must
   * keep reading correctly while a draft or a terminal screen is up. Writing only on
   * a CHANGE keeps the DOM untouched on the overwhelming majority of frames.
   *
   * Then the overlays, terminal first: a finished run is terminal, so it wins over a
   * draft that would otherwise still be on screen (in practice they cannot coexist —
   * the encounter scheduler goes inert the moment the run ends, so no draft can be
   * rolled afterwards — but the precedence must be stated, not inferred). A run can
   * be FAILED or WON but never both, so the two terminal branches cannot fight.
   *
   * No draft => hide (and tear down). Draft changed => rebuild. Draft unchanged =>
   * strict no-op, which is the common case (a draft is open for many frames while
   * the player decides).
   */
  public sync(world: World): void {
    this.syncHud(world);

    const terminal: TerminalKind = isRunFailed(world) ? 'death' : isRunWon(world) ? 'win' : 'none';
    if (terminal !== 'none') {
      if (this.terminal !== terminal) this.renderTerminal(terminal);
      return;
    }
    if (this.terminal !== 'none') {
      this.clearTerminal();
      this.clear();
    }

    const draft = findRewardDraft(world)?.pendingRewards ?? null;

    if (draft === null) {
      if (this.rendered !== null) this.clear();
      return;
    }

    if (this.rendered !== null && sameIds(this.rendered, draft)) return;

    this.render(draft);
  }

  /** Remove the overlay, every listener with it, and the restart key listener. */
  public destroy(): void {
    this.clearTerminal();
    this.clear();
  }

  /**
   * Write the player's gold into the HUD element, if one was provided.
   *
   * A pure READ of the world (spec 09 AC-01). The label is built here rather than
   * stored anywhere, so there is no second copy of "what gold looks like" to drift
   * from the number.
   */
  private syncHud(world: World): void {
    if (this.hud === null) return;
    const gold = readGold(world);
    if (this.renderedGold === gold) return;
    this.hud.textContent = `GOLD ${String(gold)}`;
    this.renderedGold = gold;
  }

  private render(ids: readonly string[]): void {
    // `textContent = ''` detaches the old buttons AND their click listeners in one
    // step, so a rebuild can never leak a handler that would fire twice.
    this.clear();

    const heading = document.createElement('h2');
    heading.textContent = this.title;
    this.root.appendChild(heading);

    for (const id of ids) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reward-button';
      // The label lives in the logic layer's pool table, read one-way, so the draft
      // and its display name can never drift apart.
      button.textContent = getRewardDefinition(id)?.label ?? id;
      button.addEventListener('click', () => {
        this.onSelect(id);
      });
      this.root.appendChild(button);
    }

    this.root.classList.add('is-visible');
    this.rendered = [...ids];
  }

  /**
   * Mount a terminal overlay (`death` or `win`) and arm the restart key.
   *
   * One rendering path with two skins, because the two terminal states differ only
   * in their copy and their colour — and duplicating the listener lifecycle for a
   * second overlay is exactly how one of the two ends up with a stale key handler.
   * The listener is attached HERE rather than in the constructor so its lifetime is
   * exactly the overlay's: while the run is live there is no handler on the window
   * that could restart a healthy run.
   */
  private renderTerminal(kind: 'death' | 'win'): void {
    this.clear();

    const heading = document.createElement('h2');
    heading.textContent = kind === 'win' ? this.winTitle : this.deathTitle;
    this.root.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'death-hint';
    hint.textContent = kind === 'win' ? this.winHint : this.deathHint;
    this.root.appendChild(hint);

    this.root.classList.add('is-visible', kind === 'win' ? 'is-win' : 'is-death');
    this.terminal = kind;
    window.addEventListener('keydown', this.handleRestartKey);
  }

  /** Take a terminal overlay down and disarm the restart key. Idempotent. */
  private clearTerminal(): void {
    if (this.terminal === 'none') return;
    window.removeEventListener('keydown', this.handleRestartKey);
    this.terminal = 'none';
  }

  private clear(): void {
    this.root.textContent = '';
    this.root.classList.remove('is-visible', 'is-death', 'is-win');
    this.rendered = null;
  }

  private readonly handleRestartKey = (event: KeyboardEvent): void => {
    if (event.code !== RESTART_KEY_CODE) return;
    event.preventDefault();
    this.onRestart?.();
  };
}

/** Order-sensitive id comparison — a reordered draft is a different draft. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
