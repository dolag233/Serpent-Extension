import {
  bindFetchFunction,
  safeError,
  SegmentedMediaTransferClient,
  SegmentedMediaSourceError,
  uploadSegmentedMediaPlan,
  type FetchFunction,
  type SegmentedMediaCandidate,
  type SegmentedMediaSaveIntent,
  type SegmentedMediaTrack,
  type SegmentedMediaTransferOptions,
  type SegmentedMediaTransferOutcome,
} from './media-transfer';
import { isSafeRemoteMediaUrl } from './segmented-url';

const MAX_PLAYLIST_BYTES = 512 * 1024;
const MAX_SEGMENTS = 20_000;

export interface HlsRange {
  length: number;
  offset: number;
}

export interface HlsPart {
  url: string;
  range?: HlsRange;
  durationMs?: number;
  discontinuityBefore?: boolean;
}

export interface HlsTrackPlan {
  kind: 'video' | 'audio';
  protocol: 'hls-ts' | 'hls-fmp4';
  init?: { url: string; range?: HlsRange };
  parts: HlsPart[];
}

interface HlsVariant {
  url: string;
  bandwidth: number;
  width: number;
  height: number;
  audioGroup?: string;
  codecs?: string;
}

interface HlsAudioRendition {
  group: string;
  url?: string;
  isDefault: boolean;
  autoSelect: boolean;
  language?: string;
  name?: string;
  channels?: string;
  characteristics?: string;
}

export interface ResolvedHlsMediaPlan {
  plans: HlsTrackPlan[];
  identity: string;
  resolvedMediaUrl: string;
}

interface HlsManifestIdentity {
  format: 'hls';
  variant: ReturnType<typeof variantIdentity> | null;
  audio: ReturnType<typeof audioIdentity> | null;
}

class UnsupportedHlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedHlsError';
  }
}

export interface MediaManifestProbe {
  format: 'hls' | 'dash' | 'other';
  text?: string;
  finalUrl: string;
}

export async function runHlsSegmentedTransfer(
  intent: SegmentedMediaSaveIntent,
  candidate: SegmentedMediaCandidate,
  options: SegmentedMediaTransferOptions,
  initialManifest?: MediaManifestProbe,
  connectedClient?: SegmentedMediaTransferClient,
): Promise<SegmentedMediaTransferOutcome> {
  const fetchFn = bindFetchFunction(options.fetchFn);
  const client = connectedClient ?? await SegmentedMediaTransferClient.connect(fetchFn, options.signal);
  if (!client) return { state: 'unsupported', reason: '桌面端不支持分段视频导入' };
  if (!client.capability.protocols.includes('hls-ts') && !client.capability.protocols.includes('hls-fmp4')) {
    return { state: 'unsupported', reason: '桌面端不支持当前 HLS 格式' };
  }

  try {
    const resolved = await resolveHlsMediaPlan(
      candidate.url,
      intent.sourcePageUrl,
      fetchFn,
      options.signal,
      initialManifest,
    );
    const tracks = resolved.plans.map((plan, index) => planToTrack(plan, index === 0 ? 'v' : 'a'));
    const protocol = resolved.plans.some((plan) => plan.protocol === 'hls-fmp4') ? 'hls-fmp4' : 'hls-ts';
    if (resolved.plans.some((plan) => plan.protocol !== protocol)) {
      throw new UnsupportedHlsError('视频与音轨使用了不一致的 HLS 分段格式');
    }
    if (!client.capability.protocols.includes(protocol)) {
      return { state: 'unsupported', reason: '桌面端不支持该 HLS 分段格式' };
    }

    return await uploadSegmentedMediaPlan({
      intent,
      candidate,
      options,
      client,
      protocol,
      tracks,
      plans: resolved.plans.map((plan) => ({ kind: plan.kind, ...(plan.init ? { init: plan.init } : {}), parts: plan.parts })),
      resolvedMediaUrl: resolved.resolvedMediaUrl,
      manifestUrl: candidate.url,
      sourceIdentity: resolved.identity,
    });
  } catch (error) {
    if (error instanceof UnsupportedHlsError) return { state: 'unsupported', reason: error.message };
    if (options.signal?.aborted || isAbort(error)) return { state: 'failed', reason: '保存已取消' };
    return { state: 'unsupported', reason: safeError(error) };
  }
}

