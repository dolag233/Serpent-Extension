import type { ExtensionFolderOption } from './folder-menu';
import type { MediaSelection } from './media-resolution/types';
import { followSelectedMediaDetail } from './media-resolution/detail';
import { isBehanceOriginalAssetUrl, isSameBehanceAsset } from './media-resolution/behance';
import { artstationMediaKey, artstationVariantRank } from './media-resolution/artstation';
import { makeSegmentedRequestId, trySegmentedMediaTransfer } from './media-transfer';

export const SERPENT_PORTS = [19876, 19877, 19878] as const;

const SERPENT_HOST = 'http://127.0.0.1';
/** Keep in sync with Main MAX_EXTENSION_UPLOAD_BYTES. */
export const MAX_BROWSER_FETCH_BYTES = 500 * 1024 * 1024;
const BEHANCE_CANDIDATE_HEADERS_TIMEOUT_MS = 15_000;

export interface SaveIntent {
  kind: 'image' | 'video';
  sourcePageUrl: string;
  /** Compatibility alias; new intents keep this equal to selection.previewUrl. */
  mediaUrl: string;
  selection?: MediaSelection;
  /** Frozen at the beginning of this save operation. */
  preferOriginalMedia?: boolean;
  /** Used only for a recovered preview fallback; the desktop rejects a different active library. */
  expectedLibraryId?: string;
  /** Prevent a recovered preview transfer from offering another preview fallback. */
  allowRecoveryFallback?: boolean;
  targetFolderId?: string | null;
  /** 合集模式：文件仍进资源库根目录，保存成功后再加入该合集。 */
  targetCollectionId?: string;
}

export interface ExtensionCollectionOption {
  readonly collectionId: string;
  readonly name: string;
  readonly relativePath: string;
  readonly assetCount?: number;
}

export interface ContextMenuMediaInfo {
  mediaType?: 'image' | 'video' | 'audio';
  pageUrl?: string;
  srcUrl?: string;
  selection?: MediaSelection;
}

export type SaveOutcome =
  | { kind: 'accepted'; savedVersion?: 'candidate' | 'preview'; duplicate?: true }
  | { kind: 'rejected'; status: number; reason: string; failureKind?: 'source-invalid' }
  | { kind: 'pending'; reason: string }
  | { kind: 'transfer_failed'; reason: string }
  | { kind: 'unreachable' }
  | { kind: 'fetch_failed'; reason: string };

export type ConnectionOutcome =
  | { kind: 'connected' }
  | { kind: 'offline' };

export type FolderListOutcome =
  | {
      kind: 'ok';
      folders: ExtensionFolderOption[];
      recentBrowsedFolderIds: string[];
      libraryDisplayName: string;
    }
  | { kind: 'rejected'; status: number; reason: string }
  | { kind: 'unreachable' };

export type CollectionListOutcome =
  | {
      kind: 'ok';
      collections: ExtensionCollectionOption[];
      libraryDisplayName: string;
    }
  | { kind: 'rejected'; status: number; reason: string }
  | { kind: 'unreachable' };

import type { ExtensionSaveBehavior } from './preferences';

export interface UserNotification {
  title: string;
  message: string;
}

export interface FetchedMedia {
  body: ArrayBuffer;
  contentType: string;
  filename: string;
  sourceUrl?: string;
  savedVersion?: 'candidate' | 'preview';
}

export interface SaveExecutionOptions {
  /** Optional gate for side effects that can import media into the library. */
  commit?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Test override for the Behance image candidate response-header timeout. */
  candidateHeadersTimeoutMs?: number;
}

type FetchHeaders = { get(name: string): string | null };
type FetchResponse = {
  status: number;
  ok: boolean;
  url?: string;
  headers: FetchHeaders;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
};
type FetchFunction = (
  input: string,
  init?: RequestInit,
) => Promise<FetchResponse>;

export type PageBlobFetchResult =
  | { body: ArrayBuffer; contentType: string }
  | { error: string };

export type PageBlobFetcher = (
  mediaUrl: string,
  intent: SaveIntent,
) => Promise<PageBlobFetchResult>;

export type PageBridgeFetcher = (
  selection: MediaSelection,
) => Promise<readonly {
  url: string;
  contentId: string;
  kind?: 'image' | 'video';
  mediaIndex?: number;
}[]>;

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function saveIntentFromContextMenu(
  info: ContextMenuMediaInfo,
): SaveIntent | undefined {
  if (!isHttpUrl(info.srcUrl) || !isHttpUrl(info.pageUrl)) return undefined;

  return {
    kind: info.mediaType === 'video' ? 'video' : 'image',
    sourcePageUrl: info.pageUrl,
    mediaUrl: info.srcUrl,
    ...(info.selection ? { selection: info.selection } : {}),
  };
}

function rejectionReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;

    for (const key of ['reason', 'message', 'error']) {
      const value = Reflect.get(parsed, key);
      if (typeof value === 'string' && value.trim()) {
        return value.trim().slice(0, 240);
      }
    }
  } catch {
    const trimmed = body.trim();
    return trimmed ? trimmed.slice(0, 240) : undefined;
  }

  return undefined;
}

function rejectionFailureKind(body: string): 'source-invalid' | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && Reflect.get(parsed, 'failureKind') === 'source-invalid'
      ? 'source-invalid'
      : undefined;
  } catch {
    return undefined;
  }
}

