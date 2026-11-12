import { parse, type DefaultTreeAdapterTypes } from 'parse5';

import type { SaveIntent } from '../save-client';
import type { MediaCandidate } from './types';
import { behanceCandidatesFromParsedState, type BehanceTarget } from './behance';
import { pinterestPwsScriptId, pinterestVideoForSelection } from './pinterest-video';
import { huabanOriginalCandidateForState } from './huaban';

const MAX_DETAIL_HTML_BYTES = 2 * 1024 * 1024;
const DETAIL_FETCH_TIMEOUT_MS = 3_000;
const URL_FIELDS = new Set([
  'src', 'href', 'url', 'contenturl', 'content_url', 'originalurl', 'original_url',
  'image', 'imageurl', 'image_url', 'video', 'videourl', 'video_url', 'large', 'original',
]);

type DetailFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Follow the single detail URL attached to the selected item, at most once. */
export async function followSelectedMediaDetail(
  intent: SaveIntent,
  fetchFn: DetailFetch = fetch,
): Promise<MediaCandidate[]> {
  const selection = intent.selection;
  const detailUrl = selection?.detailPageUrl;
  if (
    intent.preferOriginalMedia !== true ||
    !selection ||
    !detailUrl ||
    !isHttpUrl(detailUrl) ||
    detailUrl === selection.pageUrl ||
    !hasIdentity(selection.contentId, selection.mediaIndex, selection.previewUrl)
  ) return [];

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), DETAIL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(detailUrl, {
      method: 'GET',
      credentials: 'include',
      referrer: intent.sourcePageUrl,
      referrerPolicy: 'unsafe-url',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || response.status !== 200) return [];
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mime && !/text\/html|application\/xhtml\+xml/.test(mime)) return [];
    const html = await readTextBounded(response);
    if (!html) return [];
    const document = parse(html);
    return candidatesFromParsedHtml(document, intent);
  } catch {
    return [];
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function candidatesFromParsedHtml(
  document: DefaultTreeAdapterTypes.Document,
  intent: SaveIntent,
): MediaCandidate[] {
  const selection = intent.selection;
  if (!selection) return [];
  const nodes: DefaultTreeAdapterTypes.Element[] = [];
  walk(document, (node) => {
    if (isElement(node)) nodes.push(node);
  });

  if (selection.siteAdapter === 'behance' && selection.kind === 'image') {
    return behanceCandidatesFromDetailState(nodes, selection);
  }

  const candidates: MediaCandidate[] = [];
  if (selection.siteAdapter === 'pinterest' && selection.kind === 'video' && selection.contentId) {
    const matches = nodes.flatMap((node) => {
      if (node.tagName.toLowerCase() !== 'script'
        || !pinterestPwsScriptId(attributes(node).get('id') ?? '')) return [];
      const text = textContent(node);
      if (text.length > MAX_DETAIL_HTML_BYTES) return [];
      try {
        const state = JSON.parse(text) as unknown;
        const match = pinterestVideoForSelection(state, {
          contentId: selection.contentId,
          ...(selection.posterUrl ? { posterUrl: selection.posterUrl } : {}),
        }, selection.detailPageUrl ?? selection.pageUrl);
        return match ? [match] : [];
      } catch {
        return [];
      }
    });
    const uniqueMatches = new Map(matches.map((match) => [
      match.candidates.map((candidate) => candidate.url).join('\n'), match,
    ]));
    if (uniqueMatches.size === 1) {
      const match = [...uniqueMatches.values()][0];
      if (match) candidates.push(...match.candidates);
    }
  }
  if (selection.siteAdapter === 'huaban' && selection.kind === 'image' && selection.contentId) {
    const contentId = selection.contentId;
    const matches = nodes.flatMap((node) => {
      if (node.tagName.toLowerCase() !== 'script'
        || attributes(node).get('id') !== '__NEXT_DATA__') return [];
      const text = textContent(node);
      if (text.length > MAX_DETAIL_HTML_BYTES) return [];
      try {
        const state = JSON.parse(text) as unknown;
        const candidate = huabanOriginalCandidateForState(
          state,
          contentId,
          selection.previewUrl,
          selection.detailPageUrl ?? selection.pageUrl,
        );
        return candidate ? [candidate] : [];
      } catch {
        return [];
      }
    });
    const uniqueMatches = new Map(matches.map((match) => [`${match.source}\n${match.url}`, match]));
    if (uniqueMatches.size === 1) {
      const match = [...uniqueMatches.values()][0];
      if (match && match.url !== selection.previewUrl) {
        candidates.push({
          url: match.url,
          kind: 'image',
          source: match.source,
          contentId,
          ...(selection.mediaIndex === undefined ? {} : { mediaIndex: selection.mediaIndex }),
        });
      }
    }
  }
  const add = (value: string, source: MediaCandidate['source']) => {
    const normalized = normalizeUrl(value, selection.detailPageUrl ?? selection.pageUrl);
    if (!normalized || normalized === selection.previewUrl || !kindCompatible(normalized, selection.kind)) return;
    if (!matchesMediaIdentity(normalized, selection.contentId, selection.previewUrl)) return;
    if (candidates.some((candidate) => candidate.url === normalized)) return;
    candidates.push({
      url: normalized,
      kind: selection.kind,
      source,
      ...(selection.contentId ? { contentId: selection.contentId } : {}),
      ...(selection.mediaIndex === undefined ? {} : { mediaIndex: selection.mediaIndex }),
    });
  };

  for (const node of nodes) {
    const attrs = attributes(node);
    const tag = node.tagName.toLowerCase();
    if (tag === 'img' && selection.kind === 'image') {
      for (const name of ['src', 'data-src', 'data-original', 'data-large', 'data-full']) {
        const value = attrs.get(name);
        if (value) add(value, 'site-field');
      }
      for (const value of parseSrcset(attrs.get('srcset') ?? '', selection.detailPageUrl ?? selection.pageUrl)) {
        add(value, 'srcset');
      }
    }
    if (tag === 'video' && selection.kind === 'video') {
      for (const name of ['src', 'data-src', 'data-video', 'data-original']) {
        const value = attrs.get(name);
        if (value) add(value, 'site-field');
      }
    }
    if (tag === 'source' && selection.kind === 'video') {
      const value = attrs.get('src');
      if (value) add(value, 'site-field');
    }
    if (tag === 'meta') {
      const property = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
      if (selection.kind === 'image' && (property === 'og:image' || property === 'twitter:image')) {
        const value = attrs.get('content');
        if (value) add(value, 'structured-data');
      }
      if (selection.kind === 'video' && ['og:video', 'og:video:url', 'twitter:player:stream'].includes(property)) {
        const value = attrs.get('content');
        if (value) add(value, 'structured-data');
      }
    }
    if (tag === 'script' && (attrs.get('type') ?? '').toLowerCase().includes('ld+json')) {
      const text = textContent(node);
      if (text.length <= 500_000) {
        try {
          const parsed = JSON.parse(text) as unknown;
          for (const value of structuredMediaUrls(parsed, selection.kind)) add(value, 'structured-data');
        } catch {
          // Malformed JSON-LD is simply not evidence.
        }
      }
    }
    if (tag === 'a') {
      const href = attrs.get('href');
      if (href && containsPreviewImage(node, selection.previewUrl, selection.detailPageUrl ?? selection.pageUrl)) {
        add(href, 'site-field');
      }
    }
  }
  return candidates;
}

function behanceCandidatesFromDetailState(
  nodes: readonly DefaultTreeAdapterTypes.Element[],
  selection: NonNullable<SaveIntent['selection']>,
): MediaCandidate[] {
  const contentId = selection.contentId;
  if (!contentId) return [];
  const identity = /^behance:(\d+):(cover|module:(\d+))$/.exec(contentId);
  if (!identity?.[1] || !identity[2]) return [];
  const target: BehanceTarget = {
    projectId: identity[1],
    ...(identity[3] ? { moduleId: identity[3] } : {}),
    contentId,
  };

  const matches = new Map<string, { urls: readonly string[]; widths: ReadonlyMap<string, number> }>();
  for (const node of nodes) {
    if (node.tagName.toLowerCase() !== 'script' || attributes(node).get('id') !== 'beconfig-store_state') continue;
    const text = textContent(node);
    if (text.length > MAX_DETAIL_HTML_BYTES) continue;
    try {
      const state = JSON.parse(text) as unknown;
      const variants = behanceCandidatesFromParsedState(
        state,
        target,
        selection.previewUrl,
        selection.previewWidth,
      );
      if (!variants || variants.urls.length === 0) continue;
      const signature = JSON.stringify(variants.urls.map((url) => [url, variants.widths.get(url) ?? null]));
      matches.set(signature, variants);
    } catch {
      // Malformed state is not evidence for this selected Behance asset.
    }
  }
  if (matches.size !== 1) return [];
  const variants = [...matches.values()][0];
  if (!variants) return [];
  return variants.urls
    .filter((url) => url !== selection.previewUrl)
    .map((url) => ({
      url,
      kind: 'image' as const,
      source: 'site-field' as const,
      contentId,
      ...(selection.mediaIndex === undefined ? {} : { mediaIndex: selection.mediaIndex }),
      ...(variants.widths.get(url) ? { width: variants.widths.get(url) } : {}),
    }));
}

function structuredMediaUrls(value: unknown, kind: 'image' | 'video'): string[] {
  const found: string[] = [];
  const visit = (current: unknown, depth: number, activeType: string): void => {
    if (depth > 12 || found.length > 100) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 100)) visit(item, depth + 1, activeType);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const nodeType = Reflect.get(current, '@type');
    const types = Array.isArray(nodeType) ? nodeType.map(String) : [String(nodeType ?? activeType)];
    const mediaType = types.some((entry) => /videoobject/i.test(entry))
      ? 'video'
      : types.some((entry) => /imageobject/i.test(entry))
        ? 'image'
        : activeType;
    if (mediaType !== kind) return;
    for (const [key, child] of Object.entries(current)) {
      if (typeof child === 'string' && URL_FIELDS.has(key.toLowerCase())) found.push(child);
      else if (child && typeof child === 'object') visit(child, depth + 1, mediaType);
    }
  };
  visit(value, 0, '');
  return found;
}

