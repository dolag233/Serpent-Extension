import browser from 'webextension-polyfill';

import { openBatchPanel, setBatchProgress } from './batch-panel';
import { resolveMediaTargetAtPoint } from './media-target';
import { startCapture, type CaptureMode } from './page-capture';
import {
  DRAG_RADIAL_MENU_ENABLED_KEY,
  dragRadialMenuEnabledFromStored,
  readDragRadialMenuEnabled,
} from './preferences';
import { applyDragGhostThumbnail, startRadialSaveMenu } from './radial-menu';
import { showSaveToast } from './save-bubble';
import type { MediaSelection } from './media-resolution/types';
import type { PageBridgeAdapter, PageBridgeResponse } from './media-resolution/page-bridge-data';
import { siteAdapterForUrl } from './media-resolution/resolve';

// 右键菜单保存（background.ts）通过此消息把「保存中/保存结果」反馈到当前页面。
// 同步处理、不回复：background 端 tabs.sendMessage 已用 catch 吞掉无响应错误。
let lastContextMedia: {
  kind: 'image' | 'video';
  mediaUrl: string;
  selection: MediaSelection;
  pageUrl: string;
  capturedAt: number;
} | null = null;

const MAX_PAGE_BLOB_BYTES = 500 * 1024 * 1024;
const PAGE_BLOB_CHUNK_BYTES = 64 * 1024;

interface BlobReadPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: () => void): void;
    removeListener(callback: () => void): void;
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  }
  return btoa(binary);
}

function requestPageBlobChunkAck(port: BlobReadPort, seq: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      if (Reflect.get(message, 'type') !== 'serpent-page-blob-ack' || Reflect.get(message, 'seq') !== seq) return;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      resolve();
    };
    const onDisconnect = () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      reject(new Error('source frame disconnected'));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
  });
}

async function streamPageBlobToBackground(port: BlobReadPort, message: object): Promise<void> {
  const mediaUrl = Reflect.get(message, 'url');
  const pageUrl = Reflect.get(message, 'pageUrl');
  if (typeof mediaUrl !== 'string' || typeof pageUrl !== 'string') {
    port.postMessage({ type: 'serpent-page-blob-error', reason: 'invalid page blob request' });
    return;
  }
  let blobUrl: URL;
  try {
    blobUrl = new URL(mediaUrl);
  } catch {
    port.postMessage({ type: 'serpent-page-blob-error', reason: 'invalid blob URL' });
    return;
  }
  if (
    blobUrl.protocol !== 'blob:' ||
    blobUrl.origin !== window.location.origin ||
    pageUrl !== window.location.href
  ) {
    port.postMessage({ type: 'serpent-page-blob-error', reason: 'source page changed or blob origin mismatched' });
    return;
  }
  if (typeof MediaSource !== 'undefined') {
    const hasMediaSourceObject = [...document.querySelectorAll('video')].some((video) =>
      (video.currentSrc === mediaUrl || video.src === mediaUrl) && video.srcObject instanceof MediaSource,
    );
    if (hasMediaSourceObject) {
      port.postMessage({ type: 'serpent-page-blob-error', reason: 'MediaSource blob is not a complete media file' });
      return;
    }
  }

  try {
    const response = await fetch(mediaUrl, { cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`blob read failed (HTTP ${response.status})`);
    const declaredBytes = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
      throw new Error('blob size is unavailable');
    }
    if (declaredBytes > MAX_PAGE_BLOB_BYTES) throw new Error('file too large');
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    port.postMessage({
      type: 'serpent-page-blob-meta',
      size: declaredBytes,
      contentType,
    });

    const reader = response.body.getReader();
    let seq = 0;
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        for (let offset = 0; offset < result.value.byteLength; offset += PAGE_BLOB_CHUNK_BYTES) {
          const chunk = result.value.subarray(offset, Math.min(offset + PAGE_BLOB_CHUNK_BYTES, result.value.byteLength));
          total += chunk.byteLength;
          if (total > declaredBytes || total > MAX_PAGE_BLOB_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error('blob size exceeded declared limit');
          }
          const currentSeq = seq++;
          const ack = requestPageBlobChunkAck(port, currentSeq);
          port.postMessage({
            type: 'serpent-page-blob-chunk',
            seq: currentSeq,
            size: chunk.byteLength,
            data: encodeBase64(chunk),
          });
          await ack;
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (total !== declaredBytes) throw new Error('blob body length did not match its declared size');
    port.postMessage({ type: 'serpent-page-blob-done', chunks: seq, size: total });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      port.postMessage({ type: 'serpent-page-blob-error', reason: reason.slice(0, 200) });
    } catch {
      // The background may have closed the port after enforcing its size bound.
    }
  }
}

