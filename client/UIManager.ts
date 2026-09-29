/**
 * UIManager — the DOM half of the run: the boon draft (M6-T01) and the death
 * overlay (M8-T01).
 * See specs/11_roguelike_loop_spec.md §4.3 / §4.5 and
 * specs/14_aoe_and_run_lifecycle_spec.md §4.6 (AC-02).
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
 * Two overlays share the one root element, and only one can be on screen at a
 * time:
 *
 *   - the REWARD DRAFT (`#ui-layer.is-visible`), driven by `findRewardDraft`;
 *   - the DEATH OVERLAY (`#ui-layer.is-visible.is-death`), driven by
 *     `isRunFailed`. It takes precedence, because a run that has failed is over
 *     regardless of what else was on screen.
 *
 * Neither overlay touches a component. A reward click calls the injected
 * `onSelect` with the reward ID, and the composition root turns that into a
 * `selectReward` input event; the `R` key calls the injected `onRestart`, and the
 * composition root calls `sim.restartRun()` (spec 14 §4.6). This class is not
 * trusted — it is merely convenient, which is exactly why the logic layer
 * re-validates everything it is handed.
 *
 * The only state it owns is "what am I currently showing", used to avoid
 * rebuilding the DOM on every rendered frame (a fresh button per frame would drop
 * the hover state and make clicks feel unreliable), plus the lifetime of the
 * restart key listener, which is attached exactly while the death overlay is up
 * and removed the moment it goes away — a listener that outlived its overlay
 * would fire `onRestart` on a live run.
 */

import type { World } from '../src/ecs/World';
import { findRewardDraft } from '../src/ecs/components/EncounterStateComponent';
import { isRunFailed } from '../src/ecs/components/GameStateComponent';
import { getRewardDefinition } from '../src/ecs/rewards/RewardPool';

export interface UIManagerOptions {
  /** The `#ui-layer` element to render into. */
  readonly root: HTMLElement;
  /** Called with the chosen reward id when a button is clicked. */
  readonly onSelect: (rewardId: string) => void;
  /** Heading shown above the buttons. */
  readonly title?: string;
  /**
   * Called when the player presses `R` on the death overlay. The composition root
   * wires this to `GameSimulator.restartRun` — the UI never holds the simulator
   * (spec 14 §4.6).
   */
  readonly onRestart?: () => void;
  /** Heading shown on the death overlay. */
  readonly deathTitle?: string;
  /** Hint shown under the death heading. */
  readonly deathHint?: string;
}

/** Default heading for the draft overlay. */
export const DEFAULT_DRAFT_TITLE = '选择祝福';

/** Default heading for the death overlay. */
export const DEFAULT_DEATH_TITLE = 'YOU DIED';

/** Default hint under the death heading. */
export const DEFAULT_DEATH_HINT = 'Press [R] to Restart';

/** Physical key code that restarts the run on the death screen. */
export const RESTART_KEY_CODE = 'KeyR';

export class UIManager {
  private readonly root: HTMLElement;
  private readonly onSelect: (rewardId: string) => void;
  private readonly title: string;
  private readonly onRestart: (() => void) | undefined;
  private readonly deathTitle: string;
  private readonly deathHint: string;

  /**
   * The draft currently on screen (`null` = nothing rendered). Compared by VALUE
   * against the live draft so an unchanged draft is not re-rendered.
   */
  private rendered: readonly string[] | null = null;

  /** Whether the death overlay is currently mounted (and its key listener live). */
  private showingDeath = false;

  constructor(options: UIManagerOptions) {
    this.root = options.root;
    this.onSelect = options.onSelect;
    this.title = options.title ?? DEFAULT_DRAFT_TITLE;
    this.onRestart = options.onRestart;
    this.deathTitle = options.deathTitle ?? DEFAULT_DEATH_TITLE;
    this.deathHint = options.deathHint ?? DEFAULT_DEATH_HINT;
  }

  /**
   * One render-frame sync. Called once per frame with the live world.
   *
   * Death first: a failed run is terminal, so it wins over a draft that would
   * otherwise still be on screen (in practice they cannot coexist — the encounter
   * scheduler goes inert the moment the run fails, so no draft can be rolled
   * afterwards — but the precedence must be stated, not inferred).
   *
   * No draft => hide (and tear down). Draft changed => rebuild. Draft unchanged =>
   * strict no-op, which is the common case (a draft is open for many frames while
   * the player decides).
   */
  public sync(world: World): void {
    if (isRunFailed(world)) {
      if (!this.showingDeath) this.renderDeath();
      return;
    }
    if (this.showingDeath) {
      this.clearDeath();
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
    this.clearDeath();
    this.clear();
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
   * Mount the death overlay and arm the restart key.
   *
   * The listener is attached HERE rather than in the constructor so its lifetime
   * is exactly the overlay's: while the run is live there is no handler on the
   * window that could restart a healthy run.
   */
  private renderDeath(): void {
    this.clear();

    const heading = document.createElement('h2');
    heading.textContent = this.deathTitle;
    this.root.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'death-hint';
    hint.textContent = this.deathHint;
    this.root.appendChild(hint);

    this.root.classList.add('is-visible', 'is-death');
    this.showingDeath = true;
    window.addEventListener('keydown', this.handleRestartKey);
  }

  /** Take the death overlay down and disarm the restart key. Idempotent. */
  private clearDeath(): void {
    if (!this.showingDeath) return;
    window.removeEventListener('keydown', this.handleRestartKey);
    this.showingDeath = false;
  }

  private clear(): void {
    this.root.textContent = '';
    this.root.classList.remove('is-visible', 'is-death');
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