function containsPreviewImage(
  node: DefaultTreeAdapterTypes.Node,
  previewUrl: string,
  baseUrl: string,
): boolean {
  let match = false;
  walk(node, (child) => {
    if (!isElement(child) || child.tagName.toLowerCase() !== 'img') return;
    const src = attributes(child).get('src') ?? attributes(child).get('data-src');
    if (src && sameResource(src, previewUrl, baseUrl)) match = true;
  });
  return match;
}

function parseSrcset(value: string, baseUrl: string): string[] {
  const results: string[] = [];
  const matches = value.match(/(?:^|,\s*)([^\s,]+)(?:\s+\d+(?:\.\d+)?[wx])?/g) ?? [];
  for (const match of matches) {
    const raw = match.replace(/^,\s*/, '').trim().split(/\s+/)[0];
    if (raw) results.push(raw);
  }
  return results.map((item) => normalizeUrl(item, baseUrl)).filter(isString);
}

function walk(node: DefaultTreeAdapterTypes.Node, callback: (node: DefaultTreeAdapterTypes.Node) => void): void {
  callback(node);
  const children = 'childNodes' in node ? node.childNodes : [];
  for (const child of children) walk(child, callback);
  if ('content' in node && node.content) walk(node.content, callback);
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node && 'attrs' in node;
}