export async function resolveHlsMediaPlan(
  manifestUrl: string,
  pageUrl: string,
  fetchFn: FetchFunction,
  signal?: AbortSignal,
  initialManifest?: MediaManifestProbe,
  expectedIdentity?: string,
): Promise<ResolvedHlsMediaPlan> {
  const first = initialManifest ?? await fetchMediaManifest(manifestUrl, pageUrl, fetchFn, signal);
  if (first.format !== 'hls' || first.text === undefined) throw new UnsupportedHlsError('地址没有返回 HLS 清单');
  const expected = expectedIdentity === undefined ? undefined : parseHlsIdentity(expectedIdentity);
  const master = parseMaster(first.text, first.finalUrl);
  let videoUrl = first.finalUrl;
  let playlist = first.text;
  let selectedVariant: HlsVariant | undefined;
  let audioRendition: HlsAudioRendition | undefined;

  if (master.variants.length > 0) {
    if (expected?.variant === null) throw new UnsupportedHlsError('HLS representation身份已变化');
    selectedVariant = expected?.variant
      ? master.variants.find((variant) => sameJson(variantIdentity(variant), expected.variant!))
      : [...master.variants].sort((left, right) =>
        (right.width * right.height - left.width * left.height) || (right.bandwidth - left.bandwidth),
      )[0];
    if (!selectedVariant) throw new UnsupportedHlsError('HLS representation身份无法核对');
    if (selectedVariant.audioGroup) {
      const renditions = master.audio.filter((item) => item.group === selectedVariant!.audioGroup);
      if (expected?.audio) {
        audioRendition = renditions.find((item) => sameJson(audioIdentity(item), expected.audio!));
        if (!audioRendition) throw new UnsupportedHlsError('HLS音轨身份已变化');
      } else if (expected && expected.audio === null) {
        audioRendition = undefined;
      } else {
        audioRendition = renditions.find((item) => item.isDefault && item.url)
          ?? renditions.find((item) => item.autoSelect && item.url)
          ?? renditions.find((item) => item.url)
          ?? renditions.find((item) => item.isDefault)
          ?? renditions.find((item) => item.autoSelect);
      }
    } else if (expected?.audio) {
      throw new UnsupportedHlsError('HLS音轨身份已变化');
    }
    const child = await fetchMediaManifest(selectedVariant.url, pageUrl, fetchFn, signal);
    if (child.format !== 'hls' || child.text === undefined) throw new UnsupportedHlsError('HLS 视频轨道没有返回媒体播放清单');
    playlist = child.text;
    videoUrl = child.finalUrl;
    if (parseMaster(playlist, videoUrl).variants.length > 0) {
      throw new UnsupportedHlsError('暂不支持嵌套 HLS master 清单');
    }
  } else if (expected?.variant) {
    throw new UnsupportedHlsError('HLS representation身份已变化');
  }

  const videoPlan = parseMediaPlaylist(playlist, videoUrl, 'video');
  const plans = [videoPlan];
  if (audioRendition?.url) plans.push(await fetchAudioPlan(audioRendition.url, pageUrl, fetchFn, signal));
  if (expected?.audio === null && plans.length > 1) throw new UnsupportedHlsError('HLS音轨身份已变化');
  if (expected && !sameJson(expected, makeHlsIdentity(selectedVariant, audioRendition))) {
    throw new UnsupportedHlsError('HLS媒体轨道身份已变化');
  }
  return {
    plans,
    identity: JSON.stringify(makeHlsIdentity(selectedVariant, audioRendition)),
    resolvedMediaUrl: videoUrl,
  };
}

function parseHlsIdentity(value: string): HlsManifestIdentity {
  try {
    const parsed = JSON.parse(value) as Partial<HlsManifestIdentity>;
    if (parsed.format !== 'hls' || !('variant' in parsed) || !('audio' in parsed)) throw new Error('invalid identity');
    return parsed as HlsManifestIdentity;
  } catch {
    throw new UnsupportedHlsError('HLS媒体身份记录无效');
  }
}

function makeHlsIdentity(variant: HlsVariant | undefined, audio: HlsAudioRendition | undefined): HlsManifestIdentity {
  return {
    format: 'hls',
    variant: variant ? variantIdentity(variant) : null,
    audio: audio ? audioIdentity(audio) : null,
  };
}

