#!/usr/bin/env node

/**
 * Real-page checks for the original-media save flow on five social sites.
 * All page media is selected through its rendered DOM and sent through the
 * extension's Alt+right-click handler to a temporary local receiver.
 */

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { altRightClick, decodeHeader, startLiveHarness } from './original-media-live-core.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(repoRoot, 'test-results', 'live-social');
const reportPath = path.join(repoRoot, 'docs', 'original-media-live-social.md');
const requestedIds = process.argv.slice(2).filter((value) => !value.startsWith('-'));

const samples = [
  {
    id: 'xiaohongshu',
    label: '小红书',
    url: 'https://xhslink.com/a/RVjdnIaGmsi2',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    url: 'https://www.instagram.com/p/DeJ28eTxo4s/',
  },
  {
    id: 'weibo',
    label: '微博',
    url: 'https://weibo.com/2/detail/5335211736565127',
  },
  {
    id: 'pixiv',
    label: 'Pixiv',
    url: 'https://www.pixiv.net/artworks/119611543',
  },
  {
    id: 'x',
    label: 'X',
    url: 'https://x.com/NASA/status/1956376225074552934',
  },
];

const activeSamples = requestedIds.length
  ? samples.filter((sample) => requestedIds.includes(sample.id))
  : samples;
const outputReportPath = requestedIds.length
  ? path.join(repoRoot, 'docs', 'original-media-live-social-retry.md')
  : reportPath;