browser.runtime.onConnect.addListener((rawPort) => {
  const port = rawPort as unknown as BlobReadPort;
  if (port.name !== 'serpent-page-blob-read') return;
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object' || Reflect.get(message, 'type') !== 'serpent-page-blob-read') return;
    void streamPageBlobToBackground(port, message);
  });
});

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return undefined;
  const type = Reflect.get(message, 'type');
  if (type === 'serpent-page-bridge-candidates') {
    const adapter = Reflect.get(message, 'adapter');
    const contentId = Reflect.get(message, 'contentId');
    const previewUrl = Reflect.get(message, 'previewUrl');
    const pageUrl = Reflect.get(message, 'pageUrl');
    if (
      !isPageBridgeAdapter(adapter) || typeof contentId !== 'string' || !contentId ||
      typeof previewUrl !== 'string' || typeof pageUrl !== 'string' ||
      pageUrl !== window.location.href || pageAdapterForSite(pageUrl) !== adapter
    ) return Promise.resolve({ candidates: [] });
    const kind = Reflect.get(message, 'kind');
    const mediaIndex = Reflect.get(message, 'mediaIndex');
    const mediaKey = Reflect.get(message, 'mediaKey');
    if (adapter === 'x-status-media' && (
      kind !== 'video' || !/^\d{1,24}$/.test(contentId) ||
      (mediaIndex !== undefined && (typeof mediaIndex !== 'number' || !Number.isSafeInteger(mediaIndex) || mediaIndex < 0)) ||
      (mediaKey !== undefined && (typeof mediaKey !== 'string' || !/^\d+_\d{1,32}$/.test(mediaKey)))
    )) return Promise.resolve({ candidates: [] });
    if (adapter !== 'x-status-media' && kind !== 'image') return Promise.resolve({ candidates: [] });
    const requestId = createBridgeRequestId();
    const request = {
      type: 'serpent-page-bridge-request',
      requestId,
      adapter,
      contentId,
      previewUrl,
      pageUrl,
      kind,
      ...(typeof mediaIndex === 'number' ? { mediaIndex } : {}),
      ...(typeof mediaKey === 'string' ? { mediaKey } : {}),
    } as const;
    return new Promise<{ candidates: Array<{ url: string; contentId: string; kind: 'image' | 'video'; mediaIndex?: number }> }>((resolve) => {
      let settled = false;
      const finish = (candidates: Array<{ url: string; contentId: string; kind: 'image' | 'video'; mediaIndex?: number }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        window.removeEventListener('message', onResponse);
        resolve({ candidates });
      };
      const onResponse = (event: MessageEvent<unknown>) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const response = event.data as Partial<PageBridgeResponse> | null;
        if (
          !response || response.type !== 'serpent-page-bridge-response' ||
          response.requestId !== requestId || response.adapter !== adapter ||
          response.contentId !== contentId || response.previewUrl !== previewUrl ||
          !Array.isArray(response.urls) ||
          (adapter === 'x-status-media' && (response.kind !== 'video' || (mediaIndex !== undefined && response.mediaIndex !== mediaIndex))) ||
          (adapter !== 'x-status-media' && response.kind !== 'image')
        ) return;
        const candidates = response.urls.slice(0, 8).flatMap((url) =>
          typeof url === 'string' && url.length <= 4_096 && isHttpMediaUrl(url) && url !== previewUrl
            ? [{ url, contentId, kind: response.kind as 'image' | 'video', ...(response.mediaIndex === undefined ? {} : { mediaIndex: response.mediaIndex }) }]
            : [],
        );
        finish(candidates);
      };
      const timeout = setTimeout(() => finish([]), 350);
      window.addEventListener('message', onResponse);
      window.postMessage(request, window.location.origin);
    });
  }
  if (type === 'serpent-context-media') {
    const srcUrl = Reflect.get(message, 'srcUrl');
    const pageUrl = Reflect.get(message, 'pageUrl');
    const checkOnly = Reflect.get(message, 'checkOnly') === true;
    const record = lastContextMedia;
    if (
      !record ||
      Date.now() - record.capturedAt > 10_000 ||
      record.pageUrl !== window.location.href ||
      (typeof pageUrl === 'string' && pageUrl !== record.pageUrl) ||
      (!checkOnly && (typeof srcUrl !== 'string' || srcUrl !== record.selection.previewUrl))
    ) {
      return checkOnly ? undefined : Promise.resolve(null);
    }
    return Promise.resolve(record);
  }
  if (type === 'serpent-batch-progress') {
    const done = Reflect.get(message, 'done');
    const total = Reflect.get(message, 'total');
    const token = Reflect.get(message, 'token');
    if (typeof done === 'number' && typeof total === 'number' && typeof token === 'number') {
      setBatchProgress(token, done, total);
    }
    return undefined;
  }
  if (type === 'serpent-save-feedback') {
    if (Reflect.get(message, 'state') === 'saving') {
      showSaveToast('正在保存到 Serpent', '发送中…');
    } else {
      showSaveToast(Reflect.get(message, 'title'), Reflect.get(message, 'message'));
    }
    return undefined;
  }
  if (type === 'serpent-open-batch') {
    openBatchPanel();
    return Promise.resolve({ ok: true });
  }
  if (type === 'serpent-start-capture') {
    const mode = Reflect.get(message, 'mode');
    if (mode === 'visible' || mode === 'area' || mode === 'element' || mode === 'page') {
      startCapture(mode as CaptureMode);
      return Promise.resolve({ ok: true });
    }
  }
  return undefined;
});

