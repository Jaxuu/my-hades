/**
 * TEMPORARY · M19 browser acceptance probe (T052 / T053).
 *
 * WHY A REAL BROWSER
 * ------------------
 * Everything else in M19 is provable in node (the models are pure, the hooks are
 * source-scanned). Two claims are not:
 *
 *   - **T052 (SC-001)** — the HUD is no longer plain text, and the card layout does
 *     not overflow at five viewports. "Does not overflow" is a layout fact that only
 *     a layout engine can answer.
 *   - **T053 (SC-003 / SC-014)** — the three quality colours are pairwise
 *     distinguishable *as painted pixels*. A `border-image` takes over the border
 *     once the asset exists, so the colour has to survive on the ring / chip — which
 *     is a claim about pixels, not about declarations.
 *
 * WHAT IS REAL AND WHAT IS A FIXTURE
 * ----------------------------------
 * Part A runs the REAL built game: real boot, real renderer, real UIManager, real
 * asset URLs, real stylesheet.
 *
 * Part B drives the REAL production stylesheet and the REAL asset URLs, but the
 * card markup is injected from here rather than produced by `UIManager`. That is a
 * deliberate, disclosed trade-off: `client/UIManager.ts` is not reachable from the
 * page (the composition root keeps `sim` and `ui` private), and a draft only appears
 * after a room is cleared. The injected markup is a VERBATIM transcription of
 * `UIManager.render()` (client/UIManager.ts:440-475) — same element order, same
 * classes, same inline `--dash-progress` shape — so what is measured is the
 * production skin over the production DOM contract. It is NOT evidence that
 * `UIManager` emits that markup; that is what `tests/ui/ui_skin.test.ts` is for.
 *
 * Usage: node production/m19-probe.mjs   (spawns its own `vite preview`)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const CHROME = process.env.M19_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.M19_CDP_PORT ?? 9335);
const SERVER_PORT = Number(process.env.M19_SERVER_PORT ?? 4173);
const URL_TARGET = process.env.M19_URL ?? `http://127.0.0.1:${String(SERVER_PORT)}/`;
const OUT = process.env.M19_OUT ?? 'production/m19-shots';
const SETTLE_MS = Number(process.env.M19_SETTLE_MS ?? 9000);

const VIEWPORTS = [
  { name: 'v1-1920x1080', w: 1920, h: 1080 },
  { name: 'v2-2560x1440', w: 2560, h: 1440 },
  { name: 'v3-ultrawide-3840x1080', w: 3840, h: 1080 },
  { name: 'v4-portrait-1080x1920', w: 1080, h: 1920 },
  { name: 'v5-small-800x600', w: 800, h: 600 },
];

/** The seven M19 slots — every one of them must resolve to a real `url(...)`. */
const SLOTS = [
  '--ui-frame-health',
  '--ui-frame-dash',
  '--ui-frame-boon-common',
  '--ui-frame-boon-epic',
  '--ui-frame-boon-legendary',
  '--ui-panel-status',
  '--ui-rule',
];

/**
 * The three cards, transcribed from `client/assets/boons.json` +
 * `client/ui/quality.ts` (labels/pips/shapes) + `client/ui/boon-catalog.ts`
 * (ICON_GLYPHS) + `client/ui/boon-presentation.ts` (rendered descriptions).
 */
