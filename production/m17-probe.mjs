/**
 * TEMPORARY · M17 browser acceptance probe.
 *
 * Drives the cached Playwright Chromium over CDP (Node 22 has a global
 * `WebSocket`, so no dependency is needed) with REAL time — headless Chrome's
 * `--virtual-time-budget` never let the async boot + rAF ticker complete.
 *
 * For each viewport it:
 *   1. sets the device metrics,
 *   2. waits for the game to actually run (a fixed real-time settle),
 *   3. captures a screenshot,
 *   4. decodes the PNG in Node and measures the ROOM's bounding box from the pixels
 *      — an objective occupancy number, not a visual impression.
 *
 * Deleted after the measurement is recorded in production/m17-evidence.md.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CHROME =
  process.env.M17_CHROME ??
  'C:/Users/14041/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const URL_TARGET = process.env.M17_URL ?? 'http://localhost:5199/';
const PORT = 9333;
const OUT = process.env.M17_OUT ?? 'production/m17-shots';
const SETTLE_MS = Number(process.env.M17_SETTLE_MS ?? 9000);

const VIEWPORTS = [
  { name: 'v1-1920x1080', w: 1920, h: 1080 },
  { name: 'v2-2560x1440', w: 2560, h: 1440 },
  { name: 'v5a-32x9-3840x1080', w: 3840, h: 1080 },
  { name: 'v5b-9x16-1080x1920', w: 1080, h: 1920 },
  { name: 'v6-800x600', w: 800, h: 600 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- PNG decode */

/** Minimal PNG decoder for what Chrome emits: 8-bit, colour type 2 or 6, no interlace. */
function decodePng(buffer) {
  let offset = 8; // signature
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

/**
 * The bounding box of pixels that differ from the app's clear colour (`0x14161c`),
 * with the DOM chrome MASKED OUT.
 *
 * The DOM skin draws a frame around the whole viewport plus three HUD panels, and
 * those are real pixels in the screenshot. Since their exact rectangles are known
 * from `getBoundingClientRect`, masking them (inflated a little) leaves the canvas
 * CONTENT — which, on a live start room, is the room and nothing else.
 */
function contentBox(png, exclude = [], tolerance = 12) {
  const { width, height, channels, data } = png;
  const bg = [0x14, 0x16, 0x1c];
  const masked = (x, y) => {
    for (const r of exclude) {
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return true;
    }
    return false;
  };
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let hits = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (masked(x, y)) continue;
      const i = (y * width + x) * channels;
      const dr = Math.abs(data[i] - bg[0]);
      const dg = Math.abs(data[i + 1] - bg[1]);
      const db = Math.abs(data[i + 2] - bg[2]);
      if (dr + dg + db > tolerance) {
        hits += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, hits };
}

/* ---------------------------------------------------------------- CDP client */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? ''))
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
}