async function requestSerpent(
  path: string,
  init: RequestInit,
  fetchFn: FetchFunction,
): Promise<FetchResponse | null> {
  for (const port of SERPENT_PORTS) {
    try {
      return await fetchFn(`${SERPENT_HOST}:${port}${path}`, init);
    } catch {
      // Serpent may have selected the next fallback port.
    }
  }
  return null;
}

const MAX_ACCEPTED_RESPONSE_BYTES = 4 * 1024;

async function readBoundedResponseText(
  response: FetchResponse,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;

  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return undefined;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function acceptedResponseIsDuplicate(response: FetchResponse): Promise<boolean> {
  try {
    const body = await readBoundedResponseText(response, MAX_ACCEPTED_RESPONSE_BYTES);
    if (body === undefined) return false;
    const parsed = JSON.parse(body) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && Reflect.get(parsed, 'duplicate') === true);
  } catch {
    return false;
  }
}

export async function probeSerpentConnection(
  fetchFn: FetchFunction = fetch,
): Promise<ConnectionOutcome> {
  const ping = await requestSerpent('/ping', { method: 'GET' }, fetchFn);
  if (!ping) return { kind: 'offline' };
  if (ping.status !== 200) return { kind: 'offline' };

  const folders = await requestSerpent('/folders', { method: 'GET' }, fetchFn);
  if (!folders) return { kind: 'offline' };
  // 200 = library open; 503 = app up but no library — still "connected" for icon.
  if (folders.status === 200 || folders.status === 503) return { kind: 'connected' };
  return { kind: 'connected' };
}

function parseFolderList(body: string): {
  folders: ExtensionFolderOption[];
  recentBrowsedFolderIds: string[];
  libraryDisplayName: string;
} {
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return { folders: [], recentBrowsedFolderIds: [], libraryDisplayName: 'Serpent' };
  }
  const folders = Reflect.get(parsed, 'folders');
  const recentBrowsedFolderIds = Reflect.get(parsed, 'recentBrowsedFolderIds');
  const libraryDisplayNameValue = Reflect.get(parsed, 'libraryDisplayName');
  const libraryDisplayName =
    typeof libraryDisplayNameValue === 'string' && libraryDisplayNameValue.trim()
      ? libraryDisplayNameValue.trim()
      : 'Serpent';
  const folderList = !Array.isArray(folders) ? [] : folders.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const folderId = Reflect.get(entry, 'folderId');
    const name = Reflect.get(entry, 'name');
    const relativePath = Reflect.get(entry, 'relativePath');
    const assetCount = Reflect.get(entry, 'assetCount');
    if (
      typeof folderId !== 'string' ||
      typeof name !== 'string' ||
      typeof relativePath !== 'string'
    ) {
      return [];
    }
    return [{
      folderId,
      name,
      relativePath,
      ...(typeof assetCount === 'number' && Number.isFinite(assetCount)
        ? { assetCount: Math.max(0, Math.floor(assetCount)) }
        : {}),
    }];
  });
  const browsed = Array.isArray(recentBrowsedFolderIds)
    ? recentBrowsedFolderIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { folders: folderList, recentBrowsedFolderIds: browsed, libraryDisplayName };
}

export async function fetchSerpentFolders(
  fetchFn: FetchFunction = fetch,
): Promise<FolderListOutcome> {
  const response = await requestSerpent('/folders', { method: 'GET' }, fetchFn);
  if (!response) return { kind: 'unreachable' };

  let body: string;
  try {
    body = await response.text();
  } catch {
    body = '';
  }

  if (response.status === 200) {
    const parsed = parseFolderList(body);
    return {
      kind: 'ok',
      folders: parsed.folders,
      recentBrowsedFolderIds: parsed.recentBrowsedFolderIds,
      libraryDisplayName: parsed.libraryDisplayName,
    };
  }

  return {
    kind: 'rejected',
    status: response.status,
    reason: rejectionReason(body) ?? `HTTP ${response.status}`,
  };
}

function parseCollectionList(body: string): {
  collections: ExtensionCollectionOption[];
  libraryDisplayName: string;
} {
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return { collections: [], libraryDisplayName: 'Serpent' };
  }
  const collections = Reflect.get(parsed, 'collections');
  const libraryDisplayNameValue = Reflect.get(parsed, 'libraryDisplayName');
  const libraryDisplayName =
    typeof libraryDisplayNameValue === 'string' && libraryDisplayNameValue.trim()
      ? libraryDisplayNameValue.trim()
      : 'Serpent';
  const collectionList = !Array.isArray(collections) ? [] : collections.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const collectionId = Reflect.get(entry, 'collectionId');
    const name = Reflect.get(entry, 'name');
    const relativePath = Reflect.get(entry, 'relativePath');
    const assetCount = Reflect.get(entry, 'assetCount');
    if (
      typeof collectionId !== 'string' ||
      typeof name !== 'string' ||
      typeof relativePath !== 'string'
    ) {
      return [];
    }
    return [{
      collectionId,
      name,
      relativePath,
      ...(typeof assetCount === 'number' && Number.isFinite(assetCount)
        ? { assetCount: Math.max(0, Math.floor(assetCount)) }
        : {}),
    }];
  });
  return { collections: collectionList, libraryDisplayName };
}

