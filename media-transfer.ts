import browser from 'webextension-polyfill';
import { downloadPart, fetchMediaManifest, resolveHlsMediaPlan, runHlsSegmentedTransfer } from './segmented-hls';
import { resolveDashMediaPlan, runDashSegmentedTransfer } from './segmented-dash';
import { isSafeRemoteMediaUrl, stableMediaResourceIdentity } from './segmented-url';

export const SERPENT_SEGMENTED_MAX_BYTES = 500 * 1024 * 1024;
export const SERPENT_SEGMENTED_CHUNK_BYTES = 4 * 1024 * 1024;
export const SERPENT_SEGMENTED_PROTOCOLS = ['hls-ts', 'hls-fmp4', 'dash-fmp4'] as const;
export const SEGMENTED_MEDIA_RECOVERY_ALARM = 'serpent-segmented-media-recovery';

const SEGMENTED_MEDIA_JOURNAL_KEY = 'serpent.segmentedMediaTransfers.v1';
const MAX_SEGMENTED_MEDIA_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENTED_MEDIA_RECOVERY_ATTEMPTS = 8;
const MAX_SEGMENTED_MEDIA_MANIFEST_REFRESHES = 1;
const SEGMENTED_MEDIA_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

let journalMutationTail: Promise<void> = Promise.resolve();
const runningJournalRequests = new Set<string>();

export type SegmentedMediaTransferState =
  | 'not-segmented'
  | 'unsupported'
  | 'pending'
  | 'source-failed'
  | 'saved'
  | 'failed';

export type SegmentedMediaTransferOutcome =
  | { state: 'not-segmented' }
  | { state: 'unsupported'; reason: string }
  | { state: 'pending'; reason: string }
  | { state: 'source-failed'; reason: string }
  | { state: 'saved'; duplicate?: true }
  | { state: 'failed'; reason: string };

export interface SegmentedMediaCandidate {
  url: string;
  kind: 'image' | 'video';
  source?: string;
  contentId?: string;
  mediaIndex?: number;
  width?: number;
  height?: number;
  requestStrategy?: string;
}

export interface SegmentedMediaSaveIntent {
  kind: 'image' | 'video';
  sourcePageUrl: string;
  mediaUrl: string;
  targetFolderId?: string | null;
  targetCollectionId?: string;
  expectedLibraryId?: string;
  allowRecoveryFallback?: boolean;
  preferOriginalMedia?: boolean;
}

export interface SegmentedMediaTrack {
  kind: 'video' | 'audio';
  segments: Array<{
    id: string;
    role: 'init' | 'media';
    durationMs?: number;
    discontinuityBefore?: boolean;
  }>;
}

export interface SegmentedMediaSessionCreate {
  requestId: string;
  filename: string;
  sourcePageUrl: string;
  mediaUrl: string;
  protocol: 'hls-ts' | 'hls-fmp4' | 'dash-fmp4';
  tracks: SegmentedMediaTrack[];
  targetFolderId?: string | null;
  targetCollectionId?: string;
  expectedLibraryId?: string;
  focusAppAfterSave?: boolean;
  revealInLibrary?: boolean;
}

export interface SegmentedMediaSessionSnapshot {
  sessionId: string;
  status: 'uploading' | 'committing' | 'complete' | 'failed' | 'cancelled';
  libraryId?: string;
  targetFolderId?: string;
  targetCollectionId?: string;
  failureKind?: 'source-invalid' | 'import-failed';
  duplicate?: true;
  receivedBytes: number;
  maxAssetBytes: number;
  chunkBytes: number;
  segments: Array<{ id: string; receivedBytes: number; complete: boolean }>;
  reason?: string;
}

export interface SegmentedMediaFallbackIntent {
  fallbackRequestId: string;
  expectedLibraryId: string;
  kind: 'video';
  sourcePageUrl: string;
  mediaUrl: string;
  targetFolderId?: string | null;
  targetCollectionId?: string;
  allowRecoveryFallback: false;
  behavior: {
    focusAppAfterSave: boolean;
    revealInLibraryAfterSave: boolean;
    notificationsEnabled: boolean;
  };
}

interface SegmentedMediaCancelSnapshot {
  state: SegmentedMediaSessionSnapshot['status'];
  cleanupFailed: boolean;
  failureKind?: SegmentedMediaSessionSnapshot['failureKind'];
  duplicate?: true;
}

export interface MediaFetchResponse {
  status: number;
  ok: boolean;
  url?: string;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  json?(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchFunction = (input: string, init?: RequestInit) => Promise<MediaFetchResponse>;

export function bindFetchFunction(fetchFn?: FetchFunction): FetchFunction {
  const target = fetchFn ?? fetch;
  return (input, init) => target(input, init);
}

export interface SegmentedMediaTransferOptions {
  fetchFn?: FetchFunction;
  signal?: AbortSignal;
  requestId?: string;
  behavior?: {
    focusAppAfterSave: boolean;
    revealInLibraryAfterSave: boolean;
    notificationsEnabled?: boolean;
  };
  /** Optional retry/poll timings for deterministic tests. */
  pollIntervalMs?: number;
  commitTimeoutMs?: number;
  journalStorage?: SegmentedMediaJournalStorage;
  recoveryAlarm?: SegmentedMediaRecoveryAlarm;
}

export interface SegmentedMediaJournalStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SegmentedMediaRecoveryAlarm {
  schedule(): Promise<void>;
  clear(): Promise<void>;
}

export interface SegmentedMediaRecoveryOptions {
  fetchFn?: FetchFunction;
  signal?: AbortSignal;
  journalStorage?: SegmentedMediaJournalStorage;
  recoveryAlarm?: SegmentedMediaRecoveryAlarm;
  onOutcome?: (outcome: {
    requestId: string;
    state: 'saved' | 'source-failed' | 'failed';
    reason?: string;
    duplicate?: true;
    fallbackIntent?: SegmentedMediaFallbackIntent;
  }) => void | Promise<void>;
  pollIntervalMs?: number;
  commitTimeoutMs?: number;
}

export interface SegmentedMediaPartPlan {
  url: string;
  range?: { offset: number; length: number };
  durationMs?: number;
  discontinuityBefore?: boolean;
}

export interface SegmentedMediaTrackPlan {
  kind: 'video' | 'audio';
  init?: { url: string; range?: { offset: number; length: number } };
  parts: SegmentedMediaPartPlan[];
}

class SegmentedMediaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SegmentedMediaHttpError';
  }
}

class SegmentedMediaTerminalError extends Error {
  constructor(message: string, readonly failureKind?: SegmentedMediaSessionSnapshot['failureKind']) {
    super(message);
    this.name = 'SegmentedMediaTerminalError';
  }
}

export class SegmentedMediaSourceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SegmentedMediaSourceError';
  }
}

interface SegmentedMediaTransferJournal {
  version: 1;
  requestId: string;
  sessionId: string;
  token: string;
  endpoint: string;
  sourcePageUrl: string;
  protocol: SegmentedMediaSessionCreate['protocol'];
  tracks: SegmentedMediaTrackPlan[];
  manifestUrl?: string;
  sourceIdentity?: string;
  fallbackPreview?: Omit<SegmentedMediaFallbackIntent, 'expectedLibraryId'>;
  fallbackUnavailableReason?: string;
  targetLibraryId?: string;
  fallbackClaimed?: boolean;
  createdAt: number;
  expiresAt: number;
  recoveryAttempts: number;
  refreshAttempts?: number;
  cancelRequested?: boolean;
  sourceFailedReason?: string;
}

export class SegmentedMediaTransferClient {
  private readonly fetchFn: FetchFunction;

