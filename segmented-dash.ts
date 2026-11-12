import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { resolveSafeMediaResourceUrl } from './segmented-url';
import {
  safeError,
  uploadSegmentedMediaPlan,
  type SegmentedMediaTransferClient,
  type SegmentedMediaCandidate,
  type SegmentedMediaSaveIntent,
  type SegmentedMediaTrack,
  type SegmentedMediaTransferOptions,
  type SegmentedMediaTransferOutcome,
} from './media-transfer';
import {
  planToTrack,
  type HlsPart,
  type HlsRange,
  type HlsTrackPlan,
  type MediaManifestProbe,
} from './segmented-hls';

const MAX_DASH_SEGMENTS = 20_000;
const DASH_MPD_NAMESPACE = 'urn:mpeg:dash:schema:mpd:2011';

interface DashRepresentation {
  attributes: Map<string, string>;
  baseUrl: string;
  bandwidth: number;
  width: number;
  height: number;
  identity: Record<string, string | number | null>;
}

interface DashManifestIdentity {
  format: 'dash';
  video: Record<string, string | number | null>;
  audio: Record<string, string | number | null> | null;
}

export interface ResolvedDashMediaPlan {
  plans: HlsTrackPlan[];
  identity: string;
}

class UnsupportedDashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDashError';
  }
}

export async function runDashSegmentedTransfer(
  intent: SegmentedMediaSaveIntent,
  candidate: SegmentedMediaCandidate,
  options: SegmentedMediaTransferOptions,
  client: SegmentedMediaTransferClient,
  manifest: MediaManifestProbe,
): Promise<SegmentedMediaTransferOutcome> {
  if (manifest.format !== 'dash' || !manifest.text) return { state: 'not-segmented' };
  if (intent.preferOriginalMedia !== true) {
    return { state: 'unsupported', reason: '当前 DASH 清单没有说明播放器正在使用的representation' };
  }
  if (!client.capability.protocols.includes('dash-fmp4')) {
    return { state: 'unsupported', reason: '桌面端不支持当前 DASH 分段格式' };
  }
  try {
    const resolved = resolveDashMediaPlan(manifest.text, manifest.finalUrl);
    const tracks: SegmentedMediaTrack[] = resolved.plans.map((plan, index) => planToTrack(plan, index === 0 ? 'v' : 'a'));
    return await uploadSegmentedMediaPlan({
      intent,
      candidate,
      options,
      client,
      protocol: 'dash-fmp4',
      tracks,
      plans: resolved.plans.map((plan) => ({ kind: plan.kind, ...(plan.init ? { init: plan.init } : {}), parts: plan.parts })),
      resolvedMediaUrl: manifest.finalUrl,
      manifestUrl: candidate.url,
      sourceIdentity: resolved.identity,
    });
  } catch (error) {
    return { state: 'unsupported', reason: safeError(error) };
  }
}

