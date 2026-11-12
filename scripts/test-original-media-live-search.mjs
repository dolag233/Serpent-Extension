#!/usr/bin/env node

/* global document, getComputedStyle, location */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { altRightClick, decodeHeader, startLiveHarness } from './original-media-live-core.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, 'docs');
const reportPath = path.join(outputDir, 'original-media-live-search.md');
const requireFromWorkspace = createRequire(path.join(repoRoot, '__live_search_resolver__.cjs'));
const sharp = requireFromWorkspace('sharp');
const navigationTimeoutMs = 25_000;
const saveTimeoutMs = 25_000;

const engines = [
  { name: 'Baidu Images', searchUrl: 'https://image.baidu.com/search/index?tn=baiduimage&word=%E9%A3%8E%E6%99%AF%E6%91%84%E5%BD%B1%E5%85%A8%E6%99%AF', selectors: ['.imgitem img', '.imgbox img'] },
  { name: 'Bing Images', searchUrl: 'https://www.bing.com/images/search?q=landscape+photography+high+resolution', selectors: ['img.mimg'] },
  { name: 'Google Images', searchUrl: 'https://www.google.com/search?tbm=isch&q=landscape+photography+high+resolution', selectors: ['img.YQ4gaf', 'img'] },
  { name: 'Sogou Images', searchUrl: 'https://pic.sogou.com/pics?query=%E9%A3%8E%E6%99%AF%E6%91%84%E5%BD%B1%E9%AB%98%E6%B8%85', selectors: ['.imgbox img', '.img-item img'] },
  { name: '360 Images', searchUrl: 'https://image.so.com/i?q=landscape%20photography%20high%20resolution', selectors: ['.imglist img', '.imgitem img'] },
  { name: 'Yandex Images', searchUrl: 'https://yandex.com/images/search?text=landscape%20photography%20high%20resolution', selectors: ['.serp-item__thumb', 'img'] },
  { name: 'DuckDuckGo Images', searchUrl: 'https://duckduckgo.com/?q=landscape+photography+high+resolution&iax=images&ia=images', selectors: ['.tile--img__img', 'img'] },
];

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return `${url.protocol}//[non-http]`;
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|signature|sig$|secret|session|cookie|access.?key|expires?/iu.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function visibleImages(page, selectors) {
  const selector = selectors.join(',');
  return page.locator(selector).evaluateAll((images) => images.map((image, index) => {
    const rect = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    const source = image.currentSrc || image.src || '';
    return {
      index,
      imgIndex: [...document.querySelectorAll('img')].indexOf(image),
      source,
      alt: image.alt || '',
      title: image.title || '',
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: rect.width >= 72 && rect.height >= 54 && style.display !== 'none' && style.visibility !== 'hidden',
      parentLink: image.closest('a')?.href || '',
      srcset: image.getAttribute('srcset') || '',
      details: (() => {
        const entries = [];
        let node = image;
        for (let level = 0; node && level < 4; level += 1, node = node.parentElement) {
          for (const attribute of [...node.attributes]) {
            if (/^(href|src|srcset|data-[a-z0-9_-]+)$/iu.test(attribute.name)) {
              entries.push(`${attribute.name}=${attribute.value}`);
            }
          }
        }
        return entries.slice(0, 32);
      })(),
    };
  }).filter((image) => image.visible
    && image.naturalWidth > 30
    && image.naturalHeight > 30
    && /^https?:/iu.test(image.source)
    && !/logo|avatar|icon|sprite|captcha/iu.test(`${image.alt} ${image.title}`))
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))
    .slice(0, 30));
}

function evidenceUrls(image) {
  const urls = new Set([image?.source, image?.parentLink]);
  for (const item of image?.details ?? []) {
    const equalsAt = item.indexOf('=');
    const raw = item.slice(equalsAt + 1);
    for (const match of raw.matchAll(/https?:\/\/[^\s"'<>),;]+/giu)) urls.add(match[0]);
    try {
      const url = new URL(raw);
      const linkedImage = url.searchParams.get('mediaurl') || url.searchParams.get('imgurl');
      if (linkedImage) urls.add(linkedImage);
    } catch {
      // Attribute values may be relative, srcset data, or non-URL metadata.
    }
  }
  return [...urls].filter((value) => typeof value === 'string' && /^https?:/iu.test(value)).map(safeUrl);
}

function blockerLabel(title, text) {
  if (/captcha|verify (that )?you are human|unusual traffic|robot check|security check|异常流量|人机验证|验证码|不是机器人|系统检测|机器人也使用|以下挑战|由真人进行|鸭子的正方形/iu.test(`${title}\n${text}`)) return 'captcha / anti-automation interstitial';
  if (/sign in|log in|login required|before you continue/iu.test(`${title}\n${text}`)) return 'login or consent gate';
  if (/access denied|request blocked|forbidden|403 forbidden/iu.test(`${title}\n${text}`)) return 'access denied';
  return null;
}

async function compactPageState(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').replace(/\s+/gu, ' ').slice(0, 900),
    imageCount: document.images.length,
  }));
}