  private constructor(
    private readonly baseUrl: string,
    fetchFn: FetchFunction,
    readonly capability: { version: number; maxAssetBytes: number; chunkBytes: number; protocols: string[] },
  ) {
    this.fetchFn = (input, init) => fetchFn(input, init);
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  static async connect(
    fetchFn: FetchFunction = fetch,
    signal?: AbortSignal,
  ): Promise<SegmentedMediaTransferClient | undefined> {
    const boundFetch = bindFetchFunction(fetchFn);
    for (const port of [19876, 19877, 19878]) {
      const client = await SegmentedMediaTransferClient.connectAt(`http://127.0.0.1:${port}`, boundFetch, signal);
      if (client) return client;
    }
    return undefined;
  }

  static async connectAt(
    endpoint: string,
    fetchFn: FetchFunction = fetch,
    signal?: AbortSignal,
    allowSessionStatusWithoutCapability = false,
  ): Promise<SegmentedMediaTransferClient | undefined> {
    if (!isDesktopEndpoint(endpoint)) return undefined;
    const boundFetch = bindFetchFunction(fetchFn);
    try {
      const response = await boundFetch(`${endpoint}/capabilities`, {
        method: 'GET',
        cache: 'no-store',
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== 200) return undefined;
      const capability = readSegmentedCapability(await safeJson(response));
      if (capability) return new SegmentedMediaTransferClient(endpoint, boundFetch, capability);
      if (!allowSessionStatusWithoutCapability) return undefined;
      return new SegmentedMediaTransferClient(endpoint, boundFetch, {
        version: 1,
        maxAssetBytes: SERPENT_SEGMENTED_MAX_BYTES,
        chunkBytes: SERPENT_SEGMENTED_CHUNK_BYTES,
        protocols: [],
      });
    } catch {
      if (signal?.aborted) throw abortError();
      return undefined;
    }
  }

  async createSession(
    input: SegmentedMediaSessionCreate,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; token: string; chunkBytes: number; maxAssetBytes: number }> {
    const response = await this.fetchFn(`${this.baseUrl}/media-transfer/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new SegmentedMediaHttpError(response.status, readReason(body) ?? `Desktop rejected the segmented transfer (HTTP ${response.status}).`);
    const sessionId = readString(body, 'sessionId');
    const token = readString(body, 'token');
    const chunkBytes = readNumber(body, 'chunkBytes');
    const maxAssetBytes = readNumber(body, 'maxAssetBytes');
    if (!sessionId || !token || !chunkBytes || !maxAssetBytes) {
      throw new Error('Desktop returned an invalid segmented transfer session.');
    }
    return { sessionId, token, chunkBytes, maxAssetBytes };
  }

  async snapshot(sessionId: string, token: string, signal?: AbortSignal): Promise<SegmentedMediaSessionSnapshot> {
    const response = await this.authorizedFetch(sessionId, token, undefined, signal);
    const body = await safeJson(response);
    if (!response.ok) throw new SegmentedMediaHttpError(response.status, readReason(body) ?? `Desktop transfer status failed (HTTP ${response.status}).`);
    const snapshot = parseSnapshot(body);
    if (!snapshot) throw new Error('Desktop returned an invalid transfer status.');
    return snapshot;
  }

  async uploadChunk(
    sessionId: string,
    token: string,
    segmentId: string,
    offset: number,
    bytes: Uint8Array,
    final: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${this.baseUrl}/media-transfer/sessions/${encodeURIComponent(sessionId)}/segments/${encodeURIComponent(segmentId)}?offset=${offset}`;
    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'X-Segment-Final': final ? 'true' : 'false',
      },
      body: new Blob([new Uint8Array(bytes).buffer as ArrayBuffer]),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const body = await safeJson(response);
      throw new SegmentedMediaHttpError(response.status, readReason(body) ?? `Desktop segment upload failed (HTTP ${response.status}).`);
    }
  }

  async commit(sessionId: string, token: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchFn(`${this.baseUrl}/media-transfer/sessions/${encodeURIComponent(sessionId)}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    const body = await safeJson(response);
    if (!response.ok) throw new SegmentedMediaHttpError(response.status, readReason(body) ?? `Desktop commit failed (HTTP ${response.status}).`);
  }

  async waitForCompletion(
    sessionId: string,
    token: string,
    options: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<SegmentedMediaSessionSnapshot> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < (options.timeoutMs ?? 60 * 60 * 1000)) {
      if (options.signal?.aborted) throw abortError();
      const snapshot = await this.snapshot(sessionId, token, options.signal);
      if (snapshot.status === 'complete') return snapshot;
      if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        throw new SegmentedMediaTerminalError(snapshot.reason ?? `Desktop transfer ${snapshot.status}.`, snapshot.failureKind);
      }
      await delay(options.intervalMs ?? 500, options.signal);
    }
    throw new Error('Desktop transfer did not finish before the time limit.');
  }

  async cancel(sessionId: string, token: string): Promise<SegmentedMediaCancelSnapshot> {
    const response = await this.fetchFn(`${this.baseUrl}/media-transfer/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = await safeJson(response);
      throw new SegmentedMediaHttpError(response.status, readReason(body) ?? `Desktop cancellation failed (HTTP ${response.status}).`);
    }
    const body = await safeJson(response);
    if (!body || typeof body !== 'object') throw new Error('Desktop returned no cancellation status.');
    const state = Reflect.get(body, 'state');
    const cleanupFailed = Reflect.get(body, 'cleanupFailed');
    const failureKind = Reflect.get(body, 'failureKind');
    const duplicate = Reflect.get(body, 'duplicate');
    if (!['uploading', 'committing', 'complete', 'failed', 'cancelled'].includes(String(state))
      || typeof cleanupFailed !== 'boolean'
      || (failureKind !== undefined && failureKind !== 'source-invalid' && failureKind !== 'import-failed')) {
      throw new Error('Desktop returned an invalid cancellation status.');
    }
    return {
      state: state as SegmentedMediaCancelSnapshot['state'],
      cleanupFailed,
      ...(failureKind ? { failureKind } : {}),
      ...(duplicate === true ? { duplicate: true } : {}),
    };
  }

  private authorizedFetch(
    sessionId: string,
    token: string,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<MediaFetchResponse> {
    return this.fetchFn(`${this.baseUrl}/media-transfer/sessions/${encodeURIComponent(sessionId)}`, {
      ...init,
      method: 'GET',
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export async function uploadSegmentedMediaPlan(input: {
  intent: SegmentedMediaSaveIntent;
  candidate: SegmentedMediaCandidate;
  options: SegmentedMediaTransferOptions;
  client: SegmentedMediaTransferClient;
  protocol: SegmentedMediaSessionCreate['protocol'];
  tracks: SegmentedMediaTrack[];
  plans: SegmentedMediaTrackPlan[];
  resolvedMediaUrl: string;
  manifestUrl: string;
  sourceIdentity: string;
}): Promise<SegmentedMediaTransferOutcome> {
  const { intent, candidate, options, client, protocol, tracks, plans } = input;
  const requestId = isUuid(options.requestId) ? options.requestId : makeSegmentedRequestId();
  const journalPlanSize = new TextEncoder().encode(JSON.stringify(plans)).byteLength;
  if (journalPlanSize > MAX_SEGMENTED_MEDIA_JOURNAL_BYTES / 2) {
    return { state: 'unsupported', reason: '分段计划过大，暂不能安全恢复此视频保存' };
  }

  let existing: SegmentedMediaTransferJournal | undefined;
  try {
    existing = (await loadSegmentedMediaJournals(options.journalStorage)).find((item) => item.requestId === requestId);
  } catch (error) {
    return { state: 'failed', reason: safeError(error) };
  }
  if (existing) {
    if (existing.protocol !== protocol
      || existing.sourcePageUrl !== sanitizeMetadataUrl(intent.sourcePageUrl)
      || existing.manifestUrl !== input.manifestUrl
      || existing.sourceIdentity !== input.sourceIdentity
      || JSON.stringify(existing.tracks) !== JSON.stringify(plans)) {
      return { state: 'failed', reason: '分段会话请求编号已绑定到另一份媒体计划' };
    }
    const resumed = await resumeOneSegmentedMediaTransfer(existing, options);
    if (resumed.state === 'saved') return { state: 'saved', ...(resumed.duplicate ? { duplicate: true } : {}) };
    if (resumed.state === 'source-failed') {
      await removeSegmentedMediaJournal(requestId, options.journalStorage).catch(() => undefined);
      await clearSegmentedMediaRecoveryAlarmWhenIdle(options.journalStorage, options.recoveryAlarm).catch(() => undefined);
      return { state: 'source-failed', reason: resumed.reason ?? '视频源数据无效' };
    }
    if (resumed.state === 'failed') {
      await removeSegmentedMediaJournal(requestId, options.journalStorage).catch(() => undefined);
      await clearSegmentedMediaRecoveryAlarmWhenIdle(options.journalStorage, options.recoveryAlarm).catch(() => undefined);
      return { state: 'failed', reason: resumed.reason ?? '桌面导入失败' };
    }
    return { state: 'pending', reason: resumed.reason ?? '分段传输将在后台恢复' };
  }

  const createInput: SegmentedMediaSessionCreate = {
    requestId,
    filename: outputFilename(candidate.url),
    sourcePageUrl: sanitizeMetadataUrl(intent.sourcePageUrl),
    mediaUrl: sanitizeMetadataUrl(input.resolvedMediaUrl),
    protocol,
    tracks,
    ...(intent.targetFolderId === undefined ? {} : { targetFolderId: intent.targetFolderId }),
    ...(intent.targetCollectionId === undefined ? {} : { targetCollectionId: intent.targetCollectionId }),
    ...(intent.expectedLibraryId === undefined ? {} : { expectedLibraryId: intent.expectedLibraryId }),
    ...(options.behavior ? {
      focusAppAfterSave: options.behavior.focusAppAfterSave,
      revealInLibrary: options.behavior.revealInLibraryAfterSave,
    } : {}),
  };

  let session: { sessionId: string; token: string };
  try {
    session = await client.createSession(createInput, options.signal);
  } catch (error) {
    return { state: 'failed', reason: options.signal?.aborted || isAbort(error) ? '保存已取消' : safeError(error) };
  }

  const now = Date.now();
  const journal: SegmentedMediaTransferJournal = {
    version: 1,
    requestId,
    sessionId: session.sessionId,
    token: session.token,
    endpoint: client.endpoint,
    sourcePageUrl: sanitizeMetadataUrl(intent.sourcePageUrl),
    protocol,
    tracks: plans,
    manifestUrl: input.manifestUrl,
    sourceIdentity: input.sourceIdentity,
    ...(intent.allowRecoveryFallback === false
      || !isSafeRemoteMediaUrl(intent.mediaUrl)
      || stableMediaResourceIdentity(candidate.url) === stableMediaResourceIdentity(intent.mediaUrl)
      ? {}
      : {
          fallbackPreview: {
            fallbackRequestId: makeSegmentedRequestId(),
            kind: 'video' as const,
            sourcePageUrl: sanitizeMetadataUrl(intent.sourcePageUrl),
            mediaUrl: intent.mediaUrl,
            ...(intent.targetFolderId === undefined ? {} : { targetFolderId: intent.targetFolderId }),
            ...(intent.targetCollectionId === undefined ? {} : { targetCollectionId: intent.targetCollectionId }),
            allowRecoveryFallback: false as const,
            behavior: {
              focusAppAfterSave: options.behavior?.focusAppAfterSave ?? false,
              revealInLibraryAfterSave: options.behavior?.revealInLibraryAfterSave ?? false,
              notificationsEnabled: options.behavior?.notificationsEnabled ?? true,
            },
          },
        }),
    ...(intent.allowRecoveryFallback === false
      ? { fallbackUnavailableReason: '预览回退已关闭。' }
      : !isSafeRemoteMediaUrl(intent.mediaUrl)
        ? { fallbackUnavailableReason: '原预览不是可恢复的 HTTP(S) 地址。' }
        : stableMediaResourceIdentity(candidate.url) === stableMediaResourceIdentity(intent.mediaUrl)
          ? { fallbackUnavailableReason: '原预览与失败的分段来源相同，无法安全回退。' }
          : {}),
    createdAt: now,
    expiresAt: now + SEGMENTED_MEDIA_SESSION_LIFETIME_MS,
    recoveryAttempts: 0,
    refreshAttempts: 0,
  };

  try {
    await storeSegmentedMediaJournal(journal, options.journalStorage);
    await (options.recoveryAlarm?.schedule() ?? scheduleSegmentedMediaRecoveryAlarm());
  } catch (error) {
    await client.cancel(session.sessionId, session.token).catch(() => undefined);
    await removeSegmentedMediaJournal(requestId, options.journalStorage).catch(() => undefined);
    return { state: 'failed', reason: safeError(error) };
  }

  const result = await resumeOneSegmentedMediaTransfer(journal, options, client);
  if (result.state !== 'pending') {
    await removeSegmentedMediaJournal(requestId, options.journalStorage).catch(() => undefined);
    await clearSegmentedMediaRecoveryAlarmWhenIdle(options.journalStorage, options.recoveryAlarm).catch(() => undefined);
    if (result.state === 'saved') return { state: 'saved', ...(result.duplicate ? { duplicate: true } : {}) };
    if (result.state === 'source-failed') return { state: 'source-failed', reason: result.reason ?? '视频源数据无效' };
    return { state: 'failed', reason: result.reason ?? '桌面导入失败' };
  }
  return { state: 'pending', reason: result.reason ?? '分段传输将在后台恢复' };
}

/** Resume only existing, frozen desktop sessions. This never creates a new session or changes its destination. */
export async function resumePendingSegmentedMediaTransfers(
  options: SegmentedMediaRecoveryOptions = {},
): Promise<Array<{
  requestId: string;
  state: 'saved' | 'source-failed' | 'failed';
  reason?: string;
  duplicate?: true;
  fallbackIntent?: SegmentedMediaFallbackIntent;
}>> {
  const journals = await loadSegmentedMediaJournals(options.journalStorage);
  const outcomes: Array<{
    requestId: string;
    state: 'saved' | 'source-failed' | 'failed';
    reason?: string;
    duplicate?: true;
    fallbackIntent?: SegmentedMediaFallbackIntent;
  }> = [];
  for (const journal of journals) {
    if (options.signal?.aborted) break;
    if (runningJournalRequests.has(journal.requestId)) continue;
    if (journal.fallbackClaimed) {
      if (!journal.fallbackPreview || !journal.targetLibraryId) {
        await removeSegmentedMediaJournal(journal.requestId, options.journalStorage);
        continue;
      }
      const outcome = {
        requestId: journal.requestId,
        state: 'source-failed' as const,
        reason: journal.sourceFailedReason ?? '视频源验证失败，正在回退到原始预览。',
        fallbackIntent: {
          ...journal.fallbackPreview,
          expectedLibraryId: journal.targetLibraryId,
        },
      };
      outcomes.push(outcome);
      try {
        await options.onOutcome?.(outcome);
        await removeSegmentedMediaJournal(journal.requestId, options.journalStorage);
      } catch {
        // Keep the claimed journal so the same idempotency key can be retried after restart.
      }
      continue;
    }
    const result = await resumeOneSegmentedMediaTransfer(journal, options);
    if (result.state === 'pending') continue;
    const outcomeJournal = result.state === 'source-failed'
      ? (await loadSegmentedMediaJournals(options.journalStorage)).find((item) => item.requestId === journal.requestId) ?? journal
      : journal;
    let outcome: typeof outcomes[number] = {
      requestId: journal.requestId,
      state: result.state,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.duplicate ? { duplicate: true } : {}),
    };
    if (result.state === 'source-failed' && outcomeJournal.fallbackPreview && outcomeJournal.targetLibraryId) {
      const fallbackIntent: SegmentedMediaFallbackIntent = {
        ...outcomeJournal.fallbackPreview,
        expectedLibraryId: outcomeJournal.targetLibraryId,
      };
      outcome = { ...outcome, fallbackIntent };
      await storeSegmentedMediaJournal({
        ...outcomeJournal,
        fallbackClaimed: true,
        ...(result.reason ? { sourceFailedReason: result.reason.slice(0, 240) } : {}),
      }, options.journalStorage);
    } else if (result.state === 'source-failed') {
      const fallbackUnavailableReason = !outcomeJournal.targetLibraryId
        ? '桌面端未提供冻结的资源库 ID。'
        : outcomeJournal.fallbackUnavailableReason ?? '未提供可恢复的原始预览。';
      outcome.reason = `${outcome.reason ? `${outcome.reason}；` : ''}未回退：${fallbackUnavailableReason}`.slice(0, 240);
    }
    outcomes.push(outcome);
    try {
      await options.onOutcome?.(outcomes[outcomes.length - 1]!);
      await removeSegmentedMediaJournal(journal.requestId, options.journalStorage);
    } catch {
      // Preserve terminal outcomes until the consumer acknowledges them.
    }
  }
  await clearSegmentedMediaRecoveryAlarmWhenIdle(options.journalStorage, options.recoveryAlarm).catch(() => undefined);
  return outcomes;
}

export async function scheduleSegmentedMediaRecoveryAlarm(): Promise<void> {
  await browser.alarms.create(SEGMENTED_MEDIA_RECOVERY_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
}

export async function clearSegmentedMediaRecoveryAlarmWhenIdle(
  storage?: SegmentedMediaJournalStorage,
  alarm?: SegmentedMediaRecoveryAlarm,
): Promise<void> {
  if ((await loadSegmentedMediaJournals(storage)).length > 0) return;
  await (alarm?.clear() ?? browser.alarms.clear(SEGMENTED_MEDIA_RECOVERY_ALARM));
}

export async function hasPendingSegmentedMediaTransfers(
  storage?: SegmentedMediaJournalStorage,
): Promise<boolean> {
  return (await loadSegmentedMediaJournals(storage)).length > 0;
}

function savedSegmentedResult(...results: Array<{ duplicate?: true } | undefined>): {
  state: 'saved';
  duplicate?: true;
} {
  return {
    state: 'saved',
    ...(results.some((result) => result?.duplicate === true) ? { duplicate: true } : {}),
  };
}

async function completedSnapshot(
  client: SegmentedMediaTransferClient,
  journal: SegmentedMediaTransferJournal,
  options: SegmentedMediaRecoveryOptions | SegmentedMediaTransferOptions,
): Promise<SegmentedMediaSessionSnapshot | undefined> {
  try {
    const snapshot = await client.snapshot(journal.sessionId, journal.token, options.signal);
    return snapshot.status === 'complete' ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

async function resumeOneSegmentedMediaTransfer(
  journal: SegmentedMediaTransferJournal,
  options: SegmentedMediaRecoveryOptions | SegmentedMediaTransferOptions,
  knownClient?: SegmentedMediaTransferClient,
): Promise<{ state: 'saved' | 'source-failed' | 'failed' | 'pending'; reason?: string; duplicate?: true }> {
  if (runningJournalRequests.has(journal.requestId)) return { state: 'pending' };
  runningJournalRequests.add(journal.requestId);
  const fetchFn = bindFetchFunction(options.fetchFn);
  let activeClient = knownClient;
  try {
    let client = activeClient;
    if (!client || client.endpoint !== journal.endpoint) {
      client = await SegmentedMediaTransferClient.connectAt(journal.endpoint, fetchFn, options.signal, true);
      activeClient = client;
    }
    if (!client) return { state: 'pending', reason: '桌面端暂时不可连接' };

    let snapshot: SegmentedMediaSessionSnapshot;
    try {
      snapshot = await client.snapshot(journal.sessionId, journal.token, options.signal);
    } catch (error) {
      if (error instanceof SegmentedMediaHttpError && error.status === 404) {
        return { state: 'failed', reason: '分段会话已过期，临时数据已清理' };
      }
      return { state: 'pending', reason: safeError(error) };
    }

    if (snapshot.libraryId) {
      if (journal.targetLibraryId && journal.targetLibraryId !== snapshot.libraryId) {
        return { state: 'failed', reason: '桌面分段会话的资源库与冻结目标不一致' };
      }
      let frozenFallbackPreview: SegmentedMediaTransferJournal['fallbackPreview'];
      if (journal.fallbackPreview) {
        frozenFallbackPreview = { ...journal.fallbackPreview };
        delete frozenFallbackPreview.targetFolderId;
        delete frozenFallbackPreview.targetCollectionId;
        if (snapshot.targetCollectionId) frozenFallbackPreview.targetCollectionId = snapshot.targetCollectionId;
        else frozenFallbackPreview.targetFolderId = snapshot.targetFolderId ?? null;
      }
      if (!journal.targetLibraryId
        || (frozenFallbackPreview && JSON.stringify(frozenFallbackPreview) !== JSON.stringify(journal.fallbackPreview))) {
        journal = {
          ...journal,
          targetLibraryId: snapshot.libraryId,
          ...(frozenFallbackPreview ? { fallbackPreview: frozenFallbackPreview } : {}),
        };
        await storeSegmentedMediaJournal(journal, options.journalStorage);
      }
    }

    if (snapshot.status === 'complete') return savedSegmentedResult(snapshot);
    if (journal.cancelRequested) {
      try {
        const cancelled = await client.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(client, journal, options), cancelled);
        if (journal.sourceFailedReason && isConfirmedSourceCleanup(cancelled)) {
          return { state: 'source-failed', reason: journal.sourceFailedReason };
        }
        if (cancelled.failureKind === 'source-invalid' && isConfirmedSourceCleanup(cancelled)) {
          return { state: 'source-failed', reason: '桌面验证认为视频源无效，临时会话已清理' };
        }
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
        return { state: 'failed', reason: '保存已取消，临时数据已清理' };
      } catch (error) {
        return { state: 'pending', reason: safeError(error) };
      }
    }
    if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      try {
        const cancelled = await client.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(client, journal, options), cancelled);
        if ((snapshot.status === 'failed' && snapshot.failureKind === 'source-invalid'
          || cancelled.failureKind === 'source-invalid') && isConfirmedSourceCleanup(cancelled)) {
          return { state: 'source-failed', reason: snapshot.reason ?? '桌面验证认为视频源无效，临时会话已清理' };
        }
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
        return { state: 'failed', reason: snapshot.reason ?? `桌面会话${snapshot.status}，临时数据已清理` };
      } catch (error) {
        return { state: 'pending', reason: safeError(error) };
      }
    }

    if (Date.now() >= journal.expiresAt || journal.recoveryAttempts >= MAX_SEGMENTED_MEDIA_RECOVERY_ATTEMPTS) {
      try {
        const cancelled = await client.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(client, journal, options), cancelled);
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
        return { state: 'failed', reason: '分段会话已过期，临时数据已清理' };
      } catch (error) {
        return { state: 'pending', reason: safeError(error) };
      }
    }

    if (snapshot.status === 'uploading' && !client.capability.protocols.includes(journal.protocol)) {
      try {
        const cancelled = await client.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(client, journal, options), cancelled);
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
        return { state: 'failed', reason: '桌面端已不再支持此分段会话，临时数据已清理' };
      } catch (error) {
        return { state: 'pending', reason: safeError(error) };
      }
    }

    const attemptJournal = { ...journal, recoveryAttempts: journal.recoveryAttempts + 1 };
    await storeSegmentedMediaJournal(attemptJournal, options.journalStorage);
    if (snapshot.status === 'uploading') {
      await uploadJournalSegments(attemptJournal, client, options, snapshot);
      await client.commit(journal.sessionId, journal.token, options.signal);
    }
    const completed = await client.waitForCompletion(journal.sessionId, journal.token, {
      signal: options.signal,
      intervalMs: options.pollIntervalMs,
      timeoutMs: options.commitTimeoutMs,
    });
    return savedSegmentedResult(completed);
  } catch (error) {
    if (error instanceof SegmentedMediaSourceError || isAssetSizeLimitError(error)) {
      const reason = safeError(error);
      if (error instanceof SegmentedMediaSourceError && activeClient
        && (journal.refreshAttempts ?? 0) < MAX_SEGMENTED_MEDIA_MANIFEST_REFRESHES) {
        let snapshot: SegmentedMediaSessionSnapshot | undefined;
        try { snapshot = await activeClient.snapshot(journal.sessionId, journal.token, options.signal); }
        catch { /* Keep the existing journal pending if the desktop status cannot be checked. */ }
        if (snapshot?.status === 'complete') return savedSegmentedResult(snapshot);
        if (!snapshot) return { state: 'pending', reason: '无法核对桌面会话状态，稍后继续恢复' };
        if (snapshot.status === 'committing') return { state: 'pending', reason: '桌面正在导入视频，等待结果确认' };
        if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
          try {
            const cancelled = await activeClient.cancel(journal.sessionId, journal.token);
            if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(activeClient, journal, options), cancelled);
            if ((snapshot.status === 'failed' && snapshot.failureKind === 'source-invalid'
              || cancelled.failureKind === 'source-invalid') && isConfirmedSourceCleanup(cancelled)) {
              return { state: 'source-failed', reason: snapshot.reason ?? '桌面验证认为视频源无效，临时会话已清理' };
            }
            if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
              return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
            }
            return { state: 'failed', reason: snapshot.reason ?? `桌面会话${snapshot.status}` };
          } catch (cancelError) {
            return { state: 'pending', reason: safeError(cancelError) };
          }
        }
        if (snapshot?.status === 'uploading') {
          const refresh = await refreshJournalMediaUrls(journal, activeClient, options, snapshot);
          if (refresh === 'refreshed') {
            return { state: 'pending', reason: '视频链接已刷新，分段传输将在后台继续' };
          }
          if (refresh === 'transient') {
            return { state: 'pending', reason: '暂时无法刷新视频链接，稍后继续恢复' };
          }
        }
      }
      if (!activeClient) {
        await storeSegmentedMediaJournal({
          ...journal,
          cancelRequested: true,
          sourceFailedReason: reason,
        }, options.journalStorage).catch(() => undefined);
        return { state: 'pending', reason: '媒体数据有误，等待清理临时会话' };
      }
      try {
        const cancelled = await activeClient.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(activeClient, journal, options), cancelled);
        if (isConfirmedSourceCleanup(cancelled)) return { state: 'source-failed', reason };
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
        if (cancelled.state === 'failed') return { state: 'failed', reason: '桌面端已拒绝导入，不能安全回退预览' };
        return { state: 'failed', reason: '媒体会话已结束，不能安全回退预览' };
      } catch (cancelError) {
        await storeSegmentedMediaJournal({
          ...journal,
          cancelRequested: true,
          sourceFailedReason: reason,
        }, options.journalStorage).catch(() => undefined);
        return { state: 'pending', reason: safeError(cancelError) };
      }
      return { state: 'source-failed', reason };
    }
    if (options.signal?.aborted || isAbort(error)) {
      if (!activeClient) {
        await storeSegmentedMediaJournal({ ...journal, cancelRequested: true }, options.journalStorage).catch(() => undefined);
        return { state: 'pending', reason: '保存取消后桌面端暂时不可连接' };
      }
      try {
        const cancelled = await activeClient.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(activeClient, journal, options), cancelled);
        if (journal.sourceFailedReason && isConfirmedSourceCleanup(cancelled)) {
          return { state: 'source-failed', reason: journal.sourceFailedReason };
        }
        if (cancelled.failureKind === 'source-invalid' && isConfirmedSourceCleanup(cancelled)) {
          return { state: 'source-failed', reason: '桌面验证认为视频源无效，临时会话已清理' };
        }
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          await storeSegmentedMediaJournal({ ...journal, cancelRequested: true }, options.journalStorage).catch(() => undefined);
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
      } catch (cancelError) {
        await storeSegmentedMediaJournal({ ...journal, cancelRequested: true }, options.journalStorage).catch(() => undefined);
        return { state: 'pending', reason: safeError(cancelError) };
      }
      return { state: 'failed', reason: '保存已取消' };
    }
    if (error instanceof SegmentedMediaTerminalError || isTerminalDesktopError(error)) {
      const client = activeClient ?? await SegmentedMediaTransferClient.connectAt(journal.endpoint, fetchFn, undefined, true).catch(() => undefined);
      if (!client) return { state: 'pending', reason: safeError(error) };
      try {
        const cancelled = await client.cancel(journal.sessionId, journal.token);
        if (cancelled.state === 'complete') return savedSegmentedResult(await completedSnapshot(client, journal, options), cancelled);
        if (error instanceof SegmentedMediaTerminalError && error.failureKind === 'source-invalid'
          && isConfirmedSourceCleanup(cancelled)) {
          return { state: 'source-failed', reason: safeError(error) };
        }
        if (cancelled.cleanupFailed || cancelled.state === 'committing' || cancelled.state === 'uploading') {
          return { state: 'pending', reason: cancelled.cleanupFailed ? '临时数据清理仍未完成' : '桌面会话仍在结束' };
        }
      } catch { return { state: 'pending', reason: safeError(error) }; }
      if (error instanceof SegmentedMediaTerminalError && error.failureKind === 'source-invalid') {
        return { state: 'failed', reason: '源验证失败，但桌面未确认导入前清理完成' };
      }
      return { state: 'failed', reason: safeError(error) };
    }
    return { state: 'pending', reason: safeError(error) };
  } finally {
    runningJournalRequests.delete(journal.requestId);
  }
}