export function resolveDashMediaPlan(xml: string, manifestUrl: string, expectedIdentity?: string): ResolvedDashMediaPlan {
  if (/<!DOCTYPE\b/iu.test(xml)) throw new UnsupportedDashError('DASH 不支持包含DOCTYPE的清单');
  let document: Document;
  try {
    document = new DOMParser({
      onError: () => { throw new Error('invalid XML'); },
    }).parseFromString(xml, 'application/xml');
  } catch {
    throw new UnsupportedDashError('DASH XML清单无效');
  }
  const root = document.documentElement;
  if (!root || root.localName !== 'MPD'
    || (root.namespaceURI && root.namespaceURI !== DASH_MPD_NAMESPACE)) {
    throw new UnsupportedDashError('DASH MPD结构无效');
  }
  if (directChildren(root, 'ContentProtection').length > 0
    || directChildren(root, 'SegmentBase').length > 0
    || descendants(root, 'ContentProtection').length > 0
    || descendants(root, 'SegmentBase').length > 0) {
    throw new UnsupportedDashError('暂不支持加密、DRM或SegmentBase/SIDX DASH');
  }
  const rootAttributes = elementAttributes(root);
  const mpdType = rootAttributes.get('type');
  if (mpdType && mpdType.toLowerCase() !== 'static') {
    throw new UnsupportedDashError('暂不支持动态或直播 DASH');
  }
  const periods = directChildren(root, 'Period');
  if (periods.length !== 1) throw new UnsupportedDashError('仅支持包含一个Period的静态 DASH');
  const period = periods[0]!;
  const mpdBase = resolveBaseUrl(root, manifestUrl);
  const periodBase = resolveBaseUrl(period, mpdBase);
  const periodAttributes = elementAttributes(period);
  const periodDuration = parseIsoDuration(periodAttributes.get('duration'))
    ?? parseIsoDuration(rootAttributes.get('mediaPresentationDuration'));
  if (!periodDuration || periodDuration <= 0 || periodDuration > 24 * 60 * 60) {
    throw new UnsupportedDashError('DASH缺少有效的完整时长');
  }
  const adaptations = directChildren(period, 'AdaptationSet');
  const videoAdaptations = adaptations.filter((adaptation) => adaptationKind(adaptation) === 'video');
  const audioAdaptations = adaptations.filter((adaptation) => adaptationKind(adaptation) === 'audio');
  if (videoAdaptations.length !== 1) throw new UnsupportedDashError('DASH视频轨道不明确');
  if (audioAdaptations.length > 1) {
    const main = audioAdaptations.filter((adaptation) => directChildren(adaptation, 'Role')
      .some((role) => elementAttributes(role).get('value')?.toLowerCase() === 'main'));
    if (main.length !== 1) throw new UnsupportedDashError('DASH包含多个未标记主音轨的音频representation');
    audioAdaptations.splice(0, audioAdaptations.length, main[0]!);
  }
  const expected = expectedIdentity === undefined ? undefined : parseDashIdentity(expectedIdentity);
  const video = buildTrackPlan(videoAdaptations[0]!, [root, period], periodBase, periodDuration, 'video', expected?.video);
  const audio = audioAdaptations.length > 0
    ? buildTrackPlan(audioAdaptations[0]!, [root, period], periodBase, periodDuration, 'audio', expected?.audio ?? undefined)
    : undefined;
  const identity: DashManifestIdentity = {
    format: 'dash',
    video: video.identity,
    audio: audio?.identity ?? null,
  };
  if (expected && !sameJson(expected, identity)) throw new UnsupportedDashError('DASH媒体轨道身份已变化');
  return { plans: [video.plan, ...(audio ? [audio.plan] : [])], identity: JSON.stringify(identity) };
}

