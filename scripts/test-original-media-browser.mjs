#!/usr/bin/env node

/* global chrome, document, HTMLImageElement, location */

/**
 * Headless end-to-end harness for the original-media save flow.
 *
 * Run this script from a workspace that can resolve the `playwright` package,
 * after building this extension. It starts isolated loopback fixture servers,
 * loads the built extension into a temporary browser profile, and always shuts
 * the browser/servers down and removes that profile in `finally`.
 *
 * This file is intentionally independent of the desktop app and never sends
 * data to a real Serpent instance. It copies the built extension into a
 * temporary directory and changes only its local desktop port list to point
 * at an ephemeral fixture server; the checked-in build output stays intact.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromiumBuildDir = path.resolve(process.env.SERPENT_BROWSER_BUILD_DIR
  || path.join(extensionRoot, 'dist', 'extension'));
const profilePrefix = 'serpent-original-media-';
const responseTimeoutMs = 12_000;

const requireFromWorkspace = createRequire(
  path.join(process.env.SERPENT_PLAYWRIGHT_RESOLVE_FROM || process.cwd(), '__playwright_resolver__.cjs'),
);

function loadChromium() {
  try {
    return requireFromWorkspace('playwright').chromium;
  } catch (error) {
    throw new Error(
      'Cannot resolve Playwright. Run this script from a workspace with Playwright installed, '
        + 'or set SERPENT_PLAYWRIGHT_RESOLVE_FROM to that workspace.',
      { cause: error },
    );
  }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function text(response, status, value, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  response.end(value);
}

function decodedHeader(headers, name) {
  const value = headers[name];
  if (typeof value !== 'string') return undefined;
  try { return decodeURIComponent(value); } catch { return value; }
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function uploadMetadataFailure(headers) {
  const sourcePageUrl = decodedHeader(headers, 'x-serpent-source-page-url');
  const mediaUrl = decodedHeader(headers, 'x-serpent-media-url');
  if (headers['x-serpent-local-file'] === 'true') {
    return sourcePageUrl === undefined && mediaUrl === undefined
      ? undefined
      : 'invalid local file metadata';
  }
  if (!sourcePageUrl || sourcePageUrl.length > 8_192 || !validHttpUrl(sourcePageUrl)) {
    return 'invalid source page url';
  }
  if (!mediaUrl || mediaUrl.length > 8_192) return 'invalid media url';
  if (validHttpUrl(mediaUrl)) return undefined;
  try {
    const source = new URL(sourcePageUrl);
    const media = new URL(mediaUrl);
    return media.protocol === 'blob:' && media.origin !== 'null' && media.origin === source.origin
      ? undefined
      : 'invalid media url';
  } catch {
    return 'invalid media url';
  }
}

async function bind(server, port, host = '127.0.0.1') {
  server.listen(port, host);
  try {
    await once(server, 'listening');
  } catch (error) {
    server.close();
    throw error;
  }
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function startDesktopFixture() {
  const uploads = [];
  const requests = [];
  const transferSessions = [];
  const segmentUploads = [];
  const committedTransfers = [];
  const cancelledSessions = [];
  let segmentedMediaUpload = false;
  let uploadBehavior = async () => ({ status: 202, body: { accepted: true } });
  let activeUploads = 0;
  let peakUploads = 0;
  let nextSession = 1;
  let port = 0;

  const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const pathname = url.pathname;
      requests.push({ port, method: request.method, pathname });

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        });
        response.end();
        return;
      }

      if (pathname === '/ping' && request.method === 'GET') {
        json(response, 200, { ok: true });
        return;
      }
      if (pathname === '/folders' && request.method === 'GET') {
        json(response, 200, {
          folders: [],
          recentBrowsedFolderIds: [],
          libraryDisplayName: 'Fixture library',
        });
        return;
      }
      if (pathname === '/collections' && request.method === 'GET') {
        json(response, 200, { collections: [], libraryDisplayName: 'Fixture library' });
        return;
      }
      if (pathname === '/capabilities' && request.method === 'GET') {
        json(response, 200, {
          status: 'ok',
          segmentedMediaUpload: segmentedMediaUpload
            ? {
                version: 1,
                maxAssetBytes: 500 * 1024 * 1024,
                chunkBytes: 4 * 1024 * 1024,
                protocols: ['hls-ts', 'hls-fmp4', 'dash-fmp4'],
              }
            : null,
        });
        return;
      }
      if (pathname === '/save-upload' && request.method === 'POST') {
        const failureReason = uploadMetadataFailure(request.headers);
        if (failureReason) {
          json(response, 400, { status: 'rejected', reason: failureReason });
          return;
        }
        const upload = {
          port,
          headers: { ...request.headers },
          body,
          sequence: uploads.length,
        };
        uploads.push(upload);
        activeUploads += 1;
        peakUploads = Math.max(peakUploads, activeUploads);
        try {
          const result = await uploadBehavior(upload);
          upload.status = result?.status ?? 202;
          upload.response = result?.body ?? { accepted: true };
          json(response, upload.status, upload.response);
        } finally {
          activeUploads -= 1;
        }
        return;
      }

      if (pathname === '/media-transfer/sessions' && request.method === 'POST') {
        if (!segmentedMediaUpload) {
          json(response, 404, { status: 'rejected', reason: 'segmented upload is disabled in fixture' });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          json(response, 400, { status: 'rejected', reason: 'invalid fixture JSON' });
          return;
        }
        const sequence = nextSession++;
        const sessionId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
        const session = {
          id: sessionId,
          token: `fixture-token-${sequence}`,
          payload,
          status: 'uploading',
          receivedBytes: 0,
          segments: (Array.isArray(payload?.tracks) ? payload.tracks : []).flatMap((track) => (
            Array.isArray(track?.segments) ? track.segments.map((segment) => ({
              id: segment.id,
              role: segment.role,
              trackKind: track.kind,
              receivedBytes: 0,
              complete: false,
              chunks: new Map(),
            })) : []
          )),
        };
        transferSessions.push(session);
        json(response, 201, {
          status: 'accepted',
          sessionId,
          token: session.token,
          chunkBytes: 4 * 1024 * 1024,
          maxAssetBytes: 500 * 1024 * 1024,
        });
        return;
      }

      const sessionRoute = /^\/media-transfer\/sessions\/([0-9a-f-]{36})(?:\/(segments\/([a-z0-9_-]{1,64})|commit))?$/iu.exec(pathname);
      if (sessionRoute) {
        const session = transferSessions.find((entry) => entry.id === sessionRoute[1]);
        if (!session || request.headers.authorization !== `Bearer ${session.token}`) {
          json(response, 404, { status: 'rejected', reason: 'fixture session not found' });
          return;
        }
        if (request.method === 'GET' && sessionRoute[2] === undefined) {
          json(response, 200, {
            sessionId: session.id,
            status: session.status,
            receivedBytes: session.receivedBytes,
            maxAssetBytes: 500 * 1024 * 1024,
            chunkBytes: 4 * 1024 * 1024,
            segments: session.segments.map(({ id, receivedBytes, complete }) => ({ id, receivedBytes, complete })),
          });
          return;
        }
        if (request.method === 'PUT' && sessionRoute[3]) {
          const segment = session.segments.find((entry) => entry.id === sessionRoute[3]);
          const offset = Number(url.searchParams.get('offset'));
          const final = request.headers['x-segment-final'] === 'true';
          if (!segment || !Number.isSafeInteger(offset) || offset < 0 || body.byteLength === 0
            || body.byteLength > 4 * 1024 * 1024) {
            json(response, 400, { status: 'rejected', reason: 'invalid fixture segment' });
            return;
          }
          const previous = segment.chunks.get(offset);
          if (previous && !previous.equals(body)) {
            json(response, 409, { status: 'rejected', reason: 'fixture retry mismatch' });
            return;
          }
          if (!previous) {
            segment.chunks.set(offset, body);
            segment.receivedBytes += body.byteLength;
            session.receivedBytes += body.byteLength;
          }
          if (final) segment.complete = true;
          segmentUploads.push({ sessionId: session.id, segmentId: segment.id, offset, final, body });
          json(response, 200, { status: 'ok', received: true });
          return;
        }
        if (request.method === 'POST' && sessionRoute[2] === 'commit') {
          if (session.segments.some((segment) => !segment.complete)) {
            json(response, 409, { status: 'rejected', reason: 'fixture segments incomplete' });
            return;
          }
          session.status = 'complete';
          committedTransfers.push({
            request: session.payload,
            segments: session.segments.map((segment) => ({
              id: segment.id,
              role: segment.role,
              trackKind: segment.trackKind,
              body: Buffer.concat([...segment.chunks.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, chunk]) => chunk)),
            })),
          });
          json(response, 202, { status: 'accepted', state: 'committing' });
          return;
        }
        if (request.method === 'DELETE' && sessionRoute[2] === undefined) {
          session.status = 'cancelled';
          session.segments = [];
          cancelledSessions.push(session.id);
          json(response, 200, { status: 'ok', state: 'cancelled', cleanupFailed: false });
          return;
        }
        json(response, 405, { status: 'rejected', reason: 'unsupported fixture transfer operation' });
        return;
      }

      json(response, 404, { error: 'unknown fixture endpoint' });
  });
  await bind(server, 0);
  const address = server.address();
  assert(address && typeof address === 'object', 'desktop fixture must have a TCP address');
  port = address.port;

  return {
    port,
    uploads,
    requests,
    get peakUploads() { return peakUploads; },
    get activeUploads() { return activeUploads; },
    setUploadBehavior(behavior) {
      uploadBehavior = behavior ?? (async () => ({ status: 202, body: { accepted: true } }));
    },
    resetUploadMetrics() {
      activeUploads = 0;
      peakUploads = 0;
    },
    transferSessions,
    segmentUploads,
    committedTransfers,
    cancelledSessions,
    setSegmentedMediaUpload(enabled) {
      segmentedMediaUpload = enabled;
    },
    close: () => closeServer(server),
  };
}

async function startSourceFixture() {
  const pages = new Map();
  const media = new Map();
  const requests = [];
  const activePinDetails = new Set();
  const activeOriginalMedia = new Set();
  let peakPinDetails = 0;
  let peakOriginalMedia = 0;
  let peakDetailAndMedia = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const record = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      host: request.headers.host,
      status: undefined,
    };
    requests.push(record);
    const isPinDetail = /^\/pin\/\d+\/$/u.test(record.path);
    const isOriginalMedia = record.host.startsWith('i.pinimg.com:') && record.path.startsWith('/originals/');
    if (isPinDetail || isOriginalMedia) {
      const activeSet = isPinDetail ? activePinDetails : activeOriginalMedia;
      activeSet.add(record);
      peakPinDetails = Math.max(peakPinDetails, activePinDetails.size);
      peakOriginalMedia = Math.max(peakOriginalMedia, activeOriginalMedia.size);
      peakDetailAndMedia = Math.max(peakDetailAndMedia, activePinDetails.size + activeOriginalMedia.size);
      const finish = () => {
        activePinDetails.delete(record);
        activeOriginalMedia.delete(record);
      };
      response.once('finish', finish);
      response.once('close', finish);
    }
    response.once('finish', () => {
      record.status = response.statusCode;
    });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      text(response, 405, 'method not allowed');
      return;
    }

    const page = pages.get(url.pathname);
    if (page && request.method === 'GET') {
      const pageBody = typeof page === 'string' ? page : page.body;
      if (typeof page?.delayMs === 'number' && page.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, page.delayMs));
      }
      text(response, 200, pageBody, 'text/html; charset=utf-8');
      return;
    }

    const file = media.get(`${url.pathname}${url.search}`) ?? media.get(url.pathname);
    if (file) {
      if (file.gate) await file.gate;
      if (typeof file.delayMs === 'number' && file.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, file.delayMs));
      }
      const status = typeof file.status === 'function' ? file.status(record, request) : file.status;
      if (status !== 200) {
        text(response, status, file.body ?? 'fixture error', file.contentType ?? 'text/plain');
        return;
      }
      const rangeMatch = /^bytes=(\d+)-(\d*)$/u.exec(String(request.headers.range ?? ''));
      if (rangeMatch && request.method === 'GET') {
        const start = Number(rangeMatch[1]);
        const requestedEnd = rangeMatch[2] ? Number(rangeMatch[2]) : file.body.byteLength - 1;
        if (start >= file.body.byteLength || requestedEnd < start) {
          response.writeHead(416, { 'Content-Range': `bytes */${file.body.byteLength}` });
          response.end();
          return;
        }
        const end = Math.min(requestedEnd, file.body.byteLength - 1);
        const bytes = file.body.subarray(start, end + 1);
        response.writeHead(206, {
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'Content-Type': file.contentType,
          'Content-Range': `bytes ${start}-${end}/${file.body.byteLength}`,
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'no-store',
        });
        response.end(bytes);
        return;
      }
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': file.contentType,
        'Content-Length': String(file.body.byteLength),
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : file.body);
      return;
    }

    text(response, 404, 'not found');
  });
  await bind(server, 0);
  const address = server.address();
  assert(address && typeof address === 'object', 'source fixture must have a TCP address');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    pages,
    media,
    requests,
    get peakPinDetails() { return peakPinDetails; },
    get peakOriginalMedia() { return peakOriginalMedia; },
    get peakDetailAndMedia() { return peakDetailAndMedia; },
    close: () => closeServer(server),
  };
}

function assertBuiltExtension() {
  return stat(path.join(chromiumBuildDir, 'manifest.json')).then(() => chromiumBuildDir).catch(() => {
    throw new Error(
      `Built Chromium extension not found at ${chromiumBuildDir}. Build the extension before running this harness.`,
    );
  });
}

async function createFixtureExtension(temporaryRoot, desktopPort) {
  const extensionDir = path.join(temporaryRoot, 'extension');
  await cp(chromiumBuildDir, extensionDir, { recursive: true });
  const backgroundPath = path.join(extensionDir, 'background.js');
  const source = await readFile(backgroundPath, 'utf8');
  const portLists = /19876\s*,\s*19877\s*,\s*19878/gu;
  const occurrences = source.match(portLists) ?? [];
  assert.equal(occurrences.length, 2, 'expected exactly two bundled desktop port lists');
  const endpointPortGuard = /:1987\[6-8\]/gu;
  const guardOccurrences = source.match(endpointPortGuard) ?? [];
  assert.equal(guardOccurrences.length, 1, 'expected one bundled desktop endpoint allowlist');
  const withFixturePorts = source.replace(portLists, String(desktopPort));
  const patched = withFixturePorts.replace(endpointPortGuard, `:${desktopPort}`);
  assert(!/19876\s*,\s*19877\s*,\s*19878/u.test(patched));
  assert(!/:1987\[6-8\]/u.test(patched));
  await writeFile(backgroundPath, patched, 'utf8');
  return extensionDir;
}

function browserLaunchOptions(extensionDir, { behanceFixtureHosts = false, proxyServer } = {}) {
  const hostResolverRules = [
    'MAP media.test 127.0.0.1',
    'MAP pic.sogou.com 127.0.0.1',
    'MAP image.so.com 127.0.0.1',
    'MAP pinterest.ca 127.0.0.1',
    'MAP i.pinimg.com 127.0.0.1',
    'MAP v1.pinimg.com 127.0.0.1',
    'MAP huaban.com 127.0.0.1',
    'MAP gd-hbimg-edge.huaban.com 127.0.0.1',
    'MAP www.artstation.com 127.0.0.1',
    'MAP cdnb.artstation.com 127.0.0.1',
  ];
  if (behanceFixtureHosts) {
    hostResolverRules.push('MAP www.behance.net 127.0.0.1', 'MAP mir-s3-cdn-cf.behance.net 127.0.0.1');
  }
  const launch = {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--host-resolver-rules=${hostResolverRules.join(',')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
  if (proxyServer) launch.args.push(`--proxy-server=${proxyServer}`);
  else launch.args.push('--no-proxy-server');

  // Playwright's Chromium build accepts unpacked extensions in a persistent
  // context. Use an explicitly supplied browser only for environments where
  // that build is unavailable or incompatible.
  const executablePath = process.env.SERPENT_BROWSER_EXECUTABLE;
  if (executablePath) launch.executablePath = executablePath;
  else launch.channel = 'chromium';
  return launch;
}

function waitFor(predicate, description, timeoutMs = responseTimeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function extensionWorker(context) {
  return waitFor(
    () => context.serviceWorkers().find((worker) => worker.url().endsWith('/background.js')),
    'extension background service worker',
  );
}

async function waitForDesktopConnection(context) {
  const worker = await extensionWorker(context);
  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const state = await page.evaluate(() => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'serpent-connection-status' }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    }));
    assert.equal(state?.kind, 'connected', 'desktop fixture must be ready before exercising the save UI');
  } finally {
    await page.close();
  }
}

async function writeSyncStorage(context, values, remove = []) {
  const worker = await extensionWorker(context);
  await worker.evaluate(({ valuesToSet, keysToRemove }) => new Promise((resolve, reject) => {
    const check = () => {
      const error = globalThis.chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    };
    globalThis.chrome.storage.sync.remove(keysToRemove, () => {
      if (globalThis.chrome.runtime.lastError) {
        check();
        return;
      }
      globalThis.chrome.storage.sync.set(valuesToSet, check);
    });
  }), { valuesToSet: values, keysToRemove: remove });
}

async function readSyncStorage(context, keys) {
  const worker = await extensionWorker(context);
  return worker.evaluate((requestedKeys) => new Promise((resolve, reject) => {
    globalThis.chrome.storage.sync.get(requestedKeys, (values) => {
      const error = globalThis.chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(values);
    });
  }), keys);
}

function expectOneUpload(desktop, beforeCount, label) {
  assert.equal(desktop.uploads.length, beforeCount + 1, `${label}: exactly one asset must be uploaded`);
  return desktop.uploads[beforeCount];
}

function makePage({ id = 'target', src, extra = '' }) {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Original media fixture</title>
    <style>body{margin:40px} img,video{width:240px;height:180px;object-fit:contain}</style>
    <img id="${id}" src="${src}" ${extra} alt="fixture">
    <div id="status" aria-live="polite"></div>`;
}

function makeVideoPage(src) {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>HLS video fixture</title>
    <style>body{margin:40px} video{width:320px;height:180px}</style>
    <video id="target" src="${src}" controls></video>
    <div id="status" aria-live="polite"></div>`;
}

function makeBlobImagePage(bytes) {
  const base64 = Buffer.from(bytes).toString('base64');
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Page-owned Blob image fixture</title>
    <style>body{margin:40px} img{width:240px;height:180px;object-fit:contain}</style>
    <img id="target" alt="page-owned Blob image">
    <script>
      const binary = atob('${base64}');
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      document.querySelector('#target').src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    </script>`;
}