function mediaIdentity(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function safeMediaUrl(value) {
  const identity = mediaIdentity(value);
  if (!identity) return null;
  try {
    const url = new URL(value);
    const signedHost = /(?:^|\.)(?:rednotecdn|xhscdn)\.com$/iu.test(url.hostname);
    const segments = url.pathname.split('/').filter(Boolean);
    const hasTimestampHashPath = segments.some((segment) => /^\d{12,14}$/u.test(segment))
      && segments.some((segment) => /^[a-f0-9]{32,64}$/iu.test(segment));
    if (signedHost || hasTimestampHashPath) return `${url.origin}/[临时签名路径省略]`;
    return identity;
  } catch {
    return null;
  }
}

function safePageUrl(value) {
  return safeMediaUrl(value);
}

function briefError(error) {
  return String(error?.message ?? error).split(/\r?\n/u, 1)[0]
    .replace(/https?:\/\/[^\s"'<>]+/giu, '<url>')
    .replace(/[?&](?:xsec_token|token|sig|signature|oe|oh)=[^&\s]*/giu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, 260);
}

function blockingCategory(text) {
  const value = text.toLowerCase();
  if (/captcha|verify (?:that )?you are human|unusual traffic|安全验证|人机验证|验证码/.test(value)) {
    return '验证码或安全验证阻断';
  }
  if (/log in to continue|sign in to continue|login required|登录后查看|登录查看更多|请先登录/.test(value)) {
    return '登录墙阻断';
  }
  if (/403 forbidden|access denied|请求过于频繁|访问受限/.test(value)) {
    return '访问限制阻断';
  }
  return null;
}

async function chooseRenderedImage(page) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const candidates = await page.locator('img').evaluateAll((images) => images.map((image, index) => {
      const rect = image.getBoundingClientRect();
      // eslint-disable-next-line no-undef
      const style = window.getComputedStyle(image);
      const url = image.currentSrc || image.src || '';
      const visible = rect.width > 60 && rect.height > 60 && style.display !== 'none'
        && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      const excluded = /avatar|profile|logo|emoji|icon|badge|sprite/i.test(url);
      return {
        index,
        visible,
        excluded,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        previewUrl: image.currentSrc || image.src || '',
        srcset: image.getAttribute('srcset') || '',
      };
    }));
    const best = candidates
      .filter((candidate) => candidate.visible && !candidate.excluded
        && candidate.naturalWidth >= 200 && candidate.naturalHeight >= 200)
      .sort((left, right) => (right.naturalWidth * right.naturalHeight) - (left.naturalWidth * left.naturalHeight))[0];
    if (best) return best;
    await page.waitForTimeout(500);
  }
  return null;
}

async function captureImageEvidence(page, index) {
  const locator = page.locator('img').nth(index);
  return locator.evaluate((image) => {
    const safePath = (value) => {
      try {
        // eslint-disable-next-line no-undef
        const url = new URL(value, document.baseURI);
        return `${url.origin}${url.pathname}`;
      } catch {
        return null;
      }
    };
    const basePath = (value) => safePath(value)?.replace(/!.*$/u, '') ?? null;
    const previewUrl = image.currentSrc || image.src || '';
    const previewBase = basePath(previewUrl);
    const parseSrcset = (value) => value.split(',').map((entry) => entry.trim().split(/\s+/u)[0])
      .filter((entry) => /^https?:/iu.test(entry));
    const explicitFields = [];
    const srcsetCandidates = [];
    let node = image;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      for (const attribute of [...node.attributes]) {
        if (/^(?:data-)?(?:original|origin|full|source|srcset)/iu.test(attribute.name)) {
          const values = attribute.name.toLowerCase().includes('srcset')
            ? parseSrcset(attribute.value)
            : /^https?:/iu.test(attribute.value) ? [attribute.value] : [];
          for (const value of values) {
            explicitFields.push({ name: attribute.name, path: safePath(value) });
          }
        }
      }
    }
    for (const value of parseSrcset(image.getAttribute('srcset') || '')) {
      const path = safePath(value);
      if (path && path !== safePath(previewUrl)) srcsetCandidates.push(path);
    }

    const structuredCandidates = [];
    const structuredFields = new Set();
    // Xiaohongshu places per-image URL variants in its public page state.
    // Walk only records that also identify the selected image URL.
    // eslint-disable-next-line no-undef
    const root = window.__INITIAL_STATE__;
    // eslint-disable-next-line no-undef
    for (const previous of document.querySelectorAll('img[data-serpent-live-social-target="selected"]')) {
      previous.removeAttribute('data-serpent-live-social-target');
    }
    let visited = 0;
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 14 || visited > 25_000) return;
      visited += 1;
      let entries;
      try { entries = Object.entries(value); } catch { return; }
      const directUrls = entries.flatMap(([key, child]) => {
        if (typeof child !== 'string' || !/^https?:\/\//iu.test(child)) return [];
        if (!/url|src|image|original|origin|source|raw|full|default|master/iu.test(key)) return [];
        return [{ key, value: child }];
      });
      if (previewBase && directUrls.some((item) => basePath(item.value) === previewBase)) {
        for (const item of directUrls) {
          const path = safePath(item.value);
          if (!path || path === safePath(previewUrl)) continue;
          structuredCandidates.push(path);
          structuredFields.add(item.key);
        }
      }
      for (const [, child] of entries) {
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };
    if (root && typeof root === 'object') walk(root);

    image.setAttribute('data-serpent-live-social-target', 'selected');
    return {
      previewPath: safePath(previewUrl),
      currentSrcPath: safePath(image.currentSrc),
      srcPath: safePath(image.src),
      previewDimensions: `${image.naturalWidth}×${image.naturalHeight}`,
      explicitFields: explicitFields.filter((item) => item.path),
      srcsetCandidates: [...new Set(srcsetCandidates)],
      structuredCandidates: [...new Set(structuredCandidates)],
      structuredFields: [...structuredFields],
    };
  });
}

function setImageEvidence(result, image, evidence) {
  result.previewDimensions = `${image.naturalWidth}×${image.naturalHeight}`;
  result.previewPath = evidence.previewPath;
  result.pageCandidateCount = evidence.structuredCandidates.length + evidence.srcsetCandidates.length;
  result.explicitOriginalFields = evidence.explicitFields
    .filter((field) => /original|origin|full|raw/iu.test(field.name))
    .map((field) => field.name);
  if (result.id === 'pixiv' && evidence.previewPath) {
    try {
      const url = new URL(evidence.previewPath);
      if (url.hostname === 'i.pximg.net' && url.pathname.includes('/img-master/')) {
        url.pathname = url.pathname.replace('/img-master/', '/img-original/')
          .replace(/_master\d+(?=\.[^.]+$)/iu, '');
        result.derivedCandidatePath = `${url.origin}${url.pathname}`;
      }
    } catch {
      // Preserve the observed DOM URL when it cannot be safely transformed.
    }
  }
}