function buildTrackPlan(
  adaptation: Element,
  ancestors: readonly Element[],
  parentBaseUrl: string,
  periodDuration: number,
  kind: 'video' | 'audio',
  expectedRepresentation?: Record<string, string | number | null> | null,
): { plan: HlsTrackPlan; identity: Record<string, string | number | null> } {
  const representationElements = directChildren(adaptation, 'Representation');
  if (representationElements.length === 0) throw new UnsupportedDashError(`DASH ${kind}轨道缺少representation`);
  const adaptationBase = resolveBaseUrl(adaptation, parentBaseUrl);
  const candidates: DashRepresentation[] = representationElements.map((representation) => {
    const baseUrl = resolveBaseUrl(representation, adaptationBase);
    const adaptationAttributes = elementAttributes(adaptation);
    const attributes = new Map([...adaptationAttributes, ...elementAttributes(representation)]);
    if (adaptationAttributes.has('id')) attributes.set('_adaptationId', adaptationAttributes.get('id')!);
    if (adaptationAttributes.has('lang')) attributes.set('_adaptationLang', adaptationAttributes.get('lang')!);
    if (adaptationAttributes.has('contentType')) attributes.set('_adaptationContentType', adaptationAttributes.get('contentType')!);
    return {
      attributes,
      baseUrl,
      bandwidth: numeric(attributes.get('bandwidth')),
      width: numeric(attributes.get('width')),
      height: numeric(attributes.get('height')),
      identity: dashRepresentationIdentity(attributes),
    };
  });
  const selected = expectedRepresentation
    ? candidates.find((candidate) => sameJson(candidate.identity, expectedRepresentation))
    : candidates.sort((left, right) => kind === 'video'
      ? (right.width * right.height - left.width * left.height) || (right.bandwidth - left.bandwidth)
      : right.bandwidth - left.bandwidth,
    )[0];
  if (!selected) throw new UnsupportedDashError(`DASH ${kind}轨道信息缺失`);
  const codecFamilies = new Set(candidates
    .map((candidate) => (candidate.attributes.get('codecs') ?? '').split(',').map((codec) => codec.trim().split('.')[0] ?? '').filter(Boolean).join(','))
    .filter(Boolean));
  if (codecFamilies.size > 1) throw new UnsupportedDashError(`DASH ${kind}包含无法跨编码比较的representation`);

  const representationId = selected.attributes.get('id');
  if (!representationId) throw new UnsupportedDashError(`DASH ${kind} representation缺少id`);
  const representationElement = representationElements.find((candidate) => elementAttributes(candidate).get('id') === representationId)!;
  const hierarchy = [...ancestors, adaptation, representationElement];
  const templates = directChildLevels(hierarchy, 'SegmentTemplate');
  const lists = directChildLevels(hierarchy, 'SegmentList');
  if (templates.length > 0 && lists.length > 0) {
    throw new UnsupportedDashError(`DASH ${kind}轨道混用了SegmentTemplate与SegmentList`);
  }
  if (templates.length > 0) {
    const attributes = new Map<string, string>();
    let timeline: Element | undefined;
    for (const template of templates) {
      for (const [key, value] of elementAttributes(template)) attributes.set(key, value);
      const nestedTimeline = firstChild(template, 'SegmentTimeline');
      if (nestedTimeline) timeline = nestedTimeline;
    }
    return { plan: buildTemplatePlan(selected, attributes, timeline, periodDuration, kind), identity: selected.identity };
  }
  if (lists.length > 0) {
    const attributes = new Map<string, string>();
    for (const list of lists) {
      for (const [key, value] of elementAttributes(list)) attributes.set(key, value);
    }
    return { plan: buildSegmentListPlan(selected, attributes, lists, periodDuration, kind), identity: selected.identity };
  }
  throw new UnsupportedDashError(`DASH ${kind}轨道缺少受支持的SegmentTemplate或SegmentList`);
}