export async function fetchSerpentCollections(
  fetchFn: FetchFunction = fetch,
): Promise<CollectionListOutcome> {
  const response = await requestSerpent('/collections', { method: 'GET' }, fetchFn);
  if (!response) return { kind: 'unreachable' };

  let body: string;
  try {
    body = await response.text();
  } catch {
    body = '';
  }

  if (response.status === 200) {
    const parsed = parseCollectionList(body);
    return {
      kind: 'ok',
      collections: parsed.collections,
      libraryDisplayName: parsed.libraryDisplayName,
    };
  }

  return {
    kind: 'rejected',
    status: response.status,
    reason: rejectionReason(body) ?? `HTTP ${response.status}`,
  };
}

function filenameFromUrl(mediaUrl: string, contentType: string): string {
  try {
    const pathname = new URL(mediaUrl).pathname;
    const base = pathname.split('/').filter(Boolean).pop();
    if (base && base.includes('.')) return decodeURIComponent(base);
  } catch {
    // Fall through.
  }
  if (contentType.startsWith('video/')) return 'video.bin';
  if (contentType === 'image/png') return 'image.png';
  if (contentType === 'image/jpeg') return 'image.jpg';
  if (contentType === 'image/webp') return 'image.webp';
  if (contentType === 'image/gif') return 'image.gif';
  return 'download.bin';
}

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/tiff': ['.tif', '.tiff'],
  'image/webp': ['.webp'],
  'image/bmp': ['.bmp'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
  'video/x-msvideo': ['.avi'],
  'video/x-ms-wmv': ['.wmv'],
};

const CONTENT_TYPE_PREFERRED_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/x-ms-wmv': '.wmv',
};

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  return filename.slice(dot).toLowerCase();
}