function makeMediaSourcePage() {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>MediaSource pseudo-file fixture</title>
    <style>body{margin:40px} video{width:320px;height:180px}</style>
    <video id="target" controls></video>
    <script>
      const mediaSource = new MediaSource();
      window.fixtureMediaSource = mediaSource;
      document.querySelector('#target').src = URL.createObjectURL(mediaSource);
    </script>`;
}

function makePinterestBlobVideoFeedPage(pins, staleState) {
  const pinMarkup = pins.map((pin, index) => `
    <article data-test-id="pin">
      <a href="/pin/${pin.id}/">
        <video id="pin-video-${index}" data-pin-video poster="${pin.posterUrl}" preload="none"></video>
      </a>
    </article>
  `).join('');
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Pinterest blob video batch fixture</title>
    <style>body{margin:24px}main{display:flex;gap:12px}video{width:320px;height:320px;object-fit:contain}</style>
    <script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(staleState)}</script>
    <main>${pinMarkup}</main>
    <script>
      for (const video of document.querySelectorAll('[data-pin-video]')) {
        const mediaSource = new MediaSource();
        video.src = URL.createObjectURL(mediaSource);
      }
    </script>`;
}

function makePinterestImageFeedPage(pins) {
  const pinMarkup = pins.map((pin, index) => `
    <article data-test-id="pin">
      <a href="/pin/${pin.id}/">
        <img id="pin-image-${index}" data-pin-image src="${pin.previewUrl}" alt="pin ${index + 1}">
      </a>
    </article>
  `).join('');
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Pinterest image batch parallel fixture</title>
    <style>body{margin:24px}main{display:flex;flex-wrap:wrap;gap:12px}img{width:160px;height:160px;object-fit:cover}</style>
    <script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify({
      initialReduxState: { pins: { '900000000000000001': { entityId: '900000000000000001' } } },
    })}</script>
    <main>${pinMarkup}</main>`;
}

function makePinterestImagePinDetailPage(pin) {
  const state = {
    initialReduxState: {
      pins: {
        [pin.id]: {
          entityId: pin.id,
          images: {
            orig: { url: pin.originalUrl },
            '236x': { url: pin.previewUrl },
          },
        },
      },
    },
  };
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Pinterest image pin detail fixture</title>
    <script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(state)}</script>`;
}

function makePinterestVideoPinDetailPage(pin) {
  const state = {
    initialReduxState: {
      pins: {
        [pin.id]: {
          entityId: pin.id,
          videos: null,
          carousel_data: {
            carousel_slots: [
              {
                images: { '236x': { url: pin.posterUrl } },
                videos: {
                  video_list: {
                    V_720P: {
                      url: pin.mp4Url,
                      width: 720,
                      height: 960,
                      duration: 6033,
                      thumbnail: pin.posterUrl,
                    },
                    V_HLSV4: {
                      url: pin.hlsUrl,
                      width: 720,
                      height: 960,
                      duration: 6033,
                      thumbnail: pin.posterUrl,
                    },
                  },
                },
              },
              {
                images: { '236x': { url: pin.imageSlotPosterUrl } },
              },
              {
                images: { '236x': { url: pin.otherVideoPosterUrl } },
                videos: {
                  video_list: {
                    V_1080P: {
                      url: pin.wrongSlotMp4Url,
                      width: 1080,
                      height: 1440,
                      duration: 6033,
                      thumbnail: pin.otherVideoPosterUrl,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Pinterest selected video detail fixture</title>
    <script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(state)}</script>`;
}

function makeCarouselPage({ previewA, previewB, candidateA, candidateB }) {
  const itemA = JSON.stringify({ contentId: '123', originalUrl: candidateA });
  const itemB = JSON.stringify({ contentId: '123', originalUrl: candidateB });
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Multi image media fixture</title>
    <style>body{margin:40px} img{display:block;width:240px;height:180px;object-fit:contain}</style>
    <section id="post">
      <img id="other" src="${previewA}" data-id="123" data-media-index="0" data-item='${itemA}' alt="first image">
      <img id="target" src="${previewB}" data-id="123" data-media-index="1" data-index="2" data-item='${itemB}' alt="selected second image">
    </section>`;
}

async function altRightClick(page, selector) {
  const target = page.locator(selector);
  await target.waitFor({ state: 'visible' });
  await target.click({ button: 'right', modifiers: ['Alt'], position: { x: 30, y: 30 } });
}

async function runPageBlobUploadCase({ context, source, desktop }) {
  const imageBytes = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  await writeSyncStorage(context, { preferOriginalMedia: false });
  source.pages.set('/page-blob', makeBlobImagePage(imageBytes));
  const beforeUploads = desktop.uploads.length;
  const page = await context.newPage();
  try {
    await page.goto(`${source.origin}/page-blob`);
    await page.waitForFunction(() => {
      const image = document.querySelector('#target');
      return image instanceof HTMLImageElement && image.complete && image.currentSrc.startsWith('blob:');
    });
    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, `${source.origin}/page-blob`);
    assert.equal(typeof tabId, 'number', 'page-owned Blob batch tab must reach the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 1);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 1 / 1');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length > beforeUploads, 'page-owned Blob batch upload');
    await waitFor(() => desktop.uploads[beforeUploads]?.status === 202, 'same-origin Blob metadata accepted by Main fixture');
    const upload = expectOneUpload(desktop, beforeUploads, 'page-owned Blob');
    assert.deepEqual(upload.body, imageBytes, 'ordinary page-owned Blob bytes must be read in their source frame');
    assert.equal(upload.headers['x-serpent-kind'], 'image');
    const mediaUrl = decodeURIComponent(upload.headers['x-serpent-media-url']);
    const sourcePageUrl = decodeURIComponent(upload.headers['x-serpent-source-page-url']);
    assert(mediaUrl.startsWith(`blob:${source.origin}/`), 'uploaded metadata must preserve the actual blob URL');
    assert.equal(new URL(mediaUrl).origin, new URL(sourcePageUrl).origin,
      'blob media metadata must match the HTTP source-page origin checked by Main');
    console.log('PASS batch save reads a same-origin page Blob and passes Main media URL validation');
  } finally {
    await page.close();
  }
}

async function selectBatchCards(page, indexes) {
  return page.evaluate((selectedIndexes) => {
    const shadow = document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot;
    const selectAll = shadow?.querySelector('[data-action="all"]');
    if (selectAll?.hasAttribute('aria-checked')) {
      // The single checkbox cycles full → none and partial/none → full.
      // Reach none from any starting state in at most two clicks.
      for (let attempts = 0; attempts < 2 && selectAll.getAttribute('aria-checked') !== 'false'; attempts += 1) {
        selectAll.click();
      }
    } else {
      shadow?.querySelector('[data-action="none"]')?.click();
    }
    const cards = shadow?.querySelectorAll('.card');
    for (const index of selectedIndexes) cards?.[index]?.click();
    return {
      checked: selectAll?.getAttribute('aria-checked'),
      selected: [...(cards ?? [])].filter((card) => card.getAttribute('aria-checked') === 'true').length,
    };
  }, indexes);
}

async function runSmokeCases({ context, source, desktop }) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const inactivePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  const cases = [
    {
      name: 'missing preference defaults on and uploads original bytes',
      path: '/page-original',
      selector: '#target',
      setup() {
        source.media.set('/preview-original.png', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/candidate-original.png', {
          status: 200,
          contentType: 'image/png',
          body: activePng,
        });
        source.pages.set('/page-original', makePage({
          src: `${source.origin}/preview-original.png`,
          extra: `data-original="${source.origin}/candidate-original.png"`,
        }));
      },
      async assert({ upload, context }) {
        assert.deepEqual(upload.body, activePng, 'saved bytes should come from the associated original candidate');
        const stored = await readSyncStorage(context, ['preferOriginalMedia']);
        assert.equal(stored.preferOriginalMedia, true, 'a fresh profile should initialize the preference to true');
      },
    },
    {
      name: 'multi-image container resolves the selected image only',
      path: '/statuses/123?media=2',
      selector: '#target',
      setup() {
        source.media.set('/media/123/0/asset-0.jpg?quality=preview', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/media/123/1/asset-1.jpg?quality=preview', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/media/123/0/asset-0.jpg?quality=original', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/media/123/1/asset-1.jpg?quality=original', {
          status: 200,
          contentType: 'image/png',
          body: activePng,
        });
        source.pages.set('/statuses/123', makeCarouselPage({
          previewA: `${source.origin}/media/123/0/asset-0.jpg?quality=preview`,
          previewB: `${source.origin}/media/123/1/asset-1.jpg?quality=preview`,
          candidateA: `${source.origin}/media/123/0/asset-0.jpg?quality=original`,
          candidateB: `${source.origin}/media/123/1/asset-1.jpg?quality=original`,
        }));
      },
      assert({ upload, source: fixture }) {
        assert.deepEqual(upload.body, activePng, 'selected item #1 original must be saved');
        assert.equal(
          fixture.requests.filter((request) => (
            request.path === '/media/123/0/asset-0.jpg' && request.search === '?quality=original'
          )).length,
          0,
          'sibling item #0 candidate must never be requested',
        );
      },
    },
    {
      name: 'legacy false migrates without changing batch filters',
      path: '/page-legacy',
      selector: '#target',
      setup({ context }) {
        source.media.set('/preview-legacy.png', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/candidate-legacy.png', {
          status: 200,
          contentType: 'image/png',
          body: activePng,
        });
        source.pages.set('/page-legacy', makePage({
          src: `${source.origin}/preview-legacy.png`,
          extra: `data-original="${source.origin}/candidate-legacy.png"`,
        }));
        return writeSyncStorage(context, {
          serpentBatchFilter: { minEdge: 321, formats: ['jpg', 'png'], preferHd: false },
        }, ['preferOriginalMedia']);
      },
      async assert({ upload, context }) {
        assert.deepEqual(upload.body, inactivePng, 'legacy false must select the current preview');
        const stored = await readSyncStorage(context, ['preferOriginalMedia', 'serpentBatchFilter']);
        assert.equal(stored.preferOriginalMedia, false, 'legacy false must be copied to the new setting');
        assert.deepEqual(stored.serpentBatchFilter, {
          minEdge: 321,
          formats: ['jpg', 'png'],
          preferHd: false,
        }, 'migration must preserve the legacy batch filter fields');
      },
    },
    {
      name: 'explicit off mode uses current preview without requesting candidate',
      path: '/page-disabled',
      selector: '#target',
      setup({ context }) {
        source.media.set('/preview-disabled.png', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/candidate-disabled.png', {
          status: 200,
          contentType: 'image/png',
          body: activePng,
        });
        source.pages.set('/page-disabled', makePage({
          src: `${source.origin}/preview-disabled.png`,
          extra: `data-original="${source.origin}/candidate-disabled.png"`,
        }));
        return writeSyncStorage(context, {
          preferOriginalMedia: false,
          serpentBatchFilter: { minEdge: 321, formats: ['jpg'], preferHd: true },
        });
      },
      assert({ upload, source: fixture }) {
        assert.deepEqual(upload.body, inactivePng, 'off mode must upload the browser-selected preview');
        assert.equal(
          fixture.requests.filter((request) => request.path === '/candidate-disabled.png').length,
          0,
          'off mode must not request the original candidate',
        );
      },
    },
    {
      name: 'invalid original candidate falls back to preview bytes',
      path: '/page-fallback',
      selector: '#target',
      setup({ context }) {
        source.media.set('/preview-fallback.png', {
          status: 200,
          contentType: 'image/png',
          body: inactivePng,
        });
        source.media.set('/candidate-html.png', {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from('<!doctype html><title>login</title>sign in'),
        });
        source.pages.set('/page-fallback', makePage({
          src: `${source.origin}/preview-fallback.png`,
          extra: `data-original="${source.origin}/candidate-html.png"`,
        }));
        return writeSyncStorage(context, { preferOriginalMedia: true });
      },
      assert({ upload, source: fixture }) {
        assert.deepEqual(upload.body, inactivePng, 'invalid candidate must fall back to the displayed preview');
        assert(
          fixture.requests.some((request) => request.path === '/candidate-html.png'),
          'an explicit new true value must override the legacy false batch value',
        );
      },
    },
  ];

  for (const testCase of cases) {
    await testCase.setup({ context, source, desktop });
    const beforeCount = desktop.uploads.length;
    const page = await context.newPage();
    try {
      await page.goto(`${source.origin}${testCase.path}`);
      await altRightClick(page, testCase.selector || '#target');
      try {
        await waitFor(
          () => desktop.uploads.length >= beforeCount + 1,
          `${testCase.name} upload`,
        );
      } catch (error) {
        console.error(`DEBUG failed image case ${testCase.name}`, JSON.stringify({
          desktopRequests: desktop.requests,
          sourceRequests: source.requests,
          uploads: desktop.uploads.length,
          toastText: await page.locator('html').evaluate((html) => Array.from(html.querySelectorAll('*'))
            .map((element) => element.shadowRoot?.textContent)
            .filter(Boolean)),
        }));
        throw error;
      }
      const upload = expectOneUpload(desktop, beforeCount, testCase.name);
      await testCase.assert({ upload, source, desktop, page, activePng, inactivePng, context });
      console.log(`PASS ${testCase.name}`);
    } finally {
      await page.close();
    }
  }

  await runPageBlobUploadCase({ context, source, desktop });

  const mediaPortForSites = new URL(source.origin).port;
  const sogouPreview = `http://media.test:${mediaPortForSites}/sogou/preview.jpg`;
  const sogouOriginal = `http://media.test:${mediaPortForSites}/sogou/original.jpg`;
  source.media.set('/sogou/preview.jpg', {
    status: 200,
    contentType: 'image/png',
    body: inactivePng,
  });
  source.media.set('/sogou/original.jpg', {
    status: 200,
    contentType: 'image/png',
    body: activePng,
  });
  source.pages.set('/page-sogou', `<!doctype html>
    <script>window.__INITIAL_STATE__ = ${JSON.stringify({
    searchList: {
      searchList: [{
        docId: 'sogou-doc-7',
        index: 7,
        thumbUrl: sogouPreview,
        oriPicUrl: sogouOriginal,
        picUrl: sogouOriginal,
      }],
    },
  })};</script>
    <img id="target" src="${sogouPreview}" alt="selected Sogou result">`);
  await writeSyncStorage(context, { preferOriginalMedia: true });
  const beforeSogouUploads = desktop.uploads.length;
  const sogouPage = await context.newPage();
  try {
    try {
      await sogouPage.goto(`http://pic.sogou.com:${mediaPortForSites}/page-sogou`);
    } catch (error) {
      console.error('DEBUG Sogou fixture navigation', JSON.stringify({
        pageUrl: `http://pic.sogou.com:${mediaPortForSites}/page-sogou`,
        sourceRequests: source.requests,
      }));
      throw error;
    }
    await altRightClick(sogouPage, '#target');
    await waitFor(() => desktop.uploads.length > beforeSogouUploads, 'Sogou adapter upload');
    assert.deepEqual(desktop.uploads[beforeSogouUploads]?.body, activePng);
    console.log('PASS Sogou result data selects the matching original record');
  } finally {
    await sogouPage.close();
  }

  const soPreview = `http://media.test:${mediaPortForSites}/so/preview.jpg`;
  const soOriginal = `http://media.test:${mediaPortForSites}/so/original.jpg`;
  const soAdvertisement = `http://media.test:${mediaPortForSites}/so/ad.jpg`;
  source.media.set('/so/preview.jpg', {
    status: 200,
    contentType: 'image/png',
    body: inactivePng,
  });
  source.media.set('/so/original.jpg', {
    status: 200,
    contentType: 'image/png',
    body: activePng,
  });
  source.media.set('/so/ad.jpg', {
    status: 200,
    contentType: 'image/png',
    body: inactivePng,
  });
  source.pages.set('/page-360', `<!doctype html>
    <script type="application/json" id="initData">${JSON.stringify({
    list: [{ id: '360-result-2', index: 2, thumb: soPreview, img: soOriginal }],
  })}</script>
    <script type="application/json" id="commercialImages">${JSON.stringify({ qhimg_url: soAdvertisement })}</script>
    <img id="target" src="${soPreview}" alt="selected 360 result">`);
  const before360Uploads = desktop.uploads.length;
  const soPage = await context.newPage();
  try {
    await soPage.goto(`http://image.so.com:${mediaPortForSites}/page-360`);
    await altRightClick(soPage, '#target');
    await waitFor(() => desktop.uploads.length > before360Uploads, '360 adapter upload');
    assert.deepEqual(desktop.uploads[before360Uploads]?.body, activePng);
    assert.equal(
      source.requests.filter((request) => request.path === '/so/ad.jpg').length,
      0,
      'commercialImages data must not be treated as the selected image',
    );
    console.log('PASS 360 result data selects its matching image and ignores commercialImages');
  } finally {
    await soPage.close();
  }

  const framePreview = `http://media.test:${mediaPortForSites}/frame/preview.png`;
  const frameOriginal = `http://media.test:${mediaPortForSites}/frame/original.png`;
  const frameUrl = `http://image.so.com:${mediaPortForSites}/page-frame`;
  source.media.set('/frame/preview.png', {
    status: 200,
    contentType: 'image/png',
    body: inactivePng,
  });
  source.media.set('/frame/original.png', {
    status: 200,
    contentType: 'image/png',
    body: activePng,
  });
  source.pages.set('/page-frame', makePage({
    src: framePreview,
    extra: `data-original="${frameOriginal}"`,
  }));
  source.pages.set('/page-iframe-host', `<!doctype html>
    <meta charset="utf-8">
    <title>Cross-origin frame fixture</title>
    <iframe id="child" src="${frameUrl}" style="width:400px;height:300px"></iframe>`);
  const beforeFrameUploads = desktop.uploads.length;
  const frameHostPage = await context.newPage();
  try {
    await frameHostPage.goto(`${source.origin}/page-iframe-host`);
    const target = frameHostPage.frameLocator('#child').locator('#target');
    await target.waitFor({ state: 'visible' });
    await target.click({ button: 'right', modifiers: ['Alt'], position: { x: 30, y: 30 } });
    await waitFor(() => desktop.uploads.length > beforeFrameUploads, 'cross-origin frame save upload');
    assert.deepEqual(desktop.uploads[beforeFrameUploads]?.body, activePng);
    assert.equal(
      decodeURIComponent(desktop.uploads[beforeFrameUploads]?.headers['x-serpent-source-page-url'] ?? ''),
      frameUrl,
      'the frame document, not its parent, must be recorded as the source page',
    );
    console.log('PASS cross-origin frame content script resolves and saves its own selected media');
  } finally {
    await frameHostPage.close();
  }

  const mediaPort = new URL(source.origin).port;
  const manifestUrl = `http://media.test:${mediaPort}/clip.m3u8`;
  const segmentBytes = Buffer.from('fixture HLS transport-stream segment bytes');
  const manifest = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:1.0,',
    'clip.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  source.media.set('/clip.m3u8', {
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: Buffer.from(manifest),
  });
  source.media.set('/clip.ts', {
    status: 200,
    contentType: 'video/mp2t',
    body: segmentBytes,
  });
  source.pages.set('/page-hls', makeVideoPage(manifestUrl));
  desktop.setSegmentedMediaUpload(true);
  const beforeUploads = desktop.uploads.length;
  const beforeCommits = desktop.committedTransfers.length;
  const page = await context.newPage();
  try {
    await page.goto(`${source.origin}/page-hls`);
    const videoState = await page.locator('#target').evaluate((video) => ({
      src: video.getAttribute('src'),
      currentSrc: video.currentSrc,
      readyState: video.readyState,
    }));
    console.log(`DEBUG HLS video selection ${JSON.stringify(videoState)}`);
    await altRightClick(page, '#target');
    try {
      await waitFor(
        () => desktop.committedTransfers.length > beforeCommits,
        'HLS segmented transfer commit',
      );
    } catch (error) {
      console.error('DEBUG HLS fixture state', JSON.stringify({
        desktopRequests: desktop.requests,
        sourceRequests: source.requests,
        transferSessions: desktop.transferSessions.map(({ id, status, payload }) => ({
          id,
          status,
          protocol: payload.protocol,
          mediaUrl: payload.mediaUrl,
        })),
        segmentUploads: desktop.segmentUploads.map(({ segmentId, offset, body }) => ({ segmentId, offset, size: body.length })),
        uploads: desktop.uploads.map(({ headers, body }) => ({ kind: headers['x-serpent-kind'], size: body.length })),
        toastText: await page.locator('html').evaluate((html) => Array.from(html.querySelectorAll('*'))
          .map((element) => element.shadowRoot?.textContent)
          .filter(Boolean)),
      }));
      throw error;
    }
    assert.equal(desktop.uploads.length, beforeUploads, 'HLS manifest and segments must not use ordinary file upload');
    const transfer = desktop.committedTransfers[beforeCommits];
    assert(transfer, 'segmented transfer must be committed');
    assert.equal(transfer.request.protocol, 'hls-ts');
    assert.equal(transfer.request.mediaUrl, manifestUrl);
    assert.equal(transfer.segments.length, 1);
    assert.equal(transfer.segments[0]?.id, 'v-000000');
    assert.deepEqual(transfer.segments[0]?.body, segmentBytes);
    assert.equal(desktop.segmentUploads.length > 0, true, 'HLS segment bytes must cross the authenticated transfer route');
    console.log('PASS HLS playlist is transferred as segments, never as a pseudo video file');
  } finally {
    await page.close();
    desktop.setSegmentedMediaUpload(false);
  }

  const mpdUrl = `http://media.test:${mediaPort}/clip.mpd`;
  const mpd = [
    '<?xml version="1.0"?>',
    '<MPD type="static" mediaPresentationDuration="PT1S">',
    '  <Period duration="PT1S">',
    '    <AdaptationSet contentType="video" mimeType="video/mp4">',
    '      <Representation id="video-1" bandwidth="100000" width="320" height="180">',
    '        <SegmentTemplate timescale="1" duration="1" initialization="dash-init.mp4" media="dash-$Number$.m4s" startNumber="1"/>',
    '      </Representation>',
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    '',
  ].join('\n');
  const initBytes = Buffer.from('fixture DASH initialization bytes');
  const mediaBytes = Buffer.from('fixture DASH media segment bytes');
  source.media.set('/clip.mpd', {
    status: 200,
    contentType: 'application/dash+xml',
    body: Buffer.from(mpd),
  });
  source.media.set('/dash-init.mp4', {
    status: 200,
    contentType: 'video/mp4',
    body: initBytes,
  });
  source.media.set('/dash-1.m4s', {
    status: 200,
    contentType: 'video/iso.segment',
    body: mediaBytes,
  });

  await writeSyncStorage(context, { preferOriginalMedia: true });
  source.pages.set('/page-dash', makeVideoPage(mpdUrl));
  desktop.setSegmentedMediaUpload(true);
  const beforeDashCommits = desktop.committedTransfers.length;
  const beforeDashUploads = desktop.uploads.length;
  const dashPage = await context.newPage();
  try {
    await dashPage.goto(`${source.origin}/page-dash`);
    await altRightClick(dashPage, '#target');
    try {
      await waitFor(
        () => desktop.committedTransfers.length > beforeDashCommits,
        'DASH segmented transfer commit',
      );
    } catch (error) {
      console.error('DEBUG DASH fixture state', JSON.stringify({
        desktopRequests: desktop.requests,
        sourceRequests: source.requests,
        transferSessions: desktop.transferSessions.map(({ id, status, payload }) => ({
          id,
          status,
          protocol: payload.protocol,
          mediaUrl: payload.mediaUrl,
        })),
        segmentUploads: desktop.segmentUploads.map(({ segmentId, offset, body }) => ({ segmentId, offset, size: body.length })),
        uploads: desktop.uploads.map(({ headers, body }) => ({ kind: headers['x-serpent-kind'], size: body.length })),
        toastText: await dashPage.locator('html').evaluate((html) => Array.from(html.querySelectorAll('*'))
          .map((element) => element.shadowRoot?.textContent)
          .filter(Boolean)),
      }));
      throw error;
    }
    assert.equal(desktop.uploads.length, beforeDashUploads, 'DASH manifest must not use ordinary file upload');
    const transfer = desktop.committedTransfers[beforeDashCommits];
    assert(transfer, 'DASH transfer must be committed');
    assert.equal(transfer.request.protocol, 'dash-fmp4');
    assert.deepEqual(
      transfer.segments.map((segment) => ({ id: segment.id, body: segment.body })),
      [
        { id: 'v-init', body: initBytes },
        { id: 'v-000000', body: mediaBytes },
      ],
    );
    console.log('PASS static DASH transfers initialization and media segments, never the MPD body');
  } finally {
    await dashPage.close();
  }

  await writeSyncStorage(context, { preferOriginalMedia: false });
  source.pages.set('/page-dash-preview', makeVideoPage(mpdUrl));
  const beforePreviewSessions = desktop.transferSessions.length;
  const beforePreviewCommits = desktop.committedTransfers.length;
  const beforePreviewUploads = desktop.uploads.length;
  const previewPage = await context.newPage();
  try {
    await previewPage.goto(`${source.origin}/page-dash-preview`);
    await altRightClick(previewPage, '#target');
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(desktop.transferSessions.length, beforePreviewSessions, 'off mode must not choose the highest DASH representation');
    assert.equal(desktop.committedTransfers.length, beforePreviewCommits);
    assert.equal(desktop.uploads.length, beforePreviewUploads, 'an MPD must never be uploaded as a video file');
    console.log('PASS DASH preview-only mode fails explicitly without uploading the manifest');
  } finally {
    await previewPage.close();
    desktop.setSegmentedMediaUpload(false);
  }

  await writeSyncStorage(context, { preferOriginalMedia: false });
  source.pages.set('/page-mse-blob', makeMediaSourcePage());
  const beforeMseUploads = desktop.uploads.length;
  const beforeMseSessions = desktop.transferSessions.length;
  const msePage = await context.newPage();
  try {
    await msePage.goto(`${source.origin}/page-mse-blob`);
    const mseState = await msePage.locator('#target').evaluate((video) => ({
      src: video.getAttribute('src'),
      currentSrc: video.currentSrc,
      sourceObjectType: Object.prototype.toString.call(video.srcObject),
    }));
    console.log(`DEBUG MSE selection ${JSON.stringify(mseState)}`);
    await altRightClick(msePage, '#target');
    await msePage.waitForFunction(() => {
      const toast = [...document.querySelectorAll('*')]
        .map((element) => element.shadowRoot?.querySelector('.bubble.show')?.textContent || '')
        .join(' ');
      return /无法保存|下载失败/.test(toast);
    }, undefined, { timeout: responseTimeoutMs });
    assert.equal(desktop.uploads.length, beforeMseUploads, 'MediaSource pseudo-files must never be uploaded');
    assert.equal(desktop.transferSessions.length, beforeMseSessions, 'MediaSource pseudo-files must not create a segmented import');
    console.log('PASS MediaSource blob is rejected instead of saved as a pseudo video file');
  } finally {
    await msePage.close();
  }
}