function buildTemplatePlan(
  representation: DashRepresentation,
  attributes: Map<string, string>,
  timeline: Element | undefined,
  periodDuration: number,
  kind: 'video' | 'audio',
): HlsTrackPlan {
  const mediaTemplate = attributes.get('media');
  const initializationTemplate = attributes.get('initialization');
  const timescale = numeric(attributes.get('timescale')) || 1;
  const startNumberValue = Number(attributes.get('startNumber') ?? 1);
  const startNumber = Number.isSafeInteger(startNumberValue) && startNumberValue >= 0 ? startNumberValue : 1;
  const presentationTimeOffset = attributes.get('presentationTimeOffset');
  if (presentationTimeOffset !== undefined && Number(presentationTimeOffset) !== 0) {
    throw new UnsupportedDashError('暂不支持带presentationTimeOffset的DASH');
  }
  if (!Number.isSafeInteger(timescale) || timescale <= 0) throw new UnsupportedDashError('DASH timescale无效');
  if (!mediaTemplate || !initializationTemplate) {
    throw new UnsupportedDashError(`DASH ${kind}轨道缺少media或initialization模板`);
  }
  const initializationUrl = expandTemplate(initializationTemplate, {
    number: startNumber,
    time: 0,
    representationId: representation.attributes.get('id')!,
    bandwidth: representation.bandwidth,
  });
  const init = { url: safeResolve(initializationUrl, representation.baseUrl) };

  const segments: Array<{ number: number; time: number; durationUnits: number }> = [];
  if (timeline) {
    const timelineEntries = directChildren(timeline, 'S').map(elementAttributes);
    let currentTime = 0;
    let number = startNumber;
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index]!;
      const duration = numeric(entry.get('d'));
      if (duration <= 0) throw new UnsupportedDashError('DASH SegmentTimeline时长无效');
      if (entry.has('t')) {
        const timestamp = Number(entry.get('t'));
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new UnsupportedDashError('DASH时间戳无效');
        currentTime = timestamp;
      }
      if (segments.length > 0 && currentTime !== segments[segments.length - 1]!.time + segments[segments.length - 1]!.durationUnits) {
        throw new UnsupportedDashError('DASH时间轴包含缺口或重叠');
      }
      let repeat = entry.has('r') ? Number(entry.get('r')) : 0;
      if (!Number.isInteger(repeat) || repeat < -1) throw new UnsupportedDashError('DASH SegmentTimeline重复值无效');
      if (repeat === -1) {
        const nextExplicit = timelineEntries.slice(index + 1).find((item) => item.has('t'));
        const endTime = nextExplicit ? numeric(nextExplicit.get('t')) : periodDuration * timescale;
        repeat = Math.ceil((endTime - currentTime) / duration) - 1;
        if (repeat < 0 || repeat > MAX_DASH_SEGMENTS) throw new UnsupportedDashError('DASH SegmentTimeline无法确定完整片段数');
      }
      if (segments.length + repeat + 1 > MAX_DASH_SEGMENTS) throw new UnsupportedDashError('DASH片段数超过限制');
      for (let count = 0; count <= repeat; count += 1) {
        segments.push({ number: number++, time: currentTime, durationUnits: duration });
        currentTime += duration;
      }
    }
    if (segments[0]?.time !== 0) throw new UnsupportedDashError('DASH时间轴未从Period起点开始');
    const timelineDuration = segments.reduce((sum, segment) => sum + segment.durationUnits, 0) / timescale;
    if (Math.abs(timelineDuration - periodDuration) > Math.max(1, periodDuration * 0.02)) {
      throw new UnsupportedDashError('DASH时间轴没有覆盖完整Period');
    }
  } else {
    const duration = numeric(attributes.get('duration'));
    if (duration <= 0) throw new UnsupportedDashError('DASH SegmentTemplate缺少duration或timeline');
    const count = Math.ceil(periodDuration * timescale / duration);
    if (count <= 0 || count > MAX_DASH_SEGMENTS) throw new UnsupportedDashError('DASH片段数超过限制');
    for (let index = 0; index < count; index += 1) {
      segments.push({ number: startNumber + index, time: index * duration, durationUnits: duration });
    }
  }
  if (segments.length === 0) throw new UnsupportedDashError(`DASH ${kind}轨道没有媒体片段`);
  const parts: HlsPart[] = segments.map((segment) => {
    const segmentStart = segment.time / timescale;
    const segmentDuration = Math.min(segment.durationUnits / timescale, periodDuration - segmentStart);
    if (segmentDuration <= 0) throw new UnsupportedDashError('DASH片段超出Period范围');
    return {
      url: safeResolve(expandTemplate(mediaTemplate, {
        number: segment.number,
        time: segment.time,
        representationId: representation.attributes.get('id')!,
        bandwidth: representation.bandwidth,
      }), representation.baseUrl),
      durationMs: Math.max(1, Math.round(segmentDuration * 1000)),
    };
  });
  return { kind, protocol: 'hls-fmp4', init, parts };
}