function variantIdentity(variant: HlsVariant): { bandwidth: number; width: number; height: number; audioGroup: string | null; codecs: string | null } {
  return {
    bandwidth: variant.bandwidth,
    width: variant.width,
    height: variant.height,
    audioGroup: variant.audioGroup ?? null,
    codecs: variant.codecs ?? null,
  };
}

function audioIdentity(audio: HlsAudioRendition): {
  group: string; uriKey: string | null; isDefault: boolean; autoSelect: boolean;
  language: string | null; name: string | null; channels: string | null; characteristics: string | null;
} {
  return {
    group: audio.group,
    uriKey: audio.url ? stableUrlKey(audio.url) : null,
    isDefault: audio.isDefault,
    autoSelect: audio.autoSelect,
    language: audio.language ?? null,
    name: audio.name ?? null,
    channels: audio.channels ?? null,
    characteristics: audio.characteristics ?? null,
  };
}

function stableUrlKey(value: string): string {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fetchAudioPlan(
  url: string,
  pageUrl: string,
  fetchFn: FetchFunction,
  signal?: AbortSignal,
): Promise<HlsTrackPlan> {
  const result = await fetchMediaManifest(url, pageUrl, fetchFn, signal);
  if (result.format !== 'hls' || result.text === undefined) throw new UnsupportedHlsError('HLS 音轨没有返回媒体播放清单');
  if (parseMaster(result.text, result.finalUrl).variants.length > 0) {
    throw new UnsupportedHlsError('暂不支持嵌套 HLS 音轨清单');
  }
  return parseMediaPlaylist(result.text, result.finalUrl, 'audio');
}

export async function fetchMediaManifest(
  inputUrl: string,
  pageUrl: string,
  fetchFn: FetchFunction,
  signal?: AbortSignal,
): Promise<MediaManifestProbe> {
  const boundFetch = bindFetchFunction(fetchFn);
  assertSafeRemoteUrl(inputUrl);
  const response = await boundFetch(inputUrl, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    referrer: pageUrl,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const message = `播放清单请求失败（HTTP ${response.status}）`;
    if ([401, 403, 404, 410].includes(response.status)) throw new SegmentedMediaSourceError(message, response.status);
    throw new Error(message);
  }
  const finalUrl = response.url || inputUrl;
  assertSafeRemoteUrl(finalUrl);
  if (!response.body) return { format: 'other', finalUrl };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const decoder = new TextDecoder();
  let prefix = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      byteLength += chunk.byteLength;
      if (byteLength > MAX_PLAYLIST_BYTES) throw new UnsupportedHlsError('HLS 播放清单超过大小限制');
      chunks.push(chunk);
      if (prefix.length < 16) {
        prefix += decoder.decode(chunk.subarray(0, Math.max(0, 16 - prefix.length)), { stream: true });
        const normalized = prefix.replace(/^\uFEFF/u, '').trimStart();
        if (normalized.length >= 8
          && !normalized.startsWith('#EXTM3U')
          && !normalized.startsWith('<?xml')
          && !/^<(?:[A-Za-z_][\w.-]*:)?MPD(?:\s|>)/u.test(normalized)) {
          await reader.cancel().catch(() => undefined);
          return { format: 'other', finalUrl };
        }
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concatBytes(chunks, byteLength)).replace(/^\uFEFF/u, '').trim();
  if (text.startsWith('#EXTM3U')) return { format: 'hls', text, finalUrl };
  if (/<(?:[A-Za-z_][\w.-]*:)?MPD(?:\s|>)/u.test(text)) return { format: 'dash', text, finalUrl };
  return { format: 'other', finalUrl };
}

function parseMaster(text: string, baseUrl: string): { variants: HlsVariant[]; audio: HlsAudioRendition[] } {
  if (/#EXT-X-(?:SESSION-KEY|PART|PRELOAD-HINT|SERVER-CONTROL)\b/u.test(text)) {
    throw new UnsupportedHlsError('暂不支持加密或低延迟 HLS');
  }
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const variants: HlsVariant[] = [];
  const audio: HlsAudioRendition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attributes.get('TYPE') !== 'AUDIO') continue;
      const group = attributes.get('GROUP-ID');
      if (!group) continue;
      const uri = attributes.get('URI');
      audio.push({
        group,
        ...(uri ? { url: resolveRemoteUrl(uri, baseUrl) } : {}),
        isDefault: attributes.get('DEFAULT') === 'YES',
        autoSelect: attributes.get('AUTOSELECT') === 'YES',
        ...(attributes.get('LANGUAGE') ? { language: attributes.get('LANGUAGE')! } : {}),
        ...(attributes.get('NAME') ? { name: attributes.get('NAME')! } : {}),
        ...(attributes.get('CHANNELS') ? { channels: attributes.get('CHANNELS')! } : {}),
        ...(attributes.get('CHARACTERISTICS') ? { characteristics: attributes.get('CHARACTERISTICS')! } : {}),
      });
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const bandwidth = Number(attributes.get('AVERAGE-BANDWIDTH') ?? attributes.get('BANDWIDTH'));
      if (!Number.isFinite(bandwidth) || bandwidth <= 0) throw new UnsupportedHlsError('HLS 视频轨道缺少码率信息');
      let uriLine: string | undefined;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (lines[next]!.startsWith('#')) continue;
        uriLine = lines[next];
        index = next;
        break;
      }
      if (!uriLine) throw new UnsupportedHlsError('HLS 视频轨道缺少播放地址');
      const [width, height] = (attributes.get('RESOLUTION') ?? '').split('x').map(Number);
      variants.push({
        url: resolveRemoteUrl(uriLine, baseUrl),
        bandwidth,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        ...(attributes.get('AUDIO') ? { audioGroup: attributes.get('AUDIO')! } : {}),
        ...(attributes.get('CODECS') ? { codecs: attributes.get('CODECS')! } : {}),
      });
    }
  }
  if (variants.some((variant) => !Number.isFinite(variant.bandwidth) || variant.bandwidth < 0)) {
    throw new UnsupportedHlsError('HLS 视频轨道信息无效');
  }
  return { variants, audio };
}