async function uploadJournalSegments(
  journal: SegmentedMediaTransferJournal,
  client: SegmentedMediaTransferClient,
  options: SegmentedMediaRecoveryOptions | SegmentedMediaTransferOptions,
  snapshot: SegmentedMediaSessionSnapshot,
): Promise<void> {
  const fetchFn = bindFetchFunction(options.fetchFn);
  for (let trackIndex = 0; trackIndex < journal.tracks.length; trackIndex += 1) {
    const plan = journal.tracks[trackIndex]!;
    const prefix = trackIndex === 0 ? 'v' : 'a';
    if (plan.init) {
      const segmentId = `${prefix}-init`;
      const state = snapshot.segments.find((item) => item.id === segmentId);
      if (!state?.complete) {
        await downloadPart({
          client,
          sessionId: journal.sessionId,
          token: journal.token,
          part: plan.init,
          segmentId,
          existingBytes: state?.receivedBytes ?? 0,
          expectedBytes: plan.init.range?.length,
          pageUrl: journal.sourcePageUrl,
          fetchFn,
          signal: options.signal,
        });
      }
    }
    for (let index = 0; index < plan.parts.length; index += 1) {
      const segmentId = `${prefix}-${index.toString().padStart(6, '0')}`;
      const part = plan.parts[index]!;
      const state = snapshot.segments.find((item) => item.id === segmentId);
      if (state?.complete) continue;
      await downloadPart({
        client,
        sessionId: journal.sessionId,
        token: journal.token,
        part,
        segmentId,
        existingBytes: state?.receivedBytes ?? 0,
        expectedBytes: part.range?.length,
        pageUrl: journal.sourcePageUrl,
        fetchFn,
        signal: options.signal,
      });
    }
  }
}

