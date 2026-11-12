#!/usr/bin/env node

/* Record the batch panel against a loopback-only gallery and upload sink. */
/* global chrome, document */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtExtension = path.join(extensionRoot, 'dist', 'extension');
const websiteHome = 'E:/MyRepositories/Serpent-Website/static/img/home';
const videoOutput = path.join(websiteHome, 'extension-batch.webm');
const posterOutput = path.join(websiteHome, 'extension-batch-poster.webp');
const requireFromExtension = createRequire(path.join(extensionRoot, '__batch_demo_resolver__.cjs'));
const chromium = requireFromExtension('playwright').chromium;
const artwork = [
  { id: 'coastal-light', title: 'Coastal light', size: 960, colors: ['#f9c78a', '#e6785b', '#165e70'], scene: 'coast' },
  { id: 'garden-study', title: 'Garden study', size: 960, colors: ['#dce7b7', '#729a68', '#375c50'], scene: 'garden' },
  { id: 'citrus-table', title: 'Citrus table', size: 960, colors: ['#f4b3a5', '#ec7b49', '#446959'], scene: 'citrus' },
  { id: 'blue-hour', title: 'Blue hour', size: 960, colors: ['#344f77', '#829ab5', '#e5bf89'], scene: 'city' },
  { id: 'pond-notes', title: 'Pond notes', size: 960, colors: ['#b8d2c3', '#397b73', '#ea9c79'], scene: 'pond' },
  { id: 'small-dunes', title: 'Dune lines', size: 320, colors: ['#f4d5ac', '#d99c78', '#915d62'], scene: 'dunes' },
  { id: 'small-window', title: 'Open window', size: 320, colors: ['#e7c5a9', '#84b8b1', '#435a68'], scene: 'window' },
  { id: 'small-still-life', title: 'Still life', size: 320, colors: ['#f0d3b2', '#b15e55', '#3c526f'], scene: 'still' },
];

