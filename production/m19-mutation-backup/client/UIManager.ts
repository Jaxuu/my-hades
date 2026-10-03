/**
 * UIManager — the DOM half of the run: the boon draft (M6-T01), the gold read-out
 * (M9-T01), the two terminal overlays — death (M8-T01) and victory (M9-T01) — the
 * camp (M13-T01), and, as of M19, the MATERIAL HUD, the enriched boon cards and the
 * non-blocking Tab status panel.
 * See specs/027-hud-boon-ui/contracts/hud-and-overlay-ui.md and
 * specs/027-hud-boon-ui/design/engineering-architecture.md §1 / §5.
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
 * SURFACES
 * --------
 * FOUR overlay surfaces share the one overlay root, and at most one can be on screen
 * at a time (priority: terminal > camp > draft > status panel):
 *
 *   - the REWARD DRAFT (`#ui-layer.is-visible`), driven by `findRewardDraft`;
 *   - the DEATH OVERLAY (`#ui-layer.is-visible.is-death`), driven by `isRunFailed`;
 *   - the VICTORY OVERLAY (`#ui-layer.is-visible.is-win`), driven by `isRunWon`;
 *   - the CAMP (`#ui-layer.is-visible.is-hub`), driven by `isInHub`;
 *   - the STATUS PANEL (`#ui-layer.is-visible.is-status`, M19), a pure overlay that
 *     does NOT pause the run.
 *
 * Plus three ALWAYS-ON surfaces, updated first and unconditionally:
 *
 *   - the DIAGNOSTICS block (`#hud`), owned by `main.ts::installHud`;
 *   - the MATERIAL HUD (`#hud-material`, M19): health bar + dash ring;
 *   - the GOLD PLATE (`#gold`, reused from M9): this run's gold.
 *
 * M19 · WHAT CHANGED
 * ------------------
 * All three of the interface's models were extracted into DOM-free modules under
 * `client/ui/` (quality / catalog / presentation / hud-model / status-panel) so they
 * are node-unit-testable — there is no jsdom in this project. THIS class remains the
 * sole DOM owner: every class and id literal (frozen AND new) lives here, which is
 * what keeps `tests/ui/ui_skin.test.ts` green with zero edits.
 *
 * The ONLY state it owns is "what am I currently showing", used to avoid rebuilding
 * the DOM on every rendered frame (a fresh button per frame would drop the hover
 * state and make clicks feel unreliable), plus the lifetimes of the two window key
 * listeners — the hub key (armed exactly while a terminal overlay is up) and the Tab
 * key (armed exactly while the run is PLAYING with no overlay). A listener that
 * outlived its surface would settle a live run or trap the keyboard.
 */

import type { World } from '../src/ecs/World';
import { findRewardDraft } from '../src/ecs/components/EncounterStateComponent';
import { isInHub, isRunFailed, isRunWon } from '../src/ecs/components/GameStateComponent';
import { readGold } from '../src/ecs/components/InventoryComponent';
import { DataManager } from '../src/data/DataManager';

import { buildBoonCard, type BoonCardView } from './ui/boon-presentation';
import { buildHudView, readHudState } from './ui/hud-model';
import { buildStatusPanel, readOwnedBoonIds } from './ui/status-panel';
import type { Rarity, RarityShape } from './ui/quality';

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
   * wires this to `GameSimulator.enterHub` — the UI never holds the simulator.
   */
  readonly onEnterHub?: () => void;
  /** Called with an upgrade id when the player clicks a talent in the camp. */
  readonly onPurchase?: (upgradeId: string) => void;
  /** Called when the camp's start button is pressed. */
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
   * The always-on read-out element (`#gold`, M9-T01), or `null`/omitted to render
   * no gold plate. Optional so a caller that only wants the overlays needs no extra
   * markup.
   */
  readonly hud?: HTMLElement | null;
  /**
   * M19 · the material HUD element (`#hud-material`), or `null`/omitted to render
   * no material HUD. Carries the health bar and the dash ring.
   */
  readonly hudMaterial?: HTMLElement | null;
  /**
   * M19 · seconds per simulation tick, injected by the composition root as
   * `sim.fixedDeltaSeconds`. Used ONLY to render a tick count as a duration in a
   * boon description — the frame duration is the engine's to own, so this class
   * never hard-codes `1/60` (Principle II).
   */
  readonly tickSeconds: number;
  /** M19 · heading shown on the Tab status panel. */
  readonly panelTitle?: string;
  /** M19 · text shown on the Tab status panel when nothing is owned. */
  readonly panelEmptyText?: string;
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

/** M19 · default heading on the Tab status panel. */
export const DEFAULT_PANEL_TITLE = '祝福 · BOONS';

/** M19 · default empty-state text on the Tab status panel. */
export const DEFAULT_PANEL_EMPTY = '暂无祝福';

