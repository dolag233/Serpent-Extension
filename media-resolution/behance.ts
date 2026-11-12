export interface BehanceTarget {
  readonly projectId: string;
  readonly moduleId?: string;
  readonly contentId: string;
}

export interface BehanceStateCandidates {
  readonly contentId: string;
  readonly urls: readonly string[];
  readonly widths: ReadonlyMap<string, number>;
}

interface CachedBehanceState {
  readonly script: HTMLScriptElement;
  readonly source: string;
  readonly parsed: unknown;
}

const MAX_BEHANCE_STATE_LENGTH = 2_000_000;
const STATE_CACHE = new WeakMap<Document, CachedBehanceState>();

/** Find the project/module that owns this image from the selected page context. */
export function behanceTargetForElement(element: Element, pageUrl: string): BehanceTarget | undefined {
  const directAnchor = element.closest('a[href]');
  const directRoute = parseBehanceRoute(directAnchor?.getAttribute('href') ?? '', pageUrl);
  const pageRoute = parseBehanceRoute(pageUrl, pageUrl);

  if (directRoute?.moduleId) {
    return {
      projectId: directRoute.projectId,
      moduleId: directRoute.moduleId,
      contentId: `behance:${directRoute.projectId}:module:${directRoute.moduleId}`,
    };
  }
  if (pageRoute) {
    return {
      projectId: pageRoute.projectId,
      contentId: `behance:${pageRoute.projectId}:cover`,
    };
  }

  const localRoutes = new Map<string, { projectId: string; href: string }>();
  let current: Element | null = element;
  for (let level = 0; current && level <= 5; level += 1) {
    const anchors = current.querySelectorAll<HTMLAnchorElement>('a[href]');
    for (const anchor of anchors) {
      const route = parseBehanceRoute(anchor.getAttribute('href') ?? anchor.href, pageUrl);
      if (route && !route.moduleId) {
        localRoutes.set(route.projectId, { projectId: route.projectId, href: anchor.href });
      }
    }
    if (current !== element && mediaCount(current) > 1) break;
    current = current.parentElement;
  }
  if (localRoutes.size !== 1) return undefined;
  const route = [...localRoutes.values()][0];
  if (!route) return undefined;
  return {
    projectId: route.projectId,
    contentId: `behance:${route.projectId}:cover`,
  };
}

/** Read only the matching Behance project cover or selected image module. */
export function behanceCandidatesForState(
  doc: Document,
  target: BehanceTarget,
  previewUrl: string,
  previewWidth?: number,
): BehanceStateCandidates | undefined {
  return behanceCandidatesFromParsedState(parseBehanceState(doc), target, previewUrl, previewWidth);
}

/** Resolve same-project, same-image Behance renditions from already parsed state. */
export function behanceCandidatesFromParsedState(
  state: unknown,
  target: BehanceTarget,
  previewUrl: string,
  previewWidth?: number,
): BehanceStateCandidates | undefined {
  const project = projectFromState(state, target.projectId);
  if (!project) return undefined;
  const preview = parseBehanceAssetUrl(previewUrl);
  if (!preview) return undefined;

  if (target.moduleId) {
    if (preview.family !== 'project_modules') return undefined;
    const modules = Reflect.get(project, 'modules');
    if (!Array.isArray(modules)) return undefined;
    const matchingModules = modules.filter((item) => (
      isObject(item)
      && String(Reflect.get(item, 'id') ?? '') === target.moduleId
      && String(Reflect.get(item, 'projectId') ?? '') === target.projectId
      && String(Reflect.get(item, '__typename') ?? '') === 'ImageModule'
    ));
    if (matchingModules.length !== 1) return undefined;
    const module = matchingModules[0];
    if (!isObject(module)) return undefined;
    const imageSizes = Reflect.get(module, 'imageSizes');
    const entries = imageVariantEntries(imageSizes);
    const variants = bestSameAssetVariants(entries, previewUrl, preview, 'project_modules', previewWidth);
    return variants.urls.length > 0 ? { contentId: target.contentId, ...variants } : undefined;
  }

  if (preview.family !== 'projects') return undefined;
  const covers = Reflect.get(project, 'covers');
  const entries = imageVariantEntries(covers, true);
  const variants = bestSameAssetVariants(entries, previewUrl, preview, 'projects', previewWidth);
  return variants.urls.length > 0 ? { contentId: target.contentId, ...variants } : undefined;
}