async function runBatchPinterestCase({ context, source, desktop }) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const inactivePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  const sourcePort = new URL(source.origin).port;
  const pageUrl = `http://pinterest.ca:${sourcePort}/pin/batch-originals`;
  const pinimg = `http://i.pinimg.com:${sourcePort}`;
  const pins = [];

  for (let index = 0; index < 75; index += 1) {
    const stem = index === 0
      ? 'batch-00-image'
      : `batch-${String(index).padStart(2, '0')}-image`;
    const prefix = index === 0
      ? 'a1/b2/c3'
      : `${String(index % 10)}/${String((index + 3) % 10)}/${String((index + 7) % 10)}`;
    const previewPath = `/236x/${prefix}/${stem}.jpg`;
    const dataPath = `/736x/${prefix}/${stem}.jpg`;
    const originalPath = `/originals/${prefix}/${stem}${index === 0 ? '.png' : '.jpg'}`;
    const previewUrl = `${pinimg}${previewPath}`;
    const dataUrl = `${pinimg}${dataPath}`;
    source.media.set(previewPath, {
      status: 200,
      contentType: 'image/png',
      body: inactivePng,
    });
    if (index === 0) {
      source.media.set(originalPath, {
        status: 200,
        contentType: 'image/png',
        body: activePng,
      });
    } else if (index === 1) {
      source.media.set(dataPath, {
        status: 403,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from('<!doctype html><title>blocked thumbnail candidate</title>'),
      });
      // The corresponding /originals/ path intentionally returns 404 to exercise preview fallback.
    }
    pins.push({ previewUrl, dataUrl });
  }

  const firstPinOriginalUrl = `${pinimg}/originals/a1/b2/c3/batch-00-image.png`;
  const firstPinState = {
    initialReduxState: {
      pins: {
        '100000000000000001': {
          entityId: '100000000000000001',
          images: {
            orig: { url: firstPinOriginalUrl },
            '236x': { url: pins[0]?.previewUrl },
            '736x': { url: pins[0]?.dataUrl },
          },
        },
      },
    },
  };

  source.pages.set('/pin/batch-originals', `<!doctype html>
    <meta charset="utf-8">
    <title>Pinterest batch selection fixture</title>
    <style>body{margin:0} img{width:240px;height:240px;object-fit:cover}</style>
    <script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(firstPinState)}</script>
    <main>${pins.map(({ previewUrl, dataUrl }, index) => `
      <img src="${previewUrl}" alt="pin ${index + 1}" ${index < 2 ? `data-src="${dataUrl}"` : ''} ${index === 0 ? `srcset="${previewUrl} 1x, ${dataUrl} 3x, ${firstPinOriginalUrl} 4x"` : ''}>
    `).join('')}</main>`);

  await writeSyncStorage(context, { preferOriginalMedia: true });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.setViewportSize({ width: 560, height: 380 });
    await page.goto(pageUrl);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'Pinterest fixture tab must be visible to the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);

    await page.waitForFunction(() => {
      const host = document.querySelector('[data-serpent-ui="batch"]');
      return host?.shadowRoot?.querySelectorAll('.card').length === 75;
    });
    const layout = await page.evaluate(() => {
      const host = document.querySelector('[data-serpent-ui="batch"]');
      const shadow = host?.shadowRoot;
      const grid = shadow?.querySelector('[data-field="grid"]');
      const cards = [...(shadow?.querySelectorAll('.card') ?? [])];
      const gridStyle = grid ? grid.ownerDocument.defaultView?.getComputedStyle(grid) : null;
      const thumbs = cards.map((card) => {
        const image = card.querySelector('img');
        const rect = image?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height } : null;
      });
      return {
        cards: cards.length,
        columns: gridStyle ? gridStyle.gridTemplateColumns.split(' ').length : 0,
        thumbs,
        originalMode: shadow?.querySelector('[data-action="hd"]')?.classList.contains('is-on') ?? false,
      };
    });
    assert.equal(layout.cards, 75, 'all collected Pinterest pins should be shown');
    assert.equal(layout.columns, 4, 'the narrowed batch panel should retain four columns');
    assert.equal(layout.originalMode, true, 'the batch save switch should carry the enabled original preference');
    for (const thumb of layout.thumbs) {
      assert(thumb && thumb.width >= 96, `thumbnail should keep its useful square size: ${JSON.stringify(thumb)}`);
      assert(Math.abs(thumb.width - thumb.height) <= 1, `thumbnail should remain square: ${JSON.stringify(thumb)}`);
    }

    await selectBatchCards(page, [0, 1]);
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-serpent-ui="batch"]');
      return host?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 2 / 75';
    });
    await page.evaluate(() => {
      document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
        ?.querySelector('[data-action="save"]')?.click();
    });
    await waitFor(() => desktop.uploads.length === beforeUploads + 2, 'two selected batch image uploads');
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-serpent-ui="batch"]');
      return /1 个原图或较高质量版本、1 个当前预览/.test(
        host?.shadowRoot?.querySelector('[data-field="status"]')?.textContent || '',
      );
    });

    const firstUpload = desktop.uploads[beforeUploads];
    const secondUpload = desktop.uploads[beforeUploads + 1];
    assert(firstUpload && secondUpload, 'both selected pins should reach the desktop upload endpoint');
    assert.deepEqual(firstUpload.body, activePng, 'the selected pin must upload original bytes');
    assert.deepEqual(secondUpload.body, inactivePng, 'a blocked original must upload the exact displayed preview');
    assert.equal(
      decodeURIComponent(firstUpload.headers['x-serpent-media-url']),
      firstPinOriginalUrl,
      'batch selection must send the derived Pinterest /originals/ URL through the save path',
    );
    assert.equal(
      decodeURIComponent(secondUpload.headers['x-serpent-media-url']),
      pins[1]?.previewUrl,
      'preview fallback metadata must name the selected image URL accurately',
    );
    assert(source.requests.some((request) => request.path === '/originals/a1/b2/c3/batch-00-image.png'));
    assert(
      !source.requests.some((request) => request.path === '/736x/a1/b2/c3/batch-00-image.jpg'),
      'a resized data-src must not win over the original-size candidate',
    );
    assert(
      !source.requests.some((request) => request.path === '/originals/a1/b2/c3/batch-00-image.jpg'),
      'the resized URL suffix must not be used when Pinterest declares an exact PNG original',
    );
    assert(
      source.requests.some((request) => request.path === '/originals/1/4/8/batch-01-image.jpg' && request.status === 404),
      'the blocked candidate case must try its original-size URL before the displayed preview',
    );
    console.log('PASS batch Pinterest panel keeps 75 thumbnails square and saves /originals before exact preview fallback');
  } finally {
    await page.close();
  }
}