async function refreshJournalMediaUrls(
  journal: SegmentedMediaTransferJournal,
  client: SegmentedMediaTransferClient,
  options: SegmentedMediaRecoveryOptions | SegmentedMediaTransferOptions,
  snapshot: SegmentedMediaSessionSnapshot,
): Promise<'refreshed' | 'transient' | 'unavailable'> {
  if (!journal.manifestUrl || !journal.sourceIdentity
    || (journal.refreshAttempts ?? 0) >= MAX_SEGMENTED_MEDIA_MANIFEST_REFRESHES) return 'unavailable';
  const attempted = { ...journal, refreshAttempts: (journal.refreshAttempts ?? 0) + 1 };
  try { await storeSegmentedMediaJournal(attempted, options.journalStorage); }
  catch { return 'transient'; }

  const fetchFn = bindFetchFunction(options.fetchFn);
  let manifest: Awaited<ReturnType<typeof fetchMediaManifest>>;
  try {
    manifest = await fetchMediaManifest(journal.manifestUrl, journal.sourcePageUrl, fetchFn, options.signal);
  } catch (error) {
    if (options.signal?.aborted || isAbort(error)) throw error;
    return error instanceof SegmentedMediaSourceError ? 'unavailable' : 'transient';
  }

  let refreshedPlans: SegmentedMediaTrackPlan[];
  let protocol: SegmentedMediaSessionCreate['protocol'];
  try {
    if (journal.protocol === 'dash-fmp4') {
      if (manifest.format !== 'dash' || !manifest.text) return 'unavailable';
      const resolved = resolveDashMediaPlan(manifest.text, manifest.finalUrl, journal.sourceIdentity);
      refreshedPlans = resolved.plans.map((plan) => ({
        kind: plan.kind,
        ...(plan.init ? { init: plan.init } : {}),
        parts: plan.parts,
      }));
      protocol = 'dash-fmp4';
    } else {
      if (manifest.format !== 'hls' || !manifest.text) return 'unavailable';
      const resolved = await resolveHlsMediaPlan(
        journal.manifestUrl,
        journal.sourcePageUrl,
        fetchFn,
        options.signal,
        manifest,
        journal.sourceIdentity,
      );
      refreshedPlans = resolved.plans.map((plan) => ({
        kind: plan.kind,
        ...(plan.init ? { init: plan.init } : {}),
        parts: plan.parts,
      }));
      protocol = resolved.plans.some((plan) => plan.protocol === 'hls-fmp4') ? 'hls-fmp4' : 'hls-ts';
    }
  } catch (error) {
    if (options.signal?.aborted || isAbort(error)) throw error;
    return error instanceof SegmentedMediaSourceError
      || (error instanceof Error && /Unsupported(?:Hls|Dash)Error/u.test(error.name))
      ? 'unavailable'
      : 'transient';
  }
  if (protocol !== journal.protocol) return 'unavailable';
  const tracks = mergeRefreshedSegmentUrls(journal.tracks, refreshedPlans, snapshot);
  if (!tracks) return 'unavailable';
  const refreshed = { ...attempted, tracks };
  try {
    await storeSegmentedMediaJournal(refreshed, options.journalStorage);
    await (options.recoveryAlarm?.schedule() ?? scheduleSegmentedMediaRecoveryAlarm());
  } catch {
    return 'transient';
  }
  return 'refreshed';
}

