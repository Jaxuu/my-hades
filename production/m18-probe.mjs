/**
 * TEMPORARY · M18 browser acceptance probe (T057 / T058).
 *
 * Drives headless Chrome over CDP with REAL time — the same lesson M17 learned the
 * hard way: `--virtual-time-budget` never lets the async boot + rAF ticker finish, so
 * the canvas stays empty. Node 22 has a global `WebSocket`, so no dependency is
 * needed.
 *
 * For each viewport it takes a FRESH page load (resizing a live SwiftShader context
 * across an extreme jump loses the canvas), screenshots, and then measures the
 * screenshot in Node. Two numbers matter and both are objective:
 *
 *   1. **horizontal run length** — the mean number of consecutive identical pixels
 *      along a scanline. Pixel art magnified ~8.6x produces runs of ~8-9; HD art at
 *      <= 2.5x with linear filtering produces runs of 1-2. This is the machine
 *      stand-in for SC-009's "no pixel-block magnification".
 *   2. **distinct colours** in the room region — a flat-colour-block room has a
 *      handful; a three-band wall + varied floor + textured characters has many.
 *
 * It also captures the 30x30 stress room at its natural zoom for the moire check
 * (T058) and records the room bounding box, so "the HD tilemap did not break the
 * camera fit" is measured rather than asserted.
 *
 * Deleted after the measurements are recorded in production/m18-evidence.md.
 *
 * Usage: node production/m18-probe.mjs   (expects a server on $M18_URL)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CHROME =
  process.env.M18_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TARGET = process.env.M18_URL ?? 'http://127.0.0.1:4173/';
const PORT = 9334;
const OUT = process.env.M18_OUT ?? 'production/m18-shots';
const SETTLE_MS = Number(process.env.M18_SETTLE_MS ?? 9000);

/** The clear colour the renderer uses for the area outside the room. */
const BG = [0x14, 0x16, 0x1c];

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

/** True when a pixel is not the renderer's clear colour (i.e. it is scene content). */
function isContent(png, x, y, tolerance = 12) {
  const i = (y * png.width + x) * png.channels;
  const d =
    Math.abs(png.data[i] - BG[0]) + Math.abs(png.data[i + 1] - BG[1]) + Math.abs(png.data[i + 2] - BG[2]);
  return d > tolerance;
}

/**
 * Measure the scene: its bounding box, its colour count, and the mean horizontal run
 * of identical pixels inside it.
 */