async function runBatchBehanceOriginalCase({ context, source, desktop }) {
  const requireFromRepo = createRequire(path.join(extensionRoot, 'package.json'));
  const sharp = requireFromRepo('sharp');
  const makeImage = async ({ width, height, color, format }) => {
    const image = sharp({
      create: {
        width,
        height,
        channels: 3,
        background: color,
      },
    });
    if (format === 'jpeg') return image.jpeg({ quality: 92 }).toBuffer();
    if (format === 'webp') return image.webp({ quality: 92 }).toBuffer();
    return image.png().toBuffer();
  };
  const port = new URL(source.origin).port;
  const pageUrl = `http://www.behance.net:${port}/search/projects?search=fixture`;
  const cdn = `http://mir-s3-cdn-cf.behance.net:${port}`;
  const ids = {
    project: '248952145',
    otherProject: '248952146',
    cover: '1441502400',
    moduleA: '1441502389',
    moduleB: '1441502377',
    missing: '1441502360',
    wrongProject: '1441502350',
  };
  const assets = {
    cover: {
      previewUrl: `${cdn}/projects/max_808_webp/cover-fixture.jpg`,
      srcsetUrl: `${cdn}/projects/original_webp/cover-fixture.jpg`,
      originalUrl: `${cdn}/projects/original/cover-fixture.jpg`,
      preview: { width: 84, height: 63, color: { r: 38, g: 95, b: 188 }, format: 'webp' },
      srcset: { width: 210, height: 158, color: { r: 178, g: 60, b: 168 }, format: 'webp' },
      original: { width: 320, height: 240, color: { r: 220, g: 42, b: 53 }, format: 'jpeg' },
    },
    moduleA: {
      previewUrl: `${cdn}/project_modules/max_3840_webp/module-a-image.jpg`,
      srcsetUrl: `${cdn}/project_modules/1400_webp/module-a-image.jpg`,
      originalUrl: `${cdn}/project_modules/source/module-a-image.jpg`,
      preview: { width: 2800, height: 2100, color: { r: 41, g: 86, b: 192 }, format: 'webp' },
      srcset: { width: 1400, height: 1050, color: { r: 120, g: 45, b: 174 }, format: 'webp' },
      original: { width: 3000, height: 2250, color: { r: 35, g: 190, b: 105 }, format: 'jpeg' },
    },
    moduleB: {
      previewUrl: `${cdn}/project_modules/disp/module-b-image.png`,
      srcsetUrl: `${cdn}/project_modules/max_3840_webp/module-b-image.png`,
      originalUrl: `${cdn}/project_modules/source/module-b-image.png`,
      preview: { width: 90, height: 60, color: { r: 30, g: 165, b: 125 }, format: 'png' },
      srcset: { width: 200, height: 134, color: { r: 210, g: 140, b: 32 }, format: 'webp' },
      original: { width: 280, height: 187, color: { r: 38, g: 118, b: 225 }, format: 'png' },
    },
    missing: {
      previewUrl: `${cdn}/project_modules/disp/module-missing-image.jpg`,
      originalUrl: `${cdn}/project_modules/source/module-missing-image.jpg`,
      preview: { width: 88, height: 60, color: { r: 235, g: 177, b: 33 }, format: 'png' },
      original: { width: 290, height: 198, color: { r: 126, g: 39, b: 65 }, format: 'jpeg' },
    },
    wrongProject: {
      previewUrl: `${cdn}/project_modules/opaque_preview/module-wrong-project-image.jpg`,
      originalUrl: `${cdn}/project_modules/source/module-wrong-project-image.jpg`,
      preview: { width: 82, height: 60, color: { r: 42, g: 174, b: 220 }, format: 'png' },
      original: { width: 350, height: 255, color: { r: 180, g: 45, b: 155 }, format: 'webp' },
    },
    unknown: {
      previewUrl: `${cdn}/project_modules/max_808_webp/unmapped-image.jpg`,
      originalUrl: `${cdn}/project_modules/source/unmapped-image.jpg`,
      preview: { width: 86, height: 60, color: { r: 217, g: 87, b: 31 }, format: 'webp' },
    },
  };
  const mimeFor = (format) => ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[format];
  for (const [name, asset] of Object.entries(assets)) {
    for (const role of ['preview', 'srcset', 'original']) {
      if (!asset[role]) continue;
      const image = asset[role];
      image.bytes = await makeImage(image);
      const url = role === 'preview'
        ? asset.previewUrl
        : role === 'srcset' ? asset.srcsetUrl : asset.originalUrl;
      source.media.set(new URL(url).pathname, {
        status: role === 'original' && ['missing', 'moduleA'].includes(name) ? 404 : 200,
        contentType: mimeFor(image.format),
        body: role === 'original' && ['missing', 'moduleA'].includes(name)
          ? Buffer.from('module source is unavailable')
          : image.bytes,
      });
    }
  }

  const stateModule = (id, projectId, asset, sourceUrl = asset.originalUrl) => ({
    id,
    projectId,
    __typename: 'ImageModule',
    src: asset.previewUrl,
    imageSizes: {
      size_disp: { url: asset.previewUrl, width: 600, height: 450 },
      allAvailable: [
        { url: sourceUrl, width: id === ids.moduleA ? 1200 : null, type: sourceUrl.endsWith('.png') ? 'PNG' : 'JPG' },
        ...(asset.srcsetUrl ? [{ url: asset.srcsetUrl, width: id === ids.moduleA ? 1400 : 2800, type: 'WEBP' }] : []),
      ],
    },
  });
  const project = {
    id: Number(ids.project),
    covers: {
      allAvailable: [
        { url: assets.cover.originalUrl, width: null, type: 'JPG' },
        { url: assets.cover.srcsetUrl, width: null, type: 'WEBP' },
        { url: `${cdn}/projects/max_404_webp/cover-fixture.webp`, width: null, type: 'WEBP' },
      ],
    },
    modules: [
      stateModule(ids.moduleA, ids.project, assets.moduleA),
      stateModule(ids.moduleB, ids.project, assets.moduleB),
      stateModule(ids.missing, ids.project, assets.missing),
      stateModule(ids.wrongProject, ids.otherProject, assets.wrongProject),
    ],
  };
  const pageState = { project: { project } };
  const projectHref = `/gallery/${ids.project}/Festival-Compana-2025-Visual-Identity`;
  const imageMarkup = (name, id, { related = true } = {}) => {
    const asset = assets[name];
    const modulePath = related ? `${projectHref}/modules/${id}` : '';
    const highResolutionCurrent = name === 'moduleA';
    const picture = `<picture>${highResolutionCurrent
      ? `<source srcset="${asset.previewUrl} 2800w" sizes="2800px">`
      : ''}<img id="${name}-image" src="${asset.previewUrl}"${asset.srcsetUrl
      ? highResolutionCurrent
        ? ` srcset="${asset.srcsetUrl} 1400w" sizes="1400px"`
        : ` srcset="${asset.previewUrl} 1x, ${asset.srcsetUrl} 2x"`
      : ''} alt="${name}"></picture>`;
    return related ? `<a href="${modulePath}">${picture}</a>` : picture;
  };
  source.pages.set('/search/projects', `<!doctype html>
    <meta charset="utf-8">
    <title>Behance project feed fixture</title>
    <style>body{margin:24px}main{display:flex;flex-wrap:wrap;gap:16px}img{width:180px;height:135px;object-fit:contain}</style>
    <script id="beconfig-store_state" type="application/json">${JSON.stringify(pageState)}</script>
    <main>
      <article class="js-project-cover" data-project-id="${ids.project}">
        <a href="${projectHref}" aria-hidden="true"></a>
        <picture><img id="cover-image" src="${assets.cover.previewUrl}"
          srcset="${assets.cover.previewUrl} 1x, ${assets.cover.srcsetUrl} 2x" alt="cover"></picture>
        <a href="${projectHref}" aria-label="Open project"></a>
      </article>
      ${imageMarkup('moduleA', ids.moduleA)}
      ${imageMarkup('moduleB', ids.moduleB)}
      ${imageMarkup('missing', ids.missing)}
      ${imageMarkup('wrongProject', ids.wrongProject)}
      ${imageMarkup('unknown', 'unlisted-module', { related: false })}
    </main>`);

  const assertImageUpload = async (upload, expected, label) => {
    assert(upload, `${label}: upload must exist`);
    assert.equal(upload.headers['x-serpent-kind'], 'image', `${label}: extension must upload an image`);
    assert.equal(upload.headers['x-serpent-content-type'], mimeFor(expected.image.format),
      `${label}: uploaded content type must match the actual image bytes`);
    assert.equal(decodeURIComponent(upload.headers['x-serpent-media-url']), expected.url,
      `${label}: upload metadata must name the exact selected original or preview URL`);
    assert.deepEqual(upload.body, expected.image.bytes, `${label}: receiver must get the exact source bytes`);
    const decoded = await sharp(upload.body).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([decoded.info.width, decoded.info.height], [expected.image.width, expected.image.height],
      `${label}: received pixels must have the expected dimensions`);
    const [r, g, b] = decoded.data;
    const tolerance = expected.image.format === 'jpeg' ? 20 : 2;
    for (const [actual, target, channel] of [[r, expected.image.color.r, 'red'],
      [g, expected.image.color.g, 'green'], [b, expected.image.color.b, 'blue']]) {
      assert(Math.abs(actual - target) <= tolerance,
        `${label}: received ${channel} pixel ${actual} should match ${target}`);
    }
  };

  await writeSyncStorage(context, {
    preferOriginalMedia: false,
    serpentBatchFilter: { minEdge: 0, formats: ['jpg', 'png', 'webp'], preferHd: true },
  });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.goto(pageUrl);
    await page.waitForFunction(() => [...document.images].length === 6
      && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const observed = await page.evaluate(() => [...document.images].map((image) => ({
      id: image.id,
      currentSrc: image.currentSrc,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      anchorHref: image.closest('a')?.href,
      projectCover: Boolean(image.closest('.js-project-cover')),
    })));
    assert.equal(observed.length, 6, 'the fixture must present six distinct Behance images');
    assert(observed[0]?.projectCover, 'the cover must be outside its sibling project links');
    assert.equal(observed[0]?.anchorHref, undefined,
      'the feed cover must resolve through its sibling project anchors, not a wrapping anchor');
    assert.equal(observed[1]?.anchorHref?.endsWith(`/modules/${ids.moduleA}`), true,
      'module A identity must come from its own containing anchor');
    assert.equal(observed[2]?.anchorHref?.endsWith(`/modules/${ids.moduleB}`), true,
      'module B identity must come from its own containing anchor');
    assert.equal(observed.find((image) => image.id === 'moduleA-image')?.currentSrc, assets.moduleA.previewUrl,
      'the 2800px responsive preview must remain the browser-selected preview over the 1400px img srcset');
    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'Behance synthetic fixture tab must be visible to the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-serpent-ui="batch"]');
      return host?.shadowRoot?.querySelectorAll('.card').length === 6;
    });
    const displayedPreviews = await page.evaluate(() => [...(document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card') ?? [])].map((card) => card.querySelector('img')?.src ?? ''));
    assert.equal(displayedPreviews.length, 6, 'the batch should retain all six Behance media items');

    await selectBatchCards(page, [0]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 1 / 6');
    const coverUpgradePaths = new Set([
      new URL(assets.cover.originalUrl).pathname,
      new URL(assets.cover.srcsetUrl).pathname,
    ]);
    const coverUpgradeRequestsBeforeOff = source.requests.filter((request) => coverUpgradePaths.has(request.path)).length;
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 1, 'Behance preview-only cover upload');
    const coverPreviewImage = assets.cover.preview;
    await assertImageUpload(desktop.uploads[beforeUploads], {
      url: assets.cover.previewUrl,
      image: coverPreviewImage,
    }, 'Behance preference-off cover');
    assert.equal(source.requests.filter((request) => coverUpgradePaths.has(request.path)).length,
      coverUpgradeRequestsBeforeOff, 'preview-only mode must not issue an original-resolution CDN request');
    assert.equal(source.requests.some((request) => request.path === new URL(assets.cover.originalUrl).pathname), false,
      'preview-only cover must not request the project cover original');

    await page.waitForFunction(() => {
      const shadow = document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot;
      return shadow?.querySelector('[data-action="save"]')?.dataset.action === 'save';
    });
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="hd"]')?.click());
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-action="hd"]')?.getAttribute('aria-pressed') === 'true');
    await selectBatchCards(page, [0, 1, 2, 3, 4, 5]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 6 / 6');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 7, 'Behance original-aware six-image batch upload');

    const expected = new Map([
      [assets.cover.originalUrl, { image: assets.cover.original, label: 'Behance cover original' }],
      [assets.moduleA.previewUrl, { image: assets.moduleA.preview, label: 'Behance module A source-failure preview fallback' }],
      [assets.moduleB.originalUrl, { image: assets.moduleB.original, label: 'Behance module B source' }],
      [assets.missing.previewUrl, { image: assets.missing.preview, label: 'Behance missing source preview fallback' }],
      [assets.wrongProject.previewUrl, { image: assets.wrongProject.preview, label: 'Behance mismatched project preview' }],
      [assets.unknown.previewUrl, { image: assets.unknown.preview, label: 'Behance unidentified preview' }],
    ]);
    const originalAwareUploads = desktop.uploads.slice(beforeUploads + 1, beforeUploads + 7);
    assert.equal(originalAwareUploads.length, 6, 'the enabled batch must upload each selected Behance item once');
    const observedUploads = new Map();
    for (const upload of originalAwareUploads) {
      const url = decodeURIComponent(upload.headers['x-serpent-media-url']);
      const selected = expected.get(url);
      assert(selected, `unexpected Behance media URL reached the receiver: ${url}`);
      assert.equal(observedUploads.has(url), false, `duplicate upload for Behance media URL: ${url}`);
      observedUploads.set(url, upload);
      await assertImageUpload(upload, { url, image: selected.image }, selected.label);
    }
    assert.deepEqual([...observedUploads.keys()].sort(), [...expected.keys()].sort(),
      'the receiver must get precisely the matched source or exact preview for each Behance image');
    assert(source.requests.some((request) => request.path === new URL(assets.missing.originalUrl).pathname
      && request.status === 404), 'a failed Behance source must be observed before exact-preview fallback');
    assert(source.requests.some((request) => request.path === new URL(assets.moduleA.originalUrl).pathname
      && request.status === 404), 'the explicit source with a smaller declared width must still be tried');
    assert.equal(source.requests.some((request) => request.path === new URL(assets.moduleA.srcsetUrl).pathname), false,
      'when that smaller-declared source fails, do not fall back to the still-smaller 1400px srcset');
    assert.equal(source.requests.some((request) => request.path === new URL(assets.wrongProject.originalUrl).pathname), false,
      'a same-filename module record with another projectId must not supply this project module’s source');
    assert.equal(source.requests.some((request) => request.path === new URL(assets.unknown.originalUrl).pathname), true,
      'an unlinked same-asset fallback may be probed only at that asset’s own verified path');
    assert.equal(source.requests.some((request) => request.path === new URL(assets.moduleB.originalUrl).pathname), true,
      'module B must resolve from its own source URL');
    console.log('PASS Behance batch matches cover/module identities, uploads verified source pixels, blocks cross-project reuse, and falls back exactly when source is unavailable');
  } finally {
    await page.close();
  }
}

async function runBatchBehanceLiveReplayCase({ context, desktop, temporaryRoot }) {
  const requireFromRepo = createRequire(path.join(extensionRoot, 'package.json'));
  const sharp = requireFromRepo('sharp');
  const pageUrl = 'https://www.behance.net/gallery/248952145/Festival-Compana-2025-Visual-Identity';
  const moduleId = '1441502389';
  const expectedFilename = 'cec024248952145.69fcc1052be55.jpg';
  const cdn = 'https://mir-s3-cdn-cf.behance.net';
  const previewUrl = `${cdn}/project_modules/1400_webp/${expectedFilename}`;
  const sourceUrl = `${cdn}/project_modules/source/${expectedFilename}`;
  const max3840Url = `${cdn}/project_modules/max_3840_webp/${expectedFilename}`;
  const projectId = '248952145';
  const module = {
    id: moduleId,
    projectId,
    __typename: 'ImageModule',
    src: previewUrl,
    imageSizes: {
      size_disp: { url: previewUrl, width: 600, height: 450 },
      allAvailable: [
        { url: sourceUrl, width: null, type: 'JPG' },
        { url: max3840Url, width: 3000, type: 'WEBP' },
        { url: previewUrl, width: 1400, type: 'WEBP' },
      ],
    },
  };
  const replayState = { project: { project: { id: Number(projectId), covers: { allAvailable: [] }, modules: [module] } } };
  const previewBytes = await sharp({
    create: { width: 1400, height: 1050, channels: 3, background: { r: 34, g: 66, b: 124 } },
  }).webp({ quality: 88 }).toBuffer();
  const replayMarkup = `<!doctype html>
    <meta charset="utf-8">
    <title>Behance captured-state DOM replay</title>
    <style>body{margin:24px}img{width:600px;height:450px;object-fit:contain}</style>
    <script id="beconfig-store_state" type="application/json">${JSON.stringify(replayState)}</script>
    <a href="/gallery/${projectId}/Festival-Compana-2025-Visual-Identity/modules/${moduleId}">
      <img id="module-replay" src="${previewUrl}" alt="captured Behance module">
    </a>`;
  const isTargetPageUrl = (url) => url.href === pageUrl;
  const isPreviewUrl = (url) => url.href === previewUrl;
  const pageRoute = async (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: replayMarkup,
  });
  const previewRoute = async (route) => route.fulfill({
    status: 200,
    contentType: 'image/webp',
    headers: { 'Cache-Control': 'no-store' },
    body: previewBytes,
  });
  const blockedSourceRequests = [];
  const liveCdnRequests = [];
  const liveCdnResponses = [];
  const liveCdnResponseBodies = [];
  const isTargetSourceUrl = (url) => url.href === sourceUrl;
  const sourceRoute = async (route) => {
    blockedSourceRequests.push(route.request().url());
    await route.fulfill({
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: 'controlled Behance source unavailability for fallback replay',
    });
  };
  await context.route(isTargetPageUrl, pageRoute);
  await context.route(isPreviewUrl, previewRoute);
  await context.route(isTargetSourceUrl, sourceRoute);
  context.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.hostname === 'mir-s3-cdn-cf.behance.net' && url.pathname.includes(expectedFilename)) {
        liveCdnRequests.push(request.url());
      }
    } catch {
      // Ignore non-URL browser requests.
    }
  });
  context.on('response', async (response) => {
    try {
      const url = new URL(response.url());
      if (url.hostname === 'mir-s3-cdn-cf.behance.net' && url.pathname.includes(expectedFilename)) {
        const record = { url: response.url(), status: response.status() };
        liveCdnResponses.push(record);
        if (response.status() === 200 && url.pathname.includes('/project_modules/max_3840_webp/')) {
          liveCdnResponseBodies.push({ ...record, body: await response.body() });
        }
      }
    } catch (error) {
      liveCdnResponses.push({ url: response.url(), status: response.status(), error: String(error).slice(0, 160) });
    }
  });

  await writeSyncStorage(context, {
    preferOriginalMedia: true,
    serpentBatchFilter: { minEdge: 0, formats: ['jpg', 'png', 'webp'], preferHd: true },
  });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('#beconfig-store_state')
      && document.querySelector('#module-replay')?.naturalWidth === 1400, undefined, { timeout: 15_000 });
    const captured = await page.waitForFunction(({ expectedModuleId, expectedFile }) => {
      const script = document.querySelector('#beconfig-store_state');
      if (!script?.textContent) return null;
      let state;
      try { state = JSON.parse(script.textContent); } catch { return null; }
      const project = state?.project?.project;
      const module = Array.isArray(project?.modules)
        ? project.modules.find((item) => String(item?.id ?? '') === expectedModuleId)
        : undefined;
      const images = [...document.images].filter((image) => (
        image.currentSrc.includes(expectedFile)
        && image.closest('a[href]')?.getAttribute('href')?.includes(`/modules/${expectedModuleId}`)
      ));
      const image = images.find((candidate) => candidate.complete && candidate.naturalWidth > 0);
      if (!module || !image) return null;
      const available = module.imageSizes?.allAvailable;
      return {
        pageUrl: location.href,
        title: document.title,
        stateLength: script.textContent.length,
        projectId: String(project?.id ?? ''),
        moduleId: String(module.id ?? ''),
        moduleProjectId: String(module.projectId ?? ''),
        moduleType: String(module.__typename ?? ''),
        modulePreview: String(module.src ?? ''),
        candidates: Array.isArray(available) ? available.flatMap((item) => (
          typeof item?.url === 'string' && item.url.includes(expectedFile)
            ? [{ url: item.url, width: item.width ?? null, type: item.type ?? null }]
            : []
        )) : [],
        image: {
          currentSrc: image.currentSrc,
          src: image.getAttribute('src'),
          srcset: image.getAttribute('srcset'),
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          anchorHref: image.closest('a[href]')?.href,
        },
      };
    }, { expectedModuleId: moduleId, expectedFile: expectedFilename }, { timeout: 10_000 });
    const capture = await captured.jsonValue();
    assert.equal(capture.projectId, projectId, 'replayed state must match the observed Behance project route');
    assert.equal(capture.moduleProjectId, capture.projectId, 'live module must belong to the current project');
    assert.equal(capture.moduleType, 'ImageModule', 'live target must be an image module');
    const sourceEntry = capture.candidates.find((candidate) => new URL(candidate.url).pathname
      .includes('/project_modules/source/'));
    const max3840Entry = capture.candidates.find((candidate) => new URL(candidate.url).pathname
      .includes('/project_modules/max_3840_webp/'));
    assert.equal(sourceEntry?.url, sourceUrl, 'replayed state must expose the exact module source URL');
    assert(max3840Entry, 'replayed state must expose the same asset’s max_3840_webp backup');
    assert.equal(new URL(max3840Entry.url).pathname.split('/').at(-1), expectedFilename,
      'the 3000px backup must preserve the exact selected module filename');
    const capturePath = path.join(temporaryRoot, 'behance-dom-replay-capture.json');
    await writeFile(capturePath, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');

    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'live Behance tab must be visible to the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length > 0, undefined, { timeout: 20_000 });
    const cards = await page.evaluate(() => [...(document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card') ?? [])].map((card) => {
      const image = card.querySelector('img');
      return { src: image?.src ?? '', currentSrc: image?.currentSrc ?? '' };
    }));
    const targetPreviewPath = new URL(capture.image.currentSrc).pathname;
    const cardIndex = cards.findIndex((card) => {
      try {
        return new URL(card.currentSrc || card.src).pathname === targetPreviewPath;
      } catch {
        return false;
      }
    });
    assert(cardIndex >= 0, 'live batch must contain the captured module preview as one selectable card');
    await selectBatchCards(page, [cardIndex]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent?.startsWith('已选 1 / '));
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 1,
      'live Behance module fallback upload', 45_000);
    const upload = desktop.uploads[beforeUploads];
    assert.equal(blockedSourceRequests.length, 1,
      'the test must inject one exact source 404 before allowing the real backup CDN request');
    assert.equal(blockedSourceRequests[0], sourceUrl);
    assert.equal(upload.headers['x-serpent-kind'], 'image');
    assert.equal(upload.headers['x-serpent-content-type'], 'image/webp',
      'receiver must identify the real backup bytes as WebP');
    assert.equal(decodeURIComponent(upload.headers['x-serpent-media-url']), max3840Entry.url,
      'receiver metadata must name the real same-asset max_3840_webp URL');
    await waitFor(() => liveCdnResponseBodies.some((response) => response.url === max3840Entry.url),
      'live max_3840_webp CDN response body capture', 10_000);
    const capturedBackup = liveCdnResponseBodies.find((response) => response.url === max3840Entry.url);
    assert(capturedBackup?.body, 'the browser must expose the real max_3840_webp response body');
    assert.deepEqual(upload.body, capturedBackup.body,
      'the isolated receiver must get exactly the bytes returned by the public Behance CDN to the extension');
    const actualPixels = await sharp(upload.body).metadata();
    assert.deepEqual([actualPixels.width, actualPixels.height, actualPixels.format], [3000, 2250, 'webp'],
      'the replay must deliver 3000×2250 real CDN pixels');
    assert(liveCdnRequests.includes(max3840Entry.url),
      'the extension browser must fetch the captured max_3840_webp URL from the live CDN');
    assert(liveCdnResponses.some((response) => response.url === max3840Entry.url && response.status === 200),
      'the real CDN must return the backup rendition successfully to the extension browser');
    console.log('PASS Behance captured-state DOM replay plus isolated extension replay: controlled source 404 falls back to the real 3000×2250 max_3840_webp CDN bytes');
  } finally {
    await page.close();
    await context.unroute(isTargetPageUrl, pageRoute);
    await context.unroute(isPreviewUrl, previewRoute);
    await context.unroute(isTargetSourceUrl, sourceRoute);
  }
}