export function mergeRefreshedSegmentUrls(
  current: readonly SegmentedMediaTrackPlan[],
  refreshed: readonly SegmentedMediaTrackPlan[],
  snapshot: SegmentedMediaSessionSnapshot,
): SegmentedMediaTrackPlan[] | undefined {
  if (current.length !== refreshed.length) return undefined;
  const result: SegmentedMediaTrackPlan[] = [];
  for (let trackIndex = 0; trackIndex < current.length; trackIndex += 1) {
    const previousTrack = current[trackIndex]!;
    const freshTrack = refreshed[trackIndex]!;
    if (previousTrack.kind !== freshTrack.kind || previousTrack.parts.length !== freshTrack.parts.length
      || Boolean(previousTrack.init) !== Boolean(freshTrack.init)
      || !sameRange(previousTrack.init?.range, freshTrack.init?.range)) return undefined;
    const prefix = previousTrack.kind === 'video' ? 'v' : 'a';
    let init = previousTrack.init;
    if (previousTrack.init && freshTrack.init) {
      const state = snapshot.segments.find((segment) => segment.id === `${prefix}-init`);
      if (!state?.complete) {
        if (!sameMediaResource(previousTrack.init.url, freshTrack.init.url)) return undefined;
        init = { ...previousTrack.init, url: freshTrack.init.url };
      }
    }
    const parts: SegmentedMediaPartPlan[] = [];
    for (let index = 0; index < previousTrack.parts.length; index += 1) {
      const previous = previousTrack.parts[index]!;
      const fresh = freshTrack.parts[index]!;
      if (previous.durationMs !== fresh.durationMs
        || previous.discontinuityBefore !== fresh.discontinuityBefore
        || !sameRange(previous.range, fresh.range)) return undefined;
      const segmentId = `${prefix}-${index.toString().padStart(6, '0')}`;
      const state = snapshot.segments.find((segment) => segment.id === segmentId);
      if (!state?.complete && !sameMediaResource(previous.url, fresh.url)) return undefined;
      parts.push(state?.complete ? previous : { ...previous, url: fresh.url });
    }
    result.push({ kind: previousTrack.kind, ...(init ? { init } : {}), parts });
  }
  return result;
}