function attributes(node: DefaultTreeAdapterTypes.Element): Map<string, string> {
  return new Map(node.attrs.map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
}

function textContent(node: DefaultTreeAdapterTypes.Node): string {
  let output = '';
  walk(node, (child) => {
    if ('value' in child && typeof child.value === 'string') output += child.value;
  });
  return output;
}

async function readTextBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DETAIL_HTML_BYTES) return '';
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= MAX_DETAIL_HTML_BYTES ? text : '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_DETAIL_HTML_BYTES) {
        await reader.cancel().catch(() => {});
        return '';
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function matchesMediaIdentity(candidate: string, contentId: string | undefined, previewUrl: string): boolean {
  if (sameResource(candidate, previewUrl, previewUrl)) return true;
  if (!contentId) return false;
  try {
    const candidateUrl = new URL(candidate);
    const preview = new URL(previewUrl);
    const candidateId = stableAssetId(candidateUrl.pathname);
    const previewId = stableAssetId(preview.pathname);
    return candidateId.length > 4 && candidateId === previewId;
  } catch {
    return false;
  }
}

function sameResource(left: string, right: string, baseUrl: string): boolean {
  const a = normalizeUrl(left, baseUrl);
  const b = normalizeUrl(right, baseUrl);
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return stableAssetId(new URL(a).pathname) === stableAssetId(new URL(b).pathname);
  } catch {
    return false;
  }
}

function stableAssetId(path: string): string {
  const file = path.split('/').filter(Boolean).pop() ?? '';
  const value = file.replace(/\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp4|m4v|webm|mov)$/i, '')
    .replace(/(?:_thumb|_thumbnail|_small|_medium|_large|_\d+w|_\d+x|_master\d+)$/i, '')
    .toLowerCase();
  return /^(?:thumb|thumbnail|small|medium|large|image|original|default|preview|cover|avatar)$/i.test(value)
    ? ''
    : value;
}

function kindCompatible(url: string, kind: 'image' | 'video'): boolean {
  try {
    const path = new URL(url).pathname;
    return kind === 'image'
      ? !/\.(?:mp4|m4v|webm|mov|m3u8|mpd)$/i.test(path)
      : !/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(path);
  } catch {
    return false;
  }
}

function normalizeUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value.trim(), baseUrl);
    return isHttpUrl(url.href) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasIdentity(contentId: string | undefined, mediaIndex: number | undefined, previewUrl: string): boolean {
  if (contentId || mediaIndex !== undefined) return true;
  try {
    return Boolean(stableAssetId(new URL(previewUrl).pathname));
  } catch {
    return false;
  }
}