async function runHuabanOriginalCase({ context, source, desktop }) {
  const requireFromRepo = createRequire(path.join(extensionRoot, 'package.json'));
  const sharp = requireFromRepo('sharp');
  const makeImage = async ({ width, height, color, format }) => {
    const image = sharp({
      create: {
        width,
        height,
        channels: 3,
        background: color,
      },
    });
    return format === 'jpeg'
      ? image.jpeg({ quality: 88 }).toBuffer()
      : image.png().toBuffer();
  };

  const sourcePort = new URL(source.origin).port;
  const pageUrl = `http://huaban.com:${sourcePort}/boards/102625833`;
  const cdn = `http://gd-hbimg-edge.huaban.com:${sourcePort}`;
  const metadataUrl = (value) => {
    const url = new URL(value);
    url.searchParams.delete('auth_key');
    return url.href;
  };
  const records = [
    {
      id: '7303246823',
      key: '9691777feaa68262335241f915cc4a0012e86582328e4-s2rARH',
      type: 'image/jpeg',
      width: 1080,
      height: 1350,
      originalStatus: 200,
      originalColor: { r: 215, g: 45, b: 55 },
      previewColor: { r: 45, g: 70, b: 190 },
    },
    {
      id: '7303246675',
      key: 'c62c813c954119839e9785f21aabb83142a5cd88-dqL8MJ',
      type: 'image/jpeg',
      width: 1280,
      height: 1920,
      originalStatus: 404,
      originalColor: { r: 205, g: 125, b: 30 },
      previewColor: { r: 30, g: 175, b: 130 },
    },
    {
      id: '7303246501',
      key: '34c1a82663e3d2e57dd12a9e891f1438f5c6a770-8QpK4x',
      type: 'image/png',
      width: 900,
      height: 1200,
      originalStatus: 200,
      originalColor: { r: 115, g: 35, b: 170 },
      previewColor: { r: 225, g: 205, b: 45 },
    },
  ];
  const derivedPin = {
    id: '7999999998',
    key: 'unlisted-pin-opaque-asset-key',
    previewColor: { r: 35, g: 155, b: 95 },
    originalColor: { r: 190, g: 60, b: 145 },
  };
  const unknownPin = {
    id: '7999999999',
    previewColor: { r: 40, g: 170, b: 220 },
  };

  for (const record of records) {
    record.originalUrl = `${cdn}/${record.key}?auth_key=fixture-signature-${record.id}`;
    record.previewUrl = `${cdn}/${record.key}_fw240webp?auth_key=fixture-preview-${record.id}`;
    record.srcsetUrl = `${cdn}/${record.key}_fw480webp?auth_key=fixture-srcset-${record.id}`;
    record.previewBytes = await makeImage({
      width: 240,
      height: record.id === '7303246675' ? 360 : 300,
      color: record.previewColor,
      format: 'png',
    });
    record.originalBytes = await makeImage({
      width: record.width,
      height: record.height,
      color: record.originalColor,
      format: record.type === 'image/jpeg' ? 'jpeg' : 'png',
    });
    record.srcsetBytes = await makeImage({
      width: 480,
      height: record.id === '7303246675' ? 720 : 600,
      color: { ...record.previewColor, r: Math.max(0, record.previewColor.r - 12) },
      format: 'png',
    });

    source.media.set(new URL(record.previewUrl).pathname + new URL(record.previewUrl).search, {
      status: 200,
      contentType: 'image/webp',
      body: await sharp(record.previewBytes).webp().toBuffer(),
    });
    source.media.set(new URL(record.srcsetUrl).pathname + new URL(record.srcsetUrl).search, {
      status: 200,
      contentType: 'image/webp',
      body: await sharp(record.srcsetBytes).webp().toBuffer(),
    });
    source.media.set(new URL(record.originalUrl).pathname + new URL(record.originalUrl).search, {
      status: record.originalStatus,
      contentType: record.type,
      body: record.originalStatus === 200
        ? record.originalBytes
        : Buffer.from('<!doctype html><title>fixture original unavailable</title>'),
    });
  }

  // A later, unlisted pin may use a narrowly evidenced Huaban rendition suffix.
  // Its own derived URL must not borrow the first NEXT record's signed URL.
  derivedPin.previewUrl = `${cdn}/${derivedPin.key}_fw240webp?auth_key=fixture-derived-pin`;
  derivedPin.originalUrl = `${cdn}/${derivedPin.key}?auth_key=fixture-derived-pin`;
  derivedPin.previewBytes = await makeImage({
    width: 240,
    height: 300,
    color: derivedPin.previewColor,
    format: 'png',
  });
  derivedPin.originalBytes = await makeImage({
    width: 1000,
    height: 1250,
    color: derivedPin.originalColor,
    format: 'jpeg',
  });
  source.media.set(new URL(derivedPin.previewUrl).pathname + new URL(derivedPin.previewUrl).search, {
    status: 200,
    contentType: 'image/webp',
    body: await sharp(derivedPin.previewBytes).webp().toBuffer(),
  });
  source.media.set(new URL(derivedPin.originalUrl).pathname + new URL(derivedPin.originalUrl).search, {
    status: 200,
    contentType: 'image/jpeg',
    body: derivedPin.originalBytes,
  });

  // An unknown format with no observed, safe rendition marker must remain a preview.
  unknownPin.previewUrl = `${cdn}/unmatched-opaque-asset-token?auth_key=fixture-unknown-pin`;
  unknownPin.previewBytes = await makeImage({
    width: 240,
    height: 300,
    color: unknownPin.previewColor,
    format: 'png',
  });
  source.media.set(new URL(unknownPin.previewUrl).pathname + new URL(unknownPin.previewUrl).search, {
    status: 200,
    contentType: 'image/webp',
    body: await sharp(unknownPin.previewBytes).webp().toBuffer(),
  });

  const serverSidePins = records.map((record) => ({
    pin_id: record.id,
    file: {
      bucket: 'gd-hbimg',
      key: record.key,
      type: record.type,
      width: record.width,
      height: record.height,
      url: record.originalUrl,
    },
  }));
  const pinMarkup = [
    ...records.map((record) => `
      <article><a href="/pins/${record.id}">
        <img src="${record.previewUrl}" srcset="${record.previewUrl} 1x, ${record.srcsetUrl} 2x"
          width="240" height="300" alt="pin ${record.id}">
      </a></article>`),
    `<article><a href="/pins/${derivedPin.id}">
      <img src="${derivedPin.previewUrl}" width="240" height="300" alt="unlisted renditional pin">
    </a></article>`,
    `<article><a href="/pins/${unknownPin.id}">
      <img src="${unknownPin.previewUrl}" width="240" height="300" alt="unmatched pin">
    </a></article>`,
  ].join('');
  source.pages.set('/boards/102625833', `<!doctype html>
    <meta charset="utf-8"><title>Huaban original-media fixture</title>
    <style>body{margin:16px}main{display:flex;flex-wrap:wrap;gap:12px}img{width:240px;height:auto}</style>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { serverSidePins } },
  })}</script>
    <main>${pinMarkup}</main>`);

  await writeSyncStorage(context, { preferOriginalMedia: true });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.goto(pageUrl);
    await page.waitForFunction(() => [...document.querySelectorAll('main img')]
      .length === 5 && [...document.querySelectorAll('main img')]
      .every((image) => image.complete && image.naturalWidth > 0));
    const initialImageState = await page.locator('main img').evaluateAll((images) => images.map((image) => ({
      currentSrc: image.currentSrc,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    })));
    assert.equal(initialImageState.length, 5);
    assert(initialImageState[0]?.currentSrc.includes('_fw240webp'), 'the first pin fixture must display a small WebP preview');

    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'Huaban fixture tab must be visible to the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 5);

    await selectBatchCards(page, [0, 1, 2, 3, 4]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 5 / 5');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 5, 'Huaban original, derived candidate, and preview fallback uploads');
    await page.waitForFunction(() => /保存 3 个原图或较高质量版本、2 个当前预览/.test(
      document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
        ?.querySelector('[data-field="status"]')?.textContent || '',
    ));

    const uploadedByUrl = new Map(desktop.uploads.slice(beforeUploads, beforeUploads + 5).map((upload) => [
      decodeURIComponent(upload.headers['x-serpent-media-url']),
      upload,
    ]));
    const firstOriginal = uploadedByUrl.get(metadataUrl(records[0].originalUrl));
    const failedOriginalFallback = uploadedByUrl.get(metadataUrl(records[1].previewUrl));
    const thirdOriginal = uploadedByUrl.get(metadataUrl(records[2].originalUrl));
    const derivedOriginal = uploadedByUrl.get(metadataUrl(derivedPin.originalUrl));
    const unmatchedFallback = uploadedByUrl.get(metadataUrl(unknownPin.previewUrl));
    assert(firstOriginal, 'the exact first Pin file.url must be downloaded and saved');
    assert(failedOriginalFallback, 'a failed original must fall back to its exact displayed preview URL');
    assert(thirdOriginal, 'the third Pin file.url must be uploaded independently');
    assert(derivedOriginal, 'a later unlisted Pin with the observed Huaban suffix must derive its own same-asset candidate');
    assert(unmatchedFallback, 'an unmatched Pin must keep its displayed preview instead of borrowing a neighbor original');
    assert.equal(firstOriginal.headers['x-serpent-content-type'], 'image/jpeg');
    assert.equal(decodeURIComponent(firstOriginal.headers['x-serpent-filename']), 'image.jpg',
      'an extensionless Huaban file key must still get a filename with the MIME-correct .jpg suffix');
    assert.equal(thirdOriginal.headers['x-serpent-content-type'], 'image/png');
    assert.equal(decodeURIComponent(thirdOriginal.headers['x-serpent-filename']), 'image.png',
      'an extensionless Huaban file key must still get a filename with the MIME-correct .png suffix');
    assert.deepEqual(firstOriginal.body, records[0].originalBytes);
    assert.deepEqual(failedOriginalFallback.body, await sharp(records[1].previewBytes).webp().toBuffer());
    assert.deepEqual(thirdOriginal.body, records[2].originalBytes);
    assert.deepEqual(derivedOriginal.body, derivedPin.originalBytes);
    assert.deepEqual(unmatchedFallback.body, await sharp(unknownPin.previewBytes).webp().toBuffer());

    const firstMeta = await sharp(firstOriginal.body).metadata();
    const thirdMeta = await sharp(thirdOriginal.body).metadata();
    const firstStats = await sharp(firstOriginal.body).stats();
    const thirdStats = await sharp(thirdOriginal.body).stats();
    assert.deepEqual({ format: firstMeta.format, width: firstMeta.width, height: firstMeta.height }, {
      format: 'jpeg', width: records[0].width, height: records[0].height,
    });
    assert.deepEqual({ format: thirdMeta.format, width: thirdMeta.width, height: thirdMeta.height }, {
      format: 'png', width: records[2].width, height: records[2].height,
    });
    assert.notDeepEqual(firstStats.channels.map((channel) => Math.round(channel.mean)),
      thirdStats.channels.map((channel) => Math.round(channel.mean)),
    'different Huaban pins must carry different decoded pixels through the upload');

    assert(source.requests.some((request) => request.path === new URL(records[0].originalUrl).pathname
      && request.search === new URL(records[0].originalUrl).search && request.status === 200),
    'the extension must fetch the first exact signed file.url, which has no filename extension');
    assert(source.requests.some((request) => request.path === new URL(records[1].originalUrl).pathname
      && request.search === new URL(records[1].originalUrl).search && request.status === 404),
    'the second exact file.url must fail before its preview fallback is saved');
    assert(source.requests.some((request) => request.path === new URL(records[2].originalUrl).pathname
      && request.search === new URL(records[2].originalUrl).search && request.status === 200),
    'the third pin must fetch its own file.url, not its neighbor\'s file.url');
    assert(source.requests.some((request) => request.path === new URL(derivedPin.originalUrl).pathname
      && request.search === new URL(derivedPin.originalUrl).search && request.status === 200),
    'a safe suffix-derived candidate must preserve the later Pin\'s own signature query');
    const unknownPreview = new URL(unknownPin.previewUrl);
    assert(source.requests.filter((request) => request.path === unknownPreview.pathname)
      .every((request) => request.search === unknownPreview.search),
    'an unknown Huaban URL without a recognized rendition suffix must not trigger a guessed candidate with altered query data');
    assert(!desktop.uploads.slice(beforeUploads, beforeUploads + 5).some((upload) => (
      decodeURIComponent(upload.headers['x-serpent-media-url']) === metadataUrl(records[1].originalUrl)
    )), 'a failed original candidate must not be reported as the saved source');

    const sourceRequestCountBeforePreviewOnly = source.requests.length;
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="hd"]')?.click());
    await page.waitForFunction(() => !document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="hd"]')?.classList.contains('is-on'));
    await selectBatchCards(page, [0, 1, 2, 3, 4]);
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 10, 'Huaban preview-only uploads');
    await page.waitForFunction(() => /保存 0 个原图或较高质量版本、5 个当前预览/.test(
      document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
        ?.querySelector('[data-field="status"]')?.textContent || '',
    ));
    const previewOnly = desktop.uploads.slice(beforeUploads + 5, beforeUploads + 10);
    const previewSources = new Set([
      metadataUrl(records[0].previewUrl),
      metadataUrl(records[1].previewUrl),
      metadataUrl(records[2].previewUrl),
      metadataUrl(derivedPin.previewUrl),
      metadataUrl(unknownPin.previewUrl),
    ]);
    assert.equal(previewOnly.length, 5);
    for (const upload of previewOnly) {
      const sourceUrl = decodeURIComponent(upload.headers['x-serpent-media-url']);
      assert(previewSources.has(sourceUrl), `original mode off must upload an exact displayed preview, got ${sourceUrl}`);
      assert(!records.some((record) => metadataUrl(record.originalUrl) === sourceUrl)
        && metadataUrl(derivedPin.originalUrl) !== sourceUrl,
      'original mode off must not upload a Huaban original candidate');
    }
    const originalCandidateUrls = [...records.map((record) => record.originalUrl), derivedPin.originalUrl];
    assert.equal(source.requests.slice(sourceRequestCountBeforePreviewOnly).filter((request) => originalCandidateUrls.some((url) => (
      request.path === new URL(url).pathname && request.search === new URL(url).search
    ))).length, 0, 'original mode off must not request any Huaban original candidate');

    console.log('PASS Huaban batch binds NEXT_DATA file.url to the same Pin, derives only a safe same-asset rendition, keeps signed URLs, validates extensionless image MIME, falls back exactly, and honors preview-only mode');
  } finally {
    await page.close();
  }
}

