import type { MediaCandidate } from './types';

export interface PinterestVideoSelection {
  readonly contentId?: string;
  readonly posterUrl?: string;
}

export interface PinterestVideoPinMatch {
  readonly candidates: readonly MediaCandidate[];
  readonly mediaIndex?: number;
}

const PINTEREST_PWS_SCRIPT_IDS = new Set(['__PWS_INITIAL_PROPS__', '__PWS_DATA__', '__PWS_ROUTES__']);
const MAX_VISITED_OBJECTS = 20_000;
const MAX_VIDEO_VARIANTS = 32;

export function isPinterestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'pinimg.com' || host.endsWith('.pinimg.com');
}

export function safePinterestPosterUrl(value: unknown, baseUrl?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 4_096) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password
      || !isPinterestHost(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Resolve variants only inside the selected Pin and the carousel slot whose
 * cover matches the selected video poster. A matching Pin with multiple
 * unmatched video slots is deliberately ambiguous.
 */
export function pinterestVideoForSelection(
  state: unknown,
  selection: PinterestVideoSelection,
  baseUrl: string,
): PinterestVideoPinMatch | undefined {
  if (!selection.contentId || !safePinterestPosterUrl(selection.posterUrl, baseUrl)) return undefined;
  const pins = findPinterestPins(state, selection.contentId);
  const matches = new Map<string, PinterestVideoPinMatch>();
  for (const pin of pins) {
    const slots = findCarouselSlots(pin);
    if (slots.length > 0) {
      for (const [index, slot] of slots.entries()) {
        if (!slotHasPoster(slot, selection.posterUrl!, baseUrl)) continue;
        const match = videoMatchFromSlot(slot, selection.contentId, index, baseUrl);
        if (match) matches.set(matchKey(match), match);
      }
      continue;
    }
    if (!slotHasPoster(pin, selection.posterUrl!, baseUrl)) continue;
    const match = videoMatchFromSlot(pin, selection.contentId, undefined, baseUrl);
    if (match) matches.set(matchKey(match), match);
  }
  if (matches.size !== 1) return undefined;
  return [...matches.values()][0];
}

export function pinterestPwsScriptId(value: string): boolean {
  return PINTEREST_PWS_SCRIPT_IDS.has(value);
}

function findPinterestPins(state: unknown, contentId: string): Record<string, unknown>[] {
  const found = new Set<Record<string, unknown>>();
  const visited = new Set<object>();
  let count = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > 24 || count >= MAX_VISITED_OBJECTS || !current || typeof current !== 'object') return;
    if (visited.has(current)) return;
    visited.add(current);
    count += 1;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 1_000)) visit(item, depth + 1);
      return;
    }
    const object = current as Record<string, unknown>;
    const id = firstString(object, ['entityId', 'pinId', 'id']);
    if (id === contentId) found.add(object);
    const pins = object.pins;
    if (pins && typeof pins === 'object' && !Array.isArray(pins)) {
      const direct = Reflect.get(pins, contentId);
      if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
        found.add(direct as Record<string, unknown>);
      }
    }
    for (const child of Object.values(object).slice(0, 1_000)) visit(child, depth + 1);
  };
  visit(state, 0);
  return [...found];
}

function findCarouselSlots(pin: Record<string, unknown>): unknown[] {
  const carousel = pin.carousel_data;
  if (!carousel || typeof carousel !== 'object' || Array.isArray(carousel)) return [];
  const slots = Reflect.get(carousel, 'carousel_slots');
  return Array.isArray(slots) ? slots.slice(0, 200) : [];
}

function slotHasPoster(slot: unknown, posterUrl: string, baseUrl: string): boolean {
  const normalizedPoster = safePinterestPosterUrl(posterUrl, baseUrl);
  if (!normalizedPoster) return false;
  return slotPosterUrls(slot, baseUrl).some((url) => samePinterestImage(url, normalizedPoster, baseUrl));
}

function slotPosterUrls(slot: unknown, baseUrl: string): string[] {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return [];
  const object = slot as Record<string, unknown>;
  const urls: string[] = [];
  const addUrl = (value: unknown) => {
    const url = safePinterestPosterUrl(value, baseUrl);
    if (url && !urls.includes(url)) urls.push(url);
  };
  for (const [key, value] of Object.entries(object)) {
    const lowered = key.toLowerCase();
    if (/^images_(?:orig|original|\d+x(?:\d+)?(?:_[a-z0-9]+)?)$/i.test(key)) {
      addUrl(readUrl(value));
      continue;
    }
    if (lowered === 'images' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [variant, image] of Object.entries(value)) {
        if (/^(?:orig|original|\d+x(?:\d+)?(?:_[a-z0-9]+)?)$/i.test(variant)) addUrl(readUrl(image));
      }
      continue;
    }
    if (lowered === 'videos' && value && typeof value === 'object' && !Array.isArray(value)) {
      const videoList = Reflect.get(value, 'video_list');
      if (videoList && typeof videoList === 'object') {
        const variants = Array.isArray(videoList) ? videoList : Object.values(videoList);
        for (const variant of variants.slice(0, MAX_VIDEO_VARIANTS)) {
          if (variant && typeof variant === 'object' && !Array.isArray(variant)) {
            addUrl(Reflect.get(variant, 'thumbnail'));
          }
        }
      }
    }
  }
  return urls;
}