function svgImage({ size, colors: [sky, accent, deep], scene }) {
  const sceneMarkup = {
    coast: `<circle cx="700" cy="240" r="112" fill="#fff2c8" opacity=".94"/><path d="M0 520 Q180 445 350 520T700 510T960 500V960H0Z" fill="${deep}"/><path d="M0 690 Q220 620 430 684T960 650V960H0Z" fill="${accent}"/><path d="M0 800 Q260 720 520 790T960 760V960H0Z" fill="${deep}" opacity=".8"/><path d="M100 665h150M590 620h190M260 850h180" stroke="#f5d7a8" stroke-width="11" stroke-linecap="round" opacity=".7"/>`,
    garden: `<path d="M480 960V300" stroke="${deep}" stroke-width="24"/><path d="M470 580Q180 540 190 300Q390 330 470 520M495 720Q760 680 785 445Q590 445 495 660M470 420Q290 370 330 170Q475 220 485 375M495 520Q660 455 630 260Q500 310 490 470" fill="${accent}" stroke="${deep}" stroke-width="14" stroke-linejoin="round"/><circle cx="255" cy="765" r="105" fill="#e89c80"/><circle cx="690" cy="810" r="128" fill="#d4b963"/><path d="M80 910Q280 820 450 915T880 900" fill="none" stroke="${deep}" stroke-width="18"/>`,
    citrus: `<ellipse cx="490" cy="690" rx="320" ry="165" fill="#fff0d1" opacity=".82"/><circle cx="345" cy="575" r="138" fill="${accent}"/><circle cx="600" cy="640" r="150" fill="#edaa43"/><path d="M340 435q40-120 142-94q-27 87-142 94M597 490q45-108 143-75q-31 88-143 75" fill="${deep}"/><path d="M222 790q267 90 530 0" fill="none" stroke="#d78e69" stroke-width="20"/><circle cx="355" cy="575" r="42" fill="#f8d77c" opacity=".7"/>`,
    city: `<circle cx="725" cy="220" r="82" fill="#f4d3a0"/><path d="M90 660V400h190v260M300 660V300h230v360M560 660V430h160v230M740 660V350h150v310" fill="${deep}"/><path d="M0 660h960v300H0Z" fill="${accent}"/><g fill="#f2cf91"><path d="M140 450h48v76h-48zM330 360h52v80h-52zM430 360h52v80h-52zM600 480h50v70h-50zM780 390h48v80h-48z"/><path d="M330 490h52v80h-52zM430 490h52v80h-52zM780 510h48v70h-48z"/></g><path d="M0 820q210-60 430 0t530 0" fill="none" stroke="#f7dfb4" stroke-width="15" opacity=".75"/>`,
    dunes: `<circle cx="710" cy="245" r="92" fill="#fff0c7"/><path d="M0 520Q210 260 500 500t460-15v475H0Z" fill="${accent}"/><path d="M0 650Q260 390 510 645t450-20v335H0Z" fill="${deep}"/><path d="M0 760Q220 570 500 760t460-30v230H0Z" fill="#d9a478"/><path d="M0 900Q290 720 540 890t420-10v80H0Z" fill="${deep}" opacity=".85"/>`,
    window: `<rect x="120" y="95" width="720" height="770" rx="360" fill="${deep}"/><path d="M205 625V240h550v385" fill="${sky}"/><path d="M205 625Q420 480 755 610v230H205Z" fill="${accent}"/><path d="M430 625V240M205 430h550" stroke="#f5dfc1" stroke-width="28"/><circle cx="640" cy="340" r="84" fill="#f3ca83"/><path d="M270 740q120-90 240 0t210 0" fill="none" stroke="#fff0d8" stroke-width="15"/>`,
    pond: `<path d="M0 300Q240 220 470 320t490-5v645H0Z" fill="${deep}"/><ellipse cx="300" cy="540" rx="190" ry="70" fill="${accent}"/><ellipse cx="720" cy="730" rx="240" ry="80" fill="#77a89a"/><path d="M300 540v-240m0 120q-145-100-200-20q78 100 200 20m0-30q135-130 220-50q-78 125-220 50" fill="none" stroke="#b9d5b2" stroke-width="24" stroke-linecap="round"/><circle cx="300" cy="270" r="66" fill="#f0a08a"/><circle cx="300" cy="270" r="23" fill="#ffe0a1"/><path d="M90 850q210-95 400 0t410-5" fill="none" stroke="#c7ddd0" stroke-width="14" opacity=".7"/>`,
    still: `<path d="M185 610q275-180 590 0l-55 235H245Z" fill="${accent}"/><path d="M355 600l30-280h200l30 280q-35 130-130 130T355 600" fill="${deep}"/><path d="M410 340q70-95 150 0" fill="none" stroke="#f2d2a9" stroke-width="18"/><path d="M460 318q-130-145-210-54q45 145 210 100M500 318q125-175 220-86q-52 155-220 132" fill="#799c77"/><circle cx="640" cy="710" r="70" fill="#ecc17c"/><path d="M155 870h650" stroke="#f6e1c6" stroke-width="19" stroke-linecap="round"/>`,
  }[scene];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 960 960"><defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="${sky}"/><stop offset="1" stop-color="#f3e3cd"/></linearGradient><pattern id="grain" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="4" cy="7" r="1.5" fill="#fff" opacity=".15"/><circle cx="22" cy="20" r="1" fill="#26313c" opacity=".06"/></pattern></defs><rect width="960" height="960" fill="url(#bg)"/>${sceneMarkup}<rect width="960" height="960" fill="url(#grain)"/></svg>`;
}

function htmlPage(sourcePort) {
  const cards = artwork.map((item, index) => `<article class="card"><img src="http://127.0.0.1:${sourcePort}/art/${item.id}.svg" alt="${item.title}"><div class="caption"><span>0${index + 1}</span><strong>${item.title}</strong></div></article>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Field notes — local collection</title><style>
    *{box-sizing:border-box}body{margin:0;background:#eee9df;color:#27312d;font:14px/1.5 Inter,"Segoe UI",sans-serif}.top{height:74px;padding:0 38px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #d7d1c7;background:#f5f1e9}.brand{font:600 17px Georgia,serif;letter-spacing:.11em}.local{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#777d72}.intro{padding:26px 38px 18px}.intro small{color:#8b806f;letter-spacing:.13em;text-transform:uppercase;font-size:10px}.intro h1{font:400 28px Georgia,serif;margin:8px 0 4px}.intro p{color:#74766e;margin:0}.gallery{padding:0 38px 28px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{margin:0;background:#faf8f2;padding:7px 7px 9px;box-shadow:0 7px 22px #302a2010}.card img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover}.caption{display:flex;gap:9px;align-items:center;padding:8px 3px 0;color:#73796f;font-size:11px}.caption strong{font:500 12px Georgia,serif;color:#33403a}.caption span{font-size:9px;color:#a19b8d}.note{position:fixed;left:16px;bottom:14px;background:#fffdf8d9;border:1px solid #dcd5c8;padding:6px 10px;border-radius:20px;color:#787d75;font-size:10px;letter-spacing:.04em}
    #recording-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:24px;height:28px;pointer-events:none;opacity:0;transform:translate(-2px,-2px);transition:opacity .12s}#recording-cursor.visible{opacity:1}#recording-cursor svg{filter:drop-shadow(0 1px 2px #0006)}#recording-cursor.clicked:after{content:"";position:absolute;left:5px;top:5px;width:20px;height:20px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 2px #2233;animation:pulse .45s ease-out forwards}@keyframes pulse{to{transform:scale(1.7);opacity:0}}
  </style></head><body><header class="top"><div class="brand">FIELD NOTES</div><div class="local">Local sample collection · 8 images</div></header><section class="intro"><small>Visual index / 2026</small><h1>Little studies of place</h1><p>A small collection of color, light, and everyday forms.</p></section><main class="gallery">${cards}</main><div class="note">Local demo page</div><div id="recording-cursor"><svg viewBox="0 0 24 28" width="24" height="28"><path d="M3 2 20 16l-7 .8 4 7-3 1.5-4-7-4.5 5z" fill="#111820" stroke="white" stroke-width="1.7" stroke-linejoin="round"/></svg></div><script>const c=document.querySelector('#recording-cursor');let t;addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px';c.classList.add('visible')});addEventListener('mousedown',()=>{c.classList.remove('clicked');void c.offsetWidth;c.classList.add('clicked');clearTimeout(t);t=setTimeout(()=>c.classList.remove('clicked'),480)});</script></body></html>`;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function launchFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-4000))));
  });
}