async function dismissResultOverlay(page) {
  const closeControl = page.locator('a.close[title="关闭"], a.close[title="Close"], [aria-label="关闭对话框"], [aria-label="Close dialog"]');
  if (await closeControl.count().catch(() => 0)) {
    await closeControl.first().click({ timeout: 3_000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(300);
}

async function imageClickPositionOutsideOverlay(page, imageIndex) {
  return page.locator('img').nth(imageIndex).evaluate((image) => {
    const rect = image.getBoundingClientRect();
    const overlay = document.querySelector('#OverlayIFrame');
    if (!overlay) return null;
    const overlayRect = overlay.getBoundingClientRect();
    const style = getComputedStyle(overlay);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return null;
    const points = [
      [Math.min(24, rect.width / 2), rect.height / 2],
      [Math.max(rect.width - 24, rect.width / 2), rect.height / 2],
      [rect.width / 2, Math.min(24, rect.height / 2)],
      [rect.width / 2, Math.max(rect.height - 24, rect.height / 2)],
    ];
    const isCovered = (x, y) => x >= overlayRect.left && x <= overlayRect.right
      && y >= overlayRect.top && y <= overlayRect.bottom;
    const point = points.find(([x, y]) => x > 0 && y > 0 && x < rect.width && y < rect.height
      && !isCovered(rect.left + x, rect.top + y));
    return point ? { x: Math.round(point[0]), y: Math.round(point[1]) } : null;
  });
}

async function attemptEngine({ harness, engine }) {
  const record = {
    engine: engine.name,
    searchEvidenceUrl: engine.searchUrl,
    outcome: 'blocked',
    reason: null,
    pageUrl: null,
    clickedPreviewUrl: null,
    pageCandidates: [],
    uploadCandidateFinalUrl: null,
    sourcePageUrl: null,
    dimensions: null,
    contentType: null,
    byteLength: null,
    imageVerified: false,
    originalExtraction: 'unobserved',
    desktopLibraryImport: false,
    clickEvidence: null,
  };
  const page = await harness.context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    let navError = null;
    try {
      await page.goto(engine.searchUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    } catch (error) {
      navError = error.message;
    }
    await page.waitForTimeout(2_200);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(900);
    const initial = await compactPageState(page);
    const blocker = blockerLabel(initial.title, initial.text);
    if (blocker) {
      record.reason = `${blocker}; ${initial.title || 'untitled page'}`;
      record.pageUrl = safeUrl(initial.url);
      record.clickEvidence = 'Page-level access barrier detected; no image was selected.';
      return record;
    }

    let candidates = [];
    for (const selector of engine.selectors) {
      if (await page.locator(selector).count().catch(() => 0)) {
        candidates = await visibleImages(page, [selector]).catch(() => []);
        if (candidates.length) break;
      }
    }
    if (!candidates.length) candidates = await visibleImages(page, ['img']).catch(() => []);
    if (!candidates.length) {
      record.pageUrl = safeUrl(initial.url);
      record.reason = navError
        ? `navigation timed out and page exposed no selectable images: ${navError.slice(0, 180)}`
        : `no loaded, visible search-result image; title=${initial.title || '(empty)'}`;
      record.clickEvidence = 'No loaded, visible image candidate was available for a DOM click.';
      return record;
    }

    const preview = candidates[0];
    record.clickedPreviewUrl = safeUrl(preview.source);
    record.pageCandidates = evidenceUrls(preview).slice(0, 8);
    record.clickEvidence = `Clicked result image ${preview.index} (${preview.width}x${preview.height}, alt=${preview.alt.slice(0, 100)})`;
    const clickTarget = page.locator('img').nth(preview.imgIndex);
    await clickTarget.scrollIntoViewIfNeeded();
    let clickError = null;
    try {
      await clickTarget.click({ timeout: 8_000 });
    } catch (error) {
      clickError = error.message;
    }
    await page.waitForTimeout(1_250);

    const current = await compactPageState(page);
    try {
      const detailUrl = new URL(current.url);
      const declaredImageUrl = detailUrl.searchParams.get('mediaurl') || detailUrl.searchParams.get('imgurl');
      if (declaredImageUrl) record.pageCandidates = [...new Set([...record.pageCandidates, safeUrl(declaredImageUrl)])].slice(0, 8);
    } catch {
      // The post-click location may be a non-URL browser state.
    }
    if (clickError && current.url === initial.url) {
      record.pageUrl = safeUrl(current.url);
      record.reason = `result image click did not open a detail view: ${clickError.split('\n')[0]}`;
      return record;
    }
    if (clickError) record.clickEvidence += '; result detail state opened despite a subsequent overlay intercepting the click';
    const afterClickBlocker = blockerLabel(current.title, current.text);
    if (afterClickBlocker) {
      record.reason = `clicked a result but opened ${afterClickBlocker}`;
      record.pageUrl = safeUrl(current.url);
      return record;
    }
    if (current.url.includes('view=detailV2') && page.frames().some((frame) => frame.name() === 'OverlayIFrame')) {
      await dismissResultOverlay(page);
    }
    let selectedImages = await visibleImages(page, ['img']).catch(() => []);
    const stablePreview = selectedImages.find((image) => image.source === preview.source);
    const selected = stablePreview ?? selectedImages[0];
    if (!selected) {
      record.pageUrl = safeUrl(current.url);
      record.reason = 'result click produced no loaded visible image to save';
      return record;
    }
    record.pageUrl = safeUrl(current.url);
    if (selected.source !== preview.source) {
      record.clickedPreviewUrl = safeUrl(selected.source);
      record.pageCandidates = [...new Set([...record.pageCandidates, ...evidenceUrls(selected)])].slice(0, 8);
    }

    const uploadBefore = harness.desktop.uploads.length;
    let targetImage = selected;
    let position = await imageClickPositionOutsideOverlay(page, targetImage.imgIndex).catch(() => null);
    if (page.frames().some((frame) => frame.name() === 'OverlayIFrame') && !position) {
      for (const candidate of selectedImages) {
        position = await imageClickPositionOutsideOverlay(page, candidate.imgIndex).catch(() => null);
        if (position) {
          targetImage = candidate;
          break;
        }
      }
    }
    let targetLocator = page.locator('img').nth(targetImage.imgIndex);
    try {
      await altRightClick(page, targetLocator, position);
    } catch (error) {
      const overlayPresent = page.frames().some((frame) => frame.name() === 'OverlayIFrame');
      if (!overlayPresent) throw error;
      await dismissResultOverlay(page);
      selectedImages = await visibleImages(page, ['img']).catch(() => []);
      const retryTarget = selectedImages.find((image) => image.source === selected.source) ?? selectedImages[0];
      if (!retryTarget) throw error;
      targetLocator = page.locator('img').nth(retryTarget.imgIndex);
      await altRightClick(page, targetLocator, await imageClickPositionOutsideOverlay(page, retryTarget.imgIndex).catch(() => null));
    }
    let upload;
    try {
      upload = await harness.waitForUpload(uploadBefore, saveTimeoutMs);
    } catch {
      const state = await compactPageState(page).catch(() => current);
      record.pageUrl = safeUrl(state.url);
      record.reason = `extension Alt+right-click produced no fake-desktop upload within ${saveTimeoutMs} ms${state.text ? `; page=${state.text.slice(0, 180)}` : ''}`;
      return record;
    }

    const headers = upload.headers;
    const finalUrl = decodeHeader(headers['x-serpent-media-url']);
    const sourcePageUrl = decodeHeader(headers['x-serpent-source-page-url']);
    record.uploadCandidateFinalUrl = safeUrl(finalUrl || '');
    record.sourcePageUrl = safeUrl(sourcePageUrl || '');
    record.contentType = headers['x-serpent-content-type'] || headers['content-type'] || null;
    record.byteLength = upload.body.byteLength;
    try {
      const metadata = await sharp(upload.body).metadata();
      record.dimensions = { width: metadata.width, height: metadata.height, format: metadata.format };
      record.imageVerified = Boolean(metadata.width > 0 && metadata.height > 0 && metadata.format);
    } catch (error) {
      record.reason = `upload arrived but is not a decodable image: ${error.message}`;
      record.outcome = 'invalid-upload';
      return record;
    }
    assert(record.imageVerified, 'sharp must identify uploaded image dimensions');
    assert(record.byteLength > 0, 'real public image download must contain bytes');

    const canonical = (value) => {
      try {
        const url = new URL(value);
        url.hash = '';
        return url.toString();
      } catch {
        return value;
      }
    };
    const finalCanonical = canonical(finalUrl || '');
    const displayedCanonical = canonical(selected.source);
    const candidateCanonicals = record.pageCandidates.map(canonical);
    if (finalCanonical && finalCanonical !== displayedCanonical && candidateCanonicals.includes(finalCanonical)) {
      record.originalExtraction = 'observed: upload used a distinct page-declared image candidate';
    } else if (finalCanonical && finalCanonical === displayedCanonical) {
      record.originalExtraction = 'preview used as final source; original extraction not observed';
    } else if (finalCanonical) {
      record.originalExtraction = 'unclassified: final source differs from visible preview and captured DOM candidates';
    }
    record.outcome = 'downloaded-and-image-verified';
    record.desktopLibraryImport = false;
    record.reason = 'real extension upload reached isolated fake desktop; Serpent library import was not performed';
    return record;
  } catch (error) {
    record.reason = /OverlayIFrame|OverlayMask|intercepts pointer events/iu.test(error.message)
      ? 'The clicked search result opened a detail overlay whose iframe/mask intercepted Alt+right-click; no extension upload reached the isolated receiver.'
      : `${error.name || 'Error'}: ${error.message.split('\n')[0].slice(0, 220)}`;
    record.outcome = record.outcome === 'blocked' ? 'failed' : record.outcome;
    return record;
  } finally {
    await page.close().catch(() => {});
  }
}

function markdownTable(records) {
  const rows = records.map((record) => {
    const details = [
      `Outcome: ${record.outcome}`,
      record.reason,
      record.clickEvidence,
      `Page original extraction: ${record.originalExtraction}`,
      `Upload bytes verified: ${record.imageVerified ? 'yes' : 'no'}`,
      `Serpent library import: ${record.desktopLibraryImport ? 'yes' : 'not performed'}`,
      record.dimensions ? `${record.dimensions.width}×${record.dimensions.height} ${record.dimensions.format}, ${record.byteLength} bytes, ${record.contentType || 'unknown MIME'}` : null,
      record.clickedPreviewUrl ? `Clicked image: ${record.clickedPreviewUrl}` : null,
      record.pageCandidates.length ? `Observed DOM candidate(s): ${record.pageCandidates.join('<br>')}` : null,
      record.uploadCandidateFinalUrl ? `Final uploaded source: ${record.uploadCandidateFinalUrl}` : null,
      record.sourcePageUrl ? `Extension source page: ${record.sourcePageUrl}` : null,
      record.pageUrl ? `After click: ${record.pageUrl}` : null,
    ].filter(Boolean).join('<br>');
    return `| ${record.engine} | [public search page](${record.searchEvidenceUrl}) | ${details} |`;
  });
  return ['| Site | Evidence URL | Result |', '| --- | --- | --- |', ...rows].join('\n');
}

async function main() {
  const harness = await startLiveHarness({ label: 'search-engines', timeoutMs: 20_000 });
  const records = [];
  const selectedNames = process.env.SERPENT_LIVE_ENGINES
    ? new Set(process.env.SERPENT_LIVE_ENGINES.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
    : null;
  const enginesToRun = selectedNames
    ? engines.filter((engine) => selectedNames.has(engine.name.toLowerCase()) || selectedNames.has(engine.name.split(' ')[0].toLowerCase()))
    : engines;
  try {
    for (const engine of enginesToRun) {
      console.log(`LIVE ${engine.name}: navigating ${engine.searchUrl}`);
      const record = await attemptEngine({ harness, engine });
      records.push(record);
      console.log(JSON.stringify(record));
    }
  } finally {
    await harness.cleanup();
  }

  await mkdir(outputDir, { recursive: true });
  const passed = records.filter((record) => record.outcome === 'downloaded-and-image-verified').length;
  const destination = selectedNames
    ? path.join(repoRoot, 'test-results', 'live-search', 'retry-report.md')
    : reportPath;
  const report = [
    '# Original media live search checks',
    '',
    `Run date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Each site was opened in an isolated Chromium profile with the current built extension. A visible search-result image was clicked in the page DOM, then the extension Alt+right-click flow was used. Upload bytes were captured by a temporary local fake desktop receiver; Sharp identified the downloaded image format and pixel dimensions. No saved asset was imported into a Serpent library.',
    '',
    `Verified public image downloads: ${passed}/${records.length}. A blocked, timed out, or image-less site is recorded as such; captcha and access controls were not bypassed.`,
    '',
    'Page original extraction is marked observed only when the uploaded URL matches a distinct image URL declared in the inspected result DOM. A preview URL as the final source is labeled preview; other cases remain unclassified. This report distinguishes that source-resolution evidence from the separate successful download and from a real Serpent library import.',
    '',
    markdownTable(records),
    '',
  ].join('\n');
  await writeFile(destination, report, 'utf8');
  console.log(`REPORT ${destination}`);
  if (passed === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

