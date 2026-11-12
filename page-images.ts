import {
  extractHttpUrlFromCssBackgroundImage,
  isHttpUrl,
  mediaFromElement,
  type MediaTarget,
} from './media-target';
import { selectionForBackgroundImage } from './media-resolution/resolve';
import type { MediaSelection } from './media-resolution/types';
import { BATCH_FORMATS, type BatchFilterSettings } from './preferences';

export interface CollectedMedia {
  readonly key: string;
  readonly kind: 'image' | 'video';
  /** Kept as a compatibility alias and always equals the exact preview URL. */
  readonly saveUrl: string;
  readonly previewUrl: string;
  readonly selection: MediaSelection;
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export function formatFromUrl(url: string, kind: 'image' | 'video'): string {
  try {
    const match = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(new URL(url).pathname);
    if (match?.[1]) {
      const ext = match[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch {
    // Fall through to the kind label.
  }
  return kind === 'video' ? 'video' : 'image';
}

function sizeOfImage(img: HTMLImageElement): { width: number; height: number } {
  const width = img.naturalWidth || Math.round(img.getBoundingClientRect().width);
  const height = img.naturalHeight || Math.round(img.getBoundingClientRect().height);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function stableKey(selection: MediaSelection): string {
  if (selection.contentId && selection.mediaIndex !== undefined) {
    return `${selection.kind}:${selection.contentId}:${selection.mediaIndex}`;
  }
  if (selection.siteAdapter === 'pinterest' && selection.kind === 'video' && selection.contentId && selection.posterUrl) {
    let posterKey = selection.posterUrl;
    try {
      const poster = new URL(selection.posterUrl);
      poster.search = '';
      poster.hash = '';
      posterKey = poster.pathname.replace(/^\/\d{1,5}x(?:\d{1,5})?(?:_[a-z0-9]+)?\//i, '/');
    } catch {
      // The selected poster was already validated at the extension boundary.
    }
    return `${selection.kind}:${selection.contentId}:${posterKey}`;
  }
  return `${selection.kind}:${selection.previewUrl}`;
}

function pushUnique(items: Map<string, CollectedMedia>, item: CollectedMedia): void {
  if (!items.has(item.key)) items.set(item.key, item);
}

function isExtensionUi(element: Element): boolean {
  return element.closest('[data-serpent-ui]') !== null;
}

function collectedFromTarget(target: MediaTarget, width: number, height: number): CollectedMedia {
  const selection = target.selection;
  return {
    key: stableKey(selection),
    kind: target.kind,
    saveUrl: selection.previewUrl,
    previewUrl: selection.previewUrl,
    selection,
    width: Math.max(0, width),
    height: Math.max(0, height),
    format: formatFromUrl(selection.previewUrl, target.kind),
  };
}

/** Collect only the browser-selected preview; candidates travel with each item. */
export function collectPageMedia(doc: Document): CollectedMedia[] {
  const items = new Map<string, CollectedMedia>();
  for (const img of doc.querySelectorAll('img')) {
    if (isExtensionUi(img)) continue;
    const target = mediaFromElement(img);
    if (!target || !target.selection.previewUrl) continue;
    const size = sizeOfImage(img);
    pushUnique(items, collectedFromTarget(target, size.width, size.height));
  }

  for (const video of doc.querySelectorAll('video')) {
    if (isExtensionUi(video)) continue;
    const target = mediaFromElement(video);
    if (!target || !target.selection.previewUrl) continue;
    const rect = video.getBoundingClientRect();
    pushUnique(items, collectedFromTarget(
      target,
      video.videoWidth || Math.round(rect.width),
      video.videoHeight || Math.round(rect.height),
    ));
  }

  for (const element of doc.querySelectorAll<HTMLElement>('[style*="background"]')) {
    if (isExtensionUi(element)) continue;
    const url = extractHttpUrlFromCssBackgroundImage(element.style.backgroundImage);
    if (!url || !isHttpUrl(url)) continue;
    const selection = selectionForBackgroundImage(element, url, doc.location.href);
    const rect = element.getBoundingClientRect();
    const item: CollectedMedia = {
      key: stableKey(selection),
      kind: 'image',
      saveUrl: url,
      previewUrl: url,
      selection,
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
      format: formatFromUrl(url, 'image'),
    };
    pushUnique(items, item);
  }

  return [...items.values()];
}

export function mediaPassesFilter(
  item: CollectedMedia,
  filter: BatchFilterSettings,
): boolean {
  const sizeKnown = item.width > 0 && item.height > 0;
  if (sizeKnown && (item.width < filter.minEdge || item.height < filter.minEdge)) return false;
  if (filter.formats.length === 0) return false;
  const known = (BATCH_FORMATS as readonly string[]).includes(item.format);
  if (!known) return true;
  return (filter.formats as readonly string[]).includes(item.format);
}
