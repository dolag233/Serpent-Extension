export interface PageBridgeImageRecord {
  readonly contentId: string;
  readonly urls: readonly string[];
}

export interface PageBridgeXVideoRecord {
  readonly contentId: string;
  readonly mediaKey: string;
  readonly mediaIndex: number;
  readonly previewUrls: readonly string[];
  readonly urls: readonly string[];
}

export type PageBridgeAdapter =
  | 'google-images'
  | 'duckduckgo-images'
  | 'yandex-images'
  | 'x-status-media';

export interface PageBridgeRequest {
  readonly type: 'serpent-page-bridge-request';
  readonly requestId: string;
  readonly adapter: PageBridgeAdapter;
  readonly contentId: string;
  readonly previewUrl: string;
  readonly pageUrl: string;
  readonly kind?: 'image' | 'video';
  readonly mediaIndex?: number;
  readonly mediaKey?: string;
}

export interface PageBridgeResponse {
  readonly type: 'serpent-page-bridge-response';
  readonly requestId: string;
  readonly adapter: PageBridgeAdapter;
  readonly contentId: string;
  readonly previewUrl: string;
  readonly urls: readonly string[];
  readonly kind?: 'image' | 'video';
  readonly mediaIndex?: number;
}

const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const MAX_RECORDS = 1_000;
const MAX_URLS_PER_RECORD = 8;
const MAX_X_TWEETS = 500;
const MAX_X_MEDIA_PER_TWEET = 16;
const MAX_X_OBJECTS_VISITED = 20_000;

/** Parse Google's paired thumbnail/original tuples without retaining the response body. */
export function parseGoogleImageRecords(text: string): PageBridgeImageRecord[] {
  if (text.length > MAX_RESPONSE_CHARS) return [];
  const decoded = text
    .replace(/\\u003a/gi, ':')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
  const records = new Map<string, Set<string>>();
  const tuple = /"([A-Za-z0-9_-]{5,100})"\s*,\s*\[\s*"((?:https?:\/\/|\/\/)[^"\\]{1,4096})"\s*,\s*\d+\s*,\s*\d+\s*\]\s*,\s*\[\s*"((?:https?:\/\/|\/\/)[^"\\]{1,4096})"\s*,\s*\d+\s*,\s*\d+\s*\]/g;
  for (const match of decoded.matchAll(tuple)) {
    const contentId = match[1];
    const original = normalizeHttp(match[3]);
    if (!contentId || !original) continue;
    const urls = records.get(contentId) ?? new Set<string>();
    urls.add(original);
    records.set(contentId, urls);
    if (records.size >= MAX_RECORDS) break;
  }
  return [...records].map(([contentId, urls]) => ({
    contentId,
    urls: [...urls].slice(0, MAX_URLS_PER_RECORD),
  }));
}

/** Parse only the explicit result records returned by DuckDuckGo's /i.js endpoint. */
export function parseDuckDuckGoImageRecords(text: string): PageBridgeImageRecord[] {
  if (text.length > MAX_RESPONSE_CHARS) return [];
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  return parseDuckDuckGoImageRecordsFromValue(value);
}

export function parseDuckDuckGoImageRecordsFromValue(value: unknown): PageBridgeImageRecord[] {
  const results = value && typeof value === 'object' ? Reflect.get(value, 'results') : undefined;
  if (!Array.isArray(results)) return [];
  const records: PageBridgeImageRecord[] = [];
  for (const item of results.slice(0, MAX_RECORDS)) {
    if (!item || typeof item !== 'object') continue;
    const thumbnail = firstString(item, ['thumbnail', 'thumbnail_url']);
    const id = firstString(item, ['id']) ?? (thumbnail ? thumbnailId(thumbnail) : undefined);
    const image = firstString(item, ['image']);
    const url = image ? normalizeHttp(image) : undefined;
    if (!id || !url) continue;
    records.push({ contentId: id, urls: [url] });
  }
  return records;
}