function parseMediaPlaylist(text: string, baseUrl: string, kind: 'video' | 'audio'): HlsTrackPlan {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  if (!lines.some((line) => line === '#EXT-X-ENDLIST')) {
    throw new UnsupportedHlsError('暂不支持直播或未结束的 HLS 播放列表');
  }
  if (lines.some((line) => /#EXT-X-(?:PART|PRELOAD-HINT|SERVER-CONTROL|GAP|I-FRAMES-ONLY)\b/u.test(line))) {
    throw new UnsupportedHlsError('暂不支持低延迟、缺片或仅关键帧 HLS');
  }

  let init: HlsTrackPlan['init'];
  let initIdentity: string | undefined;
  let nextRange: HlsRange | undefined;
  let discontinuity = false;
  let durationMs: number | undefined;
  const lastRangeEndByUrl = new Map<string, number>();
  const parts: HlsPart[] = [];

  for (const line of lines) {
    if (!line || line === '#EXTM3U' || line.startsWith('#EXT-X-VERSION:')
      || line.startsWith('#EXT-X-TARGETDURATION:') || line.startsWith('#EXT-X-MEDIA-SEQUENCE:')
      || line.startsWith('#EXT-X-PLAYLIST-TYPE:') || line === '#EXT-X-ENDLIST') continue;
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = parseAttributes(line.slice('#EXT-X-KEY:'.length)).get('METHOD');
      if (method && method !== 'NONE') throw new UnsupportedHlsError('暂不支持加密 HLS');
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) throw new UnsupportedHlsError('暂不支持加密 HLS');
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      const uri = attributes.get('URI');
      if (!uri) throw new UnsupportedHlsError('HLS 初始化片段地址缺失');
      const url = resolveRemoteUrl(uri, baseUrl);
      const range = attributes.get('BYTERANGE') ? parseRange(attributes.get('BYTERANGE')!, 0) : undefined;
      const identity = `${url}|${range?.length ?? ''}|${range?.offset ?? ''}`;
      if (initIdentity && initIdentity !== identity) throw new UnsupportedHlsError('暂不支持 HLS 中途更换初始化片段');
      initIdentity = identity;
      init = { url, ...(range ? { range } : {}) };
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      nextRange = parseRange(line.slice('#EXT-X-BYTERANGE:'.length), undefined);
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const value = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      if (!Number.isFinite(value) || value <= 0 || value > 24 * 60 * 60) {
        throw new UnsupportedHlsError('HLS 片段时长无效');
      }
      durationMs = Math.round(value * 1000);
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = resolveRemoteUrl(line, baseUrl);
    let range = nextRange;
    if (range && range.offset < 0) {
      const previousEnd = lastRangeEndByUrl.get(url);
      if (previousEnd === undefined) throw new UnsupportedHlsError('HLS byte-range 缺少前一个范围');
      range = { ...range, offset: previousEnd };
    }
    if (range) lastRangeEndByUrl.set(url, range.offset + range.length);
    if (durationMs === undefined) throw new UnsupportedHlsError('HLS 媒体片段缺少时长');
    parts.push({
      url,
      ...(range ? { range } : {}),
      durationMs,
      ...(discontinuity ? { discontinuityBefore: true } : {}),
    });
    durationMs = undefined;
    nextRange = undefined;
    discontinuity = false;
  }
  if (parts.length === 0 || parts.length > MAX_SEGMENTS) throw new UnsupportedHlsError('HLS 媒体片段数量无效');
  if (durationMs !== undefined || nextRange !== undefined) throw new UnsupportedHlsError('HLS 播放列表末尾有未使用的片段信息');
  return { kind, protocol: init ? 'hls-fmp4' : 'hls-ts', ...(init ? { init } : {}), parts };
}