function isPageBridgeAdapter(value: unknown): value is PageBridgeAdapter {
  return value === 'google-images' || value === 'duckduckgo-images' || value === 'yandex-images'
    || value === 'x-status-media';
}

function pageAdapterForSite(pageUrl: string): PageBridgeAdapter | undefined {
  const adapter = siteAdapterForUrl(pageUrl);
  if (adapter === 'x') return 'x-status-media';
  return isPageBridgeAdapter(adapter) ? adapter : undefined;
}

function createBridgeRequestId(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

function isHttpMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

document.addEventListener('contextmenu', (event) => {
  const media = resolveMediaTargetAtPoint(
    document,
    event.clientX,
    event.clientY,
    event.composedPath(),
  );
  const pageUrl = window.location.href;
  lastContextMedia = media
    ? {
      kind: media.kind,
      mediaUrl: media.mediaUrl,
      selection: media.selection,
      pageUrl,
      capturedAt: Date.now(),
    }
    : null;
  if (!event.altKey || !media) return;
  event.preventDefault();
  event.stopPropagation();
  showSaveToast('正在保存到 Serpent', '发送中…');
  void browser.runtime.sendMessage({
    type: 'serpent-save-request',
    intent: {
      kind: media.kind,
      sourcePageUrl: pageUrl,
      mediaUrl: media.mediaUrl,
      selection: media.selection,
    },
  }).then((response: unknown) => {
    const notification = response && typeof response === 'object'
      ? Reflect.get(response, 'notification')
      : undefined;
    const title = notification && typeof notification === 'object'
      ? Reflect.get(notification, 'title')
      : '已发送到 Serpent';
    const message = notification && typeof notification === 'object'
      ? Reflect.get(notification, 'message')
      : '';
    showSaveToast(
      typeof title === 'string' ? title : '已发送到 Serpent',
      typeof message === 'string' ? message : '',
    );
  }).catch(() => {
    showSaveToast('无法保存到 Serpent', '扩展后台没有响应');
  });
}, true);

// 右键保存走 Chrome 扩展原生 contextMenus（background.ts），不拦截页面右键，
// 避免浮层菜单替换整站原生菜单（Serpent-ak94 / 用户反馈 2026-07-26）。

// Serpent-c0ml / REQ-EXT-005：拖拽图片/视频时展开树状保存菜单（全站点生效）。
// 可在扩展设置中关闭；内容脚本侧缓存开关并监听变更，避免每次 dragstart 都读存储。
let radialMenuEnabled = true;
void readDragRadialMenuEnabled().then((enabled) => {
  radialMenuEnabled = enabled;
});
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const change = changes[DRAG_RADIAL_MENU_ENABLED_KEY];
  if (change) {
    radialMenuEnabled = dragRadialMenuEnabledFromStored(change.newValue);
  }
});

// 不 preventDefault——原生拖拽照常进行，轮盘只是顺路的保存菜单。
document.addEventListener(
  'dragstart',
  (event) => {
    if (!radialMenuEnabled) return;
    const media = resolveMediaTargetAtPoint(
      document,
      event.clientX,
      event.clientY,
      event.composedPath(),
    );
    if (!media) return;
    lastContextMedia = {
      kind: media.kind,
      mediaUrl: media.mediaUrl,
      selection: media.selection,
      pageUrl: window.location.href,
      capturedAt: Date.now(),
    };
    applyDragGhostThumbnail(event);
    void startRadialSaveMenu(event.clientX, event.clientY, media);
  },
  true,
);