async function runPinterestVideoCase({ context, source, desktop }) {
  const posterBytes = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  const mp4Bytes = await readFile(path.join(extensionRoot, 'test-fixtures', 'short-valid.mp4'));
  assert(mp4Bytes.byteLength > 4_000, 'Pinterest success fixture must be a complete video, not an ftyp stub');
  assert(mp4Bytes.includes(Buffer.from('ftyp')) && mp4Bytes.includes(Buffer.from('moov'))
    && mp4Bytes.includes(Buffer.from('mdat')), 'Pinterest success fixture must contain complete MP4 boxes');

  const sourcePort = new URL(source.origin).port;
  const pageUrl = `http://pinterest.ca:${sourcePort}/pin/pinterest-video-blob-batch`;
  const pinimg = `http://i.pinimg.com:${sourcePort}`;
  const videoCdn = `http://v1.pinimg.com:${sourcePort}`;
  const makePin = (id, stem, previewPrefix) => {
    const posterUrl = `${pinimg}/236x/${previewPrefix}/${stem}.jpg`;
    return {
      id,
      posterUrl,
      imageSlotPosterUrl: `${pinimg}/236x/${previewPrefix}/${stem}-image.jpg`,
      otherVideoPosterUrl: `${pinimg}/236x/${previewPrefix}/${stem}-other-video.jpg`,
      mp4Url: `${videoCdn}/videos/iht/expMp4/${previewPrefix}/${stem}_720w.mp4`,
      hlsUrl: `${videoCdn}/videos/iht/expMp4/${previewPrefix}/${stem}.m3u8`,
      wrongSlotMp4Url: `${videoCdn}/videos/iht/expMp4/${previewPrefix}/${stem}-wrong-slot_1080w.mp4`,
    };
  };
  const pins = [
    makePin('1065382855646497154', 'a8b69af284ccc8f093943919bf10f762', 'a8/b6/9a'),
    makePin('1065382855646497155', 'b1c70af284ccc8f093943919bf10f763', 'b1/c7/0a'),
    makePin('1065382855646497156', 'c2d81af284ccc8f093943919bf10f764', 'c2/d8/1a'),
  ];

  for (const pin of pins) {
    source.media.set(new URL(pin.posterUrl).pathname, {
      status: 200,
      contentType: 'image/png',
      body: posterBytes,
    });
    source.pages.set(`/pin/${pin.id}/`, makePinterestVideoPinDetailPage(pin));
    source.media.set(new URL(pin.wrongSlotMp4Url).pathname, {
      status: 200,
      contentType: 'video/mp4',
      body: mp4Bytes,
    });
  }
  const availablePin = pins[0];
  const unavailablePin = pins[1];
  const originalOffPin = pins[2];
  assert(availablePin && unavailablePin && originalOffPin);
  const feedPins = [availablePin, { ...availablePin }, unavailablePin, originalOffPin];
  source.media.set(new URL(availablePin.mp4Url).pathname, {
    status: 200,
    contentType: 'video/mp4',
    body: mp4Bytes,
  });
  source.media.set(new URL(availablePin.hlsUrl).pathname, {
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n'),
  });
  for (const unavailableUrl of [unavailablePin.mp4Url, unavailablePin.hlsUrl]) {
    source.media.set(new URL(unavailableUrl).pathname, {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('video unavailable'),
    });
  }
  source.media.set(new URL(originalOffPin.mp4Url).pathname, {
    status: 200,
    contentType: 'video/mp4',
    body: mp4Bytes,
  });
  source.media.set(new URL(originalOffPin.hlsUrl).pathname, {
    status: 200,
    contentType: 'application/vnd.apple.mpegurl',
    body: Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n'),
  });

  const staleState = {
    initialReduxState: {
      pins: {
        '900000000000000001': { entityId: '900000000000000001', videos: null },
      },
    },
  };
  source.pages.set('/pin/pinterest-video-blob-batch', makePinterestBlobVideoFeedPage(feedPins, staleState));
  await writeSyncStorage(context, { preferOriginalMedia: true });

  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(pageUrl);
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('video[data-pin-video]')];
      return videos.length === 4 && videos.every((video) => video.currentSrc.startsWith('blob:'));
    });
    const feedState = await page.locator('#__PWS_INITIAL_PROPS__').evaluate((element) => JSON.parse(element.textContent));
    for (const pin of pins) {
      assert.equal(Object.hasOwn(feedState.initialReduxState.pins, pin.id), false,
        `feed PWS state must be stale and exclude current Pin ${pin.id}`);
    }
    const feedVideos = await page.locator('video[data-pin-video]').evaluateAll((videos) => videos.map((video) => ({
      currentSrc: video.currentSrc,
      poster: video.poster,
    })));
    assert.equal(feedVideos.length, 4);
    for (const [index, pin] of feedPins.entries()) {
      assert(feedVideos[index]?.currentSrc.startsWith('blob:http://pinterest.ca:'),
        'each selected feed video must expose a blob MediaSource URL as currentSrc');
      assert.equal(feedVideos[index]?.poster, pin.posterUrl, 'the feed video poster must remain the selected cover URL');
    }

    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'Pinterest blob video feed tab must be visible to extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 3);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 3 / 3');

    const firstSelection = await selectBatchCards(page, [0]);
    assert.equal(firstSelection.checked, 'mixed');
    assert.equal(firstSelection.selected, 1);
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 1, 'the selected Pinterest MP4 upload');
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已发送 1 个文件');

    const successfulUpload = desktop.uploads[beforeUploads];
    assert(successfulUpload, 'the selected Pinterest video must reach the desktop upload endpoint');
    assert.deepEqual(successfulUpload.body, mp4Bytes, 'the upload must contain every byte of the valid MP4 fixture');
    assert(successfulUpload.body.byteLength > 4_000, 'the saved video must not be a four-byte ftyp stub');
    assert.equal(successfulUpload.headers['x-serpent-kind'], 'video', 'desktop metadata must keep the media kind as video');
    assert.equal(successfulUpload.headers['x-serpent-content-type'], 'video/mp4');
    assert.equal(decodeURIComponent(successfulUpload.headers['x-serpent-media-url']), availablePin.mp4Url,
      'the uploaded video URL must be the selected Pin slot 0 MP4 candidate');
    assert(source.requests.some((request) => request.path === `/pin/${availablePin.id}/` && request.status === 200),
      'blob video resolution must fetch the selected Pin detail page when feed PWS is stale');
    assert(source.requests.some((request) => request.path === new URL(availablePin.mp4Url).pathname && request.status === 200),
      'the selected Pin MP4 must be downloaded from its own carousel slot');
    assert.equal(source.requests.some((request) => request.path === new URL(availablePin.wrongSlotMp4Url).pathname), false,
      'the higher-resolution video in carousel slot 2 must not be selected for slot 0');
    assert.equal(source.requests.some((request) => request.path === `/pin/${unavailablePin.id}/`), false,
      'saving Pin 0 must not resolve candidates from another feed Pin');
    assert.equal(source.requests.some((request) => request.path === `/pin/${originalOffPin.id}/`), false,
      'saving Pin 0 must not resolve candidates from a second unrelated feed Pin');

    await selectBatchCards(page, [1]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 1 / 3');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await page.waitForFunction(() => /失败 1 个/u.test(document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent || ''));
    assert.equal(desktop.uploads.length, beforeUploads + 1,
      'an unavailable MP4 and HLS candidate must not upload the selected video poster as video');
    assert(source.requests.some((request) => request.path === `/pin/${unavailablePin.id}/` && request.status === 200),
      'the unavailable video must resolve against its own selected Pin detail');
    assert(source.requests.some((request) => request.path === new URL(unavailablePin.mp4Url).pathname && request.status === 404),
      'the selected Pin MP4 must be attempted before fallback');
    assert.equal(source.requests.some((request) => request.path === new URL(unavailablePin.wrongSlotMp4Url).pathname), false,
      'unavailable slot 0 must not fall through to the different video in slot 2');
    assert(!desktop.uploads.slice(beforeUploads).some((upload) => upload.body.equals(posterBytes)),
      'none of the video posters may be uploaded as media');

    await selectBatchCards(page, [2]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 1 / 3');
    await page.evaluate(() => {
      document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
        ?.querySelector('[data-action="hd"]')?.click();
    });
    assert.equal(await page.locator('[data-serpent-ui="batch"]').evaluate((host) => (
      host.shadowRoot?.querySelector('[data-action="hd"]')?.getAttribute('aria-pressed')
    )), 'false', 'turning off original selection must set the real batch switch to off');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await page.waitForFunction(() => /失败 1 个/u.test(document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent || ''));
    assert.equal(desktop.uploads.length, beforeUploads + 1,
      'with original preference off, an un-fetchable MediaSource preview must not upload a poster or MP4 candidate');
    assert.equal(source.requests.some((request) => request.path === `/pin/${originalOffPin.id}/`), false,
      'original preference off must not fetch the Pin detail page');
    assert.equal(source.requests.some((request) => request.path === new URL(originalOffPin.mp4Url).pathname), false,
      'original preference off must not secretly download a high-resolution video candidate');
    assert.equal(source.requests.some((request) => request.path === new URL(originalOffPin.hlsUrl).pathname), false,
      'original preference off must not secretly download an HLS candidate');
    console.log('PASS Pinterest blob video batch resolves only the selected Pin/slot MP4, rejects cover fallback, and honors original-off');
  } finally {
    await page.close();
  }
}

async function runBatchArtStationCase({ context, source, desktop }) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const inactivePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  const port = new URL(source.origin).port;
  const pageUrl = `http://www.artstation.com:${port}/artwork/fixture-project`;
  const cdn = `http://cdnb.artstation.com:${port}`;
  const assets = [
    { ids: '123/456/789/20260102030405', size: 'small_square', file: 'fixture-small.jpg', token: 'small', success: '8k' },
    { ids: '124/456/790/20260102030405', size: 'smaller_square', file: 'fixture-smaller.jpg', token: 'smaller', success: '4k' },
    { ids: '125/456/791', size: 'large', file: 'fixture-large.jpg', token: 'large', success: '4k' },
    { ids: '126/456/792/20260102030405', size: 'large', file: 'fixture-fallback.jpg', token: 'fallback', success: null },
  ].map((asset) => {
    const root = `/p/assets/images/images/${asset.ids}`;
    const previewUrl = `${cdn}${root}/${asset.size}/${asset.file}?cache=${asset.token}`;
    const candidates = ['8k', '4k', 'large'].map((variant) => ({
      variant,
      url: `${cdn}${root}/${variant}/${asset.file}?cache=${asset.token}`,
    }));
    source.media.set(`${root}/${asset.size}/${asset.file}?cache=${asset.token}`, {
      status: 200,
      contentType: 'image/png',
      body: inactivePng,
    });
    for (const candidate of candidates) {
      if (candidate.url === previewUrl) continue;
      if (candidate.variant === asset.success) {
        source.media.set(`${root}/${candidate.variant}/${asset.file}?cache=${asset.token}`, {
          status: 200,
          contentType: 'image/png',
          body: activePng,
        });
      } else {
        source.media.set(`${root}/${candidate.variant}/${asset.file}?cache=${asset.token}`, {
          status: 404,
          contentType: 'text/plain; charset=utf-8',
          body: 'rendition unavailable',
        });
      }
    }
    return { ...asset, root, previewUrl, candidates };
  });

  const pageMarkup = assets.map((asset) => {
    const at = (variant) => `${cdn}${asset.root}/${variant}/${asset.file}?cache=${asset.token}`;
    return `<a href="/artwork/fixture-project"><picture>
      <source media="(min-width: 1500px)" srcset="${at('large')} 1200w">
      <source media="(min-width: 1400px)" srcset="${at('medium')} 768w">
      <source media="(min-width: 1300px)" srcset="${at('small')} 640w">
      <img alt="ArtStation fixture" src="${asset.previewUrl}">
    </picture></a>`;
  }).join('');
  source.pages.set('/artwork/fixture-project', `<!doctype html>
    <meta charset="utf-8"><title>ArtStation selected asset fixture</title>
    <style>body{margin:24px}img{width:180px;height:120px;object-fit:cover}</style>
    <main>${pageMarkup}</main>`);

  await writeSyncStorage(context, { preferOriginalMedia: true });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(pageUrl);
    await page.waitForFunction(() => [...document.images].length === 4
      && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'ArtStation fixture tab must be visible to the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-serpent-ui="batch"]');
      return host?.shadowRoot?.querySelectorAll('.card').length === 4;
    });
    await selectBatchCards(page, [0, 1, 2, 3]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 4 / 4');
    await page.evaluate(() => {
      document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
        ?.querySelector('[data-action="save"]')?.click();
    });
    await waitFor(() => desktop.uploads.length === beforeUploads + 4, 'four ArtStation batch image uploads');
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent
      === '保存 3 个原图或较高质量版本、1 个当前预览');

    const uploads = desktop.uploads.slice(beforeUploads);
    const savedUrls = uploads.map((upload) => decodeURIComponent(upload.headers['x-serpent-media-url']));
    assert.equal(savedUrls.includes(assets[0]?.candidates.find((candidate) => candidate.variant === '8k')?.url), true,
      'small_square must save its same-asset 8k rendition');
    assert.equal(savedUrls.includes(assets[1]?.candidates.find((candidate) => candidate.variant === '4k')?.url), true,
      'smaller_square must try 8k then save the available same-asset 4k rendition');
    assert.equal(savedUrls.includes(assets[2]?.candidates.find((candidate) => candidate.variant === '4k')?.url), true,
      'an image already displayed at large must still save the available same-asset 4k rendition');
    assert.equal(savedUrls.includes(assets[3]?.previewUrl), true,
      'when all higher renditions fail, batch must save the exact displayed preview');
    assert(source.requests.some((request) => request.path === `${assets[1]?.root}/8k/${assets[1]?.file}` && request.status === 404));
    assert(source.requests.every((request) => !request.path.includes('/original/')),
      'the batch must not probe an unverified original path');
    console.log('PASS ArtStation batch keeps exact asset paths, tries 8k→4k→large, and reports candidate/preview results');
  } finally {
    await page.close();
  }
}

async function preparePinterestImageBatch({
  context,
  source,
  count,
  delayMs = 0,
  fallbackIndex = -1,
  stem,
  previewUrlForIndex,
  originalUrlForIndex,
  originalBodyForIndex,
}) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const inactivePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  const port = new URL(source.origin).port;
  const pageUrl = `http://pinterest.ca:${port}/pin/${stem}`;
  const pinimg = `http://i.pinimg.com:${port}`;
  const items = Array.from({ length: count }, (_, index) => {
    const id = (810000000000000000n + BigInt(index)
      + (stem === 'batch-parallel-global-error' ? 100n : 0n)).toString();
    const token = `${stem}-${String(index).padStart(2, '0')}`;
    return {
      id,
      token,
      previewUrl: previewUrlForIndex?.(index, { id, token, pinimg, stem })
        ?? `${pinimg}/236x/${token}.png`,
      originalUrl: originalUrlForIndex?.(index, { id, token, pinimg, stem })
        ?? `${pinimg}/originals/${token}.png`,
    };
  });

  for (const [index, item] of items.entries()) {
    const itemDelayMs = typeof delayMs === 'function' ? delayMs(index) : delayMs;
    source.pages.set(`/pin/${item.id}/`, {
      body: makePinterestImagePinDetailPage(item),
      delayMs: itemDelayMs,
    });
    source.media.set(new URL(item.previewUrl).pathname, {
      status: 200,
      contentType: 'image/png',
      body: inactivePng,
    });
    source.media.set(new URL(item.originalUrl).pathname, {
      status: index === fallbackIndex ? 404 : 200,
      contentType: 'image/png',
      body: index === fallbackIndex
        ? Buffer.from('fixture original unavailable')
        : originalBodyForIndex?.(index, { item, activePng, inactivePng }) ?? activePng,
      delayMs: itemDelayMs,
    });
  }
  source.pages.set(`/pin/${stem}`, makePinterestImageFeedPage(items));
  await writeSyncStorage(context, { preferOriginalMedia: true });

  const page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(pageUrl);
  await page.waitForFunction((expectedCount) => [...document.images].length === expectedCount
    && [...document.images].every((image) => image.complete && image.naturalWidth > 0), count);
  const worker = await extensionWorker(context);
  const tabId = await worker.evaluate(async (targetUrl) => {
    const tabs = await globalThis.chrome.tabs.query({});
    return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
  }, pageUrl);
  assert.equal(typeof tabId, 'number', 'Pinterest image batch fixture tab must be visible to the extension background');
  await worker.evaluate(async (selectedTabId) => {
    await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
  }, tabId);
  await page.waitForFunction((expectedCount) => document.querySelector('[data-serpent-ui="batch"]')
    ?.shadowRoot?.querySelectorAll('.card').length === expectedCount, count);
  await selectBatchCards(page, items.map((_, index) => index));
  await page.waitForFunction((expectedCount) => document.querySelector('[data-serpent-ui="batch"]')
    ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === `已选 ${expectedCount} / ${expectedCount}`, count);

  return { activePng, inactivePng, items, page, pageUrl };
}

async function getBatchPanelStatus(page) {
  return page.locator('[data-serpent-ui="batch"]').evaluate((host) => {
    const shadow = host.shadowRoot;
    return {
      status: shadow?.querySelector('[data-field="status"]')?.textContent?.trim() || '',
      progress: shadow?.querySelector('[data-field="progress"]')?.getAttribute('aria-valuenow') || null,
      action: shadow?.querySelector('[data-action="save"], [data-action="stop"]')?.getAttribute('data-action') || null,
    };
  });
}

function assertZeroFailedOrSkipped(status, label) {
  for (const [name, pattern] of [
    ['failed', /失败\s*(\d+)\s*个?/u],
    ['unexecuted', /未执行\s*(\d+)\s*个?/u],
    ['skipped', /跳过\s*(\d+)\s*个?/u],
  ]) {
    const match = pattern.exec(status);
    if (match) assert.equal(Number(match[1]), 0, `${label}: ${name} count must be zero in terminal status ${JSON.stringify(status)}`);
  }
  assert(!/失败\s*[1-9]/u.test(status), `${label}: no batch item should fail`);
  assert(!/未执行\s*[1-9]/u.test(status), `${label}: no batch item should remain unexecuted`);
  assert(!/跳过\s*[1-9]/u.test(status), `${label}: no batch item should be skipped`);
}

async function waitForBatchTerminal(page, previousStatus, description) {
  await page.waitForFunction((priorStatus) => {
    const shadow = document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot;
    const status = shadow?.querySelector('[data-field="status"]')?.textContent?.trim() || '';
    const button = shadow?.querySelector('[data-action="save"]');
    return button?.dataset.action === 'save' && status.length > 0 && status !== priorStatus;
  }, previousStatus, { timeout: 60_000 });
  const state = await getBatchPanelStatus(page);
  assert(state.status, `${description}: terminal status must be populated`);
  return state;
}

