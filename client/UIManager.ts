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
 * FOUR surfaces share the one overlay root, and at most one can be on screen at a
 * time:
 *
 *   - the REWARD DRAFT (`#ui-layer.is-visible`), driven by `findRewardDraft`;
 *   - the DEATH OVERLAY (`#ui-layer.is-visible.is-death`), driven by
 *     `isRunFailed`;
 *   - the VICTORY OVERLAY (`#ui-layer.is-visible.is-win`), driven by `isRunWon`;
 *   - the CAMP / TALENT SCREEN (`#ui-layer.is-visible.is-hub`), driven by `isInHub`
 *     (M13-T01).
 *
 * The two terminal overlays take precedence, because a run that has ENDED is over
 * regardless of what else was on screen. They are mutually exclusive by
 * construction (a run cannot be both won and lost) and share one rendering path
 * with two skins, so `R` behaves identically in both. The camp comes next: it is
 * reachable ONLY from a terminal overlay, so it can never be masked by one.
 *
 * THE CAMP IS THE ONE SURFACE THAT READS SOMETHING OTHER THAN THE WORLD, which is
 * exactly why `sync` takes a second argument (M13-T01). Meta progression lives in
 * `SaveState`, deliberately NOT a component and deliberately NOT in `snapshot()`
 * (spec 21 §3.1) — so the caller passes it in and this class treats it as one more
 * read-only input. It does not own the save, cannot construct one, cannot write one.
 *
 * The gold read-out is the fourth surface, and the only one that is not an overlay:
 * a small always-on element (`#gold`, injected as `hud`) that is updated on every
 * sync regardless of what is on screen. It reads `readGold`, which answers `0` for a
 * world with no wallet — so the HUD never has to encode the logic layer's shape.
 *
 * No surface touches a component. A reward click calls the injected `onSelect` with
 * the reward ID, and the composition root turns that into a `selectReward` input
 * event; a talent click calls `onPurchase`, the camp's button calls `onStartRun`,
 * and the `R` key on a terminal overlay calls `onEnterHub` — all of which the
 * composition root turns into `sim.purchaseMetaUpgrade(id)` / `sim.restartRun()` /
 * `sim.enterHub()`. This class is not trusted — it is merely convenient, which is
 * exactly why the logic layer re-validates everything it is handed (an
 * unaffordable talent is refused by the simulator, not by a `disabled` attribute).
 *
 * The only state it owns is "what am I currently showing", used to avoid rebuilding
 * the DOM on every rendered frame (a fresh button per frame would drop the hover
 * state and make clicks feel unreliable), plus the lifetime of the hub key
 * listener, which is attached exactly while a terminal overlay is up and removed the
 * moment it goes away — a listener that outlived its overlay would settle a live run.
 */

import type { World } from '../src/ecs/World';
import { findRewardDraft } from '../src/ecs/components/EncounterStateComponent';
import { isInHub, isRunFailed, isRunWon } from '../src/ecs/components/GameStateComponent';
import { readDarkness, readGold } from '../src/ecs/components/InventoryComponent';
import { getRewardDefinition } from '../src/ecs/rewards/RewardPool';
import { DataManager } from '../src/data/DataManager';

/**
 * The read-only slice of the save the camp draws (M13-T01).
 *
 * A STRUCTURAL type rather than `SaveState` itself, so this class depends on "the
 * two things I render" rather than on the class that happens to hold them —
 * `SaveState` satisfies it with no adapter, and a test can satisfy it with an
 * object literal.
 */
export interface MetaProgressionView {
  /** Out-of-run currency: the SAVE's total, not the current run's tally. */
  readonly darkness: number;
  /** Ids of the talents bought so far. */
  readonly unlockedUpgrades: readonly string[];
}

export interface UIManagerOptions {
  /** The `#ui-layer` element to render the overlays into. */
  readonly root: HTMLElement;
  /** Called with the chosen reward id when a button is clicked. */
  readonly onSelect: (rewardId: string) => void;
  /** Heading shown above the buttons. */
  readonly title?: string;
  /**
   * Called when the player presses `R` on a terminal overlay. The composition root
   * wires this to `GameSimulator.enterHub` — the UI never holds the simulator, and
   * M13-T01 turns the key into a SETTLEMENT rather than a restart (spec 21 AC-03).
   */
  readonly onEnterHub?: () => void;
  /**
   * Called with an upgrade id when the player clicks a talent in the camp
   * (M13-T01). The composition root wires this to
   * `GameSimulator.purchaseMetaUpgrade`.
   */
  readonly onPurchase?: (upgradeId: string) => void;
  /**
   * Called when the camp's start button is pressed (M13-T01). The composition root
   * wires this to `GameSimulator.restartRun` — the ONLY way out of the camp.
   */
  readonly onStartRun?: () => void;
  /** Heading shown on the death overlay. */
  readonly deathTitle?: string;
  /** Hint shown under the death heading. */
  readonly deathHint?: string;
  /** Heading shown on the victory overlay (M9-T01). */
  readonly winTitle?: string;
  /** Hint shown under the victory heading (M9-T01). */
  readonly winHint?: string;
  /** Heading shown on the camp overlay (M13-T01). */
  readonly hubTitle?: string;
  /** Label in front of the camp's currency read-out (M13-T01). */
  readonly darknessLabel?: string;
  /** Label on the camp's "leave for a new run" button (M13-T01). */
  readonly startLabel?: string;
  /**
   * The always-on read-out element (M9-T01), or `null`/omitted to render no HUD.
   * Optional so a caller that only wants the overlays needs no extra markup. As of
   * M13-T01 it shows the run's gold AND the run's collected darkness.
   */
  readonly hud?: HTMLElement | null;
}