export function planToTrack(plan: HlsTrackPlan, prefix: 'v' | 'a'): SegmentedMediaTrack {
  return {
    kind: plan.kind,
    segments: [
      ...(plan.init ? [{ id: `${prefix}-init`, role: 'init' as const }] : []),
      ...plan.parts.map((part, index) => ({
        id: `${prefix}-${index.toString().padStart(6, '0')}`,
        role: 'media' as const,
        durationMs: part.durationMs!,
        ...(part.discontinuityBefore ? { discontinuityBefore: true } : {}),
      })),
    ],
  };
}

export async function downloadPart(input: {
  client: SegmentedMediaTransferClient;
  sessionId: string;
  token: string;
  part: { url: string; range?: HlsRange };
  segmentId: string;
  existingBytes: number;
  expectedBytes?: number;
  pageUrl: string;
  fetchFn: FetchFunction;
  signal?: AbortSignal;
}): Promise<void> {
  const boundFetch = bindFetchFunction(input.fetchFn);
  if (input.expectedBytes !== undefined && input.existingBytes >= input.expectedBytes) return;
  assertSafeRemoteUrl(input.part.url);
  let requestUrl = input.part.url;
  const headers: Record<string, string> = {};
  if (input.part.range) {
    const offset = input.part.range.offset + input.existingBytes;
    const end = input.part.range.offset + input.part.range.length - 1;
    headers.Range = `bytes=${offset}-${end}`;
    requestUrl = input.part.url;
  }
  const response = await boundFetch(requestUrl, {
    method: 'GET',
    headers,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    referrer: input.pageUrl,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) {
    const message = `HLS 片段请求失败（HTTP ${response.status}）`;
    if ([401, 403, 404, 410, 416].includes(response.status)) {
      throw new SegmentedMediaSourceError(message, response.status);
    }
    throw new Error(message);
  }
  try {
    assertSafeRemoteUrl(response.url || requestUrl);
  } catch (error) {
    throw new SegmentedMediaSourceError(safeError(error));
  }
  if (input.part.range) {
    if (response.status !== 206) throw new SegmentedMediaSourceError('HLS byte-range 请求未获得部分响应');
    const actualRange = response.headers.get('content-range');
    const expectedStart = input.part.range.offset + input.existingBytes;
    const expectedEnd = input.part.range.offset + input.part.range.length - 1;
    if (!actualRange || !new RegExp(`^bytes ${expectedStart}-${expectedEnd}/`, 'u').test(actualRange)) {
      throw new SegmentedMediaSourceError('HLS byte-range 响应范围不匹配');
    }
  }
  if (!response.body) throw new Error('浏览器没有提供 HLS 片段流');
  const reader = response.body.getReader();
  let sourceOffset = 0;
  let uploadOffset = input.existingBytes;
  const chunkLimit = SegmentedMediaTransferClientChunkSize(input.client);
  let fillBuffer = new Uint8Array(chunkLimit);
  let fillLength = 0;
  let pendingChunk: Uint8Array | undefined;
  let receivedRelevant = 0;
  const queueFullChunk = async (): Promise<void> => {
    const full = fillBuffer;
    if (pendingChunk) {
      await uploadPending(input.client, input.sessionId, input.token, input.segmentId, uploadOffset, pendingChunk, false, input.signal);
      uploadOffset += pendingChunk.byteLength;
      receivedRelevant += pendingChunk.byteLength;
    }
    pendingChunk = full;
    fillBuffer = new Uint8Array(chunkLimit);
    fillLength = 0;
  };
  try {
    for (;;) {
      if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      let cursor = 0;
      while (cursor < value.byteLength) {
        const absoluteStart = sourceOffset + cursor;
        const skipBefore = input.part.range ? 0 : input.existingBytes;
        if (absoluteStart + (value.byteLength - cursor) <= skipBefore) {
          cursor = value.byteLength;
          break;
        }
        if (absoluteStart < skipBefore) cursor += skipBefore - absoluteStart;
        const usable = value.subarray(cursor);
        let pieceOffset = 0;
        while (pieceOffset < usable.byteLength) {
          const amount = Math.min(chunkLimit - fillLength, usable.byteLength - pieceOffset);
          fillBuffer.set(usable.subarray(pieceOffset, pieceOffset + amount), fillLength);
          fillLength += amount;
          pieceOffset += amount;
          if (fillLength === chunkLimit) await queueFullChunk();
        }
        cursor = value.byteLength;
        continue;
      }
      sourceOffset += value.byteLength;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (input.expectedBytes !== undefined) {
    const expectedRemaining = input.expectedBytes - input.existingBytes;
    if (receivedRelevant + (pendingChunk?.byteLength ?? 0) + fillLength !== expectedRemaining) {
      throw new SegmentedMediaSourceError('HLS byte-range segment length mismatch');
    }
  }
  if (fillLength > 0) {
    if (pendingChunk) {
      await uploadPending(input.client, input.sessionId, input.token, input.segmentId, uploadOffset, pendingChunk, false, input.signal);
      uploadOffset += pendingChunk.byteLength;
      receivedRelevant += pendingChunk.byteLength;
    }
    pendingChunk = fillBuffer.slice(0, fillLength);
  }
  if (!pendingChunk || pendingChunk.byteLength === 0) throw new SegmentedMediaSourceError('HLS segment is empty or already fully uploaded');
  await uploadPending(input.client, input.sessionId, input.token, input.segmentId, uploadOffset, pendingChunk, true, input.signal);
}

function SegmentedMediaTransferClientChunkSize(client: SegmentedMediaTransferClient): number {
  return client.capability.chunkBytes;
}

async function uploadPending(
  client: SegmentedMediaTransferClient,
  sessionId: string,
  token: string,
  segmentId: string,
  offset: number,
  bytes: Uint8Array,
  final: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await client.uploadChunk(sessionId, token, segmentId, offset, bytes, final, signal);
}

function parseRange(value: string, defaultOffset: number | undefined): HlsRange {
  const match = /^(\d+)(?:@(\d+))?$/u.exec(value.trim());
  if (!match) throw new UnsupportedHlsError('HLS byte-range 格式无效');
  const length = Number(match[1]);
  const offset = match[2] === undefined ? (defaultOffset ?? -1) : Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset)) {
    throw new UnsupportedHlsError('HLS byte-range 超出范围');
  }
  return { length, offset };
}

function parseAttributes(value: string): Map<string, string> {
  const result = new Map<string, string>();
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      tokens.push(current);
      current = '';
    } else current += char;
  }
  if (current) tokens.push(current);
  for (const token of tokens) {
    const equals = token.indexOf('=');
    if (equals < 1) continue;
    result.set(token.slice(0, equals).trim(), token.slice(equals + 1).trim().replace(/^"|"$/gu, ''));
  }
  return result;
}

function resolveRemoteUrl(reference: string, baseUrl: string): string {
  if (reference.includes('{$')) throw new UnsupportedHlsError('暂不支持 HLS 清单变量');
  let url: URL;
  try { url = new URL(reference, baseUrl); } catch { throw new UnsupportedHlsError('HLS 资源地址无效'); }
  assertSafeRemoteUrl(url.toString());
  return url.toString();
}

function assertSafeRemoteUrl(value: string): void {
  if (!isSafeRemoteMediaUrl(value)) throw new UnsupportedHlsError('HLS 资源地址不安全或不是 HTTP(S) 公网地址');
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