async function wsEndpoint() {
  // NOTE: `/json/version` yields the BROWSER-level endpoint, which has no `Page.*`
  // domain. The page target from `/json/list` is what supports navigation,
  // screenshots and Runtime evaluation.
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

async function main() {
  mkdirSync(OUT, { recursive: true });
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

  let cdp;
  try {
    const url = await wsEndpoint();
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    cdp = new Cdp(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const results = [];
    for (const viewport of VIEWPORTS) {
      // A FRESH boot per viewport. Resizing an already-running SwiftShader context
      // across a 3840x1080 -> 1080x1920 jump was measured to lose the canvas
      // entirely (a blank clear colour), so each size gets its own page load.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.w,
        height: viewport.h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Page.navigate', { url: URL_TARGET });
      // REAL time: the boot is async and the ticker needs actual frames.
      await sleep(SETTLE_MS);

      const probe = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          canvasCount: document.querySelectorAll('canvas').length,
          canvasW: document.querySelector('canvas')?.width ?? -1,
          canvasH: document.querySelector('canvas')?.height ?? -1,
          dpr: window.devicePixelRatio,
          gold: document.getElementById('gold')?.getBoundingClientRect().toJSON() ?? null,
          hud: document.getElementById('hud')?.getBoundingClientRect().toJSON() ?? null,
          uiLayer: document.getElementById('ui-layer')?.getBoundingClientRect().toJSON() ?? null,
        })`,
        returnByValue: true,
      });
      const dom = JSON.parse(probe.result.value);

      // Hide the DOM chrome for the measurement shot. The skin draws a frame around
      // the viewport plus four HUD panels, and masking them by rectangle is fragile
      // (the bottom hint bar overflows its own box). Hiding the DOM leaves ONLY the
      // canvas content, which on a live start room is the room and nothing else —
      // so "differs from the clear colour" becomes an exact room measurement.
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const ids = ['ui-layer', 'hud', 'gold', 'keys'];
          window.__m17 = ids.map((id) => {
            const el = document.getElementById(id);
            if (el === null) return null;
            const prev = el.style.display;
            el.style.display = 'none';
            return { id, prev };
          });
          return 'hidden';
        })()`,
        returnByValue: true,
      });
      await sleep(400);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buffer = Buffer.from(shot.data, 'base64');
      writeFileSync(`${OUT}/${viewport.name}.png`, buffer);

      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          for (const entry of window.__m17 ?? []) {
            if (entry === null) continue;
            const el = document.getElementById(entry.id);
            if (el !== null) el.style.display = entry.prev;
          }
          return 'restored';
        })()`,
        returnByValue: true,
      });

      const png = decodePng(buffer);
      const box = contentBox(png);
      results.push({ viewport, box, png: { w: png.width, h: png.height }, dom });

      const occupancy = box === null ? 0 : Math.max(box.w / viewport.w, box.h / viewport.h);
      console.log(
        `${viewport.name}: canvas ${String(dom.canvasW)}x${String(dom.canvasH)} dpr=${String(dom.dpr)} ` +
          `| room ${box === null ? 'EMPTY' : `${String(box.w)}x${String(box.h)} @ (${String(box.minX)},${String(box.minY)})`}` +
          ` | longest-side occupancy ${(occupancy * 100).toFixed(1)}%` +
          ` | short-side occupancy ${(box === null ? 0 : Math.min(box.w / viewport.w, box.h / viewport.h) * 100).toFixed(1)}%`,
      );
    }

    console.log('--- console from the page ---');
    for (const line of cdp.consoleLines.slice(0, 30)) console.log(line);
    console.log('--- DOM HUD geometry (SC-003) ---');
    for (const r of results) {
      const gold = r.dom.gold;
      const hud = r.dom.hud;
      const fmt = (x) =>
        x === null
          ? 'null'
          : `${x.width.toFixed(3)}x${x.height.toFixed(3)} @ (${x.left.toFixed(3)},${x.top.toFixed(3)})`;
      console.log(
        `${r.viewport.name}: hud ${fmt(hud)} | gold ${fmt(gold)} | ` +
          `gold right-inset ${gold === null ? '?' : (r.viewport.w - gold.right).toFixed(3)}`,
      );
    }
    console.log('--- room summary (SC-001 / SC-002 / SC-008) ---');
    for (const r of results) {
      const b = r.box;
      if (b === null) {
        console.log(`${r.viewport.name}: EMPTY`);
        continue;
      }
      const vw = r.viewport.w;
      const vh = r.viewport.h;
      const shortSide = Math.min(vw, vh);
      const roomShort = Math.min(b.w, b.h);
      const centreX = b.minX + b.w / 2;
      const centreY = b.minY + b.h / 2;
      const fits =
        b.minX >= 0 && b.minY >= 0 && b.maxX <= vw - 1 && b.maxY <= vh - 1 ? 'YES' : 'NO';
      console.log(
        `${r.viewport.name}: room ${String(b.w)}x${String(b.h)} | centred (${centreX.toFixed(1)},${centreY.toFixed(1)}) ` +
          `vs (${(vw / 2).toFixed(1)},${(vh / 2).toFixed(1)}) | room-short/viewport-short ` +
          `${((roomShort / shortSide) * 100).toFixed(1)}% | fully visible ${fits}`,
      );
    }
  } finally {
    if (cdp) {
      try {
        await cdp.send('Browser.close');
      } catch {
        /* ignore */
      }
    }
    chrome.kill();
  }
}

main().catch((error) => {
  console.error('PROBE FAILED:', error);
  process.exitCode = 1;
});