/** Verify that two Behance CDN URLs name the same project asset and family. */
export function isSameBehanceAsset(candidateUrl: string, previewUrl: string): boolean {
  const candidate = parseBehanceAssetUrl(candidateUrl);
  const preview = parseBehanceAssetUrl(previewUrl);
  return Boolean(candidate && preview
    && candidate.origin === preview.origin
    && candidate.family === preview.family
    && candidate.filename === preview.filename);
}

/** True only for a Behance path explicitly labeled as an original/source asset. */
export function isBehanceOriginalAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!isBehanceHostname(url.hostname)) return false;
    const family = assetFamily(url.pathname);
    return family ? isOriginalFamilyPath(url.pathname, family) : false;
  } catch {
    return false;
  }
}

/** Return a state-declared size for an exact rendition URL, ignoring signature queries. */
export function behanceStateVariantWidth(
  widths: ReadonlyMap<string, number> | undefined,
  value: string,
): number | undefined {
  if (!widths) return undefined;
  const exact = widths.get(value);
  if (exact !== undefined) return exact;
  const key = variantPathKey(value);
  if (!key) return undefined;
  for (const [url, width] of widths) {
    if (variantPathKey(url) === key) return width;
  }
  return undefined;
}

/** Derive an evidenced original path while preserving the exact asset name and family. */
export function behanceOriginalPath(value: string): string[] {
  try {
    const url = new URL(value);
    if (!isBehanceHostname(url.hostname)) return [];
    const family = assetFamily(url.pathname);
    if (!family) return [];
    if (family === 'projects' && /^\/projects\/original(?:_webp)?\//i.test(url.pathname)) return [];
    if (family === 'project_modules' && /^\/project_modules\/source\//i.test(url.pathname)) return [];
    const pathPattern = family === 'projects'
      ? /^(\/projects\/)(?:max_\d+|\d+)(?:_webp)?\//i
      : /^(\/project_modules\/)(?:disp|fs(?:_webp)?|(?:max_)?\d+(?:_webp)?)\//i;
    const nextPath = url.pathname.replace(pathPattern, (_match, prefix: string) => (
      `${prefix}${family === 'projects' ? 'original' : 'source'}/`
    ));
    return nextPath === url.pathname ? [] : [`${url.origin}${nextPath}${url.search}${url.hash}`];
  } catch {
    return [];
  }
}

function parseBehanceState(doc: Document): unknown {
  const script = [...doc.scripts].find((item) => item.id === 'beconfig-store_state');
  if (!script) return undefined;
  const source = script.textContent ?? '';
  if (source.length > MAX_BEHANCE_STATE_LENGTH) return undefined;
  const cached = STATE_CACHE.get(doc);
  if (cached?.script === script && cached.source === source) return cached.parsed;
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; } catch { return undefined; }
  STATE_CACHE.set(doc, { script, source, parsed });
  return parsed;
}

function projectFromState(state: unknown, projectId: string): Record<string, unknown> | undefined {
  const root = objectField(state, 'project');
  const project = objectField(root, 'project');
  if (!project || String(project.id ?? '') !== projectId) return undefined;
  return project;
}

function imageVariantEntries(value: unknown, includeNamedOriginals = false): Array<{ url: string; width?: number }> {
  if (!isObject(value)) return [];
  const allAvailable = Reflect.get(value, 'allAvailable');
  const entries = Array.isArray(allAvailable)
    ? allAvailable.flatMap(imageVariantEntry)
    : [];
  if (includeNamedOriginals) {
    for (const [name, item] of Object.entries(value)) {
      if (!/^size_original(?:_webp)?$/i.test(name)) continue;
      entries.push(...imageVariantEntry(item));
    }
  }
  const unique = new Map<string, { url: string; width?: number }>();
  for (const entry of entries) unique.set(entry.url, entry);
  return [...unique.values()];
}

function imageVariantEntry(value: unknown): Array<{ url: string; width?: number }> {
  if (typeof value === 'string') return [{ url: value }];
  if (!isObject(value) || typeof value.url !== 'string') return [];
  const width = typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
    ? value.width
    : undefined;
  return [{ url: value.url, ...(width ? { width } : {}) }];
}

function bestSameAssetVariants(
  entries: readonly { url: string; width?: number }[],
  previewUrl: string,
  preview: NonNullable<ReturnType<typeof parseBehanceAssetUrl>>,
  family: 'projects' | 'project_modules',
  previewWidth?: number,
): { urls: string[]; widths: ReadonlyMap<string, number> } {
  const matches = entries.flatMap((entry) => {
    const parsed = parseBehanceAssetUrl(entry.url, previewUrl);
    if (!parsed || parsed.origin !== preview.origin || parsed.family !== family
      || parsed.filename !== preview.filename) return [];
    const sourcePath = isOriginalFamilyPath(parsed.pathname, family);
    return [{ url: parsed.href, width: entry.width, sourcePath }];
  });
  const widths = new Map(matches.flatMap((item) => item.width ? [[item.url, item.width] as const] : []));
  const candidates = matches.filter((item) => (
    item.sourcePath || Boolean(previewWidth && item.width && item.width > previewWidth)
  ));
  candidates.sort((left, right) => (
    Number(right.sourcePath) - Number(left.sourcePath)
    || (right.width ?? 0) - (left.width ?? 0)
  ));
  return {
    urls: [...new Set(candidates.map((item) => item.url))],
    widths,
  };
}

function isOriginalFamilyPath(pathname: string, family: 'projects' | 'project_modules'): boolean {
  return family === 'projects'
    ? /^\/projects\/original(?:_webp)?\//i.test(pathname)
    : /^\/project_modules\/source\//i.test(pathname);
}

function parseBehanceAssetUrl(value: string, baseUrl?: string): {
  href: string;
  origin: string;
  pathname: string;
  filename: string;
  family: 'projects' | 'project_modules';
} | undefined {
  try {
    const url = new URL(value, baseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isBehanceHostname(url.hostname)
      || url.username || url.password) return undefined;
    const family = assetFamily(url.pathname);
    const filename = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (!family || !filename) return undefined;
    return {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      filename,
      family,
    };
  } catch {
    return undefined;
  }
}

function assetFamily(pathname: string): 'projects' | 'project_modules' | undefined {
  if (/^\/projects\//i.test(pathname)) return 'projects';
  if (/^\/project_modules\//i.test(pathname)) return 'project_modules';
  return undefined;
}

function parseBehanceRoute(value: string, baseUrl: string): { projectId: string; moduleId?: string } | undefined {
  try {
    const url = new URL(value, baseUrl);
    if (!isBehanceHostname(url.hostname)) return undefined;
    const match = /^\/gallery\/(\d+)(?:\/[^/]+)?(?:\/modules\/(\d+))?\/?$/i.exec(url.pathname);
    if (!match?.[1]) return undefined;
    return {
      projectId: match[1],
      ...(match[2] ? { moduleId: match[2] } : {}),
    };
  } catch {
    return undefined;
  }
}

function mediaCount(element: Element): number {
  return element.querySelectorAll('img,video').length;
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const child = Reflect.get(value, key);
  return isObject(child) ? child : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBehanceHostname(hostname: string): boolean {
  return hostname === 'behance.net' || hostname.endsWith('.behance.net');
}

function variantPathKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