async function waitForSaveFeedback(page) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const title = await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      for (const element of document.querySelectorAll('*')) {
        const bubble = element.shadowRoot?.querySelector('.bubble');
        const text = bubble?.firstElementChild?.textContent?.trim();
        if (text && text !== '正在保存到 Serpent') return text;
      }
      return null;
    }).catch(() => null);
    if (title) return title;
    await page.waitForTimeout(100);
  }
  return null;
}

function candidateAssessment(sample, evidence, finalUrl, dimensions, savedVersion) {
  const finalPath = mediaIdentity(finalUrl);
  const candidateCount = evidence.structuredCandidates.length + evidence.srcsetCandidates.length;
  if (savedVersion === 'preview') {
    const sameSource = finalPath === evidence.previewPath;
    const sameDimensions = dimensions && dimensions === evidence.previewDimensions;
    return `扩展 feedback savedVersion=preview；${sameSource ? '实收 URL 与 DOM currentSrc 相同' : '实收 URL 与 DOM currentSrc 不同'}${sameDimensions ? '且尺寸相同' : ''}；页面结构化/srcset 其他候选 ${candidateCount} 个。`;
  }
  if (savedVersion === 'candidate') return `扩展 feedback savedVersion=candidate；页面结构化/srcset 其他候选 ${candidateCount} 个。`;
  if (finalPath && finalPath === evidence.previewPath) {
    return '实收 URL 与 DOM currentSrc 相同；未观察到原图升档。';
  }
  if (sample.id === 'weibo' && evidence.previewPath) {
    try {
      const url = new URL(evidence.previewPath);
      const derived = url.pathname.replace(/\/(?:thumb\d*|orj\d*|mw\d*|crop[^/]*)\//iu, '/large/');
      if (derived !== url.pathname && `${url.origin}${derived}` === finalPath) {
        return `实收路径匹配扩展推导的 /large 候选；预览 ${evidence.previewDimensions}，文件 ${dimensions ?? '未知尺寸'}。`;
      }
    } catch {
      // Keep the assessment unknown when the page source cannot be parsed.
    }
  }
  if (evidence.structuredCandidates.includes(finalPath)) return '实收 URL 命中页面结构化状态中的另一媒体候选。';
  if (evidence.srcsetCandidates.includes(finalPath)) return '实收 URL 命中页面 DOM srcset 中的另一尺寸候选。';
  return `实际交付 ${savedVersion ?? '版本未知'}；页面显式候选 ${evidence.structuredCandidates.length + evidence.srcsetCandidates.length} 个。`;
}

async function saveAttempt(harness, page, sample, runDir) {
  const result = {
    id: sample.id,
    label: sample.label,
    pageUrl: sample.url,
    status: 'blocked',
    detail: '页面中未发现可见的实际图片。',
  };
  const pageDir = path.join(runDir, sample.id);
  await mkdir(pageDir, { recursive: true });

  let navigationError = null;
  try {
    await page.goto(sample.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  } catch (error) {
    navigationError = briefError(error);
  }

  await page.waitForTimeout(2_500);
  const finalPageUrl = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
  const block = blockingCategory(bodyText);
  const selectedImage = await chooseRenderedImage(page);

  await writeFile(path.join(pageDir, 'page.html'), await page.content().catch(() => ''), 'utf8');
  await page.screenshot({ path: path.join(pageDir, 'page.png'), fullPage: false }).catch(() => {});

  result.pageUrl = sample.url;
  result.finalPageUrl = safePageUrl(finalPageUrl);
  if (navigationError) result.navigation = navigationError;

  if (!selectedImage) {
    result.status = 'blocked';
    result.detail = block ?? (navigationError ? `页面导航失败：${navigationError}` : '页面中未发现可见的实际图片。');
    return result;
  }

  const before = harness.desktop.uploads.length;
  let evidence = await captureImageEvidence(page, selectedImage.index);
  setImageEvidence(result, selectedImage, evidence);
  let clickError = null;
  try {
    const target = page.locator('img[data-serpent-live-social-target="selected"]');
    await target.scrollIntoViewIfNeeded();
    await altRightClick(page, target);
  } catch (error) {
    clickError = error;
  }
  if (clickError && harness.desktop.uploads.length === before && /Timeout|not visible|detached/iu.test(briefError(clickError))) {
    const refreshed = await chooseRenderedImage(page);
    if (refreshed) {
      evidence = await captureImageEvidence(page, refreshed.index);
      setImageEvidence(result, refreshed, evidence);
      try {
        const target = page.locator('img[data-serpent-live-social-target="selected"]');
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.boundingBox();
        if (!bounds) throw new Error('selected image has no visible bounds');
        result.pointerRetry = true;
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
          button: 'right',
          modifiers: ['Alt'],
        });
        clickError = null;
      } catch (error) {
        clickError = error;
      }
    }
  }
  try {
    if (clickError) throw clickError;
    const upload = await harness.waitForUpload(before, 22_000);
    await writeFile(path.join(pageDir, 'received-media.bin'), upload.body);

    const headers = upload.headers;
    const mediaUrl = decodeHeader(headers['x-serpent-media-url']);
    const sourcePageUrl = decodeHeader(headers['x-serpent-source-page-url']);
    const contentType = headers['x-serpent-content-type'] ?? headers['content-type'] ?? null;
    const feedback = await waitForSaveFeedback(page);
    const savedVersion = feedback?.startsWith('已保存当前预览')
      ? 'preview'
      : feedback?.startsWith('已发送到 Serpent') ? 'candidate' : null;
    let dimensions = null;
    let sharpFormat = null;
    try {
      const metadata = await sharp(upload.body).metadata();
      dimensions = metadata.width && metadata.height ? `${metadata.width}×${metadata.height}` : null;
      sharpFormat = metadata.format ?? null;
    } catch {
      // Keep the upload evidence; the content-type/bytes are still reported.
    }

    result.status = 'saved';
    result.detail = '扩展 Alt+右键已将页面选中图像送达临时接收端。';
    result.kind = headers['x-serpent-kind'] ?? null;
    result.contentType = contentType;
    result.bytes = upload.body.length;
    result.fileDimensions = dimensions;
    result.fileFormat = sharpFormat;
    result.mediaUrl = safeMediaUrl(mediaUrl);
    result.savedVersion = savedVersion ?? 'unknown';
    result.saveFeedback = feedback;
    result.originalAssessment = candidateAssessment(sample, evidence, mediaUrl, dimensions, savedVersion);
    result.sourcePageOrigin = safePageUrl(sourcePageUrl)?.split('/').slice(0, 3).join('/') ?? null;
    result.pageOrigin = new URL(finalPageUrl).origin;
    result.samePageOrigin = result.sourcePageOrigin === result.pageOrigin;
    if (!result.bytes || !result.kind || !result.contentType) {
      result.detail = '扩展已上传，但接收头缺少媒体类型或有效字节。';
      result.status = 'invalid-upload';
    } else if (result.kind === 'image' && !dimensions) {
      result.detail = '扩展已上传图片字节，但无法读取图像尺寸。';
      result.status = 'invalid-image';
    }
  } catch (error) {
    result.status = block ? 'blocked' : 'no-upload';
    result.saveFeedback = await waitForSaveFeedback(page);
    const clickSummary = result.pointerRetry
      ? '首次定位点击超时，坐标 Alt+右键重试也未上传'
      : `Alt+右键未送达媒体：${briefError(error)}`;
    result.detail = block ?? `${clickSummary}${result.saveFeedback ? `；扩展提示：${result.saveFeedback}` : '；未观察到扩展反馈'}`;
  }

  return result;
}

