const ARTSTATION_CDN_HOST = /^cdn[a-z0-9-]*\.artstation\.com$/i;

const ARTSTATION_VARIANTS = new Set([
  'small', 'smaller_square', 'small_square', 'micro_square',
  'medium', 'medium_wide', 'default', 'large', '4k', '8k', 'original',
]);

const VARIANT_RANK: Readonly<Record<string, number>> = {
  original: 0,
  '8k': 1,
  '4k': 2,
  large: 3,
  default: 4,
  medium: 4,
  medium_wide: 4,
  small: 5,
  small_square: 5,
  smaller_square: 5,
  micro_square: 5,
};

function imagePathParts(value: string): {
  idPath: string;
  variant: string;
  fileName: string;
} | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!ARTSTATION_CDN_HOST.test(url.hostname)) return undefined;
    const match = /^\/p\/assets\/images\/images\/(\d{1,5}\/\d{1,5}\/\d{1,5}\/)(?:(\d{14})\/)?([^/]+)\/([^/]+)$/i.exec(url.pathname);
    if (!match || !ARTSTATION_VARIANTS.has(match[3]?.toLowerCase() ?? '')) return undefined;
    return {
      idPath: `${match[1]}${match[2] ? `${match[2]}/` : ''}`,
      variant: match[3].toLowerCase(),
      fileName: match[4],
    };
  } catch {
    return undefined;
  }
}

/** A CDN-independent key for one ArtStation image asset, including its filename. */
export function artstationMediaKey(value: string): string | undefined {
  const parts = imagePathParts(value);
  return parts ? `artstation:${parts.idPath}${parts.fileName}` : undefined;
}

/** Returns the path variant rank used to order evidenced ArtStation image URLs. */
export function artstationVariantRank(value: string): number | undefined {
  const parts = imagePathParts(value);
  return parts ? VARIANT_RANK[parts.variant] : undefined;
}

/** Derives only the same asset's documented non-cropped renditions. */
export function artstationCandidates(value: string): string[] {
  const parts = imagePathParts(value);
  if (!parts) return [];

  const currentRank = VARIANT_RANK[parts.variant];
  const targetVariants = ['8k', '4k', 'large']
    .filter((variant) => VARIANT_RANK[variant] < currentRank);
  const candidates: string[] = [];
  for (const variant of targetVariants) {
    try {
      const url = new URL(value);
      url.pathname = url.pathname.replace(/\/[^/]+\/([^/]+)$/u, `/${variant}/$1`);
      if (url.href !== value) candidates.push(url.href);
    } catch {
      return [];
    }
  }
  return candidates;
}

/** Allows CDN host changes only when ArtStation's path ID and filename still match. */
export function isSameArtStationAsset(left: string, right: string): boolean {
  const leftKey = artstationMediaKey(left);
  return Boolean(leftKey && leftKey === artstationMediaKey(right));
}

export function isArtStationHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'artstation.com' || host.endsWith('.artstation.com');
}