function sameRange(
  left: SegmentedMediaPartPlan['range'],
  right: SegmentedMediaPartPlan['range'],
): boolean {
  return left?.offset === right?.offset && left?.length === right?.length;
}

function sameMediaResource(left: string, right: string): boolean {
  try { return stableMediaResourceIdentity(left) === stableMediaResourceIdentity(right); }
  catch { return false; }
}

async function loadSegmentedMediaJournals(
  suppliedStorage?: SegmentedMediaJournalStorage,
): Promise<SegmentedMediaTransferJournal[]> {
  const value = await getJournalStorage(suppliedStorage).get(SEGMENTED_MEDIA_JOURNAL_KEY);
  const raw = value[SEGMENTED_MEDIA_JOURNAL_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.values(raw).flatMap((item) => {
    const parsed = parseSegmentedMediaJournal(item);
    return parsed ? [parsed] : [];
  });
}

async function storeSegmentedMediaJournal(
  journal: SegmentedMediaTransferJournal,
  suppliedStorage?: SegmentedMediaJournalStorage,
): Promise<void> {
  await withJournalMutation(async () => {
    const storage = getJournalStorage(suppliedStorage);
    const existing = await loadSegmentedMediaJournalMap(storage);
    existing[journal.requestId] = journal;
    const serialized = JSON.stringify(existing);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SEGMENTED_MEDIA_JOURNAL_BYTES) {
      throw new Error('分段恢复记录空间不足');
    }
    await storage.set({ [SEGMENTED_MEDIA_JOURNAL_KEY]: existing });
  });
}

async function removeSegmentedMediaJournal(
  requestId: string,
  suppliedStorage?: SegmentedMediaJournalStorage,
): Promise<void> {
  await withJournalMutation(async () => {
    const storage = getJournalStorage(suppliedStorage);
    const existing = await loadSegmentedMediaJournalMap(storage);
    delete existing[requestId];
    if (Object.keys(existing).length === 0) await storage.remove(SEGMENTED_MEDIA_JOURNAL_KEY);
    else await storage.set({ [SEGMENTED_MEDIA_JOURNAL_KEY]: existing });
  });
}

