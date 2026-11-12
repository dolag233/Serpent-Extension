#!/usr/bin/env node

/* global document, getComputedStyle, location, window */

/*
 * Real-site original-media checks for public creative portfolio pages.
 * Uses the current built extension in an isolated Chromium profile and an
 * isolated loopback desktop receiver. Temporary page HTML and downloaded
 * media live under test-results/live-portfolio and are removed in finally.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { altRightClick, decodeHeader, startLiveHarness } from './original-media-live-core.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(extensionRoot, 'test-results', 'live-portfolio');
const navigationTimeoutMs = 35_000;
const uploadTimeoutMs = 24_000;
const postNavigationWaitMs = 1_600;
const pinterestPinId = '344314334016546758';
const pinterestReplayPageUrl = `https://www.pinterest.com/pin/${pinterestPinId}/`;
const pinterestReplayPreviewUrl = 'https://i.pinimg.com/236x/84/9f/6e/849f6e995823741352f3e61d9bd5f613.jpg';
const pinterestReplayOriginalUrl = 'https://i.pinimg.com/originals/84/9f/6e/849f6e995823741352f3e61d9bd5f613.png';
const dribbbleWorkUrl = 'https://dribbble.com/shots/26089505-Isometric-Ramen';
const dribbbleResizedImageUrl = 'https://cdn.dribbble.com/userupload/43517435/file/original-d853cfa4c0a06c197a1417835b07045f.jpg?resize=752x&vertical=center';

const samples = [
  {
    site: 'Pinterest',
    slug: 'pinterest',
    pageUrl: 'https://www.pinterest.com/pin/344314334016546758/',
  },
  {
    site: 'Huaban',
    slug: 'huaban',
    pageUrl: 'https://huaban.com/pins/3154231487/',
    alternativePageUrl: 'https://huaban.com/',
  },
  {
    site: 'Behance',
    slug: 'behance',
    pageUrl: 'https://www.behance.net/gallery/242373217/Illustration-Portfolio-2026',
  },
  {
    site: 'ZCOOL',
    slug: 'zcool',
    pageUrl: 'https://www.zcool.com.cn/work/ZNTY2Mzg4NDA=.html',
    alternativePageUrl: 'https://www.zcool.com.cn/work/ZNjE2MjQwOTI%3D.html',
  },
  {
    site: 'Dribbble',
    slug: 'dribbble',
    pageUrl: 'https://dribbble.com/shots/26052539-Illustration',
    alternativePageUrl: 'https://dribbble.com/shots/26089505-Isometric-Ramen',
  },
  {
    site: 'ArtStation',
    slug: 'artstation',
    pageUrl: 'https://www.artstation.com/artwork/vz2GGO',
    alternativePageUrl: 'https://www.artstation.com/artwork/1abEq',
  },
];

function pinterestCapturedDomHtml() {
  const pwsData = {
    pinId: pinterestPinId,
    images: {
      orig: { url: pinterestReplayOriginalUrl },
      '236x': { url: pinterestReplayPreviewUrl },
    },
  };
  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><title>Captured public Pin DOM</title>
      <style>body{margin:40px}img{display:block;width:234px;height:133px;object-fit:contain}</style>
    </head><body>
      <img id="captured-pin" src="${pinterestReplayPreviewUrl}" srcset="${pinterestReplayOriginalUrl} 4x" width="234" height="133" alt="captured public Pin image">
      <script id="__PWS_DATA__" type="application/json">${JSON.stringify(pwsData)}</script>
    </body></html>`;
}

async function preparePinterestCapturedDomReplay(page) {
  const html = pinterestCapturedDomHtml();
  await page.route(pinterestReplayPageUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: html,
  }));
  return page.goto(pinterestReplayPageUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
}

async function probeDribbbleUnresizedAsset(harness, evidenceDir) {
  const unresizedUrl = new URL(dribbbleResizedImageUrl);
  unresizedUrl.search = '';
  const page = await harness.context.newPage();
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  try {
    await page.setExtraHTTPHeaders({ Referer: dribbbleWorkUrl });
    const response = await page.goto(unresizedUrl.href, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    const body = response ? await response.body() : Buffer.alloc(0);
    await writeFile(path.join(evidenceDir, 'dribbble-unresized.media.bin'), body);
    let media = null;
    let decodeError = null;
    try {
      const metadata = await sharp(body, { failOn: 'error' }).metadata();
      media = {
        format: metadata.format ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        bytes: body.byteLength,
      };
    } catch (error) {
      decodeError = error.message.split('\n')[0];
    }
    return {
      site: 'Dribbble',
      mode: 'same_asset_unresized_url_probe',
      pageUrl: safeUrl(dribbbleWorkUrl),
      candidateUrl: safeUrl(unresizedUrl.href),
      httpStatus: response?.status() ?? null,
      contentType: response?.headers()['content-type'] ?? null,
      status: media ? 'media_available' : 'media_unavailable_or_unreadable',
      media,
      reason: decodeError,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^(?:data|blob):/iu.test(value)) return `[${value.split(':', 1)[0]} URL omitted]`;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|auth|signature|(?:^|_)sig(?:$|_)|session|cookie|credential|access[_-]?key|secret)/iu.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

function lowerHeaders(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
}

function sameResource(left, right) {
  if (!left || !right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return left === right;
  }
}

function hasExplicitOriginalPath(value) {
  try {
    return /(?:^|\/)(?:originals?|img-original)(?:\/|$)/iu.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function classifyMedia({ finalUrl, selectedUrl, explicitOriginalUrls, sourceDimensions, savedDimensions }) {
  const explicitOriginalPath = hasExplicitOriginalPath(finalUrl);
  const explicitOriginalCandidate = explicitOriginalUrls.some((candidate) => sameResource(candidate, finalUrl));
  const selectedResource = sameResource(selectedUrl, finalUrl);
  const largerThanDisplayed = Boolean(
    sourceDimensions?.width && sourceDimensions?.height
      && savedDimensions?.width && savedDimensions?.height
      && savedDimensions.width * savedDimensions.height > sourceDimensions.width * sourceDimensions.height,
  );

  if (explicitOriginalPath || explicitOriginalCandidate) return 'original_confirmed';
  if (!selectedResource && largerThanDisplayed) return 'higher_quality_candidate';
  if (selectedResource || !largerThanDisplayed) return 'preview_fallback';
  return 'unverified';
}

async function inspectDom(page) {
  return page.evaluate(() => {
    const bodyText = (document.body?.innerText ?? '').slice(0, 8_000);
    const title = document.title ?? '';
    const blocked = /captcha|verify (?:that )?you(?:'| a)re human|unusual traffic|access denied|security check|robot verification|安全验证|机器人验证/iu.test(`${title}\n${bodyText}`);
    const redirectLooksLikeLogin = /\/(?:login|signin|sign-in|auth)(?:[/?#]|$)/iu.test(location.pathname);
    const loginWall = /log in to continue|sign in to view this content|login required|登录后查看|登录后继续/iu.test(bodyText);
    const images = [...document.images].map((image, index) => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
      const sourceSets = [image.srcset, ...[...image.parentElement?.querySelectorAll('source') ?? []].map((source) => source.srcset)]
        .filter(Boolean)
        .flatMap((sourceSet) => sourceSet.split(',').map((item) => item.trim().split(/\s+/u)[0]).filter(Boolean));
      const dataCandidates = [...image.attributes]
        .filter((attribute) => /^(?:data-(?:original|src|large|full|actualsrc|url)|data-srcset)$/iu.test(attribute.name))
        .flatMap((attribute) => attribute.name.toLowerCase().endsWith('srcset')
          ? attribute.value.split(',').map((item) => item.trim().split(/\s+/u)[0]).filter(Boolean)
          : [attribute.value]);
      const candidateUrls = [...new Set([
        image.currentSrc,
        image.src,
        ...sourceSets,
        ...dataCandidates,
      ].filter((value) => /^https?:/iu.test(value)))];
      const explicitOriginalUrls = candidateUrls.filter((value) => {
        try {
          return /(?:^|\/)(?:originals?|img-original)(?:\/|$)/iu.test(new URL(value).pathname);
        } catch {
          return false;
        }
      });
      const declaredOriginalUrls = [...image.attributes]
        .filter((attribute) => /^data-(?:original|original-url|original-src)$/iu.test(attribute.name))
        .flatMap((attribute) => /^https?:/iu.test(attribute.value) ? [attribute.value] : []);
      const alt = image.alt ?? '';
      const descriptor = `${alt} ${image.className?.toString?.() ?? ''} ${image.id ?? ''}`;
      const avatarLike = /avatar|profile|headshot|logo|icon|sprite|badge/iu.test(descriptor)
        || (rect.width <= 120 && rect.height <= 120);
      const area = visible ? rect.width * rect.height : 0;
      const naturalArea = image.naturalWidth * image.naturalHeight;
      return {
        index,
        visible,
        avatarLike,
        currentUrl: image.currentSrc || image.src || '',
        srcUrl: image.src || '',
        srcset: image.srcset || '',
        alt,
        workUrl: image.closest('a[href]')?.href ?? '',
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        complete: image.complete,
        candidateUrls,
        explicitOriginalUrls: [...new Set([...explicitOriginalUrls, ...declaredOriginalUrls])],
        score: (avatarLike ? 0 : 1) * Math.max(area, naturalArea * 0.1),
      };
    }).sort((left, right) => right.score - left.score);
    return {
      title,
      finalPageUrl: location.href,
      readyState: document.readyState,
      blocked,
      redirectLooksLikeLogin,
      loginWall,
      diagnostics: {
        bodyChars: bodyText.length,
        imageTags: images.length,
        loadedImages: images.filter((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).length,
        scriptTags: document.scripts.length,
      },
      visibleImages: images.filter((image) => image.visible && !image.avatarLike && image.naturalWidth > 0 && image.naturalHeight > 0).length,
      images,
    };
  });
}

async function waitForVisibleImage(page) {
  await page.waitForTimeout(postNavigationWaitMs);
  await page.evaluate(() => window.scrollBy(0, Math.max(250, window.innerHeight * 0.55)));
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  const deadline = Date.now() + 9_000;
  let dom;
  do {
    dom = await inspectDom(page);
    if (dom.visibleImages > 0) return dom;
    await page.waitForTimeout(750);
  } while (Date.now() < deadline);
  return dom;
}

async function attemptSample(harness, sample, evidenceDir, mode = 'anonymous_live_page', preparePage = null) {
  const page = await harness.context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let response = null;
  let dom = null;
  let status;
  let failureReason = null;
  let saved = null;
  let savedMetadata = null;
  let selectedImage = null;

  try {
    if (preparePage) {
      response = await preparePage(page);
    } else {
      try {
        response = await page.goto(sample.pageUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      } catch (error) {
        failureReason = `navigation failed: ${error.message.split('\n')[0]}`;
      }
    }

    if (page.url() && page.url() !== 'about:blank') {
      try {
        dom = await waitForVisibleImage(page);
      } catch (error) {
        failureReason ??= `DOM inspection failed: ${error.message.split('\n')[0]}`;
      }
    }

    if (dom) {
      await writeFile(path.join(evidenceDir, `${sample.slug}.html`), await page.content(), 'utf8');
      await writeFile(path.join(evidenceDir, `${sample.slug}.dom.json`), JSON.stringify(dom, null, 2), 'utf8');
    }

    const httpStatus = response?.status() ?? null;
    if (httpStatus !== null && httpStatus >= 400) {
      status = 'source_inaccessible';
      failureReason = `source returned HTTP ${httpStatus}`;
      return resultRecord(sample, status, failureReason, dom, httpStatus, null, null, null, mode);
    }
    if (dom?.blocked) {
      status = 'source_inaccessible';
      failureReason = 'page presented a verification or access block';
      return resultRecord(sample, status, failureReason, dom, httpStatus, null, null, null, mode);
    }
    if (dom?.redirectLooksLikeLogin || dom?.loginWall) {
      status = 'source_inaccessible';
      failureReason = dom.redirectLooksLikeLogin ? 'page redirected to a sign-in route' : 'page requires sign-in to view content';
      return resultRecord(sample, status, failureReason, dom, httpStatus, null, null, null, mode);
    }
    if (!dom) {
      status = 'source_inaccessible';
      failureReason ??= 'no page DOM was available';
      return resultRecord(sample, status, failureReason, dom, httpStatus, null, null, null, mode);
    }

    const candidates = dom.images.filter((image) => (
      image.visible && !image.avatarLike && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
    ));
    selectedImage = candidates[0] ?? null;
    if (!selectedImage) {
      const minimalDocument = dom.diagnostics.bodyChars < 250;
      status = minimalDocument ? 'source_inaccessible' : 'candidate_not_found';
      failureReason = minimalDocument
        ? 'page returned only a minimal document without public artwork content'
        : 'no visible, loaded artwork image was found in the page DOM';
      return resultRecord(sample, status, failureReason, dom, httpStatus, null, null, null, mode);
    }

    status = 'candidate_found';
    const imageLocator = page.locator('img').nth(selectedImage.index);
    await imageLocator.scrollIntoViewIfNeeded();
    const uploadIndex = harness.desktop.uploads.length;
    try {
      await altRightClick(page, imageLocator);
      saved = await harness.waitForUpload(uploadIndex, uploadTimeoutMs);
      status = 'downloaded';
    } catch (error) {
      failureReason = `extension save did not reach the fake desktop: ${error.message.split('\n')[0]}`;
      return resultRecord(sample, status, failureReason, dom, httpStatus, selectedImage, null, null, mode);
    }

    const imageBytesPath = path.join(evidenceDir, `${sample.slug}.media.bin`);
    await writeFile(imageBytesPath, saved.body);
    try {
      const metadata = await sharp(saved.body, { failOn: 'error' }).metadata();
      savedMetadata = {
        format: metadata.format ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        space: metadata.space ?? null,
        bytes: saved.body.byteLength,
      };
    } catch (error) {
      status = 'downloaded_unreadable_media';
      failureReason = `upload reached the fake desktop but Sharp could not decode it: ${error.message.split('\n')[0]}`;
    }
    return resultRecord(sample, status, failureReason, dom, httpStatus, selectedImage, saved, savedMetadata, mode);
  } catch (error) {
    return resultRecord(sample, 'attempt_failed', error.message.split('\n')[0], dom, response?.status() ?? null, selectedImage, saved, savedMetadata, mode);
  } finally {
    if (pageErrors.length > 0) {
      const errorPath = path.join(evidenceDir, `${sample.slug}.page-errors.txt`);
      await writeFile(errorPath, pageErrors.join('\n'), 'utf8').catch(() => {});
    }
    await page.close().catch(() => {});
  }
}

function resultRecord(sample, status, reason, dom, httpStatus, image = null, upload = null, metadata = null, mode = 'anonymous_live_page') {
  const headers = lowerHeaders(upload?.headers);
  const finalUrl = decodeHeader(headers['x-serpent-media-url']);
  const pageUrl = decodeHeader(headers['x-serpent-source-page-url']);
  const candidateUrls = image?.candidateUrls ?? [];
  const savedDimensions = metadata?.width && metadata?.height
    ? { width: metadata.width, height: metadata.height }
    : null;
  const sourceDimensions = image?.naturalWidth && image?.naturalHeight
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : null;
  const classification = upload
    ? classifyMedia({
      finalUrl,
      selectedUrl: image?.currentUrl,
      explicitOriginalUrls: image?.explicitOriginalUrls ?? [],
      sourceDimensions,
      savedDimensions,
    })
    : null;
  return {
    site: sample.site,
    mode,
    pageUrl: safeUrl(sample.pageUrl),
    landedPageUrl: safeUrl(dom?.finalPageUrl),
    httpStatus,
    status,
    reason: reason || null,
    domDiagnostics: dom?.diagnostics ?? null,
    candidateFound: Boolean(image),
    candidate: image ? {
      currentUrl: safeUrl(image.currentUrl),
      srcUrl: safeUrl(image.srcUrl),
      linkedWorkUrl: safeUrl(image.workUrl),
      srcset: image.srcset.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
        const [url, descriptor] = item.split(/\s+/u);
        return { url: safeUrl(url), descriptor: descriptor ?? null };
      }),
      otherCandidateUrls: candidateUrls
        .filter((candidate) => !sameResource(candidate, image.currentUrl))
        .map(safeUrl),
      explicitOriginalUrls: (image.explicitOriginalUrls ?? []).map(safeUrl),
      displayedPixels: sourceDimensions,
    } : null,
    download: upload ? {
      finalUrl: safeUrl(finalUrl),
      sourcePageUrl: safeUrl(pageUrl),
      contentType: headers['x-serpent-content-type'] ?? null,
      media: metadata,
      classification,
      uploadedBytes: upload.body.byteLength,
    } : null,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const directMode = args.has('--direct');
  const pinterestReplay = args.has('--pinterest-replay');
  const dribbbleUnresizedProbe = args.has('--dribbble-unresized-probe');
  const requestedSites = args.has('--sites')
    ? new Set(process.argv[process.argv.indexOf('--sites') + 1]?.split(',').map((site) => site.trim().toLowerCase()).filter(Boolean) ?? [])
    : null;
  const selectedSamples = requestedSites
    ? samples.filter((sample) => requestedSites.has(sample.slug))
    : pinterestReplay || dribbbleUnresizedProbe ? [] : samples;
  assert(selectedSamples.length > 0 || pinterestReplay || dribbbleUnresizedProbe, 'No matching sites selected. Use --sites pinterest,huaban,behance,zcool,dribbble,artstation, --pinterest-replay, or --dribbble-unresized-probe.');
  if (!directMode) assert(process.env.SERPENT_LIVE_PROXY, 'Set SERPENT_LIVE_PROXY in this process to the temporary proxy URL.');
  const harness = await startLiveHarness({
    label: 'portfolio',
    artifactRoot,
    proxyServer: directMode ? null : process.env.SERPENT_LIVE_PROXY,
    timeoutMs: 20_000,
  });
  const evidenceDir = path.join(harness.runDir, 'evidence');
  const results = [];

  try {
    await mkdir(evidenceDir, { recursive: true });
    for (const sample of selectedSamples) {
      const result = await attemptSample(harness, sample, evidenceDir);
      results.push(result);
      const media = result.download?.media;
      const short = media
        ? `${media.width ?? '?'}×${media.height ?? '?'} ${media.format ?? 'unknown'}; ${media.bytes} B; ${result.download.classification}`
        : result.reason ?? result.status;
      console.log(`${result.status === 'downloaded' ? 'PASS' : 'INFO'} ${sample.site}: ${short}`);
      if (sample.alternativePageUrl && !result.candidateFound) {
        const alternative = {
          ...sample,
          slug: `${sample.slug}-alternative`,
          pageUrl: sample.alternativePageUrl,
        };
        const fallbackResult = await attemptSample(harness, alternative, evidenceDir);
        results.push(fallbackResult);
        const fallbackMedia = fallbackResult.download?.media;
        const fallbackShort = fallbackMedia
          ? `${fallbackMedia.width ?? '?'}×${fallbackMedia.height ?? '?'} ${fallbackMedia.format ?? 'unknown'}; ${fallbackMedia.bytes} B; ${fallbackResult.download.classification}`
          : fallbackResult.reason ?? fallbackResult.status;
        console.log(`${fallbackResult.status === 'downloaded' ? 'PASS' : 'INFO'} ${sample.site} alternate public work: ${fallbackShort}`);
      }
    }

    if (pinterestReplay) {
      const replaySample = { site: 'Pinterest', slug: 'pinterest-captured-dom-replay', pageUrl: pinterestReplayPageUrl };
      const result = await attemptSample(
        harness,
        replaySample,
        evidenceDir,
        'captured_dom_replay',
        preparePinterestCapturedDomReplay,
      );
      results.push(result);
      const media = result.download?.media;
      const short = media
        ? `${media.width ?? '?'}×${media.height ?? '?'} ${media.format ?? 'unknown'}; ${media.bytes} B; ${result.download.classification}`
        : result.reason ?? result.status;
      console.log(`${result.status === 'downloaded' ? 'PASS' : 'INFO'} Pinterest captured DOM replay: ${short}`);
    }

    if (dribbbleUnresizedProbe) {
      const result = await probeDribbbleUnresizedAsset(harness, evidenceDir);
      results.push(result);
      const media = result.media;
      const short = media
        ? `${media.width ?? '?'}×${media.height ?? '?'} ${media.format ?? 'unknown'}; ${media.bytes} B`
        : `${result.status}${result.httpStatus ? `; HTTP ${result.httpStatus}` : ''}`;
      console.log(`${result.status === 'media_available' ? 'INFO' : 'BLOCKED'} Dribbble same-asset URL probe: ${short}`);
    }

    const evidencePath = path.join(evidenceDir, 'portfolio-report.json');
    await writeFile(evidencePath, JSON.stringify(results, null, 2), 'utf8');
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await harness.cleanup();
  }

  const downloaded = results.filter((result) => result.download?.media?.width && result.download?.media?.height);
  console.log(`Attempted ${results.length} of ${selectedSamples.length + Number(pinterestReplay) + Number(dribbbleUnresizedProbe)} selected checks; ${downloaded.length} produced decodable image uploads${directMode ? ' (direct network)' : ' (proxy network)'}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
