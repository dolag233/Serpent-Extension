import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { build } from 'vite';

import {
  extensionIconSizes,
  iconSources,
} from './icon-assets.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 独立仓库中源码位于仓库根（manifest.json / *.ts / options.* 平铺）。
const sourceDir = rootDir;
// Chromium 产物（Chrome/Edge 等，MV3 service worker）与 Firefox 产物
// （MV3 event page）各自独立输出，manifest 来源不同，脚本产物共用一份
// 自包含 bundle（Firefox event page 不是 module，不能含顶层 import）。
const targets = [
  {
    name: 'chrome',
    outDir: path.join(rootDir, 'dist', 'extension'),
    manifestSource: 'manifest.json',
    validateBackground: (manifest) => manifest.background?.service_worker === 'background.js',
    validateGecko: false,
  },
  {
    name: 'firefox',
    outDir: path.join(rootDir, 'dist', 'extension-firefox'),
    manifestSource: 'manifest.firefox.json',
    validateBackground: (manifest) =>
      Array.isArray(manifest.background?.scripts) &&
      manifest.background.scripts.includes('background.js'),
    validateGecko: true,
  },
];

async function assertFile(outDir, relativePath) {
  const absolutePath = path.join(outDir, relativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Extension build output is missing or empty: ${relativePath}`);
  }
}

async function validateBuild(outDir, target) {
  const manifest = JSON.parse(
    await readFile(path.join(outDir, 'manifest.json'), 'utf8'),
  );

  if (manifest.manifest_version !== 3) {
    throw new Error('Extension manifest must use Manifest V3');
  }
  if (!target.validateBackground(manifest)) {
    throw new Error(
      `Extension manifest (${target.name}) must reference the generated background.js ` +
      'in the background section',
    );
  }
  if (target.validateGecko && !manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('Firefox manifest must declare browser_specific_settings.gecko.id');
  }
  if (!manifest.permissions?.includes('notifications')) {
    throw new Error('Extension manifest must request notifications permission');
  }
  if (!manifest.permissions?.includes('storage')) {
    throw new Error('Extension manifest must request storage permission for recent folders');
  }
  if (!manifest.permissions?.includes('alarms')) {
    throw new Error('Extension manifest must request alarms permission for connection checks');
  }
  if (!manifest.action?.default_icon?.['32']?.includes('icon-gray-32.png')) {
    throw new Error('Extension action must default to the gray toolbar icon');
  }
  if (manifest.options_page !== 'options.html') {
    throw new Error('Extension manifest must reference options.html');
  }
  const contentScript = manifest.content_scripts?.[0];
  if (!contentScript?.js?.includes('content-script.js')) {
    throw new Error('Extension manifest must register content-script.js on http(s) pages');
  }
  const hasPageBridge = manifest.content_scripts?.some((entry) => entry.js?.includes('page-bridge.js'));
  if (hasPageBridge && !manifest.content_scripts.some((entry) => entry.world === 'MAIN')) {
    throw new Error('page-bridge.js must run in MAIN world');
  }
  if (hasPageBridge) {
    const bridgeMatches = manifest.content_scripts.find((entry) => entry.js?.includes('page-bridge.js'))?.matches ?? [];
    for (const xMatch of ['*://x.com/*', '*://*.x.com/*', '*://twitter.com/*', '*://*.twitter.com/*']) {
      if (!bridgeMatches.includes(xMatch)) {
        throw new Error(`page-bridge.js must include the X host match ${xMatch}`);
      }
    }
  }

  await assertFile(outDir, 'background.js');
  await assertFile(outDir, 'content-script.js');
  if (hasPageBridge) await assertFile(outDir, 'page-bridge.js');
  await assertFile(outDir, 'options.js');
  await assertFile(outDir, 'options.html');
  await assertFile(outDir, 'options.css');
  await assertFile(outDir, 'popup.js');
  await assertFile(outDir, 'popup.html');
  if (manifest.action?.default_popup !== 'popup.html') {
    throw new Error('Extension action must open popup.html');
  }
  await assertFile(outDir, 'README.md');

  // 三个脚本都必须是自包含单文件。多入口同一次构建会让 Rollup 抽取共享 chunk，
  // 产物首行出现 import 语句；Chrome content script 与 Firefox event page
  // 都不能是 ES module，整个脚本会解析失败、静默失效（2026-07-25 实测事故）。
  for (const relativePath of ['background.js', 'content-script.js', 'options.js', 'popup.js', 'page-bridge.js']) {
    const source = await readFile(path.join(outDir, relativePath), 'utf8');
    if (/^(?:import|export)\s/m.test(source)) {
      throw new Error(
        `${relativePath} must be a self-contained single file (found top-level import/export)`,
      );
    }
  }
  for (const size of extensionIconSizes) {
    const relativePath = `icons/icon-${size}.png`;
    if (manifest.icons?.[String(size)] !== relativePath) {
      throw new Error(`Extension manifest icon ${size} must reference ${relativePath}`);
    }
    await assertFile(outDir, relativePath);
    const grayRelativePath = `icons/icon-gray-${size}.png`;
    if (manifest.action?.default_icon?.[String(size)] !== grayRelativePath) {
      throw new Error(`Extension action icon ${size} must reference ${grayRelativePath}`);
    }
    await assertFile(outDir, grayRelativePath);
  }

  const background = await readFile(path.join(outDir, 'background.js'), 'utf8');
  if (background.includes('capturedMedia') || background.includes('capture-media')) {
    throw new Error('Generated background must not use ephemeral captured-media state');
  }

  process.stdout.write(`Verified installable extension (${target.name}) at ${outDir}\n`);
}

/**
 * 三个入口各自独立打包：单入口构建会把全部静态依赖（含 webextension-polyfill）
 * 内联进一个文件，不会产生共享 chunk。content script 必须是 classic script（IIFE）；
 * background 与 options 同样输出无任何 import 的单文件，杜绝 chunk 解析依赖。
 */
const scriptEntries = [
  { name: 'background', format: 'es' },
  { name: 'content-script', format: 'iife' },
  { name: 'page-bridge', format: 'iife' },
  { name: 'options', format: 'es' },
  { name: 'popup', format: 'es' },
];

async function bundleScriptEntries(outDir) {
  for (const [index, entry] of scriptEntries.entries()) {
    await build({
      configFile: false,
      root: rootDir,
      logLevel: 'warn',
      build: {
        target: 'chrome120',
        outDir,
        emptyOutDir: index === 0,
        minify: false,
        sourcemap: true,
        rollupOptions: {
          input: path.join(sourceDir, `${entry.name}.ts`),
          output: {
            format: entry.format,
            codeSplitting: false,
            entryFileNames: `${entry.name}.js`,
          },
        },
      },
    });
  }
}

async function copyStaticAssets(outDir) {
  await copyFile(path.join(sourceDir, 'README.md'), path.join(outDir, 'README.md'));
  await copyFile(path.join(sourceDir, 'options.html'), path.join(outDir, 'options.html'));
  await copyFile(path.join(sourceDir, 'options.css'), path.join(outDir, 'options.css'));
  await copyFile(path.join(sourceDir, 'popup.html'), path.join(outDir, 'popup.html'));
  await mkdir(path.join(outDir, 'icons'), { recursive: true });

  await Promise.all(extensionIconSizes.flatMap((size) => [
    sharp(iconSources.extensionActive)
      .resize(size, size, { fit: 'cover' })
      .png()
      .toFile(path.join(outDir, 'icons', `icon-${size}.png`)),
    sharp(iconSources.extensionInactive)
      .resize(size, size, { fit: 'cover' })
      .png()
      .toFile(path.join(outDir, 'icons', `icon-gray-${size}.png`)),
  ]));
}

async function buildTarget(target) {
  const { outDir } = target;
  await rm(outDir, { recursive: true, force: true });

  await bundleScriptEntries(outDir);
  await copyFile(
    path.join(sourceDir, target.manifestSource),
    path.join(outDir, 'manifest.json'),
  );
  await copyStaticAssets(outDir);

  await validateBuild(outDir, target);
}

async function buildExtension() {
  for (const target of targets) {
    await buildTarget(target);
  }
}

await buildExtension();
