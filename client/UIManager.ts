/**
 * UIManager — the DOM half of the boon draft (M6-T01).
 * See specs/11_roguelike_loop_spec.md §4.3 / §4.5.
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
 * A click does NOT touch a component. It calls the injected `onSelect` callback with
 * the reward ID, and the composition root turns that into a `selectReward` input
 * event for the simulator (spec 11 AC-03). The logic layer re-validates the id
 * against the draft it rolled itself, so this class is not trusted — it is merely
 * convenient.
 *
 * The only state it owns is "what am I currently showing", used to avoid rebuilding
 * the DOM on every rendered frame (a fresh button per frame would drop the hover
 * state and make clicks feel unreliable).
 */

import type { World } from '../src/ecs/World';
import { findRewardDraft } from '../src/ecs/components/EncounterStateComponent';
import { getRewardDefinition } from '../src/ecs/rewards/RewardPool';

export interface UIManagerOptions {
  /** The `#ui-layer` element to render into. */
  readonly root: HTMLElement;
  /** Called with the chosen reward id when a button is clicked. */
  readonly onSelect: (rewardId: string) => void;
  /** Heading shown above the buttons. */
  readonly title?: string;
}

/** Default heading for the draft overlay. */
export const DEFAULT_DRAFT_TITLE = '选择祝福';

export class UIManager {
  private readonly root: HTMLElement;
  private readonly onSelect: (rewardId: string) => void;
  private readonly title: string;

  /**
   * The draft currently on screen (`null` = nothing rendered). Compared by VALUE
   * against the live draft so an unchanged draft is not re-rendered.
   */
  private rendered: readonly string[] | null = null;

  constructor(options: UIManagerOptions) {
    this.root = options.root;
    this.onSelect = options.onSelect;
    this.title = options.title ?? DEFAULT_DRAFT_TITLE;
  }

  /**
   * One render-frame sync. Called once per frame with the live world.
   *
   * No draft => hide (and tear down). Draft changed => rebuild. Draft unchanged =>
   * strict no-op, which is the common case (a draft is open for many frames while
   * the player decides).
   */
  public sync(world: World): void {
    const draft = findRewardDraft(world)?.pendingRewards ?? null;

    if (draft === null) {
      if (this.rendered !== null) this.clear();
      return;
    }

    if (this.rendered !== null && sameIds(this.rendered, draft)) return;

    this.render(draft);
  }

  /** Remove the overlay and every listener with it. */
  public destroy(): void {
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

  private clear(): void {
    this.root.textContent = '';
    this.root.classList.remove('is-visible');
    this.rendered = null;
  }
}

/** Order-sensitive id comparison — a reordered draft is a different draft. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