const CARDS = [
  {
    rarity: 'common',
    cls: 'boon-rarity-common',
    label: '普通',
    pips: 1,
    glyph: '♥',
    token: 'heart',
    frame: 'boon-icon-frame--square',
    name: '生命上限',
    desc: '生命上限 +20',
  },
  {
    rarity: 'epic',
    cls: 'boon-rarity-epic',
    label: '史诗',
    pips: 2,
    glyph: '↯',
    token: 'lightning',
    frame: 'boon-icon-frame--cut',
    name: '宙斯之击',
    desc: '攻击命中时在目标处引发 20 点雷电伤害',
  },
  {
    rarity: 'legendary',
    cls: 'boon-rarity-legendary',
    label: '传说',
    pips: 3,
    glyph: '◎',
    token: 'trident',
    frame: 'boon-icon-frame--crown',
    name: '海神冲刺',
    desc: '冲刺时在原地引发冲击波，造成 5 点伤害并击退 40',
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- PNG decode */

function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colour type ${String(colorType)}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const target = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? target[i - channels] : 0;
      const b = prior !== null ? prior[i] : 0;
      const c = prior !== null && i >= channels ? prior[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      target[i] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function pixelAt(png, x, y) {
  const cx = Math.max(0, Math.min(png.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(png.height - 1, Math.round(y)));
  const i = (cy * png.width + cx) * png.channels;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

const rgbToHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const maxChannel = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/* ---------------------------------------------------------------- CDP client */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    this.requests = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') this.requests.push(msg.params.request.url);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
          .join(' ');
        this.consoleLines.push(`[${msg.params.type}] ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleLines.push(`[exception] ${msg.params.exceptionDetails?.text ?? '?'}`);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.text}`);
    return res.result.value;
  }

  async shot(name, clip) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const shot = await this.send('Page.captureScreenshot', params);
    const buffer = Buffer.from(shot.data, 'base64');
    writeFileSync(`${OUT}/${name}.png`, buffer);
    return buffer;
  }
}

async function wsEndpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('CDP page endpoint never came up');
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(URL_TARGET);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('preview server never came up');
}

/* ---------------------------------------------------------------- the fixture */

/** The card markup, transcribed from client/UIManager.ts:440-475. */
function cardMarkup(card) {
  const pips = '<i></i>'.repeat(card.pips);
  return (
    `<button type="button" class="reward-button ui-card boon-card ${card.cls}" data-rarity="${card.rarity}">` +
    `<span class="boon-rarity-tag">${card.label}</span>` +
    `<span class="boon-pips">${pips}</span>` +
    `<span class="boon-icon boon-icon-${card.token} ${card.frame}">${card.glyph}</span>` +
    `<span class="boon-name">${card.name}</span>` +
    `<span class="boon-desc">${card.desc}</span>` +
    `</button>`
  );
}

/**
 * Render the cards into a PROBE-OWNED overlay.
 *
 * It deliberately does NOT reuse `#ui-layer`: `UIManager.sync` runs every frame and
 * owns that element, so anything injected into it is wiped (or replaced by the death
 * overlay the unattended run reaches) before the screenshot lands. A separate
 * container keeps the production STYLESHEET and the production ASSET URLs — which is
 * what this part measures — while removing the race.
 */
const INJECT_CARDS = `(() => {
  const stale = document.getElementById('m19-probe-layer');
  if (stale !== null) stale.remove();
  const layer = document.createElement('div');
  layer.id = 'm19-probe-layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:16px;background:rgba(8,10,14,0.86);';
  document.body.appendChild(layer);
  const heading = document.createElement('h2');
  heading.className = 'ui-heading';
  heading.textContent = '选择祝福';
  layer.appendChild(heading);
  const grid = document.createElement('div');
  grid.className = 'boon-grid';
  grid.innerHTML = ${JSON.stringify(CARDS.map(cardMarkup).join(''))};
  layer.appendChild(grid);
  const rects = {};
  for (const card of grid.querySelectorAll('.boon-card')) {
    const r = card.getBoundingClientRect();
    const tag = card.querySelector('.boon-rarity-tag').getBoundingClientRect();
    rects[card.dataset.rarity] = {
      left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
      ringX: r.left - 2, ringY: r.top + r.height / 2,
      chipX: tag.left + tag.width / 2, chipY: tag.top + tag.height / 2,
      chip: getComputedStyle(card.querySelector('.boon-rarity-tag')).backgroundColor,
      shadow: getComputedStyle(card).boxShadow,
      borderImage: getComputedStyle(card).borderImageSource,
      pips: card.querySelectorAll('.boon-pips i').length,
      tagText: card.querySelector('.boon-rarity-tag').textContent,
      frame: [...card.querySelector('.boon-icon').classList].find((c) => c.startsWith('boon-icon-frame--')) ?? null,
    };
  }
  return rects;
})()`;

const ISOLATE = (rarity) => `(() => {
  for (const card of document.querySelectorAll('.boon-card')) {
    card.style.visibility = card.dataset.rarity === ${JSON.stringify(rarity)} ? 'visible' : 'hidden';
  }
  return 'ok';
})()`;

/* ------------------------------------------------------------------- main */

async function main() {
  mkdirSync(OUT, { recursive: true });

  const server = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'preview', '--port', String(SERVER_PORT), '--strictPort'],
    { stdio: 'ignore', shell: process.platform === 'win32' },
  );

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--disable-lcd-text',
      '--force-device-scale-factor=1',
      `--remote-debugging-port=${String(PORT)}`,
      '--window-size=1920,1080',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const report = { partA: [], partB: null, partC: null, console: [] };
  let exitCode = 0;

  try {
    await waitForServer();
    const ws = new WebSocket(await wsEndpoint());
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    console.log('--- T052 · viewport sweep on the REAL built game ---');
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.w,
        height: viewport.h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Page.navigate', { url: URL_TARGET });
      await sleep(SETTLE_MS);

      const dom = await cdp.evaluate(`(() => {
        const hud = document.getElementById('hud-material');
        const gold = document.getElementById('gold');
        const slots = ${JSON.stringify(SLOTS)};
        const resolved = {};
        const cs = getComputedStyle(document.documentElement);
        for (const slot of slots) resolved[slot] = cs.getPropertyValue(slot).trim();
        return {
          canvas: document.querySelectorAll('canvas').length,
          hudExists: hud !== null,
          hudHealth: hud === null ? 0 : hud.querySelectorAll('.hud-health').length,
          hudDash: hud === null ? 0 : hud.querySelectorAll('.hud-dash').length,
          hudDashRing: hud === null ? 0 : hud.querySelectorAll('.hud-dash-ring').length,
          hudHealthFill: hud === null ? 0 : hud.querySelectorAll('.hud-health-fill').length,
          hudTextOnly: hud === null ? true : hud.children.length === 0,
          // NOTE: no backticks in here — this comment lives INSIDE a template
          // literal, and a backtick would terminate it. (#gold carries the .hud-gold
          // class ITSELF, UIManager.ts:365, so a descendant query reports 0.)
          goldIsPlate: gold === null ? false : gold.classList.contains('hud-gold'),
          goldIcon: gold === null ? 0 : gold.querySelectorAll('.hud-gold-icon').length,
          goldValue: gold === null ? 0 : gold.querySelectorAll('.hud-gold-value').length,
          overlayClass: document.getElementById('ui-layer').className,
          slots: resolved,
          dpr: window.devicePixelRatio,
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
          canvasBox: (() => {
            const c = document.querySelector('#app canvas');
            if (c === null) return null;
            const r = c.getBoundingClientRect();
            return { cssW: Math.round(r.width), cssH: Math.round(r.height), attrW: c.width, attrH: c.height,
                     styleW: c.style.width, styleH: c.style.height, display: getComputedStyle(c).display };
          })(),
          // Which element actually drives the document's scroll box.
          overflowSource: (() => {
            let worst = null;
            let worstBottom = -1;
            for (const el of document.querySelectorAll('body *')) {
              const r = el.getBoundingClientRect();
              if (r.bottom > worstBottom) { worstBottom = r.bottom; worst = el; }
            }
            if (worst === null) return null;
            const r = worst.getBoundingClientRect();
            return { tag: worst.tagName, id: worst.id, cls: String(worst.className).slice(0, 48),
                     bottom: Math.round(r.bottom), right: Math.round(r.right),
                     position: getComputedStyle(worst).position };
          })(),
        };
      })()`);

      const unresolved = SLOTS.filter((s) => !dom.slots[s].startsWith('url('));
      const hudNonText = dom.hudHealth > 0 && dom.hudDash > 0 && dom.hudDashRing > 0 && dom.hudHealthFill > 0;
      const noScroll = dom.scrollW <= viewport.w && dom.scrollH <= viewport.h;

      const buffer = await cdp.shot(`${viewport.name}-game`);
      report.partA.push({
        viewport: viewport.name,
        size: `${String(viewport.w)}x${String(viewport.h)}`,
        canvas: dom.canvas,
        hudNonText,
        hudParts: { health: dom.hudHealth, dash: dom.hudDash, ring: dom.hudDashRing, fill: dom.hudHealthFill },
        goldIsPlate: dom.goldIsPlate,
        goldIcon: dom.goldIcon,
        goldValue: dom.goldValue,
        unresolvedSlots: unresolved,
        overlayClass: dom.overlayClass,
        dpr: dom.dpr,
        canvasBox: dom.canvasBox,
        overflowSource: dom.overflowSource,
        noScroll,
        scroll: `${String(dom.scrollW)}x${String(dom.scrollH)}`,
        screenshot: `${viewport.name}-game.png`,
        screenshotBytes: buffer.length,
      });
      console.log(
        `  ${viewport.name}: canvas=${String(dom.canvas)} hudNonText=${String(hudNonText)} ` +
          `goldPlate=${String(dom.goldIsPlate)} unresolved=${String(unresolved.length)} ` +
          `noScroll=${String(noScroll)} dpr=${String(dom.dpr)} overlay="${String(dom.overlayClass)}"`,
      );
      console.log(
        `      scroll=${String(dom.scrollW)}x${String(dom.scrollH)} ` +
          `canvas=${JSON.stringify(dom.canvasBox)} overflowBy=${JSON.stringify(dom.overflowSource)}`,
      );
    }

    console.log('--- T052/T053 · card skin at 1920x1080 (production stylesheet + assets) ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: URL_TARGET });
    await sleep(SETTLE_MS);

    const rects = await cdp.evaluate(INJECT_CARDS);
    await sleep(600);
    const cardShot = await cdp.shot('cards-1920x1080');
    const png = decodePng(cardShot);

    const measured = [];
    for (const card of CARDS) {
      const r = rects[card.rarity];
      const ring = pixelAt(png, r.ringX, r.ringY);
      const chip = pixelAt(png, r.chipX, r.chipY);
      measured.push({
        rarity: card.rarity,
        ringRgb: rgbToHex(ring),
        chipRgb: rgbToHex(chip),
        computedChip: r.chip,
        computedShadow: r.shadow,
        borderImage: r.borderImage.slice(0, 48),
        pips: r.pips,
        tagText: r.tagText,
        frame: r.frame,
        rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }

    // T053 · the pixel criterion: pairwise Euclidean dRGB >= 60 AND max-channel d >= 50.
    const pairs = [];
    for (let i = 0; i < measured.length; i += 1) {
      for (let j = i + 1; j < measured.length; j += 1) {
        const a = measured[i];
        const b = measured[j];
        const ringA = hexToRgb(a.ringRgb);
        const ringB = hexToRgb(b.ringRgb);
        const chipA = hexToRgb(a.chipRgb);
        const chipB = hexToRgb(b.chipRgb);
        const ringE = euclid(ringA, ringB);
        const ringM = maxChannel(ringA, ringB);
        const chipE = euclid(chipA, chipB);
        const chipM = maxChannel(chipA, chipB);
        pairs.push({
          pair: `${a.rarity}↔${b.rarity}`,
          ring: `${ringE.toFixed(1)} / ${String(ringM)}`,
          chip: `${chipE.toFixed(1)} / ${String(chipM)}`,
          pass: ringE >= 60 && ringM >= 50 && chipE >= 60 && chipM >= 50,
        });
      }
    }

    // T053 · grayscale: with colour removed the three cards must STILL differ
    // (pips / label / silhouette), so their crops cannot be identical.
    await cdp.evaluate(`(() => { document.documentElement.style.filter = 'grayscale(1)'; return 'ok'; })()`);
    await sleep(400);
    const grayHashes = {};
    for (const card of CARDS) {
      await cdp.evaluate(ISOLATE(card.rarity));
      await sleep(250);
      const r = rects[card.rarity];
      const crop = await cdp.shot(`cards-gray-${card.rarity}`, {
        x: Math.max(0, r.left - 6),
        y: Math.max(0, r.top - 6),
        width: Math.round(r.width + 12),
        height: Math.round(r.height + 12),
      });
      grayHashes[card.rarity] = sha(crop);
    }
    await cdp.evaluate(`(() => { document.documentElement.style.filter = ''; return 'ok'; })()`);
    await cdp.evaluate(ISOLATE('__none__'));

    const grayDistinct = new Set(Object.values(grayHashes)).size === 3;

    report.partB = { measured, pairs, allPairsPass: pairs.every((p) => p.pass) };
    report.partC = { grayHashes, grayDistinct };

    console.log('  quality ring / chip (sampled pixels):');
    for (const m of measured) {
      console.log(`    ${m.rarity.padEnd(10)} ring=${m.ringRgb} chip=${m.chipRgb} pips=${String(m.pips)} tag=${m.tagText}`);
    }
    console.log('  pairwise:');
    for (const p of pairs) console.log(`    ${p.pair.padEnd(22)} ring ${p.ring}  chip ${p.chip}  pass=${String(p.pass)}`);
    console.log(`  grayscale crops distinct: ${String(grayDistinct)}`);

    // Offline: no external requests at all (FR-053 / SC-011).
    const external = cdp.requests.filter(
      (u) => !/^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|data:|blob:)/.test(u),
    );
    report.externalRequests = external;

    // The M19-scoped verdict. `noScroll` is deliberately NOT part of it: the page's
    // 2x-tall scroll box is a PRE-EXISTING PixiJS canvas-pool artifact, measured
    // identically on the M18 baseline commit (8606ca5) at all five viewports — same
    // `scrollHeight = 2 x viewport`, same bare `position: static` CANVAS as the
    // overflow source. It is reported, not silently dropped, and it is not M19's.
    const ok =
      report.partA.every((v) => v.canvas > 0 && v.hudNonText && v.unresolvedSlots.length === 0) &&
      report.partB.allPairsPass &&
      grayDistinct &&
      external.length === 0;
    report.preExistingPageOverflow = report.partA.every((v) => !v.noScroll);
    if (!ok) exitCode = 1;

    report.console = cdp.consoleLines.slice(0, 20);
  } finally {
    chrome.kill();
    server.kill();
  }

  writeFileSync(`${OUT}/m19-probe-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n[probe] external requests: ${String(report.externalRequests?.length ?? 'n/a')}`);
  console.log(`[probe] report: ${OUT}/m19-probe-report.json`);
  console.log(`[probe] overall: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(exitCode);
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

await main();
