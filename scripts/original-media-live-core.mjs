#!/usr/bin/env node

/* global chrome */

/** Shared real-site browser harness for original-media live checks. */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromiumBuildDir = path.join(extensionRoot, 'dist', 'extension');
const liveRoot = path.join(extensionRoot, 'test-results', 'live-search');

const requireFromWorkspace = createRequire(
  path.join(process.env.SERPENT_PLAYWRIGHT_RESOLVE_FROM || process.cwd(), '__playwright_resolver__.cjs'),
);

function loadChromium() {
  try {
    return requireFromWorkspace('playwright').chromium;
  } catch (error) {
    throw new Error('Cannot resolve Playwright. Run from the extension workspace or set SERPENT_PLAYWRIGHT_RESOLVE_FROM.', { cause: error });
  }
}

function json(response, status, value) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function startDesktopReceiver() {
  const uploads = [];
  const requests = [];
  let port = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search });

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/ping') {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/folders') {
      json(response, 200, { folders: [], recentBrowsedFolderIds: [], libraryDisplayName: 'Isolated live-test receiver' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/collections') {
      json(response, 200, { collections: [], libraryDisplayName: 'Isolated live-test receiver' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/capabilities') {
      json(response, 200, { status: 'ok', segmentedMediaUpload: null });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/save-upload') {
      uploads.push({ port, headers: { ...request.headers }, body, receivedAt: new Date().toISOString() });
      json(response, 202, { accepted: true });
      return;
    }
    json(response, 404, { error: 'unknown isolated receiver endpoint' });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'fake desktop receiver must have a TCP address');
  port = address.port;
  return { port, uploads, requests, close: () => closeServer(server) };
}

async function createCopiedExtension(runDir, desktopPort) {
  const extensionDir = path.join(runDir, 'extension');
  await cp(chromiumBuildDir, extensionDir, { recursive: true });
  const backgroundPath = path.join(extensionDir, 'background.js');
  const source = await readFile(backgroundPath, 'utf8');
  const portLists = /19876\s*,\s*19877\s*,\s*19878/gu;
  const occurrences = source.match(portLists) ?? [];
  assert.equal(occurrences.length, 2, 'expected exactly two copied desktop port lists');
  const endpointPortGuard = /:1987\[6-8\]/gu;
  assert.equal((source.match(endpointPortGuard) ?? []).length, 1, 'expected one copied desktop endpoint allowlist');
  const patched = source.replace(portLists, String(desktopPort)).replace(endpointPortGuard, `:${desktopPort}`);
  assert(!/19876\s*,\s*19877\s*,\s*19878/u.test(patched));
  assert(!/:1987\[6-8\]/u.test(patched));
  await writeFile(backgroundPath, patched, 'utf8');
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [
    ...manifest.host_permissions.filter((permission) => !/^http:\/\/127\.0\.0\.1:1987[6-8]\/\*$/u.test(permission)),
    `http://127.0.0.1:${desktopPort}/*`,
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return extensionDir;
}

function waitFor(predicate, description, timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description} (${timeoutMs} ms)`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

export function extensionWorker(context, timeoutMs = 20_000) {
  return waitFor(
    () => context.serviceWorkers().find((worker) => worker.url().endsWith('/background.js')),
    'extension background service worker',
    timeoutMs,
  );
}

async function assertReceiverConnected(context, desktop) {
  const worker = await extensionWorker(context);
  const extensionId = await worker.evaluate(() => chrome.runtime.id);
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    const startedAt = Date.now();
    let lastStatus = null;
    let lastError = null;
    while (Date.now() - startedAt < 20_000) {
      try {
        lastStatus = await page.evaluate(() => new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'serpent-connection-status' }, (response) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(response);
          });
        }));
      } catch (error) {
        lastError = error.message;
      }
      if (lastStatus?.kind === 'connected') return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const worker = await extensionWorker(context);
    const probe = await worker.evaluate(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ping`);
        return { status: response.status, body: await response.text() };
      } catch (error) {
        return { error: error.message, name: error.name };
      }
    }, desktop.port);
    const permission = await worker.evaluate((port) => new Promise((resolve) => {
      chrome.permissions.contains({ origins: [`http://127.0.0.1:${port}/*`] }, resolve);
    }), desktop.port);
    assert.fail(`isolated desktop receiver did not connect within 20s; status=${JSON.stringify(lastStatus)}; error=${lastError}; requests=${JSON.stringify(desktop.requests)}; directProbe=${JSON.stringify(probe)}; dynamicHostPermission=${permission}`);
  } finally {
    await page.close();
  }
}

export async function startLiveHarness({
  label = 'run',
  artifactRoot = liveRoot,
  proxyServer = process.env.SERPENT_LIVE_PROXY,
  timeoutMs = 20_000,
} = {}) {
  const chromium = loadChromium();
  await stat(path.join(chromiumBuildDir, 'manifest.json')).catch(() => {
    throw new Error(`Built extension missing at ${chromiumBuildDir}; use the existing current dist without rebuilding during live checks.`);
  });
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const allowedRoot = path.resolve(path.join(extensionRoot, 'test-results'));
  const relativeRoot = path.relative(allowedRoot, resolvedArtifactRoot);
  assert(relativeRoot === '' || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== '..' && !path.isAbsolute(relativeRoot)),
    'artifactRoot must stay beneath this repository test-results directory');
  await mkdir(resolvedArtifactRoot, { recursive: true });
  const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-|-$/gu, '') || 'run';
  const runId = `${safeLabel}-${Date.now()}-${process.pid}`;
  const runDir = path.join(resolvedArtifactRoot, runId);
  await mkdir(runDir, { recursive: true });

  let desktop;
  let context;
  let closed = false;
  try {
    desktop = await startDesktopReceiver();
    const extensionDir = await createCopiedExtension(runDir, desktop.port);
    const profileDir = path.join(runDir, 'profile');
    const options = {
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      proxy: proxyServer
        ? { server: proxyServer, bypass: '127.0.0.1,localhost,[::1]' }
        : undefined,
    };
    if (process.env.SERPENT_BROWSER_EXECUTABLE) options.executablePath = process.env.SERPENT_BROWSER_EXECUTABLE;
    else options.channel = 'chromium';
    context = await chromium.launchPersistentContext(profileDir, options);
    await assertReceiverConnected(context, desktop);

    const harness = {
      context,
      desktop,
      runDir,
      proxyServer: proxyServer || null,
      extensionWorker: () => extensionWorker(context, timeoutMs),
      waitForUpload(since = 0, waitMs = timeoutMs) {
        return waitFor(() => desktop.uploads.length > since && desktop.uploads[since], `upload #${since + 1}`, waitMs);
      },
      async cleanup() {
        if (closed) return;
        closed = true;
        await Promise.allSettled([context?.close(), desktop?.close()]);
        const resolvedRoot = path.resolve(runDir);
        assert(path.dirname(resolvedRoot) === resolvedArtifactRoot, 'refusing to remove live-test files outside this run directory');
        await rm(resolvedRoot, { recursive: true, force: true });
      },
    };
    return harness;
  } catch (error) {
    await Promise.allSettled([context?.close(), desktop?.close()]);
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

export async function altRightClick(page, locator, position) {
  const target = typeof locator === 'string' ? page.locator(locator) : locator;
  await target.waitFor({ state: 'visible' });
  await target.click({ button: 'right', modifiers: ['Alt'], ...(position ? { position } : {}) });
}

export function decodeHeader(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