function buildSegmentListPlan(
  representation: DashRepresentation,
  attributes: Map<string, string>,
  lists: readonly Element[],
  periodDuration: number,
  kind: 'video' | 'audio',
): HlsTrackPlan {
  const initialization = [...lists].reverse().map((list) => firstChild(list, 'Initialization')).find(Boolean);
  const initAttributes = initialization ? elementAttributes(initialization) : new Map<string, string>();
  const initUri = initAttributes.get('sourceURL');
  if (!initUri) throw new UnsupportedDashError(`DASH ${kind} SegmentList缺少初始化片段`);
  const initRange = parseDashRange(initAttributes.get('range'));
  const segmentElements = [...lists].reverse().map((list) => directChildren(list, 'SegmentURL')).find((items) => items.length > 0) ?? [];
  if (segmentElements.length === 0 || segmentElements.length > MAX_DASH_SEGMENTS) throw new UnsupportedDashError('DASH SegmentList片段数量无效');
  const timescale = numeric(attributes.get('timescale')) || 1;
  const durationUnits = numeric(attributes.get('duration'));
  const timeline = [...lists].reverse().map((list) => firstChild(list, 'SegmentTimeline')).find(Boolean);
  let durationsMs: number[];
  if (timeline) {
    const entries = directChildren(timeline, 'S').map(elementAttributes);
    durationsMs = [];
    for (const entry of entries) {
      const duration = numeric(entry.get('d'));
      const repeat = entry.has('r') ? Number(entry.get('r')) : 0;
      if (duration <= 0 || !Number.isInteger(repeat) || repeat < 0 || durationsMs.length + repeat + 1 > MAX_DASH_SEGMENTS) {
        throw new UnsupportedDashError('DASH SegmentList时间轴无效');
      }
      for (let count = 0; count <= repeat; count += 1) durationsMs.push(Math.round(duration / timescale * 1000));
    }
    if (durationsMs.length !== segmentElements.length) throw new UnsupportedDashError('DASH SegmentList与SegmentTimeline片段数不一致');
  } else if (durationUnits > 0) {
    const durationMs = Math.round(durationUnits / timescale * 1000);
    durationsMs = segmentElements.map(() => durationMs);
  } else {
    throw new UnsupportedDashError('DASH SegmentList缺少有效时长');
  }
  if (durationsMs.some((duration) => duration <= 0)
    || durationsMs.reduce((sum, duration) => sum + duration, 0) > periodDuration * 1000 + 1_000) {
    throw new UnsupportedDashError('DASH SegmentList时长超过Period范围');
  }
  const parts = segmentElements.map((segment, index) => {
    const attrs = elementAttributes(segment);
    const media = attrs.get('media');
    if (!media) throw new UnsupportedDashError('DASH SegmentURL缺少media地址');
    const range = parseDashRange(attrs.get('mediaRange'));
    return {
      url: safeResolve(media, representation.baseUrl),
      ...(range ? { range } : {}),
      durationMs: durationsMs[index]!,
    };
  });
  return {
    kind,
    protocol: 'hls-fmp4',
    init: { url: safeResolve(initUri, representation.baseUrl), ...(initRange ? { range: initRange } : {}) },
    parts,
  };
}

function adaptationKind(adaptation: Element): 'video' | 'audio' | undefined {
  const attributes = elementAttributes(adaptation);
  const contentType = attributes.get('contentType')?.toLowerCase();
  const mimeTypes = [attributes.get('mimeType'), ...directChildren(adaptation, 'Representation').map((rep) => elementAttributes(rep).get('mimeType'))]
    .map((mime) => mime?.toLowerCase() ?? '');
  const video = contentType === 'video' || mimeTypes.some((mime) => mime.startsWith('video/'));
  const audio = contentType === 'audio' || mimeTypes.some((mime) => mime.startsWith('audio/'));
  if (video && !audio) return 'video';
  if (audio && !video) return 'audio';
  return undefined;
}

function resolveBaseUrl(element: Element, parent: string): string {
  const baseElements = directChildren(element, 'BaseURL');
  if (baseElements.length === 0) return parent;
  const value = baseElements[0]!.textContent?.trim() ?? '';
  return value ? safeResolve(value, parent) : parent;
}

function safeResolve(reference: string, base: string): string {
  try { return resolveSafeMediaResourceUrl(reference, base); }
  catch { throw new UnsupportedDashError('DASH资源地址无效或指向本机、局域网地址'); }
}