/** Physical key code that leaves a terminal overlay for the camp (M13-T01). */
export const HUB_KEY_CODE = 'KeyR';

/** M19 · physical key code that toggles the in-run status panel. */
export const PANEL_KEY_CODE = 'Tab';

/** The coin glyph on the material gold plate (a CSS character, no asset). */
const GOLD_GLYPH = '◎';

/**
 * M19 · rarity -> the `boon-rarity-*` class hook.
 *
 * The literal strings live HERE, in the DOM owner, rather than in `client/ui/quality`
 * — the skin contract test scans this file for them, and class names are a DOM
 * concern. `quality.ts` supplies the colour / label / pips / shape the classes key on.
 */
const RARITY_CLASS_HOOKS: Readonly<Record<Rarity, string>> = {
  common: 'boon-rarity-common',
  epic: 'boon-rarity-epic',
  legendary: 'boon-rarity-legendary',
};

/** M19 · icon-frame silhouette -> the `boon-icon-frame--*` class hook. */
const ICON_FRAME_HOOKS: Readonly<Record<RarityShape, string>> = {
  square: 'boon-icon-frame--square',
  cut: 'boon-icon-frame--cut',
  crown: 'boon-icon-frame--crown',
};

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
  private readonly hudMaterial: HTMLElement | null;
  private readonly tickSeconds: number;
  private readonly panelTitle: string;
  private readonly panelEmptyText: string;

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

  /** The gold text last written, so an unchanged value is a no-op. */
  private renderedHud: string | null = null;

  /** M19 · the material HUD's render key, so an unchanged frame writes no DOM. */
  private renderedHudMaterial: string | null = null;

  /** M19 · whether the player has the Tab panel open. */
  private panelOpen = false;

  /** M19 · whether the Tab key listener is currently armed. */
  private panelKeyAttached = false;

  /** M19 · the panel's render key (the owned ids), so an idle frame is a no-op. */
  private panelKey: string | null = null;

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
    this.hudMaterial = options.hudMaterial ?? null;
    this.tickSeconds = options.tickSeconds;
    this.panelTitle = options.panelTitle ?? DEFAULT_PANEL_TITLE;
    this.panelEmptyText = options.panelEmptyText ?? DEFAULT_PANEL_EMPTY;
  }

  /**
   * One render-frame sync. Called once per frame with the live world, plus — as of
   * M13-T01 — the read-only meta view the camp draws.
   *
   * The HUD surfaces are updated FIRST and unconditionally: they are not overlays, so
   * they must keep reading correctly while a draft or a terminal screen is up.
   * Writing only on a CHANGE keeps the DOM untouched on the overwhelming majority of
   * frames (FR-006).
   *
   * Then the overlays, in precedence order: terminal first (a finished run is
   * terminal, so it wins over a draft that would otherwise still be on screen), then
   * the camp, then the draft, then the Tab status panel — which is available only
   * while the run is PLAYING with no overlay (FR-026).
   */
  public sync(world: World, meta?: MetaProgressionView): void {
    this.syncHud(world);
    this.syncHudMaterial(world);

    const terminal: TerminalKind = isRunFailed(world) ? 'death' : isRunWon(world) ? 'win' : 'none';
    if (terminal !== 'none') {
      this.closePanel();
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
      this.closePanel();
      this.renderHub(meta);
      return;
    }
    this.clearHub();

    const draft = findRewardDraft(world)?.pendingRewards ?? null;

    if (draft !== null) {
      this.closePanel();
      if (this.rendered !== null && sameIds(this.rendered, draft)) return;
      this.render(draft);
      return;
    }
    if (this.rendered !== null) this.clear();

    // PLAYING and no overlay: the Tab status panel is available (and only then —
    // arming the listener here is what keeps it from outliving the run, FR-025).
    this.attachPanelKey();
    if (this.panelOpen) {
      this.renderPanel(world);
    } else if (this.root.classList.contains('is-status')) {
      this.clearPanel();
    }
  }

  /** Remove the overlay, every listener with it, and the hub / panel key listeners. */
  public destroy(): void {
    this.closePanel();
    this.clearTerminal();
    this.clearHub();
    this.clear();
  }

  /**
   * M19 · toggle the in-run status panel.
   *
   * A PURE PRESENTATION flip: the signature takes no `World` and no `GameSimulator`,
   * and the body touches neither — the panel is a reference overlay, never a pause
   * (FR-022 / SC-006). The next `sync` re-renders it from the live owned set.
   */
  public togglePanel(): void {
    this.panelOpen = !this.panelOpen;
    if (this.panelOpen) {
      this.panelKey = null; // force the next sync to render the panel
    } else {
      this.clearPanel();
    }
  }

  /**
   * Write this run's gold into the gold plate (`#gold`), if one was provided.
   *
   * A pure READ of the world (spec 09 AC-01). The plate is rebuilt only when the
   * number changes, so an idle frame writes nothing (FR-006). The run's darkness is
   * shown by the diagnostics block (`#hud`), so this surface stays a clean gold plate
   * and the two never contradict each other (FR-007).
   */
  private syncHud(world: World): void {
    if (this.hud === null) return;
    const gold = readGold(world);
    const key = String(gold);
    if (this.renderedHud === key) return;

    this.hud.textContent = '';
    this.hud.className = 'hud-gold';
    const icon = document.createElement('span');
    icon.className = 'hud-gold-icon';
    icon.textContent = GOLD_GLYPH;
    const value = document.createElement('span');
    value.className = 'hud-gold-value';
    value.textContent = String(gold);
    this.hud.appendChild(icon);
    this.hud.appendChild(value);
    this.renderedHud = key;
  }

  /**
   * M19 · write the material HUD (health + dash) into `#hud-material`.
   *
   * Rebuilt only when the underlying numbers change: `HudView.key` folds hp / maxHp /
   * the dash counters / gold, so a frame with no change performs ZERO DOM writes
   * (FR-006, the testable form of "no flicker").
   */
  private syncHudMaterial(world: World): void {
    if (this.hudMaterial === null) return;
    const view = buildHudView(readHudState(world));
    if (this.renderedHudMaterial === view.key) return;

    this.hudMaterial.textContent = '';

    const health = document.createElement('div');
    health.className = `hud-health is-${view.hpState}`;
    const track = document.createElement('div');
    track.className = 'hud-health-track';
    const fill = document.createElement('div');
    fill.className = 'hud-health-fill';
    fill.style.width = `${String(Math.round(view.hpRatio * 100))}%`;
    track.appendChild(fill);
    const healthValue = document.createElement('span');
    healthValue.className = 'hud-health-value';
    healthValue.textContent = view.hpText;
    health.appendChild(track);
    health.appendChild(healthValue);

    const dash = document.createElement('div');
    dash.className = `hud-dash is-${view.dashState}`;
    const ring = document.createElement('span');
    ring.className = 'hud-dash-ring';
    ring.style.setProperty('--dash-progress', String(view.dashProgress));
    const dashValue = document.createElement('span');
    dashValue.className = 'hud-dash-value';
    dashValue.textContent = view.dashText;
    dash.appendChild(ring);
    dash.appendChild(dashValue);

    this.hudMaterial.appendChild(health);
    this.hudMaterial.appendChild(dash);
    this.renderedHudMaterial = view.key;
  }

  private render(ids: readonly string[]): void {
    // `textContent = ''` detaches the old buttons AND their click listeners in one
    // step, so a rebuild can never leak a handler that would fire twice.
    this.clear();

    const heading = document.createElement('h2');
    // M16: a skin hook only. The heading's text, its position in the DOM and the
    // branch that produces it are untouched (ui-asset-slots.md 承诺 1).
    heading.className = 'ui-heading';
    heading.textContent = this.title;
    this.root.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'boon-grid';

    for (const id of ids) {
      // The label lives in the logic layer's pool table, read one-way, so the draft
      // and its display name can never drift apart. M19 adds the three card
      // elements (quality / glyph / numeric description) on top of the same button.
      const button = document.createElement('button');
      button.type = 'button';
      const card = buildBoonCard(id, this.tickSeconds);
      button.className = `reward-button ui-card boon-card ${RARITY_CLASS_HOOKS[card.rarity]}`;

      const tag = document.createElement('span');
      tag.className = 'boon-rarity-tag';
      tag.textContent = card.rarityLabel;

      const pips = document.createElement('span');
      pips.className = 'boon-pips';
      for (let pip = 0; pip < card.pips; pip += 1) {
        pips.appendChild(document.createElement('i'));
      }

      const icon = document.createElement('span');
      icon.className = `boon-icon boon-icon-${card.iconToken} ${ICON_FRAME_HOOKS[card.shape]}`;
      icon.textContent = card.iconGlyph;

      const name = document.createElement('span');
      name.className = 'boon-name';
      name.textContent = card.label;

      const description = document.createElement('span');
      description.className = 'boon-desc';
      description.textContent = card.description;

      button.appendChild(tag);
      button.appendChild(pips);
      button.appendChild(icon);
      button.appendChild(name);
      button.appendChild(description);
      button.addEventListener('click', () => {
        this.onSelect(id);
      });
      grid.appendChild(button);
    }

    this.root.appendChild(grid);
    this.root.classList.add('is-visible');
    this.rendered = [...ids];
  }

  /**
   * Mount a terminal overlay (`death` or `win`) and arm the restart key.
   *
   * One rendering path with two skins, because the two terminal states differ only
   * in their copy and their colour — and duplicating the listener lifecycle for a
   * second overlay is exactly how one of the two ends up with a stale key handler.
   */
  private renderTerminal(kind: 'death' | 'win'): void {
    this.clear();

    const heading = document.createElement('h2');
    heading.className = 'ui-heading ui-heading-terminal';
    heading.textContent = kind === 'win' ? this.winTitle : this.deathTitle;
    this.root.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'death-hint ui-hint';
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
   * The render is keyed on everything it DRAWS, so a purchase re-renders the list
   * exactly once while an idle frame touches nothing. AFFORDABILITY IS A HINT, NOT A
   * GATE: the real check lives in `GameSimulator.purchaseMetaUpgrade` (spec 21 §4.6).
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
    currency.className = 'hub-currency ui-currency';
    currency.textContent = `${this.darknessLabel} ${String(darkness)}`;
    this.root.appendChild(currency);

    const list = document.createElement('div');
    list.className = 'hub-talents ui-list';
    for (const id of DataManager.metaUpgradeIds) {
      const config = DataManager.getMetaUpgradeConfig(id);
      const owned = unlocked.includes(id);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'talent-button ui-card';
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
    start.className = 'start-button ui-button-primary';
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

  /**
   * M19 · render the Tab status panel: one row per owned boon, or an explicit empty
   * state. Rebuilt only when the owned set changes, so an idle open panel costs
   * nothing per frame.
   */
  private renderPanel(world: World): void {
    const view = buildStatusPanel(readOwnedBoonIds(world), this.tickSeconds);
    const key = view.rows.map((row) => row.id).join(',');
    if (this.panelKey === key && this.root.classList.contains('is-status')) return;

    this.clear();

    const heading = document.createElement('h2');
    heading.className = 'ui-heading';
    heading.textContent = this.panelTitle;
    this.root.appendChild(heading);

    const panel = document.createElement('div');
    panel.className = 'status-panel';

    if (view.isEmpty) {
      const empty = document.createElement('p');
      empty.className = 'status-empty';
      empty.textContent = this.panelEmptyText;
      panel.appendChild(empty);
    } else {
      for (const row of view.rows) panel.appendChild(this.buildStatusRow(row));
    }

    this.root.appendChild(panel);
    this.root.classList.add('is-visible', 'is-status');
    this.panelKey = key;
  }

  /** M19 · one status-panel row (quality + glyph + name + description). */
  private buildStatusRow(row: BoonCardView): HTMLElement {
    const element = document.createElement('div');
    element.className = `status-row ${RARITY_CLASS_HOOKS[row.rarity]}`;

    const icon = document.createElement('span');
    icon.className = `boon-icon boon-icon-${row.iconToken} ${ICON_FRAME_HOOKS[row.shape]}`;
    icon.textContent = row.iconGlyph;

    const text = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'boon-name';
    name.textContent = row.label;
    const description = document.createElement('span');
    description.className = 'boon-desc';
    description.textContent = row.description;
    text.appendChild(name);
    text.appendChild(description);

    const tag = document.createElement('span');
    tag.className = 'boon-rarity-tag';
    tag.textContent = row.rarityLabel;

    element.appendChild(icon);
    element.appendChild(text);
    element.appendChild(tag);
    return element;
  }

  /** M19 · take the panel down (idempotent). Wipes the root only if it is up. */
  private clearPanel(): void {
    if (this.panelKey === null && !this.root.classList.contains('is-status')) return;
    this.panelKey = null;
    if (this.root.classList.contains('is-status')) this.clear();
  }

  /** M19 · close the panel and disarm its key. Called on every non-PLAYING frame. */
  private closePanel(): void {
    this.detachPanelKey();
    this.panelOpen = false;
    this.clearPanel();
  }

  /** M19 · arm the Tab key, exactly once. */
  private attachPanelKey(): void {
    if (this.panelKeyAttached) return;
    window.addEventListener('keydown', this.handlePanelKey);
    this.panelKeyAttached = true;
  }

  /** M19 · disarm the Tab key, exactly once. Idempotent. */
  private detachPanelKey(): void {
    if (!this.panelKeyAttached) return;
    window.removeEventListener('keydown', this.handlePanelKey);
    this.panelKeyAttached = false;
  }

  private clear(): void {
    this.root.textContent = '';
    this.root.classList.remove('is-visible', 'is-death', 'is-win', 'is-hub', 'is-status');
    this.rendered = null;
    this.hubKey = null;
    this.panelKey = null;
  }

  private readonly handleHubKey = (event: KeyboardEvent): void => {
    if (event.code !== HUB_KEY_CODE) return;
    event.preventDefault();
    this.onEnterHub?.();
  };

  private readonly handlePanelKey = (event: KeyboardEvent): void => {
    if (event.code !== PANEL_KEY_CODE) return;
    event.preventDefault();
    this.togglePanel();
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