/** Index Yandex entities by their result thumbnail id and keep only that entity's media fields. */
export function parseYandexImageRecords(value: unknown): PageBridgeImageRecord[] {
  const entities: Array<{ key: string; value: Record<string, unknown> }> = [];
  collectYandexEntities(value, entities, 0);
  const records: PageBridgeImageRecord[] = [];
  for (const { key, value: entity } of entities.slice(0, MAX_RECORDS)) {
    const image = firstString(entity, ['image']);
    const id = image ? thumbnailId(image) : key;
    if (!id) continue;
    const urls = new Set<string>();
    for (const raw of [
      entity.origUrl,
      readObjectString(entity.viewerData, 'img_href'),
    ]) {
      if (typeof raw === 'string') {
        const url = normalizeHttp(raw);
        if (url) urls.add(url);
      }
    }
    for (const list of [
      entity.dups,
      entity.preview,
      readObject(entity.viewerData, 'dups'),
      readObject(entity.viewerData, 'preview'),
    ]) {
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, MAX_URLS_PER_RECORD)) {
        const raw = readObjectString(item, 'url');
        const url = raw ? normalizeHttp(raw) : undefined;
        if (url && !/avatars\.mds\.yandex\.net\/get-yapic/i.test(url)) urls.add(url);
      }
    }
    if (urls.size > 0) {
      records.push({ contentId: id, urls: [...urls].slice(0, MAX_URLS_PER_RECORD) });
    }
  }
  return records;
}

/**
 * Extract only video variants nested in each X Tweet's own media record.
 * The result keeps status ID, media key, and the media-array ordinal together
 * so callers never rank variants across unrelated Tweets or attachments.
 */
