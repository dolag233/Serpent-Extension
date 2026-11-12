import {
  parseDuckDuckGoImageRecords,
  parseDuckDuckGoImageRecordsFromValue,
  parseGoogleImageRecords,
  parseXStatusVideoRecords,
  parseYandexImageRecords,
  resolvePageBridgeRequest,
  type PageBridgeAdapter,
  type PageBridgeImageRecord,
  type PageBridgeXVideoRecord,
} from './media-resolution/page-bridge-data';

const MAX_BODY_CHARS = 2 * 1024 * 1024;
const MAX_RECORDS = 1_000;
const MAX_URLS = 8;
const records = new Map<PageBridgeAdapter, Map<string, Set<string>>>();
const xVideoRecords = new Map<string, Map<string, PageBridgeXVideoRecord>>();

function pageAdapter(): PageBridgeAdapter | undefined {
  const host = location.hostname.toLowerCase();
  if (host === 'google.com' || host.endsWith('.google.com')) return 'google-images';
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) return 'duckduckgo-images';
  if (
    host === 'yandex.com' || host.endsWith('.yandex.com') ||
    host === 'yandex.ru' || host.endsWith('.yandex.ru')
  ) return 'yandex-images';
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
    return 'x-status-media';
  }
  return undefined;
}

const adapter = pageAdapter();
if (adapter) {
  const ingest = (url: string, body: string) => {
    if (!adapter || body.length > MAX_BODY_CHARS || !isAllowedResponse(url, adapter)) return;
    if (adapter === 'x-status-media') {
      try { rememberXRecords(parseXStatusVideoRecords(JSON.parse(body) as unknown)); } catch { /* Not a Tweet response. */ }
      return;
    }
    let parsed: PageBridgeImageRecord[];
    if (adapter === 'google-images') parsed = parseGoogleImageRecords(body);
    else if (adapter === 'duckduckgo-images') parsed = parseDuckDuckGoImageRecords(body);
    else {
      try { parsed = parseYandexImageRecords(JSON.parse(body) as unknown); } catch { return; }
    }
    rememberRecords(parsed);
  };

  const ingestValue = (url: string, value: unknown) => {
    if (!adapter || !isAllowedResponse(url, adapter)) return;
    if (adapter === 'x-status-media') rememberXRecords(parseXStatusVideoRecords(value));
    else if (adapter === 'duckduckgo-images') rememberRecords(parseDuckDuckGoImageRecordsFromValue(value));
    else if (adapter === 'yandex-images') rememberRecords(parseYandexImageRecords(value));
  };

  const rememberRecords = (parsed: readonly PageBridgeImageRecord[]) => {
    if (!adapter) return;
    const index = records.get(adapter) ?? new Map<string, Set<string>>();
    for (const record of parsed.slice(0, MAX_RECORDS)) {
      if (!record.contentId || record.contentId.length > 160) continue;
      const urls = index.get(record.contentId) ?? new Set<string>();
      for (const candidate of record.urls.slice(0, MAX_URLS)) {
        if (isHttpUrl(candidate)) urls.add(candidate);
      }
      if (urls.size > 0) index.set(record.contentId, new Set([...urls].slice(0, MAX_URLS)));
    }
    while (index.size > MAX_RECORDS) {
      const oldest = index.keys().next().value as string | undefined;
      if (!oldest) break;
      index.delete(oldest);
    }
    records.set(adapter, index);
  };

  const rememberXRecords = (parsed: readonly PageBridgeXVideoRecord[]) => {
    for (const record of parsed.slice(0, MAX_RECORDS)) {
      if (!/^\d{1,24}$/.test(record.contentId) || !/^\d+_\d{1,32}$/.test(record.mediaKey)) continue;
      const media = xVideoRecords.get(record.contentId) ?? new Map<string, PageBridgeXVideoRecord>();
      media.set(record.mediaKey, {
        contentId: record.contentId,
        mediaKey: record.mediaKey,
        mediaIndex: record.mediaIndex,
        previewUrls: record.previewUrls.slice(0, 4),
        urls: record.urls.slice(0, MAX_URLS),
      });
      while (media.size > 16) {
        const oldest = media.keys().next().value as string | undefined;
        if (!oldest) break;
        media.delete(oldest);
      }
      xVideoRecords.set(record.contentId, media);
    }
    while (xVideoRecords.size > MAX_RECORDS) {
      const oldest = xVideoRecords.keys().next().value as string | undefined;
      if (!oldest) break;
      xVideoRecords.delete(oldest);
    }
  };

  const inspectInitialState = () => {
    if (!adapter) return;
    let remaining = MAX_BODY_CHARS;
    const scriptCount = Math.min(document.scripts.length, 64);
    for (let scriptIndex = 0; scriptIndex < scriptCount; scriptIndex += 1) {
      const script = document.scripts.item(scriptIndex);
      if (!script) continue;
      const text = script.textContent ?? '';
      if (!text || text.length > remaining || text.length > MAX_BODY_CHARS) continue;
      remaining -= text.length;
      if (adapter === 'google-images') {
        rememberRecords(parseGoogleImageRecords(text));
      } else if (adapter === 'duckduckgo-images') {
        rememberRecords(parseDuckDuckGoImageRecords(text));
      } else if (adapter === 'yandex-images' && (
        script.type === 'application/json' || /^(?:initData|__NEXT_DATA__|ImagesAppState)$/i.test(script.id)
      )) {
        try { rememberRecords(parseYandexImageRecords(JSON.parse(text) as unknown)); } catch { /* Not JSON state. */ }
      }
    }
    if (adapter === 'yandex-images') {
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      let checkedNodes = 0;
      let stateNodes = 0;
      let current: Node | null;
      while ((current = walker.nextNode()) && checkedNodes < 5_000 && stateNodes < 20) {
        checkedNodes += 1;
        if (!(current instanceof Element) || !current.hasAttribute('data-state')) continue;
        stateNodes += 1;
        const state = current.getAttribute('data-state');
        if (!state || state.length > remaining || state.length > MAX_BODY_CHARS) continue;
        remaining -= state.length;
        try { rememberRecords(parseYandexImageRecords(JSON.parse(state) as unknown)); } catch { /* Unrelated state. */ }
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inspectInitialState, { once: true });
  } else {
    setTimeout(inspectInitialState, 0);
  }
  setTimeout(inspectInitialState, 1_000);

  const originalFetch = window.fetch;
  window.fetch = function (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    const input = args[0];
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = originalFetch.apply(this, args);
    void response.then((result) => {
      if (!isAllowedResponse(rawUrl, adapter)) return;
      void readBoundedResponseText(result).then((body) => {
        if (body !== undefined) ingest(rawUrl, body);
      }).catch(() => {});
    }).catch(() => {});
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    const url = args[1];
    Reflect.set(this, '__serpentBridgeUrl', new URL(String(url), location.href).href);
    return Reflect.apply(originalOpen, this, args);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
    this.addEventListener('load', () => {
      const rawUrl = Reflect.get(this, '__serpentBridgeUrl');
      if (typeof rawUrl !== 'string' || !isAllowedResponse(rawUrl, adapter)) return;
      try {
        if (typeof this.response === 'string' && this.response.length <= MAX_BODY_CHARS) {
          ingest(rawUrl, this.response);
        } else if (this.responseType === 'json') {
          ingestValue(rawUrl, this.response as unknown);
        }
      } catch { /* The page may use a non-readable XHR response type. */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;
    const request = event.data;
    if (Reflect.get(request, 'type') !== 'serpent-page-bridge-request') return;
    const indexed = records.get(adapter);
    const snapshot = indexed
      ? [...indexed].map(([contentId, urls]) => ({ contentId, urls: [...urls] }))
      : [];
    const xSnapshot = adapter === 'x-status-media'
      ? [...xVideoRecords.values()].flatMap((items) => [...items.values()])
      : [];
    const response = resolvePageBridgeRequest(request, adapter, location.href, snapshot, xSnapshot);
    if (response) window.postMessage(response, location.origin);
  });
}

function isAllowedResponse(value: string, currentAdapter: PageBridgeAdapter): boolean {
  try {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || url.protocol !== 'https:') return false;
    if (currentAdapter === 'google-images') {
      return (url.pathname === '/search' && (
        url.searchParams.get('tbm') === 'isch' || url.searchParams.get('udm') === '2'
      ))
        || /^\/async\//.test(url.pathname);
    }
    if (currentAdapter === 'duckduckgo-images') return url.pathname === '/i.js';
    if (currentAdapter === 'x-status-media') {
      return /^\/i\/api\/graphql\/[^/]+\/(?:TweetDetail|TweetResultByRestId|HomeLatestTimeline|HomeTimeline|UserTweets|UserTweetsAndReplies)(?:\/|$)/.test(url.pathname)
        || /^\/i\/api\/1\.1\/statuses\/(?:show|lookup)\.json$/.test(url.pathname);
    }
    return /^\/images\/search\/?$/.test(url.pathname) && url.searchParams.get('format') === 'json';
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

async function readBoundedResponseText(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_CHARS) return undefined;
  const body = response.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_CHARS) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_BODY_CHARS) {
        await reader.cancel();
        return undefined;
      }
    }
    text += decoder.decode();
    return text.length <= MAX_BODY_CHARS ? text : undefined;
  } finally {
    reader.releaseLock();
  }
}
