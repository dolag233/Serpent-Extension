import type { MediaKind } from './types';

export interface GenericEngineCandidate {
  readonly url: string;
  readonly engine: 'wordpress' | 'mediawiki';
}

/** Conservative URL transforms enabled only after identifying the page engine. */
export function genericEngineCandidates(
  doc: Document,
  previewUrl: string,
  kind: MediaKind,
): GenericEngineCandidate[] {
  if (kind !== 'image') return [];
  const engine = identifyEngine(doc, previewUrl);
  if (!engine) return [];
  if (engine === 'wordpress') return wordpressCandidates(previewUrl);
  return mediaWikiCandidates(previewUrl);
}

export function identifyEngine(doc: Document, previewUrl: string): 'wordpress' | 'mediawiki' | undefined {
  const generator = doc.querySelector<HTMLMetaElement>('meta[name="generator"]')?.content ?? '';
  if (/wordpress/i.test(generator)) return 'wordpress';
  if (/mediawiki/i.test(generator)) return 'mediawiki';
  try {
    const url = new URL(previewUrl);
    if (url.hostname === 'upload.wikimedia.org' || url.hostname.endsWith('.wikimedia.org')) {
      return 'mediawiki';
    }
  } catch {
    // A non-HTTP preview cannot use engine URL transforms.
  }
  const hasWordPressAssets = [...doc.scripts, ...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .some((element) => /\/wp-(?:content|includes)\//i.test('src' in element ? element.src : element.href));
  if (hasWordPressAssets) return 'wordpress';
  return undefined;
}

function wordpressCandidates(value: string): GenericEngineCandidate[] {
  try {
    const url = new URL(value);
    const variants = new Set<string>();
    const dimensionless = url.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.[^.]+$)/i, '');
    if (dimensionless !== url.pathname) variants.add(dimensionless);
    const unscaled = url.pathname.replace(/-scaled(?=\.[^.]+$)/i, '');
    if (unscaled !== url.pathname) variants.add(unscaled);
    return [...variants].map((pathname) => ({
      url: `${url.origin}${pathname}${url.search}${url.hash}`,
      engine: 'wordpress' as const,
    }));
  } catch {
    return [];
  }
}

function mediaWikiCandidates(value: string): GenericEngineCandidate[] {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/');
    const thumbIndex = segments.findIndex((segment) => segment.toLowerCase() === 'thumb');
    if (thumbIndex < 0 || thumbIndex + 2 >= segments.length) return [];
    const originalSegments = segments.slice();
    originalSegments.splice(thumbIndex, 1);
    originalSegments.pop();
    const pathname = originalSegments.join('/');
    if (!pathname || pathname === url.pathname) return [];
    return [{
      url: `${url.origin}${pathname}${url.search}${url.hash}`,
      engine: 'mediawiki',
    }];
  } catch {
    return [];
  }
}
