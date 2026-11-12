import browser from 'webextension-polyfill';

import {
  BATCH_TARGET_KEY,
  batchTargetFromStored,
  type BatchTargetState,
} from './batch-model';
import {
  BATCH_FILTER_KEY,
  migratePreferOriginalMedia as migratePreferOriginalMediaWithStorage,
  PREFER_ORIGINAL_MEDIA_KEY,
  preferOriginalMediaFromStored,
  type SyncStorageLike,
} from './media-resolution/preferences';

export {
  BATCH_FILTER_KEY,
  PREFER_ORIGINAL_MEDIA_KEY,
  preferOriginalMediaFromStored,
  type SyncStorageLike,
};

export const NOTIFICATIONS_ENABLED_KEY = 'serpentNotificationsEnabled';
export const FOCUS_APP_AFTER_SAVE_KEY = 'serpentFocusAppAfterSave';
export const REVEAL_IN_LIBRARY_AFTER_SAVE_KEY = 'serpentRevealInLibraryAfterSave';
export const DRAG_RADIAL_MENU_ENABLED_KEY = 'serpentDragRadialMenuEnabled';
export const SAVE_TARGET_KIND_KEY = 'serpentSaveTargetKind';

/** 右键与拖拽菜单的保存目标。合集模式会把文件放进资源库根目录再加入合集。 */
export type SaveTargetKind = 'folder' | 'collection';

/** Default on so first-time users still see save feedback. */
export function notificationsEnabledFromStored(value: unknown): boolean {
  return value !== false;
}

/** Default on so Serpent surfaces after a browser save. */
export function focusAppAfterSaveFromStored(value: unknown): boolean {
  return value !== false;
}

/** Default on so the saved asset is easy to find in the library. */
export function revealInLibraryAfterSaveFromStored(value: unknown): boolean {
  return value !== false;
}

/** Default on so the drag-save radial menu works out of the box. */
export function dragRadialMenuEnabledFromStored(value: unknown): boolean {
  return value !== false;
}

/** Default keeps the existing folder picker. */
export function saveTargetKindFromStored(value: unknown): SaveTargetKind {
  return value === 'collection' ? 'collection' : 'folder';
}

export type ExtensionSaveBehavior = {
  notificationsEnabled: boolean;
  focusAppAfterSave: boolean;
  revealInLibraryAfterSave: boolean;
};

export async function readExtensionSaveBehavior(): Promise<ExtensionSaveBehavior> {
  const values = await browser.storage.sync.get([
    NOTIFICATIONS_ENABLED_KEY,
    FOCUS_APP_AFTER_SAVE_KEY,
    REVEAL_IN_LIBRARY_AFTER_SAVE_KEY,
  ]);
  return {
    notificationsEnabled: notificationsEnabledFromStored(
      values[NOTIFICATIONS_ENABLED_KEY],
    ),
    focusAppAfterSave: focusAppAfterSaveFromStored(
      values[FOCUS_APP_AFTER_SAVE_KEY],
    ),
    revealInLibraryAfterSave: revealInLibraryAfterSaveFromStored(
      values[REVEAL_IN_LIBRARY_AFTER_SAVE_KEY],
    ),
  };
}

export function readNotificationsEnabled(): Promise<boolean> {
  return readExtensionSaveBehavior().then(
    (behavior) => behavior.notificationsEnabled,
  );
}

export async function writeNotificationsEnabled(enabled: boolean): Promise<void> {
  await browser.storage.sync.set({ [NOTIFICATIONS_ENABLED_KEY]: enabled });
}

export async function writeFocusAppAfterSave(enabled: boolean): Promise<void> {
  await browser.storage.sync.set({ [FOCUS_APP_AFTER_SAVE_KEY]: enabled });
}

export async function writeRevealInLibraryAfterSave(enabled: boolean): Promise<void> {
  await browser.storage.sync.set({ [REVEAL_IN_LIBRARY_AFTER_SAVE_KEY]: enabled });
}