async function main() {
  await stat(path.join(builtExtension, 'manifest.json'));
  await mkdir(websiteHome, { recursive: true });
  const tempParent = os.tmpdir();
  const tempRoot = await mkdtemp(path.join(tempParent, 'serpent-batch-demo-'));
  const rawDir = path.join(tempRoot, 'raw-video');
  const profileDir = path.join(tempRoot, 'profile');
  await mkdir(rawDir);
  let context;
  let sourceServer;
  let desktopServer;
  let rawVideo;
  let startMs;
  let panelOpenedMs;
  let doneMs;
  const uploads = [];
  const artByPath = new Map(artwork.map((item) => [`/art/${item.id}.svg`, item]));
  let sourcePort;
  try {
    sourceServer = createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/collection') {
        const port = sourceServer.address().port;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(htmlPage(port));
        return;
      }
      const item = artByPath.get(url.pathname);
      if (request.method === 'GET' && item) {
        response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(svgImage(item));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
    });
    sourcePort = await listen(sourceServer);

    desktopServer = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', '*');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
      if (request.method === 'GET' && pathname === '/ping') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); return;
      }
      if (request.method === 'GET' && pathname === '/folders') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ folders: [], recentBrowsedFolderIds: [], libraryDisplayName: 'Demo library' })); return;
      }
      if (request.method === 'GET' && pathname === '/collections') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"collections":[],"libraryDisplayName":"Demo library"}'); return;
      }
      if (request.method === 'GET' && pathname === '/capabilities') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok","segmentedMediaUpload":null}'); return;
      }
      if (request.method === 'POST' && pathname === '/save-upload') {
        const pageUrl = decodeURIComponent(String(request.headers['x-serpent-source-page-url'] || ''));
        const mediaUrl = decodeURIComponent(String(request.headers['x-serpent-media-url'] || ''));
        assert.equal(pageUrl, `http://127.0.0.1:${sourcePort}/collection`, 'upload must refer to the local demo page');
        assert(artByPath.has(new URL(mediaUrl).pathname), 'upload must refer to a local demo artwork');
        uploads.push({ body, headers: request.headers });
        await new Promise((resolve) => setTimeout(resolve, 850));
        response.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":true}'); return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"unknown fixture endpoint"}');
    });
    const desktopPort = await listen(desktopServer);

    const fixtureExtension = path.join(tempRoot, 'extension');
    await cp(builtExtension, fixtureExtension, { recursive: true });
    const backgroundPath = path.join(fixtureExtension, 'background.js');
    const background = await readFile(backgroundPath, 'utf8');
    assert.equal((background.match(/19876\s*,\s*19877\s*,\s*19878/gu) || []).length, 2);
    assert.equal((background.match(/:1987\[6-8\]/gu) || []).length, 1);
    const patched = background.replace(/19876\s*,\s*19877\s*,\s*19878/gu, String(desktopPort))
      .replace(/:1987\[6-8\]/gu, `:${desktopPort}`);
    await writeFile(backgroundPath, patched, 'utf8');

    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 760, height: 620 },
      screen: { width: 760, height: 620 },
      recordVideo: { dir: rawDir, size: { width: 760, height: 620 } },
      args: [
        `--disable-extensions-except=${fixtureExtension}`,
        `--load-extension=${fixtureExtension}`,
        '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      ],
      channel: 'chromium',
    });
    const page = await context.newPage();
    rawVideo = page.video();
    startMs = Date.now();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${sourcePort}/collection`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.images.length === 8
      && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    await page.waitForTimeout(350);

    const worker = await waitForWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, page.url());
    assert.equal(typeof tabId, 'number');
    await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'serpent-open-batch' }), tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 8);
    panelOpenedMs = Date.now();
    await page.waitForTimeout(650);

    const edge = page.getByLabel('最短边');
    await edge.click();
    await edge.fill('500');
    await edge.press('Tab');
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 5);
    await page.waitForTimeout(800);

    const selectAll = page.locator('[data-serpent-ui="batch"] [data-action="all"]');
    const box = await selectAll.boundingBox();
    assert(box, 'selection control must be visible');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(260);
    const cards = page.locator('[data-serpent-ui="batch"] .card');
    for (const index of [0, 2, 4]) {
      const cardBox = await cards.nth(index).boundingBox();
      assert(cardBox, `card ${index} must be visible`);
      await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.waitForTimeout(280);
    }
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 3 / 5');
    await page.waitForTimeout(700);

    const save = page.locator('[data-serpent-ui="batch"] [data-action="save"]');
    const saveBox = await save.boundingBox();
    assert(saveBox, 'save control must be visible');
    await page.mouse.click(saveBox.x + saveBox.width / 2, saveBox.y + saveBox.height / 2);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="progress"]')?.hidden === false);
    await waitForNode(() => uploads.length === 3, 20_000, 'three local fixture uploads');
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent?.includes('已保存 3 个文件')
      || document.querySelector('[data-serpent-ui="batch"]')
        ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent?.includes('保存 0 个原图或较高质量版本、3 个当前预览'),
    undefined, { timeout: 20_000 });
    doneMs = Date.now();
    assert.equal(uploads.length, 3, 'the isolated receiver should accept exactly three local uploads');
    assert(pageErrors.length === 0, `demo page errors: ${pageErrors.join('; ')}`);
    const panelBounds = await page.locator('[data-serpent-ui="batch"]').evaluate((host) => {
      const rect = host.shadowRoot?.querySelector('.panel')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    });
    assert(panelBounds && panelBounds.width >= 520 && panelBounds.width <= 522,
      `unexpected panel bounds: ${JSON.stringify(panelBounds)}`);
    await page.waitForTimeout(5250);
    const panelText = await page.locator('[data-serpent-ui="batch"]').evaluate((host) => host.shadowRoot?.textContent || '');
    assert(!/无法保存|下载失败|错误/u.test(panelText), `unexpected UI error: ${panelText}`);

    await context.close();
    context = undefined;
    const rawPath = await rawVideo.path();
    const cropX = Math.round(panelBounds.x) + 1;
    const cropY = Math.floor(panelBounds.y);
    const cropWidth = 520;
    const cropHeight = Math.ceil(panelBounds.height / 2) * 2;
    const crop = `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`;
    const trimStart = Math.max(0, (panelOpenedMs - startMs) / 1000 - 0.12);
    const completionFrame = Math.max(trimStart + 0.5, (doneMs - startMs) / 1000 + 0.3);
    await launchFfmpeg([
      '-y', '-ss', trimStart.toFixed(3), '-i', rawPath,
      '-vf', crop, '-an', '-t', '16', '-r', '30',
      '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p',
      videoOutput,
    ]);
    await launchFfmpeg([
      '-y', '-ss', completionFrame.toFixed(3), '-i', rawPath,
      '-frames:v', '1', '-vf', crop, '-c:v', 'libwebp', '-quality', '86', '-compression_level', '6', posterOutput,
    ]);
    const videoStat = await stat(videoOutput);
    const posterStat = await stat(posterOutput);
    console.log(JSON.stringify({ video: videoOutput, videoBytes: videoStat.size, poster: posterOutput, posterBytes: posterStat.size, size: `${cropWidth}x${cropHeight}`, panelBounds, uploads: uploads.length, trimStartSeconds: trimStart.toFixed(2) }, null, 2));
  } finally {
    await Promise.allSettled([context?.close(), close(sourceServer), close(desktopServer)]);
    const resolved = path.resolve(tempRoot);
    assert(path.dirname(resolved) === path.resolve(tempParent) && path.basename(resolved).startsWith('serpent-batch-demo-'));
    await rm(resolved, { recursive: true, force: true });
  }
}

function waitForWorker(context) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const worker = context.serviceWorkers().find((item) => item.url().endsWith('/background.js'));
      if (worker) return resolve(worker);
      if (Date.now() - started > 12_000) return reject(new Error('extension background worker did not start'));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function waitForNode(predicate, timeoutMs, description) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${description}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
