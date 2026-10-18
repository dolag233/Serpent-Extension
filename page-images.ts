import {
  extractHttpUrlFromCssBackgroundImage,
  isHttpUrl,
  mediaFromElement,
  mediaUrlFromImage,
} from './media-target';
import { BATCH_FORMATS, type BatchFilterSettings } from './preferences';

export interface CollectedMedia {
  readonly key: string;
  readonly kind: 'image' | 'video';
  readonly saveUrl: string;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

const IMAGE_PATH = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const SIZE_QUERY_KEYS = ['w', 'h', 'width', 'height', 'resize', 'fit'];

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

/** Drop common CDN size params. The path is unchanged, so a rejected URL still 404s visibly. */
export function stripSizeQuery(url: string): string {
  if (!isHttpUrl(url)) return url;
  try {
    const parsed = new URL(url);
    for (const key of SIZE_QUERY_KEYS) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url;
  }
}

function imageLinkAround(element: Element): string | undefined {
  const href = element.closest('a')?.href;
  if (!href || !isHttpUrl(href)) return undefined;
  return IMAGE_PATH.test(href) ? href : undefined;
}

function chooseSaveUrl(
  displayed: string,
  element: Element,
  preferHd: boolean,
): string {
  if (!preferHd) return displayed;
  return stripSizeQuery(imageLinkAround(element) ?? displayed);
}

function sizeOfImage(img: HTMLImageElement): { width: number; height: number } {
  const width = img.naturalWidth || Math.round(img.getBoundingClientRect().width);
  const height = img.naturalHeight || Math.round(img.getBoundingClientRect().height);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

function pushUnique(
  items: Map<string, CollectedMedia>,
  item: CollectedMedia,
): void {
  if (!items.has(item.key)) items.set(item.key, item);
}

function isExtensionUi(element: Element): boolean {
  return element.closest('[data-serpent-ui]') !== null;
}

export function collectPageMedia(doc: Document, preferHd: boolean): CollectedMedia[] {
  const items = new Map<string, CollectedMedia>();
  const images = doc.querySelectorAll('img');
  for (const img of images) {
    if (isExtensionUi(img)) continue;
    const displayed = mediaUrlFromImage(img);
    if (!displayed) continue;
    const saveUrl = chooseSaveUrl(displayed, img, preferHd);
    const size = sizeOfImage(img);
    pushUnique(items, {
      key: saveUrl,
      kind: 'image',
      saveUrl,
      previewUrl: displayed,
      width: size.width,
      height: size.height,
      format: formatFromUrl(saveUrl, 'image'),
    });
  }

  const videos = doc.querySelectorAll('video');
  for (const video of videos) {
    if (isExtensionUi(video)) continue;
    const media = mediaFromElement(video);
    if (!media) continue;
    const rect = video.getBoundingClientRect();
    pushUnique(items, {
      key: media.mediaUrl,
      kind: 'video',
      saveUrl: media.mediaUrl,
      previewUrl: isHttpUrl(video.poster) ? video.poster : media.mediaUrl,
      width: video.videoWidth || Math.round(rect.width),
      height: video.videoHeight || Math.round(rect.height),
      format: formatFromUrl(media.mediaUrl, 'video'),
    });
  }

  const styled = doc.querySelectorAll<HTMLElement>('[style*="background"]');
  for (const element of styled) {
    if (isExtensionUi(element)) continue;
    const url = extractHttpUrlFromCssBackgroundImage(element.style.backgroundImage);
    if (!url) continue;
    const saveUrl = preferHd ? stripSizeQuery(imageLinkAround(element) ?? url) : url;
    const rect = element.getBoundingClientRect();
    pushUnique(items, {
      key: saveUrl,
      kind: 'image',
      saveUrl,
      previewUrl: url,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      format: formatFromUrl(saveUrl, 'image'),
    });
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