export async function readDragRadialMenuEnabled(): Promise<boolean> {
  const values = await browser.storage.sync.get(DRAG_RADIAL_MENU_ENABLED_KEY);
  return dragRadialMenuEnabledFromStored(values[DRAG_RADIAL_MENU_ENABLED_KEY]);
}

export async function writeDragRadialMenuEnabled(enabled: boolean): Promise<void> {
  await browser.storage.sync.set({ [DRAG_RADIAL_MENU_ENABLED_KEY]: enabled });
}

export async function readSaveTargetKind(): Promise<SaveTargetKind> {
  const values = await browser.storage.sync.get(SAVE_TARGET_KIND_KEY);
  return saveTargetKindFromStored(values[SAVE_TARGET_KIND_KEY]);
}

export async function writeSaveTargetKind(kind: SaveTargetKind): Promise<void> {
  await browser.storage.sync.set({ [SAVE_TARGET_KIND_KEY]: kind });
}

export async function writePreferOriginalMedia(enabled: boolean): Promise<void> {
  await browser.storage.sync.set({ [PREFER_ORIGINAL_MEDIA_KEY]: enabled });
}

export function migratePreferOriginalMedia(
  storage: SyncStorageLike = browser.storage.sync,
): Promise<boolean> {
  return migratePreferOriginalMediaWithStorage(storage);
}

export function readPreferOriginalMedia(): Promise<boolean> {
  return migratePreferOriginalMedia();
}

export const BATCH_FORMATS = [
  'jpg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'mp4',
  'webm',
] as const;

export type BatchFormat = (typeof BATCH_FORMATS)[number];

export type BatchFilterSettings = {
  minEdge: number;
  formats: BatchFormat[];
};

export const DEFAULT_BATCH_FILTER: BatchFilterSettings = {
  minEdge: 200,
  formats: [...BATCH_FORMATS],
};

function isBatchFormat(value: string): value is BatchFormat {
  return (BATCH_FORMATS as readonly string[]).includes(value);
}

export function batchFilterFromStored(value: unknown): BatchFilterSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_BATCH_FILTER, formats: [...BATCH_FORMATS] };
  const minEdgeRaw = Reflect.get(value, 'minEdge');
  const formatsRaw = Reflect.get(value, 'formats');
  const minEdge = typeof minEdgeRaw === 'number' && Number.isFinite(minEdgeRaw)
    ? Math.max(0, Math.min(8000, Math.floor(minEdgeRaw)))
    : DEFAULT_BATCH_FILTER.minEdge;
  const formats = Array.isArray(formatsRaw)
    ? formatsRaw.filter((entry): entry is BatchFormat => typeof entry === 'string' && isBatchFormat(entry))
    : [...BATCH_FORMATS];
  return {
    minEdge,
    formats,
  };
}

export async function readBatchFilter(): Promise<BatchFilterSettings> {
  const values = await browser.storage.sync.get(BATCH_FILTER_KEY);
  return batchFilterFromStored(values[BATCH_FILTER_KEY]);
}

export async function writeBatchFilter(settings: BatchFilterSettings): Promise<void> {
  await browser.storage.sync.set({ [BATCH_FILTER_KEY]: settings });
}

export async function readBatchTarget(): Promise<BatchTargetState> {
  const values = await browser.storage.local.get(BATCH_TARGET_KEY);
  return batchTargetFromStored(values[BATCH_TARGET_KEY]);
}

export async function rememberBatchTarget(
  kind: SaveTargetKind,
  id: string | null,
): Promise<void> {
  const values = await browser.storage.local.get(BATCH_TARGET_KEY);
  const current = values[BATCH_TARGET_KEY];
  const base: Record<string, unknown> =
    current && typeof current === 'object'
      ? { ...(current as Record<string, unknown>) }
      : {};
  const key = kind === 'folder' ? 'folderId' : 'collectionId';
  await browser.storage.local.set({
    [BATCH_TARGET_KEY]: { ...base, [key]: id },
  });
}
