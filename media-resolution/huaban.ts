export interface HuabanOriginalCandidate {
  readonly url: string;
  readonly source: 'site-field' | 'known-transform';
}

const MAX_PIN_SEARCH_DEPTH = 12;
const MAX_PIN_SEARCH_NODES = 10_000;

/** Resolve only the pin named by the selected card/page and the preview's file key. */
export function huabanOriginalCandidateForState(
  state: unknown,
  pinId: string,
  previewUrl: string,
  baseUrl: string,
): HuabanOriginalCandidate | undefined {
  if (!/^\d+$/.test(pinId)) return undefined;
  const serverSidePins = objectPath(state, ['props', 'pageProps', 'serverSidePins']);
  const directRecords = Array.isArray(serverSidePins)
    ? serverSidePins.filter((pin) => hasPinId(pin, pinId))
    : [];
  const records = directRecords.length > 0
    ? directRecords
    : findPinRecords(objectPath(state, ['props', 'pageProps']), pinId);
  const uniqueRecords = uniquePinFiles(records);

  if (uniqueRecords.length > 1) return undefined;
  const pin = uniqueRecords[0];
  if (pin) {
    const file = Reflect.get(pin, 'file');
    if (!file || typeof file !== 'object') return undefined;
    const fileKey = stringField(file, 'key');
    if (!fileKey || !previewMatchesFileKey(previewUrl, fileKey, baseUrl)) return undefined;
    const fileUrl = stringField(file, 'url');
    const originalUrl = fileUrl ? normalizeHuabanImageUrl(fileUrl, baseUrl) : undefined;
    if (originalUrl && originalMatchesFileKey(originalUrl, fileKey)) {
      return { url: originalUrl, source: 'site-field' };
    }
    return deriveOriginalFromPreview(previewUrl, fileKey, baseUrl);
  }

  // A board's initial state may not contain Pins loaded later while scrolling.
  // The observed Huaban fwNNNwebp suffix is removable only when the page still
  // identifies the selected Pin and no conflicting Pin record was found.
  return deriveOriginalFromPreview(previewUrl, undefined, baseUrl);
}

function objectPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function hasPinId(value: unknown, pinId: string): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object'
    && String(Reflect.get(value, 'pin_id')) === pinId);
}

function findPinRecords(root: unknown, pinId: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_PIN_SEARCH_DEPTH || visitedNodes >= MAX_PIN_SEARCH_NODES) return;
    if (Array.isArray(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      visitedNodes += 1;
      for (const child of value.slice(0, 500)) visit(child, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    visitedNodes += 1;
    if (hasPinId(value, pinId)) found.push(value);
    for (const child of Object.values(value).slice(0, 200)) visit(child, depth + 1);
  };
  visit(root, 0);
  return found;
}

function uniquePinFiles(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const unique = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const file = Reflect.get(record, 'file');
    if (!file || typeof file !== 'object') {
      unique.set(`invalid:${unique.size}`, record);
      continue;
    }
    const key = stringField(file, 'key') ?? '';
    const url = stringField(file, 'url') ?? '';
    unique.set(`${key}\n${url}`, record);
  }
  return [...unique.values()];
}

function stringField(value: object, name: string): string | undefined {
  const field = Reflect.get(value, name);
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function previewMatchesFileKey(previewUrl: string, fileKey: string, baseUrl: string): boolean {
  const url = parseHuabanImageUrl(previewUrl, baseUrl);
  if (!url) return false;
  const filename = decodedFilename(url);
  return filename === fileKey || new RegExp(`^${escapeRegExp(fileKey)}_fw\\d+webp$`, 'i').test(filename);
}

function originalMatchesFileKey(originalUrl: string, fileKey: string): boolean {
  const url = parseHuabanImageUrl(originalUrl, originalUrl);
  return Boolean(url && decodedFilename(url) === fileKey);
}

function deriveOriginalFromPreview(
  previewUrl: string,
  expectedFileKey: string | undefined,
  baseUrl: string,
): HuabanOriginalCandidate | undefined {
  const url = parseHuabanImageUrl(previewUrl, baseUrl);
  if (!url) return undefined;
  const pathname = url.pathname;
  const slash = pathname.lastIndexOf('/');
  const encodedFilename = pathname.slice(slash + 1);
  const filename = decodedFilename(url);
  const suffix = /_fw\d+webp$/i.exec(filename)?.[0];
  if (!suffix) return undefined;
  const fileKey = filename.slice(0, -suffix.length);
  if (!fileKey || (expectedFileKey && fileKey !== expectedFileKey)) return undefined;
  url.pathname = `${pathname.slice(0, slash + 1)}${encodedFilename.replace(/_fw\d+webp$/i, '')}`;
  const candidateUrl = url.href;
  return candidateUrl === previewUrl ? undefined : { url: candidateUrl, source: 'known-transform' };
}

function normalizeHuabanImageUrl(value: string, baseUrl: string): string | undefined {
  const url = parseHuabanImageUrl(value, baseUrl);
  return url?.href;
}

function parseHuabanImageUrl(value: string, baseUrl: string): URL | undefined {
  try {
    const url = new URL(value, baseUrl);
    const host = url.hostname.toLowerCase();
    const trustedHost = host === 'huaban.com' || host.endsWith('.huaban.com')
      || host === 'huabanimg.com' || host.endsWith('.huabanimg.com')
      || host === 'hb.aicdn.com';
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && trustedHost
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function decodedFilename(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