/** Align URL-derived filenames with the response Content-Type (Serpent-1jyi). */
export function alignFilenameWithContentType(
  filename: string,
  contentType: string,
): string {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const allowed = CONTENT_TYPE_EXTENSIONS[normalized];
  const preferred = CONTENT_TYPE_PREFERRED_EXTENSION[normalized];
  if (!allowed || !preferred) return filename;

  const current = fileExtension(filename);
  if (current && allowed.includes(current)) return filename;

  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}${preferred}`;
}

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value);
}

function asciiAtBytes(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** Sniff media type when servers return application/octet-stream or omit it. */
export function sniffContentType(body: ArrayBuffer): string | undefined {
  const bytes = new Uint8Array(body, 0, Math.min(64, body.byteLength));
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAtBytes(bytes, 0, 'GIF87a') || asciiAtBytes(bytes, 0, 'GIF89a')) {
    return 'image/gif';
  }
  if (asciiAtBytes(bytes, 0, 'RIFF') && asciiAtBytes(bytes, 8, 'WEBP')) {
    return 'image/webp';
  }
  if (asciiAtBytes(bytes, 0, 'BM')) return 'image/bmp';
  if (bytes.length >= 16 && asciiAtBytes(bytes, 4, 'ftyp') && /^(?:avif|avis)$/i.test(String.fromCharCode(...bytes.slice(8, 12)))) {
    return 'image/avif';
  }
  if (bytes.length >= 12 && asciiAtBytes(bytes, 4, 'ftyp')) return 'video/mp4';
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  const prefix = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(4_096, body.byteLength)));
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) return 'image/svg+xml';
  return undefined;
}

function bytesContainAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function validPng(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && bytes.length >= 45
    && asciiAtBytes(bytes, 12, 'IHDR')
    && bytesContainAscii(bytes, 'IEND');
}

function validJpeg(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0xff, 0xd8, 0xff])
    && bytes.some((byte, index) => byte === 0xff && bytes[index + 1] === 0xda)
    && bytes.some((byte, index) => byte === 0xff && bytes[index + 1] === 0xd9);
}

function validGif(bytes: Uint8Array): boolean {
  return (asciiAtBytes(bytes, 0, 'GIF87a') || asciiAtBytes(bytes, 0, 'GIF89a'))
    && bytes.length >= 14 && bytes[bytes.length - 1] === 0x3b;
}

function validWebp(bytes: Uint8Array): boolean {
  if (!(asciiAtBytes(bytes, 0, 'RIFF') && asciiAtBytes(bytes, 8, 'WEBP')) || bytes.length < 20) return false;
  const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
  return declared <= bytes.length && bytes.length >= 20;
}

function validBmp(bytes: Uint8Array): boolean {
  if (!asciiAtBytes(bytes, 0, 'BM') || bytes.length < 54) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(2, true) <= bytes.length && view.getUint32(18, true) > 0 && view.getUint32(22, true) > 0;
}

function validMp4(bytes: Uint8Array): boolean {
  let cursor = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMdat = false;
  while (cursor + 8 <= bytes.length) {
    let size = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.byteLength - cursor).getUint32(0, false);
    const type = String.fromCharCode(...bytes.slice(cursor + 4, cursor + 8));
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > bytes.length) return false;
      const view = new DataView(bytes.buffer, bytes.byteOffset + cursor + 8, 8);
      const high = view.getUint32(0, false);
      const low = view.getUint32(4, false);
      const bigSize = high * 0x1_0000_0000 + low;
      if (!Number.isSafeInteger(bigSize)) return false;
      size = bigSize;
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - cursor;
    }
    if (size < headerSize || cursor + size > bytes.length) return false;
    if (type === 'ftyp') hasFtyp = true;
    if (type === 'moov') hasMoov = true;
    if (type === 'mdat') hasMdat = true;
    cursor += size;
  }
  return cursor === bytes.length && hasFtyp && hasMoov && hasMdat;
}

function containsByteSequence(bytes: Uint8Array, sequence: readonly number[]): boolean {
  outer: for (let offset = 0; offset <= bytes.length - sequence.length; offset += 1) {
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[offset + index] !== sequence[index]) continue outer;
    }
    return true;
  }
  return false;
}

function validWebm(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])
    && bytes.length >= 64
    && containsByteSequence(bytes, [0x18, 0x53, 0x80, 0x67])
    && containsByteSequence(bytes, [0x16, 0x54, 0xae, 0x6b])
    && containsByteSequence(bytes, [0x1f, 0x43, 0xb6, 0x75]);
}

function isHlsOrDashManifest(bytes: Uint8Array, contentType: string): boolean {
  const declared = contentType.toLowerCase();
  if (/mpegurl|dash\+xml/.test(declared)) return true;
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2_048))).trimStart();
  return prefix.startsWith('#EXTM3U') || /<MPD(?:\s|>)/i.test(prefix);
}

/** Check both media signature and container structure before any upload. */
export async function validateMediaBody(
  body: ArrayBuffer,
  kind: 'image' | 'video',
  declaredContentType: string,
): Promise<{ contentType: string } | { error: string }> {
  const bytes = new Uint8Array(body);
  const declared = declaredContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (bytes.length === 0) return { error: 'empty body' };
  if (isHlsOrDashManifest(bytes, declared)) return { error: 'playlist manifest' };
  if (/^(?:text\/|application\/(?:json|xml|xhtml)|text\/html)/i.test(declared)) {
    return { error: 'response is not a media file' };
  }
  const sniffed = sniffContentType(body);
  if (!sniffed) return { error: 'unrecognized media data' };
  if (kind === 'image' && !sniffed.startsWith('image/')) return { error: 'candidate is not an image' };
  if (kind === 'video' && !sniffed.startsWith('video/')) return { error: 'candidate is not a video' };
  if (declared.startsWith('image/') && !sniffed.startsWith('image/')) return { error: 'media type mismatch' };
  if (declared.startsWith('video/') && !sniffed.startsWith('video/')) return { error: 'media type mismatch' };

  if (sniffed === 'image/png' && !validPng(bytes)) return { error: 'image data is incomplete' };
  if (sniffed === 'image/jpeg' && !validJpeg(bytes)) return { error: 'image data is incomplete' };
  if (sniffed === 'image/gif' && !validGif(bytes)) return { error: 'image data is incomplete' };
  if (sniffed === 'image/webp' && !validWebp(bytes)) return { error: 'image data is incomplete' };
  if (sniffed === 'image/bmp' && !validBmp(bytes)) return { error: 'image data is incomplete' };
  if (sniffed === 'image/tiff' && bytes.length < 16) return { error: 'image data is incomplete' };
  if (sniffed === 'image/avif' && bytes.length < 24) return { error: 'image data is incomplete' };
  if (sniffed === 'image/svg+xml') {
    const source = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 16_384)));
    if (!/<svg[\s>]/i.test(source) || !/<\/svg\s*>/i.test(new TextDecoder().decode(bytes))) {
      return { error: 'invalid SVG image' };
    }
  }
  if (sniffed === 'video/mp4' && !validMp4(bytes)) return { error: 'video container is incomplete' };
  if (sniffed === 'video/webm' && !validWebm(bytes)) return { error: 'video container is incomplete' };

  if (kind === 'image' && sniffed !== 'image/svg+xml' && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(new Blob([body], { type: sniffed }));
      const valid = bitmap.width > 0 && bitmap.height > 0;
      bitmap.close();
      if (!valid) return { error: 'image cannot be decoded' };
    } catch {
      return { error: 'image cannot be decoded' };
    }
  }
  return { contentType: sniffed };
}

async function readBodyBounded(response: FetchResponse): Promise<ArrayBuffer> {
  const stream = response.body;
  if (!stream?.getReader) {
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_BROWSER_FETCH_BYTES) throw new Error('file too large');
    return body;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_BROWSER_FETCH_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('file too large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function mediaUrlForMetadata(value: string): string {
  try {
    const url = new URL(value);
    const sensitiveKey = /(?:^|[_-])(?:token|signature|sig|auth|expires?|policy|keypair|key-pair)(?:$|[_-])/i;
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKey.test(key) || /^x-(?:amz|goog)-/i.test(key) || /^(?:oe|oh|xsec_token)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

/**
 * Fetch media in the browser with cookies + page referrer (Serpent-1jyi).
 * This is the anti-hotlink path; Serpent no longer re-downloads the URL.
 */
export async function fetchMediaInBrowser(
  intent: SaveIntent,
  fetchFn: FetchFunction = fetch,
  mediaUrl = intent.mediaUrl,
  pageBlobFetcher?: PageBlobFetcher,
): Promise<FetchedMedia | { error: string; playlist?: boolean }> {
  let body: ArrayBuffer;
  let contentType: string;
  let sourceUrl: string;
  if (mediaUrl.startsWith('blob:')) {
    if (!pageBlobFetcher) return { error: 'page blob is unavailable outside its source frame' };
    let result: PageBlobFetchResult;
    try {
      result = await pageBlobFetcher(mediaUrl, intent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message.slice(0, 200) || 'page blob read failed' };
    }
    if ('error' in result) return { error: result.error };
    body = result.body;
    contentType = result.contentType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    sourceUrl = mediaUrl;
  } else {
    let response: FetchResponse;
    try {
      response = await fetchFn(mediaUrl, {
        method: 'GET',
        credentials: 'include',
        referrer: intent.sourcePageUrl,
        referrerPolicy: 'unsafe-url',
        cache: 'no-store',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message.slice(0, 200) || 'network error' };
    }

    if (!response.ok) return { error: `HTTP ${response.status}` };
    if (response.status === 206) return { error: 'partial media response' };

    const contentTypeHeader = response.headers.get('content-type') ?? '';
    contentType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BROWSER_FETCH_BYTES) {
      return { error: 'file too large' };
    }

    try {
      body = await readBodyBounded(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message.slice(0, 200) || 'read failed' };
    }
    sourceUrl = response.url || mediaUrl;
  }

  if (body.byteLength === 0) return { error: 'empty body' };
  if (body.byteLength > MAX_BROWSER_FETCH_BYTES) return { error: 'file too large' };

  const validation = await validateMediaBody(body, intent.kind, contentType);
  if ('error' in validation) {
    return {
      error: validation.error,
      ...(validation.error === 'playlist manifest' ? { playlist: true } : {}),
    };
  }
  const actualContentType = validation.contentType;
  const filename = alignFilenameWithContentType(
    filenameFromUrl(sourceUrl, actualContentType),
    actualContentType,
  );

  return {
    body,
    contentType: actualContentType,
    filename,
    sourceUrl,
  };
}

export async function deliverSaveUpload(
  intent: SaveIntent,
  media: FetchedMedia,
  behavior: ExtensionSaveBehavior,
  fetchFn: FetchFunction = fetch,
): Promise<SaveOutcome> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(media.body.byteLength),
    'X-Serpent-Kind': intent.kind,
    'X-Serpent-Source-Page-Url': encodeURIComponent(mediaUrlForMetadata(intent.sourcePageUrl)),
    'X-Serpent-Media-Url': encodeURIComponent(mediaUrlForMetadata(media.sourceUrl ?? intent.mediaUrl)),
    'X-Serpent-Content-Type': media.contentType,
    'X-Serpent-Filename': encodeURIComponent(media.filename),
    'X-Serpent-Focus-App-After-Save': String(behavior.focusAppAfterSave),
    'X-Serpent-Reveal-In-Library': String(behavior.revealInLibraryAfterSave),
  };
  if (intent.targetFolderId !== undefined) {
    headers['X-Serpent-Target-Folder-Id'] =
      intent.targetFolderId === null ? 'null' : encodeURIComponent(intent.targetFolderId);
  }
  if (intent.targetCollectionId) {
    headers['X-Serpent-Target-Collection-Id'] = encodeURIComponent(intent.targetCollectionId);
  }
  if (intent.expectedLibraryId) {
    headers['X-Serpent-Expected-Library-Id'] = encodeURIComponent(intent.expectedLibraryId);
  }

  const response = await requestSerpent(
    '/save-upload',
    {
      method: 'POST',
      headers,
      body: media.body,
    },
    fetchFn,
  );
  if (!response) return { kind: 'unreachable' };

  if (response.status === 202) {
    const duplicate = await acceptedResponseIsDuplicate(response);
    return {
      kind: 'accepted',
      ...(media.savedVersion ? { savedVersion: media.savedVersion } : {}),
      ...(duplicate ? { duplicate: true } : {}),
    };
  }

  let body = '';
  try {
    body = await response.text();
  } catch {
    // Status alone is still actionable.
  }

  return {
    kind: 'rejected',
    status: response.status,
    reason: rejectionReason(body) ?? `HTTP ${response.status}`,
    ...(rejectionFailureKind(body) ? { failureKind: rejectionFailureKind(body) } : {}),
  };
}

function isPinterestOriginalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === 'pinimg.com' || url.hostname.endsWith('.pinimg.com'))
      && /^\/originals\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function dribbbleResizeWidth(value: string): number | undefined {
  try {
    const match = /^(\d{1,5})x\d{0,5}$/i.exec(new URL(value).searchParams.get('resize') ?? '');
    const width = match?.[1] ? Number(match[1]) : undefined;
    return width && width > 0 ? width : undefined;
  } catch {
    return undefined;
  }
}

function isDribbbleUnscaledSameAsset(candidateUrl: string, previewUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const preview = new URL(previewUrl);
    const isDribbbleCdn = (url: URL) => url.hostname === 'cdn.dribbble.com'
      || url.hostname.endsWith('.cdn.dribbble.com');
    return isDribbbleCdn(candidate) && isDribbbleCdn(preview)
      && candidate.origin === preview.origin
      && candidate.pathname === preview.pathname
      && !candidate.searchParams.has('resize')
      && preview.searchParams.has('resize');
  } catch {
    return false;
  }
}

function candidateRank(
  candidate: { source: string; url: string; kind: 'image' | 'video'; width?: number; contentId?: string },
  siteAdapter?: string,
  previewUrl?: string,
  previewWidth?: number,
  contentId?: string,
): number {
  // Pinterest pages expose several resized pinimg URLs as ordinary fields and
  // srcset entries. Only the /originals/ path is direct evidence of the
  // uploaded asset, so give that URL priority without changing other sites.
  if (siteAdapter === 'pinterest' && isPinterestOriginalUrl(candidate.url)) {
    return candidate.source === 'known-transform' ? -1 : -2;
  }
  // The Huaban adapter attaches this ID only to the exact file.url found in
  // the selected pin's own NEXT_DATA record. Prefer that signed original over
  // resize URLs from srcset or the legacy path transform.
  if (
    siteAdapter === 'huaban' && candidate.source === 'site-field'
    && contentId && candidate.contentId === contentId
  ) return -2;
  if (siteAdapter === 'behance' && candidate.kind === 'image') {
    if (candidate.source === 'site-field' && candidate.contentId && candidate.contentId === contentId) {
      return isBehanceOriginalAssetUrl(candidate.url) ? -3 : -2;
    }
    if (candidate.source === 'known-transform') return 1;
    if (candidate.source === 'srcset') return 2;
  }
  if (siteAdapter === 'dribbble') {
    if (previewUrl && isDribbbleUnscaledSameAsset(candidate.url, previewUrl)) return -2;
    const candidateWidth = candidate.width ?? dribbbleResizeWidth(candidate.url);
    if (candidateWidth && previewWidth && candidateWidth > previewWidth) return -1;
  }
  if (siteAdapter === 'artstation' && previewUrl) {
    const candidateKey = artstationMediaKey(candidate.url);
    const previewKey = artstationMediaKey(previewUrl);
    const variantRank = artstationVariantRank(candidate.url);
    if (candidateKey && candidateKey === previewKey && variantRank !== undefined) return -50 + variantRank;
  }
  switch (candidate.source) {
    case 'site-field': return 0;
    case 'page-bridge': return 1;
    case 'structured-data': return 2;
    case 'known-transform': return 3;
    case 'srcset': return 4;
    default: return 4;
  }
}

function fetchWithResponseHeadersTimeout(fetchFn: FetchFunction, timeoutMs: number): FetchFunction {
  return async (input, init = {}) => {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(input, { ...init, signal: controller.signal });
    } finally {
      globalThis.clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abortFromCaller);
    }
  };
}

function candidatesForIntent(intent: SaveIntent): Array<{
  url: string;
  kind: 'image' | 'video';
  source: string;
  contentId?: string;
  mediaIndex?: number;
}> {
  const previewUrl = intent.selection?.previewUrl ?? intent.mediaUrl;
  const preview = { url: previewUrl, kind: intent.kind, source: 'preview' };
  if (!intent.selection || intent.preferOriginalMedia === false) return [preview];
  const upgrades = intent.selection.candidates
    .filter((candidate) => candidate.source !== 'preview')
    .filter((candidate) => candidate.kind === intent.kind)
    .filter((candidate) => !candidate.contentId || !intent.selection?.contentId
      || candidate.contentId === intent.selection.contentId)
    .filter((candidate) => intent.kind !== 'image' || intent.selection?.siteAdapter !== 'huaban'
      || Boolean(intent.selection.contentId && candidate.contentId === intent.selection.contentId))
    .filter((candidate) => candidate.mediaIndex === undefined
      || intent.selection?.mediaIndex === undefined
      || candidate.mediaIndex === intent.selection.mediaIndex)
    .filter((candidate) => intent.kind !== 'image' || intent.selection?.siteAdapter !== 'behance'
      || isSameBehanceAsset(candidate.url, previewUrl))
    .filter((candidate) => {
      if (intent.selection?.siteAdapter !== 'artstation' || intent.kind !== 'image') return true;
      const previewKey = artstationMediaKey(previewUrl);
      const previewRank = artstationVariantRank(previewUrl);
      const candidateRank = artstationVariantRank(candidate.url);
      return Boolean(
        previewKey
        && artstationMediaKey(candidate.url) === previewKey
        && previewRank !== undefined
        && candidateRank !== undefined
        && candidateRank < previewRank,
      );
    })
    .filter((candidate) => isHttpUrl(candidate.url))
    .filter((candidate) => {
      if (intent.selection?.siteAdapter !== 'dribbble' || !intent.selection.previewWidth) return true;
      const resizeWidth = dribbbleResizeWidth(candidate.url);
      // A smaller Dribbble transform is not an upgrade over the URL currently
      // displayed by the page; skip it and keep the preview as the last resort.
      return resizeWidth === undefined || resizeWidth > intent.selection.previewWidth;
    })
    .sort((left, right) => (
      candidateRank(
        left,
        intent.selection?.siteAdapter,
        previewUrl,
        intent.selection?.previewWidth,
        intent.selection?.contentId,
      )
      - candidateRank(
        right,
        intent.selection?.siteAdapter,
        previewUrl,
        intent.selection?.previewWidth,
        intent.selection?.contentId,
      )
      || (intent.selection?.siteAdapter === 'dribbble'
        ? (right.width ?? dribbbleResizeWidth(right.url) ?? 0)
          - (left.width ?? dribbbleResizeWidth(left.url) ?? 0)
        : intent.selection?.siteAdapter === 'behance' && intent.kind === 'image'
          ? (right.width ?? 0) - (left.width ?? 0)
          : 0)
    ));
  const unique = new Map<string, typeof upgrades[number]>();
  for (const candidate of upgrades) {
    if (candidate.url === previewUrl || unique.has(candidate.url)) continue;
    unique.set(candidate.url, candidate);
  }
  return [
    ...[...unique.values()].map((candidate) => ({
      url: candidate.url,
      kind: candidate.kind,
      source: candidate.source,
      ...(candidate.contentId ? { contentId: candidate.contentId } : {}),
      ...(candidate.mediaIndex === undefined ? {} : { mediaIndex: candidate.mediaIndex }),
    })),
    preview,
  ];
}

function likelyStreamManifest(url: string): boolean {
  try {
    return /\.(?:m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function trySegmentedCandidate(
  intent: SaveIntent,
  candidate: { url: string; kind: 'image' | 'video'; source: string },
  behavior: ExtensionSaveBehavior,
  fetchFn: FetchFunction,
  requestId: string,
  transferFn: typeof trySegmentedMediaTransfer,
): Promise<{
  state: 'not-segmented' | 'unsupported' | 'saved' | 'pending' | 'source-failed' | 'failed';
  reason?: string;
  outcome?: SaveOutcome;
}> {
  if (candidate.kind !== 'video') return { state: 'not-segmented' };
  const segmented = await transferFn({
    kind: intent.kind,
    sourcePageUrl: intent.sourcePageUrl,
    mediaUrl: intent.mediaUrl,
    ...(intent.preferOriginalMedia === undefined ? {} : { preferOriginalMedia: intent.preferOriginalMedia }),
    ...(intent.allowRecoveryFallback === undefined ? {} : { allowRecoveryFallback: intent.allowRecoveryFallback }),
    ...(intent.expectedLibraryId === undefined ? {} : { expectedLibraryId: intent.expectedLibraryId }),
    ...(intent.targetFolderId === undefined ? {} : { targetFolderId: intent.targetFolderId }),
    ...(intent.targetCollectionId ? { targetCollectionId: intent.targetCollectionId } : {}),
  }, candidate, {
    fetchFn: fetchFn as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    behavior: {
      notificationsEnabled: behavior.notificationsEnabled,
      focusAppAfterSave: behavior.focusAppAfterSave,
      revealInLibraryAfterSave: behavior.revealInLibraryAfterSave,
    },
    requestId,
  });
  if (segmented.state === 'saved') {
    return {
      state: 'saved',
      outcome: {
        kind: 'accepted',
        savedVersion: candidate.source === 'preview' ? 'preview' : 'candidate',
        ...(segmented.duplicate ? { duplicate: true } : {}),
      },
    };
  }
  if (segmented.state === 'failed') {
    return { state: 'failed', reason: segmented.reason, outcome: { kind: 'transfer_failed', reason: segmented.reason } };
  }
  if (segmented.state === 'pending') {
    return { state: 'pending', reason: segmented.reason, outcome: { kind: 'pending', reason: segmented.reason } };
  }
  if (segmented.state === 'source-failed') {
    return { state: 'source-failed', reason: segmented.reason };
  }
  return { state: segmented.state };
}

/** Try evidenced candidates in order, validate bytes, then use the exact preview. */
export async function saveMediaViaBrowser(
  intent: SaveIntent,
  behavior: ExtensionSaveBehavior,
  fetchFn: FetchFunction = fetch,
  pageBlobFetcher?: PageBlobFetcher,
  pageBridgeFetcher?: PageBridgeFetcher,
  transferFn: typeof trySegmentedMediaTransfer = trySegmentedMediaTransfer,
  execution?: SaveExecutionOptions,
): Promise<SaveOutcome> {
  const commit = execution?.commit ?? (<T>(operation: () => Promise<T>) => operation());
  let effectiveIntent = intent;
  if (
    intent.preferOriginalMedia === true &&
    intent.selection?.siteCapability === 'page-bridge' && intent.selection.contentId && pageBridgeFetcher
  ) {
    const bridged = await pageBridgeFetcher(intent.selection).catch(() => []);
    if (bridged.length > 0) {
      const candidates = bridged.slice(0, 8).flatMap(({ url, contentId, kind, mediaIndex }) => {
        const candidateKind = kind ?? (intent.kind === 'image' ? 'image' : undefined);
        if (
          contentId !== intent.selection?.contentId || candidateKind !== intent.kind || !isHttpUrl(url) ||
          (intent.selection?.mediaIndex !== undefined && mediaIndex !== intent.selection.mediaIndex) ||
          url === intent.selection.previewUrl || url.length > 4_096
        ) return [];
        return [{
          url,
          kind: candidateKind,
          source: 'page-bridge' as const,
          contentId,
          ...(mediaIndex === undefined ? {} : { mediaIndex }),
        }];
      });
      if (candidates.length > 0) {
        const existing = intent.selection.candidates.filter((candidate) => candidate.source !== 'preview');
        const preview = intent.selection.candidates.filter((candidate) => candidate.source === 'preview');
        effectiveIntent = {
          ...intent,
          selection: {
            ...intent.selection,
            candidates: [
              ...existing,
              ...candidates.filter((candidate) => !existing.some((item) => item.url === candidate.url)),
              ...preview,
            ],
          },
        };
      }
    }
  }
  if (effectiveIntent.preferOriginalMedia === true && effectiveIntent.selection?.detailPageUrl) {
    const detailCandidates = await followSelectedMediaDetail(
      effectiveIntent,
      fetchFn as unknown as (input: string, init?: RequestInit) => Promise<Response>,
    );
    if (detailCandidates.length > 0 && effectiveIntent.selection) {
      const preview = effectiveIntent.selection.candidates.filter((candidate) => candidate.source === 'preview');
      effectiveIntent = {
        ...effectiveIntent,
        selection: {
          ...effectiveIntent.selection,
          candidates: [
            ...effectiveIntent.selection.candidates.filter((candidate) => candidate.source !== 'preview'),
            ...detailCandidates,
            ...preview,
          ],
        },
      };
    }
  }
  const candidates = candidatesForIntent(effectiveIntent);
  let lastFailure = 'download failed';
  let previewFallbackOnly = false;
  for (const candidate of candidates) {
    const isPreview = candidate.source === 'preview';
    if (previewFallbackOnly && !isPreview) continue;
    const requestId = makeSegmentedRequestId();
    const attemptSegmented = () => trySegmentedCandidate(
      effectiveIntent, candidate, behavior, fetchFn, requestId, transferFn,
    );
    const segmentAttempt = candidate.kind === 'video'
      ? await commit(attemptSegmented)
      : await attemptSegmented();
    if (segmentAttempt.outcome) return segmentAttempt.outcome;
    if (segmentAttempt.state === 'source-failed') {
      lastFailure = segmentAttempt.reason ?? 'source media download failed';
      if (isPreview) break;
      continue;
    }
    if (segmentAttempt.state === 'unsupported' && likelyStreamManifest(candidate.url)) {
      lastFailure = 'stream format is unsupported';
      continue;
    }

    const candidateFetch = !isPreview && candidate.kind === 'image'
      && effectiveIntent.selection?.siteAdapter === 'behance'
      ? fetchWithResponseHeadersTimeout(
        fetchFn,
        execution?.candidateHeadersTimeoutMs ?? BEHANCE_CANDIDATE_HEADERS_TIMEOUT_MS,
      )
      : fetchFn;
    const fetched = await fetchMediaInBrowser(effectiveIntent, candidateFetch, candidate.url, pageBlobFetcher);
    if ('error' in fetched) {
      lastFailure = fetched.error;
      if (fetched.playlist && candidate.kind === 'video') {
        if (segmentAttempt.state !== 'unsupported') {
          const segmentAfterSniff = await commit(attemptSegmented);
          if (segmentAfterSniff.outcome) return segmentAfterSniff.outcome;
        }
        // Never upload a manifest as an ordinary file.
        continue;
      }
      // A failed upgrade candidate falls through to the exact browser preview.
      if (isPreview) break;
      continue;
    }
    const saved = await commit(() => deliverSaveUpload(effectiveIntent, {
      ...fetched,
      savedVersion: isPreview ? 'preview' : 'candidate',
    }, behavior, fetchFn));
    if (saved.kind === 'accepted') {
      return {
        kind: 'accepted',
        savedVersion: isPreview ? 'preview' : 'candidate',
        ...(saved.duplicate ? { duplicate: true } : {}),
      };
    }
    if (saved.kind === 'rejected' && saved.failureKind === 'source-invalid' && intent.kind === 'video') {
      lastFailure = saved.reason;
      if (isPreview) return { kind: 'fetch_failed', reason: saved.reason };
      previewFallbackOnly = true;
      continue;
    }
    // Import/desktop errors do not switch to another URL or duplicate the asset.
    return saved;
  }
  return { kind: 'fetch_failed', reason: lastFailure };
}

export function notificationForOutcome(outcome: SaveOutcome): UserNotification {
  switch (outcome.kind) {
    case 'accepted':
      if (outcome.duplicate) {
        return {
          title: '已跳过重复文件',
          message: '资源库中已有内容相同的文件，本次未重复保存。',
        };
      }
      if (outcome.savedVersion === 'preview') {
        return {
          title: '已保存当前预览',
          message: '原图或更高质量版本不可用，已保存当前预览。',
        };
      }
      return {
        title: '已发送到 Serpent',
        message: 'Serpent 已接收保存请求。',
      };
    case 'rejected':
      return {
        title: 'Serpent 拒绝了保存请求',
        message: `HTTP ${outcome.status}：${outcome.reason}`,
      };
    case 'pending':
      return {
        title: '视频正在后台传输',
        message: outcome.reason || '分段视频已建立保存任务，Serpent 将继续恢复传输。',
      };
    case 'transfer_failed':
      return {
        title: '视频导入失败',
        message: `Serpent 无法完成分段视频导入：${outcome.reason}`,
      };
    case 'unreachable':
      return {
        title: '无法连接 Serpent',
        message: '请先启动 Serpent 桌面应用并打开资源库，然后重新保存。',
      };
    case 'fetch_failed': {
      const hotlinkHint = outcome.reason.startsWith('HTTP 403')
        ? '（该站点可能启用了防盗链，请反馈给扩展开发者加入支持列表）'
        : '';
      return {
        title: '浏览器无法下载该媒体',
        message: `下载失败：${outcome.reason}${hotlinkHint}`,
      };
    }
  }
}