async function loadSegmentedMediaJournalMap(
  storage: SegmentedMediaJournalStorage,
): Promise<Record<string, SegmentedMediaTransferJournal>> {
  const value = await storage.get(SEGMENTED_MEDIA_JOURNAL_KEY);
  const raw = value[SEGMENTED_MEDIA_JOURNAL_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, SegmentedMediaTransferJournal> = {};
  for (const [key, item] of Object.entries(raw)) {
    const parsed = parseSegmentedMediaJournal(item);
    if (parsed && parsed.requestId === key) result[key] = parsed;
  }
  return result;
}

function parseSegmentedMediaJournal(value: unknown): SegmentedMediaTransferJournal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<SegmentedMediaTransferJournal>;
  if (record.version !== 1
    || !isUuid(record.requestId)
    || !isUuid(record.sessionId)
    || typeof record.token !== 'string'
    || !/^[A-Za-z0-9_-]{32,128}$/u.test(record.token)
    || typeof record.endpoint !== 'string'
    || !isDesktopEndpoint(record.endpoint)
    || typeof record.sourcePageUrl !== 'string'
    || !isHttpUrl(record.sourcePageUrl)
    || !['hls-ts', 'hls-fmp4', 'dash-fmp4'].includes(String(record.protocol))
    || !Number.isSafeInteger(record.createdAt)
    || !Number.isSafeInteger(record.expiresAt)
    || !Number.isSafeInteger(record.recoveryAttempts)
    || record.recoveryAttempts! < 0
    || record.recoveryAttempts! > MAX_SEGMENTED_MEDIA_RECOVERY_ATTEMPTS
    || (record.refreshAttempts !== undefined
      && (!Number.isSafeInteger(record.refreshAttempts) || record.refreshAttempts < 0
        || record.refreshAttempts > MAX_SEGMENTED_MEDIA_MANIFEST_REFRESHES))
    || (record.manifestUrl !== undefined
      && (typeof record.manifestUrl !== 'string' || !isSafeMediaResourceUrl(record.manifestUrl)))
    || (record.sourceIdentity !== undefined
      && (typeof record.sourceIdentity !== 'string' || record.sourceIdentity.length === 0 || record.sourceIdentity.length > 8_192))
    || (record.fallbackUnavailableReason !== undefined
      && (typeof record.fallbackUnavailableReason !== 'string' || record.fallbackUnavailableReason.length > 240))
    || (record.cancelRequested !== undefined && typeof record.cancelRequested !== 'boolean')
    || (record.sourceFailedReason !== undefined && typeof record.sourceFailedReason !== 'string')
    || !Array.isArray(record.tracks)) return undefined;

  const tracks: SegmentedMediaTrackPlan[] = [];
  for (const item of record.tracks) {
    if (!item || typeof item !== 'object') return undefined;
    const track = item as Partial<SegmentedMediaTrackPlan>;
    if ((track.kind !== 'video' && track.kind !== 'audio') || !Array.isArray(track.parts) || track.parts.length === 0) return undefined;
    const init = track.init === undefined ? undefined : parsePartPlan(track.init);
    if (track.init !== undefined && !init) return undefined;
    const parts = track.parts.map(parsePartPlan);
    if (parts.some((part) => !part)) return undefined;
    tracks.push({
      kind: track.kind,
      ...(init ? { init: { url: init.url, ...(init.range ? { range: init.range } : {}) } } : {}),
      parts: parts as SegmentedMediaPartPlan[],
    });
  }
  if (tracks.length < 1 || tracks.length > 2
    || tracks.filter((track) => track.kind === 'video').length !== 1
    || tracks.filter((track) => track.kind === 'audio').length > 1
    || tracks.reduce((sum, track) => sum + track.parts.length + (track.init ? 1 : 0), 0) > 20_000) return undefined;
  return {
    version: 1,
    requestId: record.requestId!,
    sessionId: record.sessionId!,
    token: record.token,
    endpoint: record.endpoint,
    sourcePageUrl: record.sourcePageUrl,
    protocol: record.protocol as SegmentedMediaTransferJournal['protocol'],
    tracks,
    ...(typeof record.manifestUrl === 'string' ? { manifestUrl: record.manifestUrl } : {}),
    ...(typeof record.sourceIdentity === 'string' ? { sourceIdentity: record.sourceIdentity } : {}),
    ...(typeof record.targetLibraryId === 'string' && record.targetLibraryId.length > 0
      ? { targetLibraryId: record.targetLibraryId }
      : {}),
    ...(record.fallbackPreview && parseFallbackPreview(record.fallbackPreview)
      ? { fallbackPreview: parseFallbackPreview(record.fallbackPreview)! }
      : {}),
    ...(record.fallbackClaimed === true ? { fallbackClaimed: true } : {}),
    ...(record.fallbackUnavailableReason ? { fallbackUnavailableReason: record.fallbackUnavailableReason } : {}),
    createdAt: record.createdAt!,
    expiresAt: record.expiresAt!,
    recoveryAttempts: record.recoveryAttempts!,
    refreshAttempts: Number.isSafeInteger(record.refreshAttempts) ? record.refreshAttempts! : 0,
    ...(record.cancelRequested ? { cancelRequested: true } : {}),
    ...(record.sourceFailedReason ? { sourceFailedReason: record.sourceFailedReason.slice(0, 240) } : {}),
  };
}

function parseFallbackPreview(value: unknown): SegmentedMediaTransferJournal['fallbackPreview'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<SegmentedMediaFallbackIntent>;
  if (!isUuid(record.fallbackRequestId)
    || record.kind !== 'video'
    || typeof record.sourcePageUrl !== 'string'
    || !isHttpUrl(record.sourcePageUrl)
    || typeof record.mediaUrl !== 'string'
    || !isSafeRemoteMediaUrl(record.mediaUrl)
    || record.allowRecoveryFallback !== false
    || !record.behavior
    || typeof record.behavior.focusAppAfterSave !== 'boolean'
    || typeof record.behavior.revealInLibraryAfterSave !== 'boolean'
    || typeof record.behavior.notificationsEnabled !== 'boolean'
    || (record.targetFolderId !== undefined
      && record.targetFolderId !== null
      && (typeof record.targetFolderId !== 'string' || record.targetFolderId.length === 0))
    || (record.targetCollectionId !== undefined
      && (typeof record.targetCollectionId !== 'string' || record.targetCollectionId.length === 0))) return undefined;
  return {
    fallbackRequestId: record.fallbackRequestId,
    kind: 'video',
    sourcePageUrl: sanitizeMetadataUrl(record.sourcePageUrl),
    mediaUrl: record.mediaUrl,
    ...(record.targetFolderId === undefined ? {} : { targetFolderId: record.targetFolderId }),
    ...(record.targetCollectionId === undefined ? {} : { targetCollectionId: record.targetCollectionId }),
    allowRecoveryFallback: false,
    behavior: {
      focusAppAfterSave: record.behavior.focusAppAfterSave,
      revealInLibraryAfterSave: record.behavior.revealInLibraryAfterSave,
      notificationsEnabled: record.behavior.notificationsEnabled,
    },
  };
}

function parsePartPlan(value: unknown): SegmentedMediaPartPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<SegmentedMediaPartPlan>;
  if (typeof record.url !== 'string' || !isSafeMediaResourceUrl(record.url)) return undefined;
  let range: SegmentedMediaPartPlan['range'];
  if (record.range !== undefined) {
    const input = record.range as Partial<NonNullable<SegmentedMediaPartPlan['range']>>;
    if (!Number.isSafeInteger(input.offset) || input.offset! < 0
      || !Number.isSafeInteger(input.length) || input.length! <= 0) return undefined;
    range = { offset: input.offset!, length: input.length! };
  }
  if (record.durationMs !== undefined
    && (!Number.isFinite(record.durationMs) || record.durationMs <= 0 || record.durationMs > 24 * 60 * 60 * 1000)) return undefined;
  if (record.discontinuityBefore !== undefined && typeof record.discontinuityBefore !== 'boolean') return undefined;
  return {
    url: record.url,
    ...(range ? { range } : {}),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.discontinuityBefore === undefined ? {} : { discontinuityBefore: record.discontinuityBefore }),
  };
}

async function withJournalMutation<T>(work: () => Promise<T>): Promise<T> {
  const previous = journalMutationTail;
  let release!: () => void;
  journalMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); }
}