export function parseXStatusVideoRecords(value: unknown): PageBridgeXVideoRecord[] {
  const tweets: Array<{ statusId: string; tweet: Record<string, unknown> }> = [];
  let visited = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > 24 || visited >= MAX_X_OBJECTS_VISITED || !current || typeof current !== 'object') return;
    visited += 1;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 500)) visit(item, depth + 1);
      return;
    }
    const object = current as Record<string, unknown>;
    const legacy = objectValue(object.legacy);
    const statusId = firstNumericId(object.rest_id)
      ?? firstNumericId(legacy?.id_str)
      ?? firstNumericId(object.id_str);
    const media = readObject(legacy, 'extended_entities') ?? readObject(object, 'extended_entities');
    if (statusId && media && typeof media === 'object') {
      const items = readObject(media, 'media');
      if (Array.isArray(items)) tweets.push({ statusId, tweet: object });
    }
    for (const child of Object.values(object).slice(0, 250)) {
      if (child && typeof child === 'object') visit(child, depth + 1);
    }
  };
  visit(value, 0);

  const records: PageBridgeXVideoRecord[] = [];
  const seen = new Set<string>();
  for (const { statusId, tweet } of tweets.slice(0, MAX_X_TWEETS)) {
    const legacy = objectValue(tweet.legacy);
    const extended = readObject(legacy, 'extended_entities') ?? readObject(tweet, 'extended_entities');
    const items = readObject(extended, 'media');
    if (!Array.isArray(items)) continue;
    for (const [mediaIndex, value] of items.slice(0, MAX_X_MEDIA_PER_TWEET).entries()) {
      const media = objectValue(value);
      if (!media || !['video', 'animated_gif'].includes(String(media.type ?? '').toLowerCase())) continue;
      const mediaKey = typeof media.media_key === 'string' ? media.media_key : '';
      if (!/^\d+_\d{1,32}$/.test(mediaKey)) continue;
      const videoInfo = objectValue(media.video_info);
      const rawVariants = readObject(videoInfo, 'variants');
      if (!Array.isArray(rawVariants)) continue;

      const mp4: Array<{ url: string; bitrate: number }> = [];
      const hls: Array<{ url: string; bitrate: number }> = [];
      for (const rawVariant of rawVariants.slice(0, 32)) {
        const variant = objectValue(rawVariant);
        if (!variant || typeof variant.url !== 'string') continue;
        const url = normalizeXVideoUrl(variant.url);
        if (!url) continue;
        const contentType = typeof variant.content_type === 'string' ? variant.content_type.toLowerCase() : '';
        const path = new URL(url).pathname;
        const bitrate = typeof variant.bitrate === 'number' && Number.isFinite(variant.bitrate)
          ? Math.max(0, Math.floor(variant.bitrate))
          : 0;
        if (contentType === 'video/mp4' && /\.mp4$/i.test(path)) mp4.push({ url, bitrate });
        else if (
          /^(?:application\/x-mpegurl|application\/vnd\.apple\.mpegurl)$/.test(contentType) &&
          /\.m3u8$/i.test(path)
        ) hls.push({ url, bitrate });
      }
      const urls = [
        ...mp4.sort((left, right) => right.bitrate - left.bitrate),
        ...hls.sort((left, right) => right.bitrate - left.bitrate),
      ].map(({ url }) => url).filter((url, index, all) => all.indexOf(url) === index).slice(0, MAX_URLS_PER_RECORD);
      if (urls.length === 0) continue;
      const key = `${statusId}\u0000${mediaKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const previewUrls = new Set<string>();
      if (typeof media.media_url_https === 'string') {
        const preview = normalizeXPreviewUrl(media.media_url_https);
        if (preview) previewUrls.add(preview);
      }
      if (typeof media.preview_image_url === 'string') {
        const preview = normalizeXPreviewUrl(media.preview_image_url);
        if (preview) previewUrls.add(preview);
      }
      records.push({
        contentId: statusId,
        mediaKey,
        mediaIndex,
        previewUrls: [...previewUrls].slice(0, 4),
        urls,
      });
      if (records.length >= MAX_X_TWEETS * MAX_X_MEDIA_PER_TWEET) return records;
    }
  }
  return records;
}

/** Derive the exact lookup key used by known image-search result formats. */
export function pageBridgeKeyFromPreview(
  adapter: PageBridgeAdapter,
  previewUrl: string,
): string | undefined {
  if (adapter === 'google-images') return undefined;
  if (adapter === 'x-status-media') return undefined;
  try {
    const preview = new URL(previewUrl);
    const wrapped = adapter === 'duckduckgo-images'
      ? preview.searchParams.get('u')
      : preview.searchParams.get('url');
    const media = wrapped ? new URL(wrapped) : preview;
    return thumbnailId(media.href);
  } catch {
    return undefined;
  }
}

/** Build a bounded response only for the exact query, site, and result key. */
export function resolvePageBridgeRequest(
  value: unknown,
  adapter: PageBridgeAdapter,
  pageUrl: string,
  records: readonly PageBridgeImageRecord[],
  xVideoRecords: readonly PageBridgeXVideoRecord[] = [],
): PageBridgeResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const requestId = Reflect.get(value, 'requestId');
  const requestedAdapter = Reflect.get(value, 'adapter');
  const contentId = Reflect.get(value, 'contentId');
  const previewUrl = Reflect.get(value, 'previewUrl');
  const requestedPageUrl = Reflect.get(value, 'pageUrl');
  if (
    Reflect.get(value, 'type') !== 'serpent-page-bridge-request' ||
    typeof requestId !== 'string' || requestId.length > 100 ||
    requestedAdapter !== adapter ||
    typeof contentId !== 'string' || contentId.length === 0 || contentId.length > 160 ||
    typeof previewUrl !== 'string' || previewUrl.length > 4_096 ||
    requestedPageUrl !== pageUrl
  ) return undefined;
  if (!pageMatchesAdapter(pageUrl, adapter)) return undefined;
  if (adapter === 'x-status-media') {
    if (
      Reflect.get(value, 'kind') !== 'video' || !/^\d{1,24}$/.test(contentId) ||
      (typeof Reflect.get(value, 'mediaIndex') === 'number' &&
        (!Number.isSafeInteger(Reflect.get(value, 'mediaIndex')) || Reflect.get(value, 'mediaIndex') < 0))
    ) return undefined;
    const requestedMediaKey = Reflect.get(value, 'mediaKey');
    const requestedIndex = Reflect.get(value, 'mediaIndex');
    const selectedPreview = normalizeXPreviewUrl(previewUrl);
    let matches = xVideoRecords.filter((record) => record.contentId === contentId);
    if (typeof requestedMediaKey === 'string' && /^\d+_\d{1,32}$/.test(requestedMediaKey)) {
      matches = matches.filter((record) => record.mediaKey === requestedMediaKey);
    } else if (typeof requestedIndex === 'number') {
      matches = matches.filter((record) => record.mediaIndex === requestedIndex);
    } else if (selectedPreview) {
      matches = matches.filter((record) =>
        record.previewUrls.includes(selectedPreview) || record.urls.includes(selectedPreview),
      );
    } else {
      return undefined;
    }
    return {
      type: 'serpent-page-bridge-response',
      requestId,
      adapter,
      contentId,
      previewUrl,
      kind: 'video',
      ...(matches.length === 1 && matches[0] ? { mediaIndex: matches[0].mediaIndex } : {}),
      urls: matches.length === 1 ? matches[0]?.urls.slice(0, MAX_URLS_PER_RECORD) ?? [] : [],
    };
  }
  if (Reflect.get(value, 'kind') !== undefined && Reflect.get(value, 'kind') !== 'image') return undefined;
  if (adapter !== 'google-images' && pageBridgeKeyFromPreview(adapter, previewUrl) !== contentId) return undefined;
  const matches = records.filter((candidate) => candidate.contentId === contentId);
  return {
    type: 'serpent-page-bridge-response',
    requestId,
    adapter,
    contentId,
    previewUrl,
    urls: matches.length === 1 ? matches[0]?.urls.slice(0, MAX_URLS_PER_RECORD) ?? [] : [],
    kind: 'image',
  };
}

function pageMatchesAdapter(pageUrl: string, adapter: PageBridgeAdapter): boolean {
  try {
    const url = new URL(pageUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (adapter === 'google-images') {
      return (host === 'google.com' || host.endsWith('.google.com')) && url.pathname === '/search'
        && (url.searchParams.get('tbm') === 'isch' || url.searchParams.get('udm') === '2');
    }
    if (adapter === 'duckduckgo-images') return host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com');
    if (adapter === 'x-status-media') return host === 'x.com' || host.endsWith('.x.com')
      || host === 'twitter.com' || host.endsWith('.twitter.com');
    return host === 'yandex.com' || host.endsWith('.yandex.com')
      || host === 'yandex.ru' || host.endsWith('.yandex.ru');
  } catch {
    return false;
  }
}

function collectYandexEntities(
  value: unknown,
  found: Array<{ key: string; value: Record<string, unknown> }>,
  depth: number,
): void {
  if (depth > 10 || found.length >= MAX_RECORDS || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectYandexEntities(item, found, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    if (key === 'entities' && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const [entityId, entity] of Object.entries(child).slice(0, MAX_RECORDS - found.length)) {
        if (entity && typeof entity === 'object' && !Array.isArray(entity)) {
          found.push({ key: entityId, value: entity as Record<string, unknown> });
        }
      }
      continue;
    }
    if (key === 'items' && child && typeof child === 'object' && !Array.isArray(child)) {
      const itemEntities = Reflect.get(child, 'entities');
      if (itemEntities && typeof itemEntities === 'object' && !Array.isArray(itemEntities)) {
        for (const [entityId, entity] of Object.entries(itemEntities).slice(0, MAX_RECORDS - found.length)) {
          if (entity && typeof entity === 'object' && !Array.isArray(entity)) {
            found.push({ key: entityId, value: entity as Record<string, unknown> });
          }
        }
      }
    }
    if (child && typeof child === 'object') collectYandexEntities(child, found, depth + 1);
  }
}

function thumbnailId(value: string): string | undefined {
  try {
    const url = new URL(value);
    const queryId = url.searchParams.get('id');
    if (queryId && /^[A-Za-z0-9_-]{4,160}$/.test(queryId)) return queryId;
    const match = /\/id\/([A-Za-z0-9_-]{4,160})(?:[/?#]|$)/.exec(url.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function normalizeHttp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeXPreviewUrl(value: string): string | undefined {
  const normalized = normalizeHttp(value);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    return (url.hostname === 'pbs.twimg.com' || url.hostname === 'video.twimg.com') ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeXVideoUrl(value: string): string | undefined {
  const normalized = normalizeHttp(value);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    return url.hostname === 'video.twimg.com' && !url.username && !url.password && url.href.length <= 4_096
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstNumericId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d{1,24}$/.test(value)) return value;
  return undefined;
}

function firstString(value: object, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = Reflect.get(value, key);
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 4_096) return candidate;
  }
  return undefined;
}

function readObject(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function readObjectString(value: unknown, key: string): string | undefined {
  const candidate = readObject(value, key);
  return typeof candidate === 'string' && candidate.length <= 4_096 ? candidate : undefined;
}