function videoMatchFromSlot(
  slot: unknown,
  contentId: string,
  mediaIndex: number | undefined,
  baseUrl: string,
): PinterestVideoPinMatch | undefined {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return undefined;
  const object = slot as Record<string, unknown>;
  const videos = object.videos;
  const videoList = videos && typeof videos === 'object' && !Array.isArray(videos)
    ? Reflect.get(videos, 'video_list')
    : object.video_list;
  if (!videoList || typeof videoList !== 'object') return undefined;
  const entries = Array.isArray(videoList)
    ? videoList.slice(0, MAX_VIDEO_VARIANTS).map((item, index) => [String(index), item] as const)
    : Object.entries(videoList as Record<string, unknown>).slice(0, MAX_VIDEO_VARIANTS);
  const variants = entries.flatMap(([variantName, raw]) => {
    const item = typeof raw === 'string' ? { url: raw } : raw;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const url = safeMediaUrl(readUrl(item), baseUrl);
    if (!url) return [];
    const kind = mediaUrlKind(url);
    if (!kind) return [];
    const width = nonNegativeNumber(Reflect.get(item, 'width'));
    const height = nonNegativeNumber(Reflect.get(item, 'height'));
    const bitrate = nonNegativeNumber(Reflect.get(item, 'bitrate'))
      ?? nonNegativeNumber(Reflect.get(item, 'bit_rate'));
    const labelHeight = /(?:^|[_-])(\d{3,4})p(?:$|[_-])/i.exec(variantName)?.[1];
    const heightRank = height ?? (labelHeight ? Number(labelHeight) : 0);
    return [{ url, kind, width, height, bitrate, rank: (width ?? 0) * (heightRank || 1), key: variantName }];
  });
  const direct = variants.filter((variant) => variant.kind === 'mp4').sort((left, right) => (
    right.rank - left.rank || (right.bitrate ?? 0) - (left.bitrate ?? 0) || left.key.localeCompare(right.key)
  ));
  const streams = variants.filter((variant) => variant.kind === 'hls');
  const ordered = [...direct, ...streams];
  if (ordered.length === 0) return undefined;
  const candidates: MediaCandidate[] = [];
  for (const item of ordered) {
    if (candidates.some((candidate) => candidate.url === item.url)) continue;
    candidates.push({
      url: item.url,
      kind: 'video',
      source: 'site-field',
      contentId,
      ...(mediaIndex === undefined ? {} : { mediaIndex }),
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
    });
  }
  return { candidates, ...(mediaIndex === undefined ? {} : { mediaIndex }) };
}

function matchKey(match: PinterestVideoPinMatch): string {
  return `${match.mediaIndex ?? ''}:${match.candidates.map((candidate) => candidate.url).join('\n')}`;
}

function samePinterestImage(left: string, right: string, baseUrl: string): boolean {
  const a = safePinterestPosterUrl(left, baseUrl);
  const b = safePinterestPosterUrl(right, baseUrl);
  if (!a || !b) return false;
  try {
    const au = new URL(a);
    const bu = new URL(b);
    if (au.hostname !== bu.hostname) return false;
    if (au.pathname === bu.pathname) return true;
    return pinterestImageIdentity(au.pathname) === pinterestImageIdentity(bu.pathname);
  } catch {
    return false;
  }
}

function pinterestImageIdentity(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (/^\d{1,5}x(?:\d{1,5})?(?:_[a-z0-9]+)?$/i.test(parts[0] ?? '')) parts.shift();
  else if (parts[0]?.toLowerCase() === 'videos' && parts[1]?.toLowerCase() === 'thumbnails') {
    if (/^(?:orig|original|originals|\d{1,5}x(?:\d{1,5})?(?:_[a-z0-9]+)?)$/i.test(parts[2] ?? '')) parts.splice(2, 1);
  }
  return parts.join('/').toLowerCase();
}

function readUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const url = Reflect.get(value, 'url');
    return typeof url === 'string' ? url : undefined;
  }
  return undefined;
}

function firstString(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).length > 0) return String(value);
  }
  return undefined;
}

function safeMediaUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password
      || !isPinterestHost(url.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function mediaUrlKind(url: string): 'mp4' | 'hls' | undefined {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (/\.(?:mp4|m4v)$/u.test(path)) return 'mp4';
    if (/\.m3u8$/u.test(path)) return 'hls';
    return undefined;
  } catch {
    return undefined;
  }
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