function renderReport(results, testedAt) {
  const lines = [
    '# 社交站点原图真实页面实测',
    '',
    `实测日期：${testedAt}。每站尝试访问一个公开贴文/作品页面；页面可访问并出现图像时，通过扩展 Alt+右键入口向临时本机接收端保存。没有调用私有下载 API、登录或读取/导出账号 Cookie。`,
    '',
    '页面 HTML、截图、浏览器临时配置和媒体字节仅存在于仓库 `test-results/live-social/` 下的单次运行目录，并在脚本 `finally` 清理。报告不保留 CDN 查询参数或页面令牌。',
    '',
    '| 站点 | 页面样本 | 结果 | DOM currentSrc | 页面预览尺寸 | 实收媒体 / savedVersion | 字节 | 文件尺寸 | 页面原图候选证据 | 最终媒体路径 | 说明 |',
    '|---|---|---|---:|---:|---|---:|---:|---|---|---|',
  ];

  for (const result of results) {
    const uploaded = result.status === 'saved' || result.status === 'invalid-upload' || result.status === 'invalid-image';
    const mediaType = uploaded ? `${result.kind ?? '未知'} / ${result.contentType ?? '未知'} / ${result.savedVersion ?? '未知'}` : '—';
    const assessment = result.originalAssessment
      ?? (result.derivedCandidatePath
        ? `DOM currentSrc 对应的 Pixiv 原图候选路径为 \`${result.derivedCandidatePath}\`；扩展保存失败，无实收文件。`
        : `原图候选未确认；${result.explicitOriginalFields?.length ? `DOM 字段 ${result.explicitOriginalFields.join(', ')}` : `页面结构化/srcset 候选 ${result.pageCandidateCount ?? 0} 个`}。`);
    const details = `${assessment} ${result.detail}`.replaceAll('|', '\\|');
    const previewPath = result.previewPath ? safeMediaUrl(result.previewPath) : null;
    const candidatePath = result.derivedCandidatePath ? safeMediaUrl(result.derivedCandidatePath) : null;
    const safeAssessment = candidatePath
      ? assessment.replace(result.derivedCandidatePath, candidatePath)
      : assessment;
    const publicPageUrl = safePageUrl(result.pageUrl) ?? '#';
    lines.push(`| ${result.label} | [公开页面](${publicPageUrl}) | ${result.status} | ${previewPath ? `\`${previewPath}\`` : '—'} | ${result.previewDimensions ?? '—'} | ${mediaType} | ${result.bytes ?? '—'} | ${result.fileDimensions ?? '—'} | ${safeAssessment} | ${result.mediaUrl ? `\`${result.mediaUrl}\`` : '—'} | ${details.replace(result.derivedCandidatePath ?? '\0', candidatePath ?? '\0')} |`);
  }

  lines.push('', '文件尺寸由临时接收的实际媒体字节经 Sharp 读取；DOM currentSrc 与原图候选只记录清理 query 后的路径。savedVersion 来自扩展保存后的页面反馈提示；若提示未暴露版本则记为 unknown。', '');
  return lines.join('\n');
}

async function main() {
  const results = [];
  let harness = null;
  try {
    harness = await startLiveHarness({
      label: 'social',
      artifactRoot,
      timeoutMs: 22_000,
    });
    const page = await harness.context.newPage();
    page.setDefaultTimeout(8_000);
    for (const sample of activeSamples) {
      const result = await saveAttempt(harness, page, sample, harness.runDir);
      results.push(result);
      process.stdout.write(`${JSON.stringify({ id: result.id, status: result.status, detail: result.detail, bytes: result.bytes, fileDimensions: result.fileDimensions, mediaUrl: result.mediaUrl ?? null })}\n`);
    }
  } catch (error) {
    const detail = briefError(error);
    for (const sample of activeSamples.slice(results.length)) {
      results.push({ id: sample.id, label: sample.label, pageUrl: sample.url, status: 'blocked', detail: `实测环境启动失败：${detail}` });
    }
    process.stderr.write(`Live harness failure: ${detail}\n`);
  } finally {
    if (harness) await harness.cleanup().catch((error) => process.stderr.write(`Harness cleanup failure: ${briefError(error)}\n`));
    const resolvedRoot = path.resolve(artifactRoot);
    assert.equal(resolvedRoot, path.resolve(repoRoot, 'test-results', 'live-social'), 'artifact cleanup path must stay in this task folder');
    await rm(resolvedRoot, { recursive: true, force: true });
  }

  await mkdir(path.dirname(outputReportPath), { recursive: true });
  await writeFile(outputReportPath, renderReport(results, new Date().toISOString().slice(0, 10)), 'utf8');
  process.stdout.write(`Report: ${path.relative(repoRoot, outputReportPath)}\n`);
  if (results.some((result) => result.status === 'saved')) return;
  if (results.some((result) => result.status !== 'blocked')) process.exitCode = 1;
}

await main();