async function savePinterestBatch({ desktop, fixture, expectedUploads, heldUploadGates = null }) {
  const { page } = fixture;
  const beforeUploads = desktop.uploads.length;
  const initialStatus = (await getBatchPanelStatus(page)).status;
  await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
    ?.querySelector('[data-action="save"]')?.click());

  if (heldUploadGates) {
    await waitFor(() => desktop.uploads.length === beforeUploads + 1, 'first upload held by the fixture receiver');
    assert.equal(desktop.activeUploads, 1, 'the first receiver request must remain held at the write gate');
    const firstPending = await getBatchPanelStatus(page);
    await heldUploadGates.captureFirst(firstPending);
    heldUploadGates.releaseFirst();
    await waitFor(() => desktop.uploads.length === beforeUploads + 2, 'second upload held by the fixture receiver');
    assert.equal(desktop.activeUploads, 1, 'the second upload must wait for the first serialized write');
    const secondPending = await getBatchPanelStatus(page);
    await heldUploadGates.captureSecond(secondPending);
    heldUploadGates.releaseSecond();
  }

  await waitFor(() => desktop.uploads.length === beforeUploads + expectedUploads,
    `${expectedUploads} Pinterest batch uploads`, 60_000);
  const terminal = await waitForBatchTerminal(page, initialStatus, 'Pinterest batch save');
  return { beforeUploads, terminal };
}

async function assertPinterestBatchResults({ desktop, source, fixture, beforeUploads, sourceRequestStart = 0, label }) {
  const { activePng, inactivePng, items, fallbackIndex } = fixture;
  const uploads = desktop.uploads.slice(beforeUploads);
  assert.equal(uploads.length, items.length, `${label}: every selected pin must upload once`);
  const savedUrls = uploads.map((upload) => decodeURIComponent(upload.headers['x-serpent-media-url']));
  assert.equal(new Set(savedUrls).size, items.length, `${label}: uploaded media URLs must be unique`);
  const expectedUrls = items.map((item, index) => index === fixture.fallbackIndex ? item.previewUrl : item.originalUrl);
  assert.deepEqual(savedUrls, expectedUrls,
    `${label}: serialized commits must preserve selected-item order when later sources settle first`);

  const runRequests = source.requests.slice(sourceRequestStart);
  const details = runRequests.filter((request) => /^\/pin\/\d+\/$/u.test(request.path));
  assert.equal(details.length, items.length, `${label}: every selected image must resolve its Pin detail JSON exactly once`);
  for (const item of items) {
    const detailRequests = details.filter((request) => request.path === `/pin/${item.id}/`);
    assert.equal(detailRequests.length, 1, `${label}: Pin ${item.id} detail must be requested once`);
    assert.equal(detailRequests[0]?.status, 200, `${label}: Pin ${item.id} detail JSON must resolve`);
    const originalRequests = runRequests.filter((request) => request.path === new URL(item.originalUrl).pathname);
    assert.equal(originalRequests.length, 1, `${label}: Pin ${item.id} original must be attempted once`);
    assert.equal(originalRequests[0]?.status, item === items[fallbackIndex] ? 404 : 200,
      `${label}: Pin ${item.id} original status must match its fixture outcome`);
    const expectedUrl = item === items[fallbackIndex] ? item.previewUrl : item.originalUrl;
    const matchingUploads = uploads.filter((upload) => decodeURIComponent(upload.headers['x-serpent-media-url']) === expectedUrl);
    assert.equal(matchingUploads.length, 1, `${label}: Pin ${item.id} must upload the correct original or preview fallback`);
    assert.deepEqual(matchingUploads[0]?.body, item === items[fallbackIndex] ? inactivePng : activePng,
      `${label}: Pin ${item.id} must upload the bytes matching its selected rendition`);
  }
}

async function runBatchDedupCase({ context, source, desktop }) {
  const port = new URL(source.origin).port;
  const pinimg = `http://i.pinimg.com:${port}`;
  const previewUrls = [
    `${pinimg}/236x/first/shared-name.png`,
    `${pinimg}/236x/duplicate/other-name.png`,
    `${pinimg}/236x/second-folder/shared-name.png`,
  ];
  const originalUrls = [
    `${pinimg}/originals/first/shared-name.png`,
    `${pinimg}/originals/duplicate/other-name.png`,
    `${pinimg}/originals/second-folder/shared-name.png`,
  ];
  const fixture = await preparePinterestImageBatch({
    context,
    source,
    count: 3,
    stem: 'batch-dedup',
    previewUrlForIndex: (index) => previewUrls[index],
    originalUrlForIndex: (index) => originalUrls[index],
    originalBodyForIndex: (index, { activePng, inactivePng }) => index === 2 ? inactivePng : activePng,
  });
  const [newContent, sameContent, sameNameDifferentBytes] = fixture.items;
  assert(newContent && sameContent && sameNameDifferentBytes, 'dedup fixture must contain three pins');

  const bodies = [fixture.activePng, fixture.activePng, fixture.inactivePng];
  assert.equal(createHash('sha256').update(bodies[0]).digest('hex'),
    createHash('sha256').update(bodies[1]).digest('hex'),
    'the first two fixture images must have identical bytes');
  assert.notEqual(createHash('sha256').update(bodies[0]).digest('hex'),
    createHash('sha256').update(bodies[2]).digest('hex'),
    'same-name fixture images must have different bytes');
  assert.equal(path.basename(new URL(originalUrls[0]).pathname), path.basename(new URL(originalUrls[2]).pathname),
    'different-byte images must exercise an identical filename');

  const knownHashes = new Set();
  const receiverDecisions = [];
  desktop.setUploadBehavior(async (upload) => {
    const digest = createHash('sha256').update(upload.body).digest('hex');
    const duplicate = knownHashes.has(digest);
    knownHashes.add(digest);
    receiverDecisions.push({ digest, duplicate, sequence: upload.sequence });
    return {
      status: 202,
      body: { status: 'accepted', ...(duplicate ? { duplicate: true } : {}) },
    };
  });

  const progressCaptureStart = async () => fixture.page.evaluate(() => {
    const track = globalThis.document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="progress"]');
    if (!track) throw new Error('batch progress track is missing');
    globalThis.__serpentDedupProgressSamples = [track.getAttribute('aria-valuenow')];
    globalThis.__serpentDedupProgressObserver = new globalThis.MutationObserver(() => {
      globalThis.__serpentDedupProgressSamples.push(track.getAttribute('aria-valuenow'));
    });
    globalThis.__serpentDedupProgressObserver.observe(track, {
      attributes: true,
      attributeFilter: ['aria-valuenow'],
    });
  });
  const progressCaptureStop = async () => fixture.page.evaluate(() => {
    globalThis.__serpentDedupProgressObserver?.disconnect();
    const samples = globalThis.__serpentDedupProgressSamples ?? [];
    delete globalThis.__serpentDedupProgressObserver;
    delete globalThis.__serpentDedupProgressSamples;
    return samples;
  });
  const assertRoundRequests = (requests, label) => {
    for (const originalUrl of originalUrls) {
      const matching = requests.filter((request) => request.path === new URL(originalUrl).pathname);
      assert.equal(matching.length, 1, `${label}: each original URL must be fetched exactly once`);
      assert.equal(matching[0]?.status, 200, `${label}: each original URL must resolve successfully`);
    }
    assert(!requests.some((request) => fixture.items.some((item) => request.path === new URL(item.previewUrl).pathname)),
      `${label}: saving originals must not re-fetch preview images`);
  };

  const beforeUploads = desktop.uploads.length;
  let previousStatus = (await getBatchPanelStatus(fixture.page)).status;
  const firstRequestStart = source.requests.length;
  await progressCaptureStart();
  await fixture.page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
    ?.querySelector('[data-action="save"]')?.click());
  await waitFor(() => desktop.uploads.length === beforeUploads + 3, 'first dedup batch uploads');
  const firstTerminal = await waitForBatchTerminal(fixture.page, previousStatus, 'first dedup batch');
  const firstProgress = await progressCaptureStop();
  assert.match(firstTerminal.status, /已保存\s*2\s*个文件/u,
    `the first batch must count the new A and same-name/different-byte B as saved; receiver decisions: ${JSON.stringify(receiverDecisions.slice(0, 3))}`);
  assert.match(firstTerminal.status, /已跳过重复\s*1\s*个/u,
    'the first batch must report the second URL with A bytes as one duplicate');
  assertZeroFailedOrSkipped(firstTerminal.status, 'first dedup batch');
  assert(firstProgress.includes('100'),
    `the first batch must settle every accepted and duplicate item to 100%, observed ${firstProgress.join(',')}`);
  assert.deepEqual(receiverDecisions.slice(0, 3).map(({ duplicate }) => duplicate), [false, true, false],
    'the receiver SHA-256 map must accept A, deduplicate its alternate URL, and accept B with the same filename but different bytes');
  assert.equal(desktop.uploads.length, beforeUploads + 3,
    'each first-round source item must reach the receiver exactly once without retries');
  assertRoundRequests(source.requests.slice(firstRequestStart), 'first dedup batch');
  for (const [index, upload] of desktop.uploads.slice(beforeUploads, beforeUploads + 3).entries()) {
    assert.equal(decodeURIComponent(upload.headers['x-serpent-media-url']), originalUrls[index],
      `first dedup batch upload ${index + 1} must preserve its selected original URL`);
    assert.deepEqual(upload.body, bodies[index],
      `first dedup batch upload ${index + 1} must preserve the original bytes`);
  }

  const saveButton = fixture.page.locator('[data-serpent-ui="batch"] [data-action="save"]');
  await saveButton.waitFor({ state: 'visible' });
  assert.equal(await saveButton.isEnabled(), true, 'the batch save control must reset after duplicate responses');
  previousStatus = firstTerminal.status;
  const secondRequestStart = source.requests.length;
  await progressCaptureStart();
  await fixture.page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
    ?.querySelector('[data-action="save"]')?.click());
  await waitFor(() => desktop.uploads.length === beforeUploads + 6, 'second dedup batch uploads');
  const secondTerminal = await waitForBatchTerminal(fixture.page, previousStatus, 'second dedup batch');
  const secondProgress = await progressCaptureStop();
  assert.match(secondTerminal.status, /已保存\s*0\s*个文件/u,
    'the second batch must save no bytes that the receiver already knows');
  assert.match(secondTerminal.status, /已跳过重复\s*3\s*个/u,
    'the second batch must report all three known images as duplicates');
  assertZeroFailedOrSkipped(secondTerminal.status, 'second dedup batch');
  assert(secondProgress.includes('100'),
    `the second batch must settle all duplicate items to 100%, observed ${secondProgress.join(',')}`);
  assert.deepEqual(receiverDecisions.slice(3).map(({ duplicate }) => duplicate), [true, true, true],
    'all three second-round responses must be duplicate accepted responses');
  assert.equal(desktop.uploads.length, beforeUploads + 6,
    'each second-round source item must reach the receiver exactly once without retries');
  assertRoundRequests(source.requests.slice(secondRequestStart), 'second dedup batch');
  await saveButton.waitFor({ state: 'visible' });
  assert.equal(await saveButton.isEnabled(), true, 'the batch save control must reset after an all-duplicate batch');
  assert.equal(desktop.peakUploads, 1, 'the fixture receiver must continue validating serialized upload writes');
  console.log('PASS batch receiver deduplicates identical bytes across URL and filename while accepting same-name different bytes');
}

async function runBatchParallelCase({ context, source, desktop }) {
  const fixture = await preparePinterestImageBatch({
    context,
    source,
    count: 12,
    delayMs: (index) => index === 10 ? 150 : (index === 11 ? 100 : 120),
    fallbackIndex: 5,
    stem: 'batch-parallel',
  });
  fixture.fallbackIndex = 5;
  const beforeUploads = desktop.uploads.length;
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  desktop.setUploadBehavior(async (upload) => {
    if (upload.sequence === beforeUploads) await firstGate;
    else if (upload.sequence === beforeUploads + 1) await secondGate;
    else await new Promise((resolve) => setTimeout(resolve, 35));
    return { status: 202, body: { accepted: true } };
  });

  try {
    const progressSamples = [];
    const result = await savePinterestBatch({
      desktop,
      fixture,
      expectedUploads: 12,
      heldUploadGates: {
        captureFirst(state) {
          progressSamples.push(state.progress);
          assert.notEqual(state.progress, '100', 'while the first receiver gate is held, unsettled work must not appear complete');
        },
        async captureSecond(state) {
          await fixture.page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
            ?.shadowRoot?.querySelector('[data-field="progress"]')?.getAttribute('aria-valuenow') === '8',
          undefined, { timeout: 5_000 });
          const settledState = await getBatchPanelStatus(fixture.page);
          state = settledState;
          progressSamples.push(state.progress);
          assert.equal(state.progress, '8', 'after one of twelve items settles, batch progress must be 1/12');
        },
        releaseFirst() { releaseFirst(); },
        releaseSecond() { releaseSecond(); },
      },
    });
    await assertPinterestBatchResults({ desktop, source, fixture, beforeUploads, label: 'batch-parallel' });
    assert.match(result.terminal.status, /保存\s*11\s*个原图或较高质量版本、\s*1\s*个当前预览/u,
      'the 404 original must appear as one successful exact-preview fallback');
    assertZeroFailedOrSkipped(result.terminal.status, 'batch-parallel');
    assert.equal(source.peakDetailAndMedia <= 3, true,
      `Pinterest detail/original request peak must stay at or below three, observed ${source.peakDetailAndMedia}`);
    assert.equal(source.peakDetailAndMedia >= 2, true,
      `Pinterest detail/original requests must overlap, observed peak ${source.peakDetailAndMedia}`);
    assert.equal(desktop.peakUploads, 1, `fixture receiver writes must remain serial, observed peak ${desktop.peakUploads}`);
    console.log(`BATCH_PARALLEL_RESULT ${JSON.stringify({
      mode: 'focused',
      detailPeak: source.peakPinDetails,
      originalPeak: source.peakOriginalMedia,
      detailAndOriginalPeak: source.peakDetailAndMedia,
      uploadPeak: desktop.peakUploads,
      progressSamples,
      terminalStatus: result.terminal.status,
    })}`);
    console.log('PASS Pinterest batch runs three overlapping original-media resolutions with one serialized upload writer and exact fallback/progress stats');
  } finally {
    releaseFirst();
    releaseSecond();
    await fixture.page.close();
  }
}

async function runBatchParallelGlobalErrorCase({ context, source, desktop }) {
  const fixture = await preparePinterestImageBatch({
    context,
    source,
    count: 4,
    delayMs: 100,
    stem: 'batch-parallel-global-error',
  });
  fixture.fallbackIndex = -1;
  const beforeUploads = desktop.uploads.length;
  desktop.setUploadBehavior(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { status: 409, body: { reason: 'target changed' } };
  });
  const initialStatus = (await getBatchPanelStatus(fixture.page)).status;
  try {
    await fixture.page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 1, 'first write rejected by the fixture receiver');
    assert.equal(desktop.activeUploads, 1, 'the rejected receiver write must remain held while other items resolve');
    await waitForBatchTerminal(fixture.page, initialStatus, 'global receiver rejection');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const terminal = await getBatchPanelStatus(fixture.page);
    assert.equal(desktop.uploads.length, beforeUploads + 1,
      'after a global receiver rejection, no ready or newly fetched item may start another upload');
    assert.match(terminal.status, /失败\s*1\s*个/u, 'global rejection must count its in-flight write as one failed item');
    assert.match(terminal.status, /HTTP\s*409/u, 'global rejection terminal status must preserve the receiver HTTP error');
    assert.match(terminal.status, /target changed/u, 'global rejection terminal status must preserve the receiver reason');
    assert.match(terminal.status, /未执行\s*3\s*个/u, 'the three undispatched images must be counted as unexecuted');
    assert.equal(terminal.progress, '25',
      `one rejected item out of four must settle to 25%, leaving the three unexecuted items outside progress (got ${terminal.progress})`);
    assert.equal(source.peakDetailAndMedia <= 3, true,
      `global-error request concurrency must stay at or below three, observed ${source.peakDetailAndMedia}`);
    assert.equal(desktop.peakUploads, 1, `global-error receiver upload peak must remain one, observed ${desktop.peakUploads}`);
    console.log(`BATCH_PARALLEL_RESULT ${JSON.stringify({
      mode: 'global-error',
      detailPeak: source.peakPinDetails,
      originalPeak: source.peakOriginalMedia,
      detailAndOriginalPeak: source.peakDetailAndMedia,
      uploadPeak: desktop.peakUploads,
      terminalStatus: terminal.status,
      uploadAttempts: desktop.uploads.length - beforeUploads,
    })}`);
    console.log('PASS global receiver rejection closes scheduling and prevents later uploads');
  } finally {
    await fixture.page.close();
  }
}

async function runBatchParallelBenchmarkCase({ context, source, desktop }) {
  const fixture = await preparePinterestImageBatch({
    context,
    source,
    count: 12,
    delayMs: (index) => index === 10 ? 150 : (index === 11 ? 100 : 120),
    fallbackIndex: 5,
    stem: 'batch-parallel-benchmark',
  });
  fixture.fallbackIndex = 5;
  desktop.setUploadBehavior(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    return { status: 202, body: { accepted: true } };
  });

  const samplesMs = [];
  const measuredStatuses = [];
  for (let iteration = 0; iteration < 4; iteration += 1) {
    if (iteration > 0) {
      await selectBatchCards(fixture.page, fixture.items.map((_, index) => index));
      await fixture.page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
        ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 12 / 12');
    }
    const beforeUploads = desktop.uploads.length;
    const sourceRequestStart = source.requests.length;
    const initialStatus = (await getBatchPanelStatus(fixture.page)).status;
    const startedAt = performance.now();
    await fixture.page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 12, `benchmark iteration ${iteration + 1} uploads`, 60_000);
    const terminal = await waitForBatchTerminal(fixture.page, initialStatus, `benchmark iteration ${iteration + 1}`);
    const elapsedMs = performance.now() - startedAt;
    assert.match(terminal.status, /保存\s*11\s*个原图或较高质量版本、\s*1\s*个当前预览/u,
      `benchmark iteration ${iteration + 1} must keep fallback successful`);
    assertZeroFailedOrSkipped(terminal.status, `benchmark iteration ${iteration + 1}`);
    if (iteration > 0) {
      samplesMs.push(Number(elapsedMs.toFixed(1)));
      measuredStatuses.push(terminal.status);
    }
    await assertPinterestBatchResults({
      desktop,
      source,
      fixture,
      beforeUploads,
      sourceRequestStart,
      label: `batch-parallel-benchmark iteration ${iteration + 1}`,
    });
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const medianMs = sorted[1];
  const expected = process.env.SERPENT_BATCH_PARALLEL_EXPECT || 'parallel';
  assert.equal(source.peakDetailAndMedia <= 3, true,
    `benchmark detail/original request peak must stay at or below three, observed ${source.peakDetailAndMedia}`);
  assert.equal(desktop.peakUploads, 1,
    `benchmark receiver writes must remain serial, observed peak ${desktop.peakUploads}`);
  if (expected === 'parallel') {
    assert.equal(source.peakDetailAndMedia >= 2, true,
      `parallel build must overlap requests, observed peak ${source.peakDetailAndMedia}`);
  } else {
    assert.equal(expected, 'baseline', `unknown SERPENT_BATCH_PARALLEL_EXPECT value: ${expected}`);
  }
  console.log(`BATCH_PARALLEL_BENCHMARK ${JSON.stringify({
    expected,
    measuredIterations: samplesMs.length,
    samplesMs,
    medianMs,
    detailPeak: source.peakPinDetails,
    originalPeak: source.peakOriginalMedia,
    detailAndOriginalPeak: source.peakDetailAndMedia,
    uploadPeak: desktop.peakUploads,
    fallback: '1 of 12 used preview successfully',
    terminalStatuses: measuredStatuses,
  })}`);
  console.log(`PASS ${expected} batch benchmark completed one warmup and three measured 12-item runs`);
  await fixture.page.close();
}

