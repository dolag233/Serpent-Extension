import type {
  MediaCandidate,
  MediaCandidateSource,
  MediaKind,
  MediaSelection,
  SiteAdapterCapability,
  SiteAdapterId,
} from './types';
import { genericEngineCandidates } from './generic';
import { pageBridgeKeyFromPreview, type PageBridgeAdapter } from './page-bridge-data';
import {
  artstationCandidates,
  artstationMediaKey,
  isArtStationHostname,
  isSameArtStationAsset,
} from './artstation';
import { pinterestVideoForSelection, safePinterestPosterUrl } from './pinterest-video';
import { huabanOriginalCandidateForState } from './huaban';
import {
  behanceCandidatesForState,
  behanceOriginalPath,
  behanceStateVariantWidth,
  isBehanceOriginalAssetUrl,
  behanceTargetForElement,
  isSameBehanceAsset,
} from './behance';

const DOCUMENT_ID = createId();
const MEDIA_FIELD = /(?:original|origin|full|large|big|source|murl|imgurl|mediaurl|imageurl|urlbig|urldefault|urlpre|display_url|video_versions|masterurl|originvideo|stream)/i;
const URL_FIELD = /^(?:url|src|href|image|video|media)$/i;
const SITE_DOCUMENT_CACHES = new WeakMap<Document, {
  entries: Map<SiteAdapterId, {
    script: HTMLScriptElement;
    records: unknown[];
    scripts?: readonly HTMLScriptElement[];
  }>;
  observer?: MutationObserver;
  observed: Set<HTMLScriptElement>;
}>();
const SAFE_ATTRIBUTE_NAMES = new Set([
  'data-original', 'data-origin', 'data-full', 'data-large', 'data-big', 'data-src',
  'data-url', 'data-img-url', 'data-image-url', 'data-media-url',
  'data-original-video', 'data-video-url', 'data-master-url', 'data-play-url',
  'data-source', 'data-pin-media', 'data-actualsrc', 'data-orig-file',
  'data-original-url', 'data-url-original', 'data-murl', 'data-srcset', 'data-media-key', 'data-state',
  'data-item', 'data-media', 'm', 'onclick',
]);
const URL_EXT = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp4|m4v|webm|mov|m3u8|mpd)(?:$|[?#])/i;

interface SiteAdapter {
  id: SiteAdapterId;
  capability: SiteAdapterCapability;
  matches(hostname: string): boolean;
  transform?(url: string, kind: MediaKind): string[];
}

const SITE_ADAPTERS: readonly SiteAdapter[] = [
  {
    id: 'baidu-images', capability: 'local-fields',
    matches: (host) => host === 'image.baidu.com',
    transform: baiduCandidates,
  },
  {
    id: 'bing-images', capability: 'local-fields',
    matches: (host) => host === 'bing.com' || host.endsWith('.bing.com'),
    transform: (url) => queryUrlCandidates(url, ['murl', 'mediaurl', 'imgurl']),
  },
  {
    id: 'google-images', capability: 'page-bridge',
    matches: (host) => host === 'google.com' || host.endsWith('.google.com'),
    transform: (url) => queryUrlCandidates(url, ['imgurl', 'mediaurl']),
  },
  {
    id: 'sogou-images', capability: 'local-fields',
    matches: (host) => host === 'pic.sogou.com',
  },
  {
    id: '360-images', capability: 'local-fields',
    matches: (host) => host === 'image.so.com' || host === 'image.360.cn',
  },
  {
    id: 'yandex-images', capability: 'page-bridge',
    matches: (host) => host === 'yandex.com' || host.endsWith('.yandex.com')
      || host === 'yandex.ru' || host.endsWith('.yandex.ru'),
  },
  {
    id: 'duckduckgo-images', capability: 'page-bridge',
    matches: (host) => host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com'),
    transform: duckDuckGoCandidates,
  },
  {
    id: 'pinterest', capability: 'verified-url-pattern',
    matches: isPinterestHostname,
    transform: pinterestCandidates,
  },
  {
    id: 'huaban', capability: 'verified-url-pattern',
    matches: (host) => host === 'huaban.com' || host.endsWith('.huaban.com')
      || host.endsWith('.huabanimg.com') || host === 'hb.aicdn.com',
  },
  {
    id: 'behance', capability: 'verified-url-pattern',
    matches: (host) => host === 'behance.net' || host.endsWith('.behance.net')
      || host.endsWith('.behance.net'),
    transform: behanceCandidates,
  },
  {
    id: 'zcool', capability: 'local-fields',
    matches: (host) => host === 'zcool.com.cn' || host.endsWith('.zcool.com.cn'),
  },
  {
    id: 'dribbble', capability: 'verified-url-pattern',
    matches: (host) => host === 'dribbble.com' || host.endsWith('.dribbble.com'),
    transform: dribbbleCandidates,
  },
  {
    id: 'artstation', capability: 'verified-url-pattern',
    matches: isArtStationHostname,
    transform: artstationCandidates,
  },
  {
    id: 'xiaohongshu', capability: 'local-fields',
    matches: (host) => host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com'),
  },
  {
    id: 'instagram', capability: 'local-fields',
    matches: (host) => host === 'instagram.com' || host.endsWith('.instagram.com'),
  },
  {
    id: 'weibo', capability: 'local-fields',
    matches: (host) => host === 'weibo.com' || host.endsWith('.weibo.com')
      || host === 'weibo.cn' || host.endsWith('.weibo.cn'),
    transform: weiboCandidates,
  },
  {
    id: 'pixiv', capability: 'verified-url-pattern',
    matches: (host) => host === 'pixiv.net' || host.endsWith('.pixiv.net'),
    transform: pixivCandidates,
  },
  {
    id: 'x', capability: 'page-bridge',
    matches: (host) => host === 'x.com' || host.endsWith('.x.com')
      || host === 'twitter.com' || host.endsWith('.twitter.com'),
    transform: xCandidates,
  },
];

export function createId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function siteAdapterForUrl(value: string): SiteAdapterId | undefined {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return SITE_ADAPTERS.find((adapter) => adapter.matches(host))?.id;
  } catch {
    return undefined;
  }
}

export function siteAdapterCapabilities(): ReadonlyArray<{
  id: SiteAdapterId;
  capability: SiteAdapterCapability;
}> {
  return SITE_ADAPTERS.map(({ id, capability }) => ({ id, capability }));
}

export interface SrcsetCandidate {
  readonly url: string;
  readonly descriptor?: string;
  readonly width?: number;
  readonly density?: number;
}

/** Parse the srcset token grammar without splitting commas inside data URLs. */
export function parseSrcset(srcset: string, baseUrl: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let position = 0;
  while (position < srcset.length) {
    while (position < srcset.length && /[\s,]/.test(srcset[position] ?? '')) position += 1;
    if (position >= srcset.length) break;

    const urlStart = position;
    while (position < srcset.length && !/\s/.test(srcset[position] ?? '')) position += 1;
    let rawUrl = srcset.slice(urlStart, position);
    let endedByComma = false;
    if (rawUrl.endsWith(',')) {
      rawUrl = rawUrl.replace(/,+$/, '');
      endedByComma = true;
    }

    const descriptors: string[] = [];
    if (!endedByComma) {
      let token = '';
      while (position < srcset.length) {
        const char = srcset[position] ?? '';
        if (char === ',') {
          position += 1;
          if (token) descriptors.push(token);
          break;
        }
        if (/\s/.test(char)) {
          if (token) descriptors.push(token);
          token = '';
          position += 1;
          continue;
        }
        token += char;
        position += 1;
      }
      if (token) descriptors.push(token);
    }

    let url: string;
    try {
      url = new URL(rawUrl, baseUrl).href;
    } catch {
      continue;
    }
    const descriptor = descriptors[0];
    const widthMatch = descriptor ? /^(\d+)w$/.exec(descriptor) : null;
    const densityMatch = descriptor ? /^(\d+(?:\.\d+)?)x$/.exec(descriptor) : null;
    candidates.push({
      url,
      ...(descriptor ? { descriptor } : {}),
      ...(widthMatch?.[1] ? { width: Number(widthMatch[1]) } : {}),
      ...(densityMatch?.[1] ? { density: Number(densityMatch[1]) } : {}),
    });
  }
  return candidates;
}

export function buildMediaSelection(args: {
  element: Element;
  kind: MediaKind;
  previewUrl: string;
  pageUrl?: string;
  previewWidth?: number;
  previewHeight?: number;
  selectionId?: string;
  frameId?: number;
}): MediaSelection {
  const { element, kind, previewUrl } = args;
  const pageUrl = args.pageUrl ?? element.ownerDocument.location?.href ?? '';
  const adapter = SITE_ADAPTERS.find((entry) => {
    try {
      return entry.matches(new URL(pageUrl).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  const candidates: MediaCandidate[] = [];
  let identity = identityFromSelection(pageUrl, previewUrl, element);
  const pinterestPinLink = adapter?.id === 'pinterest' ? pinterestPinLinkForElement(element) : undefined;
  if (adapter?.id === 'pinterest' && pinterestPinLink) {
    const pinId = pinterestPinId(pinterestPinLink.href);
    if (pinId) identity = { ...identity, contentId: pinId };
  }
  if (adapter?.id === 'pinterest' && kind === 'video') {
    identity = {
      ...(identity.contentId ? { contentId: identity.contentId } : {}),
      ...(identity.mediaKey ? { mediaKey: identity.mediaKey } : {}),
    };
  }
  if (adapter?.id === 'x') {
    const xIdentity = identityFromXSelection(pageUrl, element);
    identity = {
      ...(xIdentity.contentId ? { contentId: xIdentity.contentId } :
        xIdentity.ambiguousStatus ? {} : identity.contentId ? { contentId: identity.contentId } : {}),
      ...(xIdentity.mediaKey ? { mediaKey: xIdentity.mediaKey } : identity.mediaKey ? { mediaKey: identity.mediaKey } : {}),
      ...(xIdentity.mediaIndex === undefined
        ? identity.mediaIndex === undefined ? {} : { mediaIndex: identity.mediaIndex }
        : { mediaIndex: xIdentity.mediaIndex }),
    };
  }
  if (adapter?.id === 'artstation' && kind === 'image') {
    const mediaKey = artstationMediaKey(previewUrl);
    identity = { ...(mediaKey ? { mediaKey } : {}) };
  }
  if (adapter && ['google-images', 'duckduckgo-images', 'yandex-images'].includes(adapter.id)) {
    const bridgeAdapter = adapter.id as PageBridgeAdapter;
    const bridgeId = pageBridgeKeyFromPreview(bridgeAdapter, previewUrl);
    if (!identity.contentId && bridgeId) identity = { ...identity, contentId: bridgeId };
  }
  const add = (
    url: string | undefined,
    source: MediaCandidateSource,
    extra: Partial<MediaCandidate> = {},
    derivePinterestOriginal = true,
  ) => {
    if (!url) return;
    const normalized = normalizeHttpUrl(url, element.ownerDocument.baseURI);
    if (
      !normalized || normalized === previewUrl || !urlKindCompatible(normalized, kind)
      || candidates.some((item) => item.url === normalized)
    ) return;
    if (adapter?.id === 'artstation' && kind === 'image' && !isSameArtStationAsset(normalized, previewUrl)) return;
    candidates.push({
      url: normalized,
      kind,
      source,
      ...extra,
      ...(adapter?.id === 'artstation' && identity.mediaKey ? { mediaKey: identity.mediaKey } : {}),
    });
    if (derivePinterestOriginal && kind === 'image' && adapter?.id === 'pinterest') {
      for (const originalUrl of pinterestCandidates(normalized)) {
        add(originalUrl, 'known-transform', extra, false);
      }
    }
  };

  const videoPosterUrl = adapter?.id === 'pinterest' && kind === 'video'
    && element.tagName.toLowerCase() === 'video'
    ? safePinterestPosterUrl(element.getAttribute('poster'), element.ownerDocument.baseURI)
    : undefined;
  const localNodes = localEvidenceNodes(element);
  const siteRecord = adapter
    ? siteResultForPreview(
      element.ownerDocument,
      adapter.id,
      previewUrl,
      kind,
      element,
      identity.contentId,
      videoPosterUrl,
      args.previewWidth,
    )
    : undefined;
  if (siteRecord) {
    identity = {
      contentId: siteRecord.contentId ?? identity.contentId,
      mediaIndex: siteRecord.mediaIndex ?? identity.mediaIndex,
    };
    for (const url of siteRecord.candidateUrls) {
      add(url, siteRecord.candidateSource ?? 'site-field', {
        ...(identity.contentId ? { contentId: identity.contentId } : {}),
        ...(siteRecord.candidateWidths?.get(url) ? { width: siteRecord.candidateWidths.get(url) } : {}),
      ...(identity.mediaKey ? { mediaKey: identity.mediaKey } : {}),
        ...(identity.mediaIndex === undefined ? {} : { mediaIndex: identity.mediaIndex }),
      });
    }
  }
  for (const [nodeIndex, node] of localNodes.entries()) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (!SAFE_ATTRIBUTE_NAMES.has(name)) continue;
      if (['data-state', 'data-item', 'data-media'].includes(name)) {
        if (identity.contentId) {
          for (const url of structuredCandidates(
            attribute.value,
            identity.contentId,
            previewUrl,
            element.ownerDocument.baseURI,
          )) add(url, 'structured-data', {
            contentId: identity.contentId,
            ...(identity.mediaIndex === undefined ? {} : { mediaIndex: identity.mediaIndex }),
          });
        }
        continue;
      }
      if (name === 'm') {
        const anchor = element.closest('a');
        if (node !== element && node !== anchor) continue;
        for (const url of sameCardFieldUrls(attribute.value, element.ownerDocument.baseURI, kind)) {
          add(url, 'site-field');
        }
        continue;
      }
      if (name === 'onclick') {
        for (const url of extractUrls(attribute.value, element.ownerDocument.baseURI)) {
          add(url, 'site-field');
        }
        continue;
      }
      const values = urlsFromAttribute(attribute.value, name, element.ownerDocument.baseURI);
      for (const url of values) add(url, 'site-field');
    }
    if (nodeIndex === 0 && node instanceof HTMLImageElement) {
      const picture = adapter?.id === 'behance'
        && node.parentElement?.tagName.toLowerCase() === 'picture'
        ? node.parentElement
        : undefined;
      const pictureSourceSets = picture
        ? [...picture.querySelectorAll<HTMLSourceElement>('source[srcset]')]
          .map((source) => source.srcset || source.getAttribute('srcset') || '')
          .filter(Boolean)
        : [];
      const sourceSets = [...pictureSourceSets, node.srcset].filter(Boolean);
      const parsedSourceSets = sourceSets.map((srcset) => (
        parseSrcset(srcset, element.ownerDocument.baseURI)
      ));
      const selectedDescriptor = parsedSourceSets.flat().find((item) => item.url === previewUrl);
      const srcsetCandidates = parsedSourceSets.flat()
        .filter((item) => item.url !== previewUrl)
        .filter((item) => adapter?.id !== 'behance' || isSameBehanceAsset(item.url, previewUrl))
        .filter((item) => adapter?.id !== 'behance' || isBehanceOriginalAssetUrl(item.url)
          || ((args.previewWidth === undefined
            || (behanceStateVariantWidth(siteRecord?.candidateWidths, item.url) ?? Number.POSITIVE_INFINITY)
              > args.previewWidth)
            && isHigherBehanceSrcsetVariant(item, selectedDescriptor, args.previewWidth)))
        .filter((item) => adapter?.id === 'behance'
          || item.width === undefined || !args.previewWidth || item.width > args.previewWidth)
        .sort((left, right) => (right.width ?? right.density ?? 0) - (left.width ?? left.density ?? 0));
      for (const item of srcsetCandidates) {
        const stateWidth = adapter?.id === 'behance'
          ? behanceStateVariantWidth(siteRecord?.candidateWidths, item.url)
          : undefined;
        const width = stateWidth ?? item.width;
        add(item.url, 'srcset', {
          ...(width ? { width } : {}),
          ...(adapter?.id === 'behance' && identity.contentId ? { contentId: identity.contentId } : {}),
        });
      }
    }
  }

  const anchor = element.closest('a');
  const anchorUrl = anchor?.href;
  if (anchorUrl && URL_EXT.test(anchorUrl)) add(anchorUrl, 'site-field');

  if (kind === 'image' && adapter?.transform) {
    for (const url of adapter.transform(previewUrl, kind)) add(
      url,
      'known-transform',
      adapter.id === 'behance' && identity.contentId ? { contentId: identity.contentId } : {},
    );
    if (anchorUrl) {
      for (const url of adapter.transform(anchorUrl, kind)) add(
        url,
        'known-transform',
        adapter.id === 'behance' && identity.contentId ? { contentId: identity.contentId } : {},
      );
    }
  }
  for (const candidate of genericEngineCandidates(element.ownerDocument, previewUrl, kind)) {
    add(candidate.url, 'known-transform');
  }

  const evidenceAttributes = Object.fromEntries(
    [...element.attributes]
      .filter((attribute) => SAFE_ATTRIBUTE_NAMES.has(attribute.name.toLowerCase()))
      .slice(0, 12)
      .map((attribute) => [attribute.name.toLowerCase(), attribute.value.slice(0, 2_000)]),
  );
  const linkedDetail = anchorUrl && adapter
    ? detailPageUrlFromSiteAnchor(adapter.id, anchorUrl)
    : undefined;
  const detailPageUrl = siteRecord?.detailPageUrl ?? linkedDetail ?? pinterestPinLink?.href ?? (anchorUrl && !URL_EXT.test(anchorUrl) && isHttpUrl(anchorUrl)
    ? anchorUrl
    : undefined);
  candidates.push({
    url: previewUrl,
    kind,
    source: 'preview',
    ...(identity.contentId ? { contentId: identity.contentId } : {}),
    ...(identity.mediaKey ? { mediaKey: identity.mediaKey } : {}),
    ...(identity.mediaIndex === undefined ? {} : { mediaIndex: identity.mediaIndex }),
    ...(args.previewWidth ? { width: args.previewWidth } : {}),
    ...(args.previewHeight ? { height: args.previewHeight } : {}),
  });

  return {
    selectionId: args.selectionId ?? createId(),
    documentId: DOCUMENT_ID,
    ...(args.frameId === undefined ? {} : { frameId: args.frameId }),
    kind,
    previewUrl,
    pageUrl,
    ...(detailPageUrl ? { detailPageUrl } : {}),
    ...(videoPosterUrl ? { posterUrl: videoPosterUrl } : {}),
    ...(identity.contentId ? { contentId: identity.contentId } : {}),
    ...(identity.mediaKey ? { mediaKey: identity.mediaKey } : {}),
    ...(identity.mediaIndex === undefined ? {} : { mediaIndex: identity.mediaIndex }),
    ...(args.previewWidth ? { previewWidth: args.previewWidth } : {}),
    ...(args.previewHeight ? { previewHeight: args.previewHeight } : {}),
    ...(adapter ? { siteAdapter: adapter.id, siteCapability: adapter.capability } : {}),
    candidates,
    evidence: {
      tagName: element.tagName.toLowerCase(),
      ...(anchorUrl && isHttpUrl(anchorUrl) ? { anchorUrl } : {}),
      ...(Object.keys(evidenceAttributes).length > 0 ? { attributes: evidenceAttributes } : {}),
    },
  };
}

export function selectionForBackgroundImage(
  element: Element,
  url: string,
  pageUrl = element.ownerDocument.location?.href ?? '',
): MediaSelection {
  const adapter = siteAdapterForUrl(pageUrl);
  const candidates: MediaCandidate[] = [
    {
      url,
      kind: 'image',
      source: 'preview',
      ...(adapter === 'artstation' && artstationMediaKey(url) ? { mediaKey: artstationMediaKey(url) } : {}),
    },
  ];
  const site = SITE_ADAPTERS.find((entry) => entry.id === adapter);
  for (const candidate of site?.transform?.(url, 'image') ?? []) {
    const normalized = normalizeHttpUrl(candidate, element.ownerDocument.baseURI);
    if (normalized && !candidates.some((item) => item.url === normalized)) {
      candidates.unshift({
        url: normalized,
        kind: 'image',
        source: 'known-transform',
        ...(adapter === 'artstation' && artstationMediaKey(url) ? { mediaKey: artstationMediaKey(url) } : {}),
      });
    }
  }
  return {
    selectionId: createId(),
    documentId: DOCUMENT_ID,
    kind: 'image',
    previewUrl: url,
    pageUrl,
    ...(adapter ? {
      siteAdapter: adapter,
      siteCapability: site?.capability,
    } : {}),
    candidates,
    evidence: { tagName: element.tagName.toLowerCase() },
  };
}

function pinterestPinLinkForElement(element: Element): HTMLAnchorElement | undefined {
  const direct = element.closest('a[href*="/pin/"]');
  const card = element.closest('[data-test-id="pin"]');
  const links = card
    ? [...card.querySelectorAll<HTMLAnchorElement>('a[href*="/pin/"]')]
    : direct?.tagName.toLowerCase() === 'a' ? [direct as HTMLAnchorElement] : [];
  const matching = links.filter((link) => pinterestPinId(link.href));
  const uniqueIds = new Set(matching.map((link) => pinterestPinId(link.href)));
  return uniqueIds.size === 1 ? matching[0] : undefined;
}

function pinterestPinId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!isPinterestHostname(url.hostname)) return undefined;
    return /\/pin\/(\d{1,24})(?:[/?#]|$)/i.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function localEvidenceNodes(element: Element): Element[] {
  const result: Element[] = [element];
  const anchor = element.closest('a');
  if (anchor && anchor !== element && mediaDescendants(anchor) === 1) result.push(anchor);
  let current = element.parentElement;
  for (let level = 0; current && level < 4; level += 1) {
    if (mediaDescendants(current) !== 1) break;
    if (!result.includes(current)) result.push(current);
    current = current.parentElement;
  }
  return [...new Set(result)];
}

interface SiteResultMatch {
  readonly candidateUrls: readonly string[];
  readonly candidateWidths?: ReadonlyMap<string, number>;
  readonly candidateSource?: MediaCandidateSource;
  readonly contentId?: string;
  readonly mediaIndex?: number;
  readonly detailPageUrl?: string;
}

function siteResultForPreview(
  doc: Document,
  adapter: SiteAdapterId,
  previewUrl: string,
  kind: MediaKind,
  element: Element,
  contentId?: string,
  posterUrl?: string,
  previewWidth?: number,
): SiteResultMatch | undefined {
  if ((adapter === 'sogou-images' || adapter === '360-images') && kind !== 'image') return undefined;
  if (adapter === 'behance' && kind === 'image') {
    return behanceSiteRecordForPreview(
      doc,
      element,
      previewUrl,
      doc.location?.href ?? doc.baseURI,
      previewWidth,
    );
  }
  if (adapter === 'pinterest' && kind === 'video') {
    const matches = pinterestStructuredStatesForDocument(doc).flatMap((state) => {
      const match = pinterestVideoForSelection(state, {
        ...(contentId ? { contentId } : {}),
        ...(posterUrl ? { posterUrl } : {}),
      }, doc.baseURI);
      return match ? [match] : [];
    });
    const unique = new Map(matches.map((match) => [
      match.candidates.map((candidate) => candidate.url).join('\n'), match,
    ]));
    if (unique.size !== 1) return undefined;
    const match = [...unique.values()][0];
    return match ? {
      candidateUrls: match.candidates.map((candidate) => candidate.url),
      ...(contentId ? { contentId } : {}),
      ...(match.mediaIndex === undefined ? {} : { mediaIndex: match.mediaIndex }),
    } : undefined;
  }
  if (adapter === 'pinterest' && kind === 'image') {
    return pinterestSiteRecordForPreview(doc, previewUrl, contentId);
  }
  if (adapter === 'huaban' && kind === 'image') {
    return huabanSiteRecordForPreview(doc, element, previewUrl);
  }
  if ((adapter === 'zcool' && kind === 'image') || adapter === 'xiaohongshu' || adapter === 'instagram') {
    return structuredSiteRecordForPreview(doc, adapter, previewUrl, kind);
  }
  if (adapter !== 'sogou-images' && adapter !== '360-images') return undefined;
  const records = recordsForSite(doc, adapter);

  const matches = records.filter((record) => recordMatchesPreview(record, adapter, previewUrl, doc.baseURI));
  if (matches.length !== 1) return undefined;
  const record = matches[0];
  if (!record || typeof record !== 'object') return undefined;
  const indexRaw = Reflect.get(record, 'index');
  const mediaIndex = typeof indexRaw === 'number' && Number.isSafeInteger(indexRaw)
    ? indexRaw
    : typeof indexRaw === 'string' && /^\d+$/.test(indexRaw)
      ? Number(indexRaw)
      : undefined;
  if (adapter === 'sogou-images') {
    const original = firstString(record, ['oriPicUrl', 'picUrl']);
    const docId = firstString(record, ['docId']);
    const detail = firstString(record, ['url', 'link']);
    return {
      candidateUrls: original ? [original] : [],
      ...(docId ? { contentId: docId } : {}),
      ...(mediaIndex === undefined ? {} : { mediaIndex }),
      ...(detail && isHttpUrl(detail) ? { detailPageUrl: detail } : {}),
    };
  }
  const image = firstString(record, ['img']);
  const id = firstString(record, ['id']);
  const detail = firstString(record, ['link']);
  return {
    candidateUrls: image ? [image] : [],
    ...(id ? { contentId: id } : {}),
    ...(mediaIndex === undefined ? {} : { mediaIndex }),
    ...(detail && isHttpUrl(detail) ? { detailPageUrl: detail } : {}),
  };
}

function structuredSiteRecordForPreview(
  doc: Document,
  adapter: 'zcool' | 'xiaohongshu' | 'instagram',
  previewUrl: string,
  kind: MediaKind,
): SiteResultMatch | undefined {
  const parsed = parsedStructuredPageState(doc, adapter);
  if (parsed === undefined) return undefined;
  const records = adapter === 'zcool'
    ? findNamedArrays(parsed, new Set(['productimages']))
    : adapter === 'xiaohongshu' && kind === 'image'
      ? findNamedArrays(parsed, new Set(['imagelist']))
      : adapter === 'xiaohongshu'
        ? findNamedObjects(parsed, new Set(['stream', 'video']))
        : collectImageVideoRecords(parsed, kind);
  const matching = records.flatMap((record, index) => {
    const urls: string[] = [];
    collectObjectUrls(record.value, urls, 0);
    const localUrls = urls.map((url) => normalizeHttpUrl(url, doc.baseURI)).filter(isString);
    if (!localUrls.some((url) => samePreviewResource(url, previewUrl, doc.baseURI))) return [];
    const candidates = [...new Set(localUrls)]
      .filter((url) => url !== previewUrl && urlKindCompatible(url, kind));
    if (candidates.length === 0) return [];
    return [{ record: record.value, candidates, index: record.index ?? index, size: localUrls.length }];
  });
  const smallestSize = Math.min(...matching.map((item) => item.size));
  const smallest = matching.filter((item) => item.size === smallestSize);
  if (smallest.length !== 1) return undefined;
  const match = smallest[0];
  if (!match) return undefined;
  const object = match.record && typeof match.record === 'object' ? match.record : undefined;
  const contentId = object
    ? firstString(object, ['id', 'docId', 'noteId', 'pk', 'media_id'])
    : undefined;
  const indexRaw = object
    ? Reflect.get(object, 'index') ?? Reflect.get(object, 'position')
    : undefined;
  const mediaIndex = typeof indexRaw === 'number' && Number.isSafeInteger(indexRaw)
    ? indexRaw
    : typeof indexRaw === 'string' && /^\d+$/.test(indexRaw)
      ? Number(indexRaw)
      : match.index;
  const detail = object ? firstString(object, ['url', 'link']) : undefined;
  return {
    candidateUrls: match.candidates,
    ...(contentId ? { contentId } : {}),
    ...(mediaIndex === undefined ? {} : { mediaIndex }),
    ...(detail && isHttpUrl(detail) ? { detailPageUrl: detail } : {}),
  };
}

function parsedStructuredPageState(
  doc: Document,
  adapter: 'zcool' | 'xiaohongshu' | 'instagram' | 'huaban',
): unknown {
  const markers = adapter === 'zcool' || adapter === 'huaban'
    ? ['#__NEXT_DATA__']
    : adapter === 'xiaohongshu'
      ? ['__INITIAL_STATE__']
      : ['__additionalDataLoaded', '_sharedData', 'image_versions2', 'video_versions'];
  const cacheAdapter: SiteAdapterId = adapter;
  const cache = getSiteDocumentCache(doc);
  const remembered = cache.entries.get(cacheAdapter);
  let script = remembered?.script;
  if (!script?.isConnected) {
    script = adapter === 'zcool' || adapter === 'huaban'
      ? doc.querySelector<HTMLScriptElement>('script#__NEXT_DATA__') ?? undefined
      : [...doc.scripts].find((item) => markers.some((marker) => item.textContent?.includes(marker))) ?? undefined;
  }
  if (!script) return undefined;
  if (remembered?.script === script) return remembered.records[0];
  if (!cache.observed.has(script) && cache.observer) {
    cache.observed.add(script);
    cache.observer.observe(script, { characterData: true, childList: true, subtree: true });
  }
  const source = script.textContent ?? '';
  let parsed: unknown;
  if (adapter === 'zcool' || adapter === 'huaban') {
    try { parsed = JSON.parse(source) as unknown; } catch { parsed = parseAssignedJson(source, ''); }
  } else if (adapter === 'xiaohongshu') {
    parsed = parseAssignedJson(source, '__INITIAL_STATE__');
  } else {
    parsed = markers.map((marker) => parseAssignedJson(source, marker)).find((item) => item !== undefined);
  }
  const records = parsed === undefined ? [] : [parsed];
  cache.entries.set(cacheAdapter, { script, records });
  return parsed;
}

function huabanSiteRecordForPreview(
  doc: Document,
  element: Element,
  previewUrl: string,
): SiteResultMatch | undefined {
  const pinId = huabanPinIdForElement(doc, element);
  if (!pinId) return undefined;
  const state = parsedStructuredPageState(doc, 'huaban');
  const candidate = huabanOriginalCandidateForState(state, pinId, previewUrl, doc.baseURI);
  if (!candidate) return undefined;
  return {
    candidateUrls: [candidate.url],
    candidateSource: candidate.source,
    contentId: pinId,
  };
}

function huabanPinIdForElement(doc: Document, element: Element): string | undefined {
  const anchor = element.closest('a[href*="/pins/"]');
  const href = anchor?.getAttribute('href') ?? doc.location?.href;
  if (!href) return undefined;
  try {
    const url = new URL(href, doc.baseURI);
    if (!isHuabanSiteHostname(url.hostname)) return undefined;
    return /^\/pins\/(\d+)\/?$/i.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function isHuabanSiteHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'huaban.com' || host.endsWith('.huaban.com');
}

function pinterestSiteRecordForPreview(doc: Document, previewUrl: string, expectedContentId?: string): SiteResultMatch | undefined {
  const states = pinterestStructuredStatesForDocument(doc);
  if (states.length === 0) return undefined;
  const matching = new Map<string, ReturnType<typeof findPinterestImageRecords>[number]>();
  for (const record of states.flatMap(findPinterestImageRecords)) {
    if (expectedContentId && record.contentId !== expectedContentId) continue;
    if (!record.previewUrls.some((url) => samePreviewResource(url, previewUrl, doc.baseURI))) continue;
    const candidateUrl = normalizeHttpUrl(record.originalUrl, doc.baseURI);
    if (!candidateUrl || !isPinterestOriginalImageUrl(candidateUrl)) continue;
    const existing = matching.get(candidateUrl);
    if (!existing || (!existing.contentId && record.contentId)) matching.set(candidateUrl, record);
  }
  if (matching.size !== 1) return undefined;
  const [matchedUrl, match] = [...matching.entries()][0] ?? [];
  if (!matchedUrl || !match) return undefined;
  const originalUrl = matchedUrl;
  if (
    !originalUrl || originalUrl === previewUrl || !urlKindCompatible(originalUrl, 'image')
    || !isPinterestOriginalImageUrl(originalUrl)
  ) return undefined;
  return {
    candidateUrls: [originalUrl],
    ...(match.contentId ? { contentId: match.contentId } : {}),
  };
}

function findPinterestImageRecords(value: unknown): Array<{
  originalUrl: string;
  previewUrls: string[];
  contentId?: string;
}> {
  const found: Array<{
    originalUrl: string;
    previewUrls: string[];
    contentId?: string;
  }> = [];
  const visit = (current: unknown, depth: number): void => {
    if (depth > 12 || found.length > 500) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const entries = Object.entries(current).slice(0, 200);
    const flatOriginal = entries.find(([key]) => key.toLowerCase() === 'images_orig')?.[1];
    const imageVariants = entries.flatMap(([key, item]) => (
      /^(?:images_\d+x(?:\d+)?|imageSpec_\d+x)$/i.test(key)
        ? [{ name: key.replace(/^images_/i, ''), value: item }]
        : []
    ));
    const nestedImages = entries.find(([key]) => key.toLowerCase() === 'images')?.[1];
    if (nestedImages && typeof nestedImages === 'object' && !Array.isArray(nestedImages)) {
      imageVariants.push(...Object.entries(nestedImages).flatMap(([name, item]) => (
        /^(?:\d+x(?:\d+)?(?:_[a-z0-9]+)?|imageSpec_\d+x)$/i.test(name)
          ? [{ name, value: item }]
          : []
      )));
    }
    const nestedOriginal = nestedImages && typeof nestedImages === 'object' && !Array.isArray(nestedImages)
      ? Reflect.get(nestedImages, 'orig') ?? Reflect.get(nestedImages, 'original')
      : undefined;
    const originalUrl = pinterestImageUrl(flatOriginal ?? nestedOriginal);
    if (originalUrl) {
      const previewUrls = imageVariants
        .filter(({ name }) => !/^(?:orig|original)$/i.test(name))
        .flatMap(({ value: variant }) => {
          const url = pinterestImageUrl(variant);
          return url ? [url] : [];
        });
      if (previewUrls.length > 0) {
        const contentId = firstString(current, ['entityId', 'id', 'pinId']);
        found.push({ originalUrl, previewUrls, ...(contentId ? { contentId } : {}) });
      }
    }
    for (const [, child] of entries) {
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

function pinterestImageUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return firstString(value, ['url']);
  }
  return undefined;
}

function behanceSiteRecordForPreview(
  doc: Document,
  element: Element,
  previewUrl: string,
  pageUrl: string,
  previewWidth?: number,
): SiteResultMatch | undefined {
  const target = behanceTargetForElement(element, pageUrl);
  if (!target) return undefined;
  const match = behanceCandidatesForState(doc, target, previewUrl, previewWidth);
  return {
    candidateUrls: match?.urls ?? [],
    candidateWidths: match?.widths,
    candidateSource: 'site-field',
    contentId: match?.contentId ?? target.contentId,
  };
}

function isHigherBehanceSrcsetVariant(
  candidate: SrcsetCandidate,
  selected: SrcsetCandidate | undefined,
  previewWidth: number | undefined,
): boolean {
  if (candidate.width !== undefined && selected?.width !== undefined) {
    return candidate.width > selected.width;
  }
  if (candidate.density !== undefined && selected?.density !== undefined) {
    return candidate.density > selected.density;
  }
  if (candidate.width !== undefined && selected === undefined && previewWidth !== undefined) {
    return candidate.width > previewWidth;
  }
  return false;
}

function isPinterestOriginalImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === 'pinimg.com' || url.hostname.endsWith('.pinimg.com'))
      && /^\/originals\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function pinterestStructuredStatesForDocument(doc: Document): unknown[] {
  const adapter: SiteAdapterId = 'pinterest';
  const marker = '__PWS_RELAY_REGISTER_COMPLETED_REQUEST__';
  const structuredScriptIds = ['__PWS_INITIAL_PROPS__', '__PWS_DATA__', '__PWS_ROUTES__'];
  const scripts = [...doc.scripts].filter((script) => (
    structuredScriptIds.includes(script.id) || script.textContent?.includes(marker)
  )).slice(0, 200);
  if (scripts.length === 0) return [];

  const cache = getSiteDocumentCache(doc);
  const remembered = cache.entries.get(adapter);
  if (
    remembered?.scripts?.length === scripts.length
    && remembered.scripts.every((script, index) => script === scripts[index])
  ) return remembered.records;

  const states: unknown[] = [];
  for (const script of scripts) {
    if (!cache.observed.has(script) && cache.observer) {
      cache.observed.add(script);
      cache.observer.observe(script, { characterData: true, childList: true, subtree: true });
    }
    const source = script.textContent ?? '';
    if (source.length > 2_000_000) continue;
    let parsed: unknown;
    if (structuredScriptIds.includes(script.id)) {
      try { parsed = JSON.parse(source) as unknown; } catch { parsed = undefined; }
    } else {
      parsed = parseAssignedJson(source, marker);
    }
    if (parsed !== undefined) states.push(parsed);
  }
  const firstScript = scripts[0];
  if (firstScript) cache.entries.set(adapter, { script: firstScript, records: states, scripts });
  return states;
}

function findNamedArrays(value: unknown, keys: ReadonlySet<string>): Array<{ value: unknown; index?: number }> {
  const found: Array<{ value: unknown; index?: number }> = [];
  const visit = (current: unknown, depth: number): void => {
    if (depth > 12 || found.length > 500) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current).slice(0, 200)) {
      if (keys.has(key.toLowerCase()) && Array.isArray(child)) {
        child.forEach((item, index) => found.push({ value: item, index }));
      } else if (child && typeof child === 'object') {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return found;
}

function collectImageVideoRecords(
  value: unknown,
  kind: MediaKind,
): Array<{ value: unknown; index?: number }> {
  const recordFields = kind === 'image'
    ? new Set(['display_url', 'image_versions2', 'url_default', 'urldefault', 'image_url'])
    : new Set(['video_versions', 'video_resources', 'video_url', 'master_url', 'masterurl', 'play_url']);
  const mediaLists = new Set(['sidecar_children', 'carousel_media', 'media', 'items', 'image_list']);
  const found: Array<{ value: unknown; index?: number }> = [];
  const visit = (current: unknown, depth: number): void => {
    if (depth > 12 || found.length > 500) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const entries = Object.entries(current).slice(0, 200);
    if (entries.some(([key]) => recordFields.has(key.toLowerCase()))) found.push({ value: current });
    for (const [key, child] of entries) {
      if (mediaLists.has(key.toLowerCase()) && Array.isArray(child)) {
        child.slice(0, 200).forEach((item, index) => {
          if (item && typeof item === 'object') found.push({ value: item, index });
          visit(item, depth + 1);
        });
      } else if (child && typeof child === 'object') {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return found;
}

function findNamedObjects(value: unknown, keys: ReadonlySet<string>): Array<{ value: unknown; index?: number }> {
  const found: Array<{ value: unknown; index?: number }> = [];
  const visit = (current: unknown, depth: number): void => {
    if (depth > 12 || found.length > 500) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 200)) visit(item, depth + 1);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current).slice(0, 200)) {
      if (keys.has(key.toLowerCase()) && child && typeof child === 'object') found.push({ value: child });
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

function recordsForSite(doc: Document, adapter: SiteAdapterId): unknown[] {
  const cache = getSiteDocumentCache(doc);
  const script = adapter === '360-images'
    ? doc.querySelector<HTMLScriptElement>('script#initData')
    : [...doc.scripts].find((item) => item.textContent?.includes('__INITIAL_STATE__')) ?? null;
  const cached = cache.entries.get(adapter);
  if (cached && script === cached.script) return cached.records;
  if (!script) return [];
  if (!cache.observed.has(script) && cache.observer) {
    cache.observed.add(script);
    cache.observer.observe(script, { characterData: true, childList: true, subtree: true });
  }
  let data: unknown;
  if (adapter === 'sogou-images') {
    const state = script.textContent ? parseAssignedJson(script.textContent, '__INITIAL_STATE__') : undefined;
    data = getPath(state, ['searchList', 'searchList']);
  } else {
    const parsed = script.textContent ? parseAssignedJson(script.textContent, '') : undefined;
    data = parsed && typeof parsed === 'object' ? Reflect.get(parsed, 'list') : undefined;
  }
  const records = Array.isArray(data) ? data : [];
  cache.entries.set(adapter, { script, records });
  return records;
}

function getSiteDocumentCache(doc: Document): {
  entries: Map<SiteAdapterId, {
    script: HTMLScriptElement;
    records: unknown[];
    scripts?: readonly HTMLScriptElement[];
  }>;
  observer?: MutationObserver;
  observed: Set<HTMLScriptElement>;
} {
  const existing = SITE_DOCUMENT_CACHES.get(doc);
  if (existing) return existing;
  const cache: {
    entries: Map<SiteAdapterId, {
      script: HTMLScriptElement;
      records: unknown[];
      scripts?: readonly HTMLScriptElement[];
    }>;
    observer?: MutationObserver;
    observed: Set<HTMLScriptElement>;
  } = {
    entries: new Map(),
    observed: new Set(),
  };
  if (typeof MutationObserver === 'function') {
    cache.observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof HTMLScriptElement ? record.target : record.target.parentElement;
        if (!(target instanceof HTMLScriptElement)) continue;
        for (const [adapter, entry] of cache.entries) {
          if (entry.script === target || entry.scripts?.includes(target)) cache.entries.delete(adapter);
        }
      }
    });
  }
  SITE_DOCUMENT_CACHES.set(doc, cache);
  return cache;
}

function parseAssignedJson(source: string, marker: string): unknown {
  if (source.length > 2_000_000) return undefined;
  let start = marker ? source.indexOf(marker) : 0;
  if (start < 0) return undefined;
  start = source.indexOf('{', start + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function firstString(value: object, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const result = Reflect.get(value, key);
    if (typeof result === 'string' && result.length > 0) return result;
  }
  return undefined;
}

function recordMatchesPreview(
  value: unknown,
  adapter: SiteAdapterId,
  previewUrl: string,
  baseUrl: string,
): boolean {
  if (!value || typeof value !== 'object') return false;
  const keys = adapter === 'sogou-images'
    ? ['thumbUrl', 'picUrl', 'oriPicUrl']
    : ['thumb', 'thumb_bak', '_thumb', '_thumb_bak', 'img'];
  for (const key of keys) {
    const raw = Reflect.get(value, key);
    if (typeof raw !== 'string') continue;
    if (samePreviewResource(raw, previewUrl, baseUrl)) return true;
  }
  if (adapter === 'sogou-images') {
    const mfId = Reflect.get(value, 'mf_id');
    return typeof mfId === 'string' && previewBasename(previewUrl) === mfId.toLowerCase();
  }
  return false;
}

function samePreviewResource(candidate: string, previewUrl: string, baseUrl: string): boolean {
  const candidateUrl = normalizeHttpUrl(candidate, baseUrl);
  const preview = normalizeHttpUrl(previewUrl, baseUrl);
  if (!candidateUrl || !preview) return false;
  if (candidateUrl === preview) return true;
  const left = previewBasename(candidateUrl);
  const right = previewBasename(preview);
  return Boolean(left && right && left === right);
}

function previewBasename(value: string): string {
  try {
    const filename = new URL(value).pathname.split('/').filter(Boolean).pop() ?? '';
    const key = filename.replace(/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i, '')
      .replace(/(?:_thumb|_thumbnail|_small|_medium|_large|_\d+x)$/i, '')
      .toLowerCase();
    return /^(?:thumb|thumbnail|small|medium|large|image|original|default|preview|cover|avatar)$/i.test(key)
      ? ''
      : key;
  } catch {
    return '';
  }
}

function mediaDescendants(element: Element): number {
  return element.querySelectorAll('img,video').length;
}

function normalizeHttpUrl(value: string, baseUrl: string): string | undefined {
  const decoded = decodeEscapedUrl(value.trim());
  try {
    const url = new URL(decoded, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function decodeEscapedUrl(value: string): string {
  const slashNormalized = value.replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  try {
    if (/^https?%3a/i.test(slashNormalized)) return decodeURIComponent(slashNormalized);
    return slashNormalized;
  } catch {
    return slashNormalized;
  }
}

function urlsFromAttribute(value: string, name: string, baseUrl: string): string[] {
  if (value.length > 100_000) return [];
  if (name === 'm' || name === 'data-state' || name === 'data-item' || name === 'data-media') return [];
  return extractUrls(value, baseUrl);
}

function sameCardFieldUrls(value: string, baseUrl: string, kind: MediaKind): string[] {
  if (value.length > 100_000) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const fieldNames = kind === 'image'
      ? ['murl', 'imgurl', 'origurl', 'imageurl']
      : ['videourl', 'video_url', 'masterurl', 'playurl'];
    const found: string[] = [];
    for (const [key, child] of Object.entries(parsed)) {
      if (typeof child !== 'string' || !fieldNames.includes(key.toLowerCase())) continue;
      found.push(...extractUrls(child, baseUrl));
    }
    return found.filter((url) => urlKindCompatible(url, kind));
  } catch {
    return [];
  }
}

function collectObjectUrls(value: unknown, found: string[], depth: number): void {
  if (depth > 8 || found.length > 40) return;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 80)) collectObjectUrls(child, found, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (typeof child === 'string' && (MEDIA_FIELD.test(key) || URL_FIELD.test(key))) {
      found.push(...extractUrls(child, 'https://invalid.local/'));
    } else if (child && typeof child === 'object') {
      collectObjectUrls(child, found, depth + 1);
    }
  }
}

function structuredCandidates(
  value: string,
  contentId: string,
  previewUrl: string,
  baseUrl: string,
): string[] {
  if (!value || value.length > 100_000 || !value.includes(contentId)) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    const all: string[] = [];
    collectObjectUrls(parsed, all, 0);
    const previewKey = assetKey(previewUrl);
    const matches = [...new Set(all)]
      .map((url) => normalizeHttpUrl(url, baseUrl))
      .filter(isString)
      .filter((url) => url !== previewUrl && assetKey(url) === previewKey);
    return matches.length === 1 ? matches : [];
  } catch {
    return [];
  }
}

function extractUrls(value: string, baseUrl: string): string[] {
  const normalized = decodeEscapedUrl(value);
  const matches = normalized.match(/(?:https?:\/\/|\/\/|\/)[^\s"'<>\\]+/g) ?? [];
  return [...new Set(matches.map((match) => match.replace(/[),;]+$/, '')))]
    .map((match) => normalizeHttpUrl(match, baseUrl))
    .filter(isString);
}

function identityFromSelection(pageUrl: string, previewUrl: string, element: Element): {
  contentId?: string;
  mediaKey?: string;
  mediaIndex?: number;
} {
  const identityNodes: Element[] = [element];
  let parent = element.parentElement;
  for (let level = 0; parent && level < 3; level += 1) {
    if (mediaDescendants(parent) !== 1) break;
    identityNodes.push(parent);
    parent = parent.parentElement;
  }
  const idValues = identityNodes.flatMap((node) => [
    ...[...node.attributes]
      .filter((attribute) => /^(?:data-(?:id|docid|tbnid|media-key|object-id|pin-id|post-id)|data-id)$/i.test(attribute.name))
      .map((attribute) => attribute.value),
  ]).filter(Boolean);
  const text = `${pageUrl} ${previewUrl} ${element.closest('a')?.href ?? ''} ${idValues.join(' ')}`;
  const patterns = [
    /\/pin\/(\d+)/i,
    /\/artworks\/(\d+)/i,
    /\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i,
    /\/(?:statuses|status)\/(\d+)/i,
    /\/status\/(\d+)/i,
  ];
  let contentId: string | undefined;
  for (const pattern of patterns) {
    contentId = pattern.exec(text)?.[1];
    if (contentId) break;
  }
  const elementIndex = identityNodes.flatMap((node) => [
    node.getAttribute('data-index'),
    node.getAttribute('data-media-index'),
    node.getAttribute('data-idx'),
  ]).find((value) => value && /^\d+$/.test(value));
  const pixivIndex = /_p(\d+)\./i.exec(previewUrl)?.[1];
  const mediaKey = identityNodes.map((node) =>
    node.getAttribute('data-media-key') ?? node.getAttribute('media_key'),
  ).find((value) => value && /^\d+_\d{1,32}$/.test(value));
  const pageIndex = /[?&](?:index|media|page)=(\d+)/i.exec(pageUrl)?.[1];
  const indexValue = pixivIndex ?? elementIndex ?? pageIndex;
  return {
    ...(contentId ? { contentId } : {}),
    ...(mediaKey ? { mediaKey } : {}),
    ...(indexValue && Number.isSafeInteger(Number(indexValue))
      ? { mediaIndex: Math.max(0, Number(indexValue) - (pixivIndex ? 1 : 0)) }
      : {}),
  };
}

function identityFromXSelection(pageUrl: string, element: Element): {
  contentId?: string;
  mediaKey?: string;
  mediaIndex?: number;
  ambiguousStatus?: boolean;
} {
  const tweet = element.closest('[data-testid="tweet"]') ?? element.closest('article');
  const statusIds = tweet
    ? [...tweet.querySelectorAll('a[href*="/status/"]')]
      .flatMap((anchor) => {
        try {
          const href = anchor.getAttribute('href');
          if (!href) return [];
          const match = /\/status\/(\d{1,24})(?:[/?#]|$)/.exec(new URL(href, pageUrl).pathname);
          return match?.[1] ? [match[1]] : [];
        } catch { return []; }
      })
    : [];
  const uniqueStatusIds = [...new Set(statusIds)];
  let contentId = uniqueStatusIds.length === 1 ? uniqueStatusIds[0] : undefined;
  if (uniqueStatusIds.length === 0) {
    try { contentId = /\/status\/(\d{1,24})(?:[/?#]|$)/.exec(new URL(pageUrl).pathname)?.[1]; } catch { /* No status route. */ }
  }

  const mediaSlots = tweet ? [...tweet.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]')] : [];
  const selectedSlot = element.closest('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
  const slotIndex = selectedSlot ? mediaSlots.indexOf(selectedSlot) : -1;
  const mediaKey = [element, selectedSlot].flatMap((node) => node ? [
    node.getAttribute('data-media-key'),
    node.getAttribute('media_key'),
  ] : []).find((value) => value && /^\d+_\d{1,32}$/.test(value));
  const explicitIndex = [element, selectedSlot].flatMap((node) => node ? [
    node.getAttribute('data-media-index'),
    node.getAttribute('data-index'),
    node.getAttribute('data-idx'),
  ] : []).find((value) => value && /^\d+$/.test(value));
  const mediaIndex = explicitIndex && Number.isSafeInteger(Number(explicitIndex))
    ? Number(explicitIndex)
    : slotIndex >= 0 ? slotIndex : undefined;
  return {
    ...(contentId ? { contentId } : {}),
    ...(mediaKey ? { mediaKey } : {}),
    ...(mediaIndex === undefined ? {} : { mediaIndex }),
    ...(uniqueStatusIds.length > 1 ? { ambiguousStatus: true } : {}),
  };
}

function assetKey(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.split('/').filter(Boolean).pop()?.replace(/(?:_[0-9]+x|_\d+w|\.(?:jpg|png|webp|avif))$/i, '').toLowerCase() ?? '';
  } catch {
    return '';
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function urlKindCompatible(value: string, kind: MediaKind): boolean {
  try {
    const path = new URL(value).pathname;
    const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path);
    const video = /\.(?:mp4|m4v|webm|mov|m3u8|mpd)$/i.test(path);
    return !(kind === 'image' ? video : image);
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function queryUrlCandidates(value: string, keys: readonly string[]): string[] {
  try {
    const url = new URL(value);
    const found = keys.flatMap((key) => {
      const candidate = url.searchParams.get(key);
      return candidate ? [candidate] : [];
    });
    return found.flatMap((candidate) => extractUrls(candidate, value));
  } catch {
    return [];
  }
}

function duckDuckGoCandidates(value: string): string[] {
  try {
    const url = new URL(value);
    // /iu/ wraps DDG's Bing thumbnail and is the preview itself, not an original.
    if (url.hostname === 'external-content.duckduckgo.com' && url.pathname === '/iu/') return [];
    return queryUrlCandidates(value, ['image']);
  } catch {
    return [];
  }
}

function detailPageUrlFromSiteAnchor(adapter: SiteAdapterId, value: string): string | undefined {
  const queryKeys = adapter === 'google-images'
    ? ['imgrefurl']
    : adapter === 'bing-images'
      ? ['purl', 'url']
      : adapter === 'duckduckgo-images'
        ? ['url', 'source']
        : [];
  try {
    const anchor = new URL(value);
    for (const key of queryKeys) {
      const candidate = anchor.searchParams.get(key);
      if (candidate && isHttpUrl(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function baiduCandidates(value: string): string[] {
  const query = queryUrlCandidates(value, ['objurl', 'imgurl', 'url']);
  const proxy = /\/it\/u=([^&/]+)/i.exec(value)?.[1];
  if (!proxy) return query;
  const decoded = decodeEscapedUrl(proxy.replace(/%2f/gi, '/'));
  const target = normalizeHttpUrl(decoded, value);
  return target ? [target, ...query] : query;
}

function pinterestCandidates(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.hostname !== 'pinimg.com' && !url.hostname.endsWith('.pinimg.com')) return [];
    const next = url.pathname.replace(/\/(?:\d{1,5}x(?:\d{1,5})?(?:_[a-z0-9]+)?|orig|original|originals)\//i, '/originals/');
    return next === url.pathname ? [] : [`${url.origin}${next}${url.search}${url.hash}`];
  } catch {
    return [];
  }
}

function isPinterestHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return /(?:^|\.)pinterest\.(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/.test(host);
}

function behanceCandidates(value: string): string[] {
  return behanceOriginalPath(value);
}

function dribbbleCandidates(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.hostname !== 'dribbble.com' && !url.hostname.endsWith('.dribbble.com')) return [];
    const candidates: string[] = [];
    const resize = url.searchParams.get('resize');
    if ((url.hostname === 'cdn.dribbble.com' || url.hostname.endsWith('.cdn.dribbble.com'))
      && resize && /^\d{1,5}x\d{0,5}$/i.test(resize)) {
      const unscaled = new URL(url.href);
      unscaled.searchParams.delete('resize');
      // This option controls positioning within the resized output, so drop it
      // only when removing the evidenced resize operation. Preserve all other
      // query parameters, including any CDN token or format selector.
      unscaled.searchParams.delete('vertical');
      if (unscaled.href !== url.href) candidates.push(unscaled.href);
    }
    const nextPath = url.pathname.replace(/_(?:teaser|1x|2x)(?=\.[^/.]+$)/i, '');
    if (nextPath !== url.pathname) {
      const next = new URL(url.href);
      next.pathname = nextPath;
      candidates.push(next.href);
    }
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

function weiboCandidates(value: string): string[] {
  try {
    const url = new URL(value);
    if (!/(?:sinaimg|weibocdn)\./i.test(url.hostname)) return [];
    const next = url.pathname.replace(/\/(?:thumb\d*|orj\d*|mw\d*|crop[^/]*)\//i, '/large/');
    return next === url.pathname ? [] : [`${url.origin}${next}${url.search}${url.hash}`];
  } catch {
    return [];
  }
}

function pixivCandidates(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.hostname !== 'i.pximg.net' || !url.pathname.includes('/img-master/')) return [];
    const next = url.pathname
      .replace('/img-master/', '/img-original/')
      .replace(/_master\d+(?=\.[^.]+$)/i, '');
    return next === url.pathname ? [] : [`${url.origin}${next}${url.search}${url.hash}`];
  } catch {
    return [];
  }
}

function xCandidates(value: string): string[] {
  try {
    const url = new URL(value);
    if (url.hostname !== 'pbs.twimg.com' || !url.pathname.includes('/media/')) return [];
    const name = url.searchParams.get('name');
    if (!name || !/^(?:small|medium|large|orig|\d+x\d+|thumb)$/i.test(name)) return [];
    url.searchParams.set('name', 'orig');
    return [url.href];
  } catch {
    return [];
  }
}
