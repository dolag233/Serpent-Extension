import type { SaveIntent, SaveOutcome } from '../save-client';
import type { ExtensionSaveBehavior } from '../preferences';

export interface SegmentedPreviewFallbackIntent {
  readonly fallbackRequestId: string;
  readonly expectedLibraryId: string;
  readonly kind: 'video';
  readonly sourcePageUrl: string;
  /** Exact HTTP(S) preview URL frozen when the original save started. */
  readonly mediaUrl: string;
  readonly targetFolderId?: string | null;
  readonly targetCollectionId?: string;
  readonly behavior: ExtensionSaveBehavior;
  readonly allowRecoveryFallback: false;
}

export interface SegmentedRecoveryOutcome {
  readonly requestId: string;
  readonly state: 'saved' | 'source-failed' | 'failed';
  readonly reason?: string;
  readonly fallbackIntent?: SegmentedPreviewFallbackIntent;
}

export type SegmentedFallbackClaim = 'claimed' | 'duplicate' | 'unavailable';
export type SegmentedFallbackFinalState = 'saved' | 'pending' | 'failed' | 'unknown';

export type SegmentedFallbackConsumption =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'ineligible'; readonly reason: string }
  | {
      readonly kind: 'handled';
      readonly state: SegmentedFallbackFinalState;
      readonly outcome?: SaveOutcome;
      readonly reason?: string;
      readonly intent: SegmentedPreviewFallbackIntent;
    };

export async function consumeSegmentedPreviewFallback(
  recovery: SegmentedRecoveryOutcome,
  dependencies: {
    claim(requestId: string, behavior: ExtensionSaveBehavior): Promise<SegmentedFallbackClaim>;
    save(intent: SaveIntent, behavior: ExtensionSaveBehavior): Promise<SaveOutcome>;
    finish(
      requestId: string,
      state: SegmentedFallbackFinalState,
      reason: string | undefined,
      behavior: ExtensionSaveBehavior,
    ): Promise<void>;
  },
): Promise<SegmentedFallbackConsumption> {
  if (recovery.state !== 'source-failed' || !recovery.fallbackIntent) return { kind: 'ignored' };
  const fallback = recovery.fallbackIntent;
  if (!validFallbackIntent(fallback)) {
    return { kind: 'ineligible', reason: '原预览地址或冻结资源库无法恢复，未尝试保存。' };
  }

  let claim: SegmentedFallbackClaim;
  try {
    claim = await dependencies.claim(fallback.fallbackRequestId, fallback.behavior);
  } catch {
    claim = 'unavailable';
  }
  if (claim === 'duplicate') return { kind: 'duplicate' };
  if (claim !== 'claimed') {
    return {
      kind: 'ineligible',
      reason: '无法持久记录预览回退任务，因此没有发起重复导入。',
    };
  }

  const intent: SaveIntent = {
    kind: 'video',
    sourcePageUrl: fallback.sourcePageUrl,
    mediaUrl: fallback.mediaUrl,
    preferOriginalMedia: false,
    expectedLibraryId: fallback.expectedLibraryId,
    allowRecoveryFallback: false,
    ...(fallback.targetFolderId === undefined ? {} : { targetFolderId: fallback.targetFolderId }),
    ...(fallback.targetCollectionId ? { targetCollectionId: fallback.targetCollectionId } : {}),
  };

  let outcome: SaveOutcome;
  try {
    outcome = await dependencies.save(intent, fallback.behavior);
  } catch {
    outcome = { kind: 'unreachable' };
  }

  const state: SegmentedFallbackFinalState = outcome.kind === 'accepted'
    ? 'saved'
    : outcome.kind === 'pending'
      ? 'pending'
      : outcome.kind === 'unreachable'
        ? 'unknown'
        : 'failed';
  const reason = outcome.kind === 'unreachable'
    ? '预览回退上传结果未确认；为避免重复导入，扩展不会自动重试。'
    : outcome.kind === 'accepted'
      ? undefined
      : outcome.kind === 'pending'
        ? outcome.reason
        : outcome.kind === 'rejected' || outcome.kind === 'transfer_failed' || outcome.kind === 'fetch_failed'
          ? outcome.reason
          : undefined;
  try {
    await dependencies.finish(fallback.fallbackRequestId, state, reason, fallback.behavior);
  } catch {
    // The persistent claim remains. A later startup reports its outcome as unknown and never retries it.
  }
  return {
    kind: 'handled',
    state,
    outcome,
    ...(reason ? { reason } : {}),
    intent: fallback,
  };
}

function validFallbackIntent(value: SegmentedPreviewFallbackIntent): boolean {
  return isUuid(value.fallbackRequestId)
    && isStableId(value.expectedLibraryId)
    && value.kind === 'video'
    && isHttpUrl(value.sourcePageUrl)
    && isHttpUrl(value.mediaUrl)
    && value.allowRecoveryFallback === false
    && typeof value.behavior?.notificationsEnabled === 'boolean'
    && typeof value.behavior?.focusAppAfterSave === 'boolean'
    && typeof value.behavior?.revealInLibraryAfterSave === 'boolean'
    && (value.targetFolderId === undefined || value.targetFolderId === null || typeof value.targetFolderId === 'string')
    && (value.targetCollectionId === undefined || typeof value.targetCollectionId === 'string');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isStableId(value: string): boolean {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