function measure(png) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  const colours = new Set();
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (!isContent(png, x, y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const i = (y * png.width + x) * png.channels;
      colours.add(`${String(png.data[i])},${String(png.data[i + 1])},${String(png.data[i + 2])}`);
    }
  }
  if (maxX < 0) return null;

  let runTotal = 0;
  let runCount = 0;
  let diffPairs = 0;
  let pairCount = 0;
  for (let y = minY; y <= maxY; y += 1) {
    let run = 1;
    for (let x = minX; x <= maxX; x += 1) {
      if (!isContent(png, x, y)) continue;
      const i = (y * png.width + x) * png.channels;
      const j = (y * png.width + x + 1) * png.channels;
      if (x + 1 > maxX || !isContent(png, x + 1, y)) {
        runTotal += run;
        runCount += 1;
        run = 1;
        continue;
      }
      pairCount += 1;
      const same =
        Math.abs(png.data[i] - png.data[j]) +
        Math.abs(png.data[i + 1] - png.data[j + 1]) +
        Math.abs(png.data[i + 2] - png.data[j + 2]);
      if (same > 6) diffPairs += 1;
      if (same <= 6) run += 1;
      else {
        runTotal += run;
        runCount += 1;
        run = 1;
      }
    }
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    colours: colours.size,
    meanRun: runCount === 0 ? 0 : runTotal / runCount,
    diffRatio: pairCount === 0 ? 0 : diffPairs / pairCount,
  };
}

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
      if (msg.method === 'Network.requestWillBeSent') {
        this.requests.push(msg.params.request.url);
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

/** Hide the DOM skin so the screenshot is canvas content only. */
const HIDE_CHROME = `(() => {
  const ids = ['ui-layer', 'hud', 'gold', 'keys'];
  window.__m18 = ids.map((id) => {
    const el = document.getElementById(id);
    if (el === null) return null;
    const prev = el.style.display;
    el.style.display = 'none';
    return { id, prev };
  });
  return 'hidden';
})()`;

async function shoot(cdp, name) {
  await cdp.send('Runtime.evaluate', { expression: HIDE_CHROME, returnByValue: true });
  await sleep(500);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(shot.data, 'base64');
  writeFileSync(`${OUT}/${name}.png`, buffer);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => { for (const e of window.__m18 ?? []) { if (e === null) continue; const el = document.getElementById(e.id); if (el !== null) el.style.display = e.prev; } return 'ok'; })()`,
    returnByValue: true,
  });
  return measure(decodePng(buffer));
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
    const ws = new WebSocket(await wsEndpoint());
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    // Degradation mode (T064): boot ONCE against a deliberately damaged dist and
    // report whether the app still came up. No screenshots, no measurements.
    if (process.env.M18_MODE === 'degradation') {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Page.navigate', { url: URL_TARGET });
      await sleep(SETTLE_MS);
      const diag = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          canvasCount: document.querySelectorAll('canvas').length,
          canvasW: document.querySelector('canvas')?.width ?? -1,
          title: document.title,
        })`,
        returnByValue: true,
      });
      console.log(`[degradation] ${String(diag.result.value)}`);
      console.log('--- page console ---');
      for (const line of cdp.consoleLines.slice(0, 20)) console.log(line);
      const external = cdp.requests.filter(
        (u) => !/^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|data:|blob:)/.test(u),
      );
      console.log(`[degradation] external requests: ${String(external.length)}`);
      return;
    }

    console.log('--- T057 · viewport sweep (start room) ---');
    for (const viewport of VIEWPORTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.w,
        height: viewport.h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Page.navigate', { url: URL_TARGET });
      await sleep(SETTLE_MS);
      const diag = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          canvasCount: document.querySelectorAll('canvas').length,
          canvasW: document.querySelector('canvas')?.width ?? -1,
          canvasH: document.querySelector('canvas')?.height ?? -1,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          appBg: getComputedStyle(document.getElementById('app') ?? document.body).backgroundColor,
          title: document.title,
          readyState: document.readyState,
        })`,
        returnByValue: true,
      });
      console.log(`  [diag] ${String(diag.result.value)}`);
      const m = await shoot(cdp, viewport.name);
      if (m === null) {
        console.log(`${viewport.name}: EMPTY CANVAS`);
        continue;
      }
      const shortSide = Math.min(viewport.w, viewport.h);
      const fits = m.minX >= 0 && m.minY >= 0 && m.maxX <= viewport.w - 1 && m.maxY <= viewport.h - 1;
      console.log(
        `${viewport.name}: scene ${String(m.w)}x${String(m.h)} | colours ${String(m.colours)} | ` +
          `meanRun ${m.meanRun.toFixed(2)}px | adjacent-differ ${(m.diffRatio * 100).toFixed(1)}% | ` +
          `room-short/viewport-short ${((Math.min(m.w, m.h) / shortSide) * 100).toFixed(1)}% | fully visible ${fits ? 'YES' : 'NO'}`,
      );
    }

    console.log('--- T058 · stress room (30x30) moire check ---');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: `${URL_TARGET}?mode=stress` });
    await sleep(SETTLE_MS);
    const stress = await shoot(cdp, 'moire-stress-1920x1080');
    if (stress === null) {
      console.log('stress: EMPTY CANVAS');
    } else {
      console.log(
        `moire-stress-1920x1080: scene ${String(stress.w)}x${String(stress.h)} | colours ${String(stress.colours)} | ` +
          `meanRun ${stress.meanRun.toFixed(2)}px | adjacent-differ ${(stress.diffRatio * 100).toFixed(1)}%`,
      );
    }

    console.log('--- T064 · offline: zero external requests (SC-012 / FR-021) ---');
    const external = cdp.requests.filter(
      (u) => !/^(https?:\/\/(127\.0\.0\.1|localhost)(:|\/)|data:|blob:)/.test(u),
    );
    console.log(`requests observed: ${String(cdp.requests.length)}, external: ${String(external.length)}`);
    for (const url of external.slice(0, 10)) console.log(`  EXTERNAL ${url}`);

    console.log('--- page console ---');
    for (const line of cdp.consoleLines.slice(0, 25)) console.log(line);
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