function getJournalStorage(supplied?: SegmentedMediaJournalStorage): SegmentedMediaJournalStorage {
  if (supplied) return supplied;
  return {
    get: async (key) => await browser.storage.local.get(key) as Record<string, unknown>,
    set: async (items) => { await browser.storage.local.set(items); },
    remove: async (key) => { await browser.storage.local.remove(key); },
  };
}

function isDesktopEndpoint(value: string): boolean {
  return /^http:\/\/127\.0\.0\.1:1987[6-8]$/u.test(value);
}

function isSafeMediaResourceUrl(value: string): boolean {
  return isSafeRemoteMediaUrl(value);
}

function isTerminalDesktopError(error: unknown): boolean {
  if (!(error instanceof SegmentedMediaHttpError)) return false;
  return (error.status >= 400 && error.status < 500) || error.status === 507;
}

function isAssetSizeLimitError(error: unknown): boolean {
  return error instanceof SegmentedMediaHttpError
    && error.status === 413
    && /asset exceeds/iu.test(error.message);
}

function isConfirmedSourceCleanup(snapshot: SegmentedMediaCancelSnapshot): boolean {
  return !snapshot.cleanupFailed
    && (snapshot.state === 'cancelled'
      || (snapshot.state === 'failed' && snapshot.failureKind === 'source-invalid'));
}

export async function trySegmentedMediaTransfer(
  intent: SegmentedMediaSaveIntent,
  candidate: SegmentedMediaCandidate,
  options: SegmentedMediaTransferOptions = {},
): Promise<SegmentedMediaTransferOutcome> {
  if (
    intent.kind !== 'video'
    || candidate.kind !== 'video'
    || (intent.preferOriginalMedia !== true && candidate.url !== intent.mediaUrl)
    || !isHttpUrl(candidate.url)
  ) return { state: 'not-segmented' };

  try {
    const fetchFn = bindFetchFunction(options.fetchFn);
    const client = await SegmentedMediaTransferClient.connect(fetchFn, options.signal);
    if (!client) return { state: 'unsupported', reason: '桌面端不支持分段视频导入' };
    let manifest: Awaited<ReturnType<typeof fetchMediaManifest>>;
    try {
      manifest = await fetchMediaManifest(candidate.url, intent.sourcePageUrl, fetchFn, options.signal);
    } catch (error) {
      if (options.signal?.aborted || isAbort(error)) throw error;
      return { state: 'unsupported', reason: safeError(error) };
    }
    if (manifest.format === 'other') return { state: 'not-segmented' };
    if (manifest.format === 'dash') {
      return await runDashSegmentedTransfer(intent, candidate, options, client, manifest);
    }
    return await runHlsSegmentedTransfer(intent, candidate, options, manifest, client);
  } catch (error) {
    if (options.signal?.aborted || isAbort(error)) return { state: 'failed', reason: '保存已取消' };
    return { state: 'failed', reason: safeError(error) };
  }
}

export function makeSegmentedRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (token) => {
    const byte = Math.floor(Math.random() * 16);
    return (token === 'x' ? byte : ((byte & 3) | 8)).toString(16);
  });
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Strip credentials and URL tokens before a source URL becomes desktop/library metadata. */
export function sanitizeMetadataUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export async function safeJson(response: MediaFetchResponse): Promise<unknown> {
  try {
    if (response.json) return await response.json();
    return JSON.parse(await response.text()) as unknown;
  } catch { return undefined; }
}

export function readReason(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const reason = Reflect.get(value, 'reason');
  return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 240) : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = Reflect.get(value, key);
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = Reflect.get(value, key);
  return typeof item === 'number' && Number.isFinite(item) && item > 0 ? item : undefined;
}

export function readSegmentedCapability(value: unknown):
  | { version: number; maxAssetBytes: number; chunkBytes: number; protocols: string[] }
  | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = Reflect.get(value, 'segmentedMediaUpload');
  if (!raw || typeof raw !== 'object') return undefined;
  const version = Reflect.get(raw, 'version');
  const maxAssetBytes = Reflect.get(raw, 'maxAssetBytes');
  const chunkBytes = Reflect.get(raw, 'chunkBytes');
  const protocols = Reflect.get(raw, 'protocols');
  if (
    version !== 1
    || typeof maxAssetBytes !== 'number'
    || maxAssetBytes < SERPENT_SEGMENTED_MAX_BYTES
    || typeof chunkBytes !== 'number'
    || chunkBytes <= 0
    || !Array.isArray(protocols)
  ) return undefined;
  return {
    version,
    maxAssetBytes,
    chunkBytes,
    protocols: protocols.filter((protocol): protocol is string => typeof protocol === 'string'),
  };
}

function parseSnapshot(value: unknown): SegmentedMediaSessionSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const sessionId = Reflect.get(value, 'sessionId');
  const status = Reflect.get(value, 'status');
  const receivedBytes = Reflect.get(value, 'receivedBytes');
  const maxAssetBytes = Reflect.get(value, 'maxAssetBytes');
  const chunkBytes = Reflect.get(value, 'chunkBytes');
  const segments = Reflect.get(value, 'segments');
  const libraryId = Reflect.get(value, 'libraryId');
  const targetFolderId = Reflect.get(value, 'targetFolderId');
  const targetCollectionId = Reflect.get(value, 'targetCollectionId');
  const failureKind = Reflect.get(value, 'failureKind');
  const duplicate = Reflect.get(value, 'duplicate');
  if (
    typeof sessionId !== 'string'
    || !['uploading', 'committing', 'complete', 'failed', 'cancelled'].includes(String(status))
    || typeof receivedBytes !== 'number'
    || typeof maxAssetBytes !== 'number'
    || typeof chunkBytes !== 'number'
    || (libraryId !== undefined && (typeof libraryId !== 'string' || libraryId.length === 0))
    || (targetFolderId !== undefined && (typeof targetFolderId !== 'string' || targetFolderId.length === 0))
    || (targetCollectionId !== undefined && (typeof targetCollectionId !== 'string' || targetCollectionId.length === 0))
    || (failureKind !== undefined && failureKind !== 'source-invalid' && failureKind !== 'import-failed')
    || !Array.isArray(segments)
  ) return undefined;
  const parsedSegments = segments.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    const id = Reflect.get(part, 'id');
    const bytes = Reflect.get(part, 'receivedBytes');
    const complete = Reflect.get(part, 'complete');
    if (typeof id !== 'string' || typeof bytes !== 'number' || typeof complete !== 'boolean') return [];
    return [{ id, receivedBytes: bytes, complete }];
  });
  const reason = readReason(value);
  return {
    sessionId,
    status: status as SegmentedMediaSessionSnapshot['status'],
    ...(typeof libraryId === 'string' ? { libraryId } : {}),
    ...(typeof targetFolderId === 'string' ? { targetFolderId } : {}),
    ...(typeof targetCollectionId === 'string' ? { targetCollectionId } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(duplicate === true ? { duplicate: true } : {}),
    receivedBytes,
    maxAssetBytes,
    chunkBytes,
    segments: parsedSegments,
    ...(reason ? { reason } : {}),
  };
}

export function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n\t]/gu, ' ').slice(0, 240) || '分段视频保存失败';
  return '分段视频保存失败';
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function outputFilename(urlValue: string): string {
  let base = 'video';
  try {
    const url = new URL(urlValue);
    const lastPath = url.pathname.split('/').filter(Boolean).at(-1);
    if (lastPath) base = decodeURIComponent(lastPath).replace(/\.[^.]*$/u, '') || 'video';
  } catch { /* Use a generic filename. */ }
  const safeBase = [...base].map((character) => {
    const code = character.codePointAt(0)!;
    return '<>:"/\\|?*'.includes(character) || code < 0x20 ? '_' : character;
  }).join('');
  return `${safeBase.slice(0, 200)}.mp4`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}