function directChildren(parent: Element, name: string): Element[] {
  const children: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child?.nodeType === 1
      && (child as Element).localName === name
      && (child as Element).namespaceURI === parent.namespaceURI) {
      children.push(child as Element);
    }
  }
  return children;
}

function firstChild(parent: Element, name: string): Element | undefined {
  return directChildren(parent, name)[0];
}

function directChildLevels(parents: readonly Element[], name: string): Element[] {
  const result: Element[] = [];
  for (const parent of parents) {
    const children = directChildren(parent, name);
    if (children.length > 1) throw new UnsupportedDashError('DASH 每个层级最多只能有一个' + name);
    result.push(...children);
  }
  return result;
}

function descendants(parent: Element, name: string): Element[] {
  const result: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child?.nodeType !== 1) continue;
    const element = child as Element;
    if (element.localName === name && element.namespaceURI === parent.namespaceURI) result.push(element);
    result.push(...descendants(element, name));
  }
  return result;
}

function elementAttributes(element: Element): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute && (!attribute.namespaceURI || attribute.namespaceURI === '')) {
      result.set(attribute.localName || attribute.name, attribute.value);
    }
  }
  return result;
}

function dashRepresentationIdentity(attributes: Map<string, string>): Record<string, string | number | null> {
  const numericValue = (key: string): number | null => {
    const value = attributes.get(key);
    if (value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    id: attributes.get('id') ?? null,
    adaptationId: attributes.get('_adaptationId') ?? null,
    adaptationLang: attributes.get('_adaptationLang') ?? null,
    adaptationContentType: attributes.get('_adaptationContentType') ?? null,
    bandwidth: numericValue('bandwidth'),
    width: numericValue('width'),
    height: numericValue('height'),
    mimeType: attributes.get('mimeType')?.toLowerCase() ?? null,
    codecs: attributes.get('codecs') ?? null,
    frameRate: attributes.get('frameRate') ?? null,
    audioSamplingRate: attributes.get('audioSamplingRate') ?? null,
    lang: attributes.get('lang') ?? null,
  };
}

function parseDashIdentity(value: string): DashManifestIdentity {
  try {
    const parsed = JSON.parse(value) as Partial<DashManifestIdentity>;
    if (parsed.format !== 'dash' || !parsed.video || typeof parsed.video !== 'object'
      || !('audio' in parsed) || (parsed.audio !== null && (!parsed.audio || typeof parsed.audio !== 'object'))) {
      throw new Error('invalid identity');
    }
    return parsed as DashManifestIdentity;
  } catch {
    throw new UnsupportedDashError('DASH媒体身份记录无效');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function numeric(value: string | undefined): number {
  const parsed = value === undefined ? 0 : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/iu.exec(value);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function parseDashRange(value: string | undefined): HlsRange | undefined {
  if (!value) return undefined;
  const match = /^(\d+)-(\d+)$/u.exec(value);
  if (!match) throw new UnsupportedDashError('DASH byte range无效');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw new UnsupportedDashError('DASH byte range超出范围');
  }
  return { offset: start, length: end - start + 1 };
}

function expandTemplate(
  template: string,
  values: { number: number; time: number; representationId: string; bandwidth: number },
): string {
  const sentinel = '\u0000';
  const expanded = template.replace(/\$\$/gu, sentinel).replace(/\$(RepresentationID|Bandwidth|Number|Time)(%0(\d+)d)?\$/gu, (_full, key: string, _format: string | undefined, width: string | undefined) => {
    if (width && (!Number.isSafeInteger(Number(width)) || Number(width) > 20)) {
      throw new UnsupportedDashError('DASH数字模板宽度超过限制');
    }
    const value = key === 'RepresentationID' ? values.representationId
      : key === 'Bandwidth' ? String(values.bandwidth)
        : String(key === 'Number' ? values.number : values.time);
    return width && key !== 'RepresentationID' ? value.padStart(Number(width), '0') : value;
  }).replaceAll(sentinel, '$');
  if (/\$[^$]*\$/u.test(expanded)) throw new UnsupportedDashError('DASH模板包含不支持的占位符');
  return expanded;
}