async function runBatchStopCase({ context, source, desktop }) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const inactivePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-inactive.png'));
  const port = new URL(source.origin).port;
  const pageUrl = `http://pinterest.ca:${port}/pin/batch-stop`;
  const pinimg = `http://i.pinimg.com:${port}`;
  const items = [0, 1, 2, 3, 4, 5].map((index) => ({
    previewUrl: `${pinimg}/236x/batch-stop-${index}.png`,
    originalUrl: `${pinimg}/originals/batch-stop-${index}.png`,
  }));

  for (const [index, item] of items.entries()) {
    source.media.set(new URL(item.previewUrl).pathname, {
      status: 200,
      contentType: 'image/png',
      body: inactivePng,
    });
    source.media.set(new URL(item.originalUrl).pathname, {
      status: 200,
      contentType: 'image/png',
      body: activePng,
      ...(index < 3 ? { gate: new Promise((resolve) => { item.release = resolve; }) } : {}),
    });
  }

  const firstPinState = {
    initialReduxState: {
      pins: {
        '100000000000000001': {
          entityId: '100000000000000001',
          images: {
            orig: { url: items[0]?.originalUrl },
            '236x': { url: items[0]?.previewUrl },
          },
        },
      },
    },
  };
  source.pages.set('/pin/batch-stop', `<!doctype html>
    <meta charset="utf-8"><title>Pinterest batch stop fixture</title>
    <style>body{margin:24px}main{display:flex;gap:12px}img{width:240px;height:240px;object-fit:cover}</style>
    <script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(firstPinState)}</script>
    <main>${items.map(({ previewUrl }, index) => `<img src="${previewUrl}" alt="pin ${index + 1}">`).join('')}</main>`);

  await writeSyncStorage(context, { preferOriginalMedia: true });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  let releasedStartedOriginals = false;
  const releaseStartedOriginals = () => {
    if (releasedStartedOriginals) return;
    releasedStartedOriginals = true;
    for (const item of items.slice(0, 3)) item.release?.();
  };
  try {
    await page.setViewportSize({ width: 900, height: 650 });
    await page.goto(pageUrl);
    await page.waitForFunction(() => [...document.images].length === 6
      && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const worker = await extensionWorker(context);
    await worker.evaluate(() => {
      globalThis.__serpentBatchStopRequestSeen = false;
      globalThis.chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'serpent-stop-batch') globalThis.__serpentBatchStopRequestSeen = true;
      });
    });
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'Pinterest stop fixture tab must be visible to extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 6);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 6 / 6');

    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(
      () => items.slice(0, 3).every((item) => source.requests.some((request) => (
        request.path === new URL(item.originalUrl).pathname && request.status === undefined
      ))),
      'three already-started Pinterest original requests to pause at the source fixture',
    );

    // Page and panel thumbnails load /236x previews; only /originals requests
    // below represent downloads initiated by the batch save job.
    const stopButton = page.locator('[data-serpent-ui="batch"] [data-action="stop"]');
    await stopButton.waitFor({ state: 'visible' });
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="stop"]')?.click());
    await page.waitForFunction(() => {
      const shadow = document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot;
      const button = shadow?.querySelector('[data-action="stop"]');
      return button?.disabled === true
        && shadow?.querySelector('[data-field="status"]')?.textContent === '正在停止，已开始的任务完成后停止';
    });
    const stoppingProgress = await page.locator('[data-serpent-ui="batch"]').evaluate((host) => {
      const track = host.shadowRoot?.querySelector('[data-field="progress"]');
      return track?.getAttribute('aria-valuenow');
    });
    assert.notEqual(stoppingProgress, '100', 'stop request must not mark an incomplete batch as 100%');
    // Give the extension service worker time to handle the stop message while
    // the three started source requests remain held open.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      await worker.evaluate(() => globalThis.__serpentBatchStopRequestSeen),
      true,
      'the real stop button must deliver its stop request to the extension background',
    );
    assert.equal(
      source.requests.filter((request) => request.path.startsWith('/originals/batch-stop-')).length,
      3,
      'stop must keep the three started originals pending and dispatch no fourth item',
    );

    releaseStartedOriginals();
    await waitFor(() => desktop.uploads.length === beforeUploads + 3, 'all three started batch uploads after stop');
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent.includes('已停止'));
    assert.equal(desktop.uploads.length, beforeUploads + 3,
      'stop must allow all three already-started items to finish and upload exactly once');
    const stoppedStatus = await page.locator('[data-serpent-ui="batch"]').evaluate((host) => (
      host.shadowRoot?.querySelector('[data-field="status"]')?.textContent || ''
    ));
    assert.match(stoppedStatus, /(?:已保存|已发送|成功)\s*3\s*(?:个|项)/u,
      'stopped terminal stats must report three successful in-flight items');
    assert.match(stoppedStatus, /未执行\s*3\s*(?:个|项)/u,
      'stopped terminal stats must report the three never-started items');
    assert(!/失败\s*[1-9]/u.test(stoppedStatus), 'the three skipped items must not be reported as failures');
    assert.equal(source.requests.filter((request) => request.path === '/originals/batch-stop-3.png').length, 0);
    assert.equal(source.requests.filter((request) => request.path === '/originals/batch-stop-4.png').length, 0);
    assert.equal(source.requests.filter((request) => request.path === '/originals/batch-stop-5.png').length, 0);
    const stoppedProgress = await page.locator('[data-serpent-ui="batch"]').evaluate((host) => (
      Number(host.shadowRoot?.querySelector('[data-field="progress"]')?.getAttribute('aria-valuenow'))
    ));
    assert(stoppedProgress <= 50,
      `stopping with three of six items unstarted must not fill skipped work into progress, observed ${stoppedProgress}`);
    assert.equal(
      decodeURIComponent(desktop.uploads[beforeUploads]?.headers['x-serpent-media-url']),
      items[0]?.originalUrl,
      'the first in-flight item should finish with its selected Pinterest original',
    );

    const resetButton = page.locator('[data-serpent-ui="batch"] [data-action="save"]');
    await resetButton.waitFor({ state: 'visible' });
    assert.equal(await resetButton.isEnabled(), true, 'the batch save control must reset after stopping');
    await selectBatchCards(page, [3]);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 1 / 6');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await waitFor(() => desktop.uploads.length === beforeUploads + 4, 'one-item batch save after the stopped job');
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已发送 1 个文件');
    assert.equal(
      source.requests.filter((request) => request.path === '/originals/batch-stop-3.png').length,
      1,
      'a fresh one-item save must start after the stopped job was cleaned up',
    );
    assert.equal(desktop.uploads.length, beforeUploads + 4);
    assert.equal(
      decodeURIComponent(desktop.uploads[beforeUploads + 3]?.headers['x-serpent-media-url']),
      items[3]?.originalUrl,
    );
    console.log('PASS batch stop lets three started items finish, skips three later items, then accepts a fresh one-item save');
  } finally {
    releaseStartedOriginals();
    await page.close();
  }
}

async function runBatchContinueAfterFetchFailureCase({ context, source, desktop }) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const port = new URL(source.origin).port;
  const pageUrl = `http://pinterest.ca:${port}/pin/batch-continue-after-fetch-failure`;
  const pinimg = `http://i.pinimg.com:${port}`;
  const failingIndex = 37;
  const items = Array.from({ length: 75 }, (_, index) => {
    const stem = `batch-continue-${String(index).padStart(2, '0')}`;
    const prefix = `${String(index % 10)}/${String((index + 3) % 10)}/${String((index + 7) % 10)}`;
    const previewUrl = `${pinimg}/236x/${prefix}/${stem}.png`;
    const originalUrl = `${pinimg}/originals/${prefix}/${stem}.png`;
    if (index === failingIndex) {
      let previewRequestCount = 0;
      source.media.set(new URL(previewUrl).pathname, {
        status: () => {
          previewRequestCount += 1;
          return previewRequestCount === 1 ? 200 : 404;
        },
        contentType: 'image/png',
        body: activePng,
      });
    } else {
      source.media.set(new URL(previewUrl).pathname, {
        status: 200,
        contentType: 'image/png',
        body: activePng,
      });
      source.media.set(new URL(originalUrl).pathname, {
        status: 200,
        contentType: 'image/png',
        body: activePng,
      });
    }
    return { previewUrl, originalUrl };
  });
  source.pages.set('/pin/batch-continue-after-fetch-failure', `<!doctype html>
    <meta charset="utf-8"><title>Pinterest batch source failure fixture</title>
    <style>body{margin:24px}img{width:240px;height:240px;object-fit:cover}</style>
    <main>${items.map(({ previewUrl }, index) => `<img src="${previewUrl}" alt="pin ${index + 1}">`).join('')}</main>`);

  await writeSyncStorage(context, { preferOriginalMedia: true });
  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(pageUrl);
    await page.waitForFunction(() => [...document.images].length === 75
      && [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'Pinterest batch source failure tab must reach the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelectorAll('.card').length === 75);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 75 / 75');
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());

    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-action="save"]')?.dataset.action === 'save',
    undefined, { timeout: 60_000 });
    const status = await page.locator('[data-serpent-ui="batch"]').evaluate((host) => (
      host.shadowRoot?.querySelector('[data-field="status"]')?.textContent || ''
    ));
    assert.equal(status, '已发送 74 个文件，失败 1 个。下载失败：HTTP 404');
    assert.equal(desktop.uploads.length, beforeUploads + 74,
      'a single un-downloadable selected media item must not prevent the other 74 valid images from uploading');
    assert(source.requests.some((request) => request.path === new URL(items[failingIndex]?.originalUrl).pathname
      && request.status === 404), 'the failing image must exercise a source fetch failure');
    assert(source.requests.some((request) => request.path === new URL(items[failingIndex]?.previewUrl).pathname
      && request.status === 404), 'the failing image preview must also be unavailable');
    for (const [index, item] of items.entries()) {
      if (index === failingIndex) continue;
      assert(source.requests.some((request) => request.path === new URL(item.originalUrl).pathname
        && request.status === 200), `image ${index} must be fetched after or before the failed item`);
    }
    console.log('PASS batch continues all 74 valid Pinterest images after one unavailable item in the middle');
  } finally {
    await page.close();
  }
}

async function runBatchExtensionReloadCase({ context, source, desktop }) {
  const activePng = await readFile(path.join(extensionRoot, 'assets', 'icons', 'source-extension-active.png'));
  const port = new URL(source.origin).port;
  const pageUrl = `http://pinterest.ca:${port}/pin/batch-extension-reload`;
  const previewUrl = `http://i.pinimg.com:${port}/236x/batch-extension-reload.png`;
  source.media.set(new URL(previewUrl).pathname, {
    status: 200,
    contentType: 'image/png',
    body: activePng,
  });
  source.pages.set('/pin/batch-extension-reload', `<!doctype html>
    <meta charset="utf-8"><title>Pinterest batch reload fixture</title>
    <img src="${previewUrl}" alt="reload target" style="width:240px;height:240px">`);
  await writeSyncStorage(context, { preferOriginalMedia: false });

  const page = await context.newPage();
  const beforeUploads = desktop.uploads.length;
  try {
    await page.goto(pageUrl);
    await page.waitForFunction(() => document.images[0]?.complete && document.images[0]?.naturalWidth > 0);
    const worker = await extensionWorker(context);
    const tabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await globalThis.chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id ?? null;
    }, pageUrl);
    assert.equal(typeof tabId, 'number', 'reload fixture tab must reach the extension background');
    await worker.evaluate(async (selectedTabId) => {
      await globalThis.chrome.tabs.sendMessage(selectedTabId, { type: 'serpent-open-batch' });
    }, tabId);
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent === '已选 1 / 1');

    await worker.evaluate(() => {
      setTimeout(() => globalThis.chrome.runtime.reload(), 100);
      return true;
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-serpent-ui="batch"]')?.shadowRoot
      ?.querySelector('[data-action="save"]')?.click());
    await page.waitForFunction(() => document.querySelector('[data-serpent-ui="batch"]')
      ?.shadowRoot?.querySelector('[data-field="status"]')?.textContent
      ?.includes('扩展已重新加载，当前页面中的批量面板已失效。请刷新此页面后重试。'),
    undefined, { timeout: 10_000 });
    assert.equal(desktop.uploads.length, beforeUploads,
      'a stale panel after extension reload must show a page-reload instruction instead of uploading silently');
    console.log('PASS stale batch panel reports that the page must be refreshed after extension reload');
  } finally {
    await page.close();
  }
}

async function main() {
  const chromium = loadChromium();
  await assertBuiltExtension();
  const testMode = process.env.SERPENT_BROWSER_TESTS;
  const behanceFixtureMode = testMode === 'behance-original';
  const behanceLiveReplayMode = testMode === 'behance-live-replay';
  const behanceTaskMode = behanceFixtureMode || behanceLiveReplayMode;
  const testTempParent = behanceTaskMode
    ? path.join(extensionRoot, 'test-results', 'behance-current')
    : os.tmpdir();
  await mkdir(testTempParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(testTempParent, profilePrefix));
  const profileDir = path.join(temporaryRoot, 'profile');
  let desktop;
  let source;
  let fixtureExtensionDir;
  let context;
  const browserErrors = [];

  try {
    await mkdir(profileDir, { recursive: true });
    desktop = await startDesktopFixture();
    source = await startSourceFixture();
    fixtureExtensionDir = await createFixtureExtension(temporaryRoot, desktop.port);
    context = await chromium.launchPersistentContext(
      profileDir,
      browserLaunchOptions(fixtureExtensionDir, {
        behanceFixtureHosts: behanceFixtureMode,
        ...(behanceLiveReplayMode ? { proxyServer: 'http://127.0.0.1:10808' } : {}),
      }),
    );
    context.on('page', (page) => {
      page.on('pageerror', (error) => browserErrors.push(`${page.url()}: ${error.message}`));
    });

    await waitForDesktopConnection(context);
    if (testMode === 'blob-upload') {
      await runPageBlobUploadCase({ context, source, desktop });
    } else if (testMode === 'huaban-original') {
      await runHuabanOriginalCase({ context, source, desktop });
    } else if (testMode === 'behance-original') {
      await runBatchBehanceOriginalCase({ context, source, desktop });
    } else if (testMode === 'behance-live-replay') {
      await runBatchBehanceLiveReplayCase({ context, source, desktop, temporaryRoot });
    } else if (testMode === 'batch-pinterest') {
      await runBatchPinterestCase({ context, source, desktop });
    } else if (testMode === 'batch-dedup') {
      await runBatchDedupCase({ context, source, desktop });
    } else if (testMode === 'batch-parallel') {
      await runBatchParallelCase({ context, source, desktop });
    } else if (testMode === 'batch-parallel-global-error') {
      await runBatchParallelGlobalErrorCase({ context, source, desktop });
    } else if (testMode === 'batch-parallel-benchmark') {
      await runBatchParallelBenchmarkCase({ context, source, desktop });
    } else if (testMode === 'pinterest-video') {
      await runPinterestVideoCase({ context, source, desktop });
    } else if (testMode === 'artstation-batch') {
      await runBatchArtStationCase({ context, source, desktop });
    } else if (testMode === 'batch-stop') {
      await runBatchStopCase({ context, source, desktop });
    } else if (testMode === 'batch-continue-after-fetch-failure') {
      await runBatchContinueAfterFetchFailureCase({ context, source, desktop });
    } else if (testMode === 'batch-extension-reload') {
      await runBatchExtensionReloadCase({ context, source, desktop });
    } else {
      await runSmokeCases({ context, source, desktop });
    }

    if (browserErrors.length > 0) {
      assert.fail(`Browser page errors:\n${browserErrors.join('\n')}`);
    }
    console.log(`Captured ${desktop.uploads.length} upload(s) and ${source.requests.length} source request(s).`);
  } finally {
    await Promise.allSettled([
      context?.close(),
      source?.close(),
      desktop?.close(),
    ]);

    const resolvedTmp = path.resolve(testTempParent);
    const resolvedRoot = path.resolve(temporaryRoot);
    assert(
      path.dirname(resolvedRoot) === resolvedTmp
        && path.basename(resolvedRoot).startsWith(profilePrefix),
      'refusing to remove temporary test files outside their generated directory',
    );
    await rm(resolvedRoot, { recursive: true, force: true });
    if (behanceTaskMode) {
      const resolvedTaskDir = path.resolve(extensionRoot, 'test-results', 'behance-current');
      const resolvedCdnArtifacts = path.resolve(resolvedTaskDir, 'cdn-check');
      assert(
        path.dirname(resolvedCdnArtifacts) === resolvedTaskDir
          && path.basename(resolvedCdnArtifacts) === 'cdn-check',
        'refusing to remove temporary CDN bytes outside the Behance task directory',
      );
      const artifacts = await readdir(resolvedCdnArtifacts).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
      assert(artifacts.every((name) => ['module-max3840.headers.txt', 'module-max3840.bin'].includes(name)),
        'refusing to remove files not created by the Behance CDN pixel check');
      await rm(resolvedCdnArtifacts, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