/** Default heading for the draft overlay. */
export const DEFAULT_DRAFT_TITLE = '选择祝福';

/** Default heading for the death overlay. */
export const DEFAULT_DEATH_TITLE = 'YOU DIED';

/** Default hint under the death heading (M13-T01: it now leads to the camp). */
export const DEFAULT_DEATH_HINT = '按 [R] 返回营地';

/** Default heading for the victory overlay (M9-T01, spec 15 AC-04). */
export const DEFAULT_WIN_TITLE = 'ESCAPED!';

/** Default hint under the victory heading (M13-T01: it now leads to the camp). */
export const DEFAULT_WIN_HINT = '按 [R] 返回营地';

/** Default heading for the camp overlay (M13-T01). */
export const DEFAULT_HUB_TITLE = '营地 · CAMP';

/** Default label in front of the camp's darkness total (M13-T01). */
export const DEFAULT_DARKNESS_LABEL = '暗影';

/** Default label on the camp's start button (M13-T01). */
export const DEFAULT_START_LABEL = '开始逃离';

/** Physical key code that leaves a terminal overlay for the camp (M13-T01). */
export const HUB_KEY_CODE = 'KeyR';

/** Which terminal overlay is currently mounted, if any. */
type TerminalKind = 'none' | 'death' | 'win';

export class UIManager {
  private readonly root: HTMLElement;
  private readonly onSelect: (rewardId: string) => void;
  private readonly title: string;
  private readonly onEnterHub: (() => void) | undefined;
  private readonly onPurchase: ((upgradeId: string) => void) | undefined;
  private readonly onStartRun: (() => void) | undefined;
  private readonly deathTitle: string;
  private readonly deathHint: string;
  private readonly winTitle: string;
  private readonly winHint: string;
  private readonly hubTitle: string;
  private readonly darknessLabel: string;
  private readonly startLabel: string;
  private readonly hud: HTMLElement | null;

  /**
   * The draft currently on screen (`null` = nothing rendered). Compared by VALUE
   * against the live draft so an unchanged draft is not re-rendered.
   */
  private rendered: readonly string[] | null = null;

  /** Which terminal overlay is mounted (and whether its key listener is live). */
  private terminal: TerminalKind = 'none';

  /**
   * The camp's render key (`null` = not mounted). Encodes everything the camp draws
   * — the currency and the owned set — so a purchase (or a banked run) re-renders
   * exactly once, while an idle frame is a strict no-op.
   */
  private hubKey: string | null = null;

  /** The HUD text last written, so an unchanged value is a no-op. */
  private renderedHud: string | null = null;

  constructor(options: UIManagerOptions) {
    this.root = options.root;
    this.onSelect = options.onSelect;
    this.title = options.title ?? DEFAULT_DRAFT_TITLE;
    this.onEnterHub = options.onEnterHub;
    this.onPurchase = options.onPurchase;
    this.onStartRun = options.onStartRun;
    this.deathTitle = options.deathTitle ?? DEFAULT_DEATH_TITLE;
    this.deathHint = options.deathHint ?? DEFAULT_DEATH_HINT;
    this.winTitle = options.winTitle ?? DEFAULT_WIN_TITLE;
    this.winHint = options.winHint ?? DEFAULT_WIN_HINT;
    this.hubTitle = options.hubTitle ?? DEFAULT_HUB_TITLE;
    this.darknessLabel = options.darknessLabel ?? DEFAULT_DARKNESS_LABEL;
    this.startLabel = options.startLabel ?? DEFAULT_START_LABEL;
    this.hud = options.hud ?? null;
  }

  /**
   * One render-frame sync. Called once per frame with the live world, plus — as of
   * M13-T01 — the read-only meta view the camp draws (omit it and the camp shows an
   * empty save).
   *
   * The HUD is updated FIRST and unconditionally: it is not an overlay, so it must
   * keep reading correctly while a draft or a terminal screen is up. Writing only on
   * a CHANGE keeps the DOM untouched on the overwhelming majority of frames.
   *
   * Then the overlays, in precedence order: terminal first (a finished run is
   * terminal, so it wins over a draft that would otherwise still be on screen), then
   * the camp, then the draft. The order is stated rather than inferred, and no two
   * of them can be live at once: the camp is reachable only FROM a terminal overlay,
   * and the encounter scheduler goes inert the moment the run ends, so no draft can
   * be rolled after a verdict.
   */
  public sync(world: World, meta?: MetaProgressionView): void {
    this.syncHud(world);

    const terminal: TerminalKind = isRunFailed(world) ? 'death' : isRunWon(world) ? 'win' : 'none';
    if (terminal !== 'none') {
      this.clearHub();
      if (this.terminal !== terminal) this.renderTerminal(terminal);
      return;
    }
    if (this.terminal !== 'none') {
      this.clearTerminal();
      this.clear();
    }

    // M13-T01: the camp. Only reachable after a settlement, so the terminal branch
    // above has already taken precedence for this frame if it applied.
    if (isInHub(world)) {
      this.renderHub(meta);
      return;
    }
    this.clearHub();

    const draft = findRewardDraft(world)?.pendingRewards ?? null;

    if (draft === null) {
      if (this.rendered !== null) this.clear();
      return;
    }

    if (this.rendered !== null && sameIds(this.rendered, draft)) return;

    this.render(draft);
  }

  /** Remove the overlay, every listener with it, and the hub key listener. */
  public destroy(): void {
    this.clearTerminal();
    this.clearHub();
    this.clear();
  }

  /**
   * Write the run's gold and collected darkness into the HUD element, if one was
   * provided.
   *
   * A pure READ of the world (spec 09 AC-01). The text is built here rather than
   * stored anywhere, so there is no second copy of "what the HUD looks like" to
   * drift from the numbers. Note the darkness shown is the RUN's tally, not the
   * save's total — the camp is where the permanent number lives.
   */
  private syncHud(world: World): void {
    if (this.hud === null) return;
    const text = `GOLD ${String(readGold(world))}\nDARKNESS ${String(readDarkness(world))}`;
    if (this.renderedHud === text) return;
    this.hud.textContent = text;
    this.renderedHud = text;
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
    window.addEventListener('keydown', this.handleHubKey);
  }

  /** Take a terminal overlay down and disarm the hub key. Idempotent. */
  private clearTerminal(): void {
    if (this.terminal === 'none') return;
    window.removeEventListener('keydown', this.handleHubKey);
    this.terminal = 'none';
  }

  /**
   * Mount (or refresh) the camp: the currency read-out, the talent price list, and
   * the one button that starts the next run (M13-T01, spec 21 AC-03).
   *
   * The render is keyed on everything it DRAWS — the darkness total and the owned
   * set — so a purchase re-renders the list exactly once (a talent must flip from
   * affordable to owned) while an idle frame touches nothing. The price list is read
   * from `DataManager`, the same one-way read `getRewardDefinition` performs, so a
   * talent's name and its price can never drift from the config.
   *
   * AFFORDABILITY IS A HINT, NOT A GATE. An unaffordable button is `disabled` so the
   * player is not invited to click it, but the real check lives in
   * `GameSimulator.purchaseMetaUpgrade`, which refuses the purchase regardless — a
   * DOM attribute is not a security boundary, and the logic layer never trusts one
   * (spec 21 §4.6).
   */
  private renderHub(meta: MetaProgressionView | undefined): void {
    const darkness = meta?.darkness ?? 0;
    const unlocked = meta?.unlockedUpgrades ?? [];
    const key = `${String(darkness)}|${unlocked.join(',')}`;
    if (this.hubKey === key) return;

    this.clear();

    const heading = document.createElement('h2');
    heading.textContent = this.hubTitle;
    this.root.appendChild(heading);

    const currency = document.createElement('p');
    currency.className = 'hub-currency';
    currency.textContent = `${this.darknessLabel} ${String(darkness)}`;
    this.root.appendChild(currency);

    const list = document.createElement('div');
    list.className = 'hub-talents';
    for (const id of DataManager.metaUpgradeIds) {
      const config = DataManager.getMetaUpgradeConfig(id);
      const owned = unlocked.includes(id);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'talent-button';
      button.textContent = `${config.label ?? id} · ${String(config.cost)}`;

      if (owned) {
        button.disabled = true;
        button.classList.add('is-owned');
      } else if (darkness < config.cost) {
        button.disabled = true;
        button.classList.add('is-locked');
      } else {
        button.addEventListener('click', () => {
          this.onPurchase?.(id);
        });
      }
      list.appendChild(button);
    }
    this.root.appendChild(list);

    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'start-button';
    start.textContent = this.startLabel;
    start.addEventListener('click', () => {
      this.onStartRun?.();
    });
    this.root.appendChild(start);

    this.root.classList.add('is-visible', 'is-hub');
    this.hubKey = key;
  }

  /**
   * Take the camp down. Idempotent.
   *
   * The root is wiped only when the camp is what is actually on screen (`is-hub`):
   * the terminal branch may have replaced it within the same frame, and clearing
   * there would blank the overlay the player is reading.
   */
  private clearHub(): void {
    if (this.hubKey === null) return;
    this.hubKey = null;
    if (this.root.classList.contains('is-hub')) this.clear();
  }

  private clear(): void {
    this.root.textContent = '';
    this.root.classList.remove('is-visible', 'is-death', 'is-win', 'is-hub');
    this.rendered = null;
    this.hubKey = null;
  }

  private readonly handleHubKey = (event: KeyboardEvent): void => {
    if (event.code !== HUB_KEY_CODE) return;
    event.preventDefault();
    this.onEnterHub?.();
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
