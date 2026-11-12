import browser from 'webextension-polyfill';

import {
  buildSaveMenuFolderHints,
  buildSaveMenuTree,
  folderMenuItemId,
  folderMenuSelfId,
  MENU_ROOT_PARENT_ID,
  parseFolderMenuId,
  pushRecentFolderId,
  RECENT_COLLECTION_IDS_KEY,
  RECENT_FOLDER_IDS_KEY,
  sortFoldersForSaveMenu,
  type ExtensionFolderOption,
  type SaveMenuTreeFolder,
} from './folder-menu';
import { saveMenuTitle } from './connection-ui';
import { installHotlinkRules } from './hotlink-sites';
import {
  readExtensionSaveBehavior,
  readPreferOriginalMedia,
  readSaveTargetKind,
  SAVE_TARGET_KIND_KEY,
  type SaveTargetKind,
  type ExtensionSaveBehavior,
} from './preferences';
import {
  deliverSaveUpload,
  fetchSerpentCollections,
  fetchSerpentFolders,
  notificationForOutcome,
  probeSerpentConnection,
  saveIntentFromContextMenu,
  saveMediaViaBrowser,
  MAX_BROWSER_FETCH_BYTES,
  type ExtensionCollectionOption,
  type FetchedMedia,
  type SaveOutcome,
  type PageBlobFetcher,
  type PageBridgeFetcher,
  type SaveExecutionOptions,
  type SaveIntent,
  type UserNotification,
} from './save-client';
import type { MediaCandidate, MediaSelection } from './media-resolution/types';
import { safePinterestPosterUrl } from './media-resolution/pinterest-video';
import {
  consumeSegmentedPreviewFallback,
  type SegmentedFallbackFinalState,
  type SegmentedPreviewFallbackIntent,
  type SegmentedRecoveryOutcome,
} from './media-resolution/segmented-preview-fallback';
import type { PageBridgeAdapter } from './media-resolution/page-bridge-data';
import {
  SEGMENTED_MEDIA_RECOVERY_ALARM,
  clearSegmentedMediaRecoveryAlarmWhenIdle,
  hasPendingSegmentedMediaTransfers,
  resumePendingSegmentedMediaTransfers,
  scheduleSegmentedMediaRecoveryAlarm,
} from './media-transfer';

interface SerpentContextMenuClickData {
  menuItemId: string | number;
  mediaType?: 'image' | 'video' | 'audio';
  pageUrl?: string;
  srcUrl?: string;
  frameId?: number;
  tab?: { id?: number };
}

const MENU_ROOT_ID = 'serpent-save';
const MENU_ROOT_FOLDER_ID = 'serpent-save-root';
const MENU_SEPARATOR_ID = 'serpent-save-sep';
const MENU_NOTICE_ID = 'serpent-save-notice';
const MENU_PAGE_ID = 'serpent-page';
const PAGE_MENU_ITEMS = [
  { id: 'serpent-page-batch', title: '批量收藏此页（Alt+1）' },
  { id: 'serpent-page-visible', title: '截取可见区域（Alt+3）' },
  { id: 'serpent-page-area', title: '截取区域（Alt+2）' },
  { id: 'serpent-page-element', title: '截取元件' },
  { id: 'serpent-page-full', title: '整页截图（Alt+4）' },
] as const;
const CONNECTION_ALARM = 'serpent-connection-check';
const ICON_SIZES = [32, 48, 64, 128] as const;

let notificationSequence = 0;
let connectionState: 'connected' | 'disconnected' = 'disconnected';
interface BatchSaveJob {
  readonly tabId: number;
  readonly frameId: number;
  readonly token: number;
  stopRequested: boolean;
  halted: boolean;
  haltMessage: string;
  commitTail: Promise<void>;
}
const batchSaveJobs = new Map<string, BatchSaveJob>();

class BatchCommitCancelled extends Error {
  constructor() {
    super('batch commit cancelled');
  }
}
let dynamicFolderMenuIds: string[] = [];
let pageActionsVisible = true;
let saveMenuVisible = true;
const SAVE_MENU_CONTEXTS = ['image', 'video', 'link'] as Array<
  'image' | 'video' | 'link'
>;
const CAPTURE_GAP_MS = 600;
let nextCaptureAt = 0;
let captureQueue: Promise<void> = Promise.resolve();
let folderMenuRefreshPromise: Promise<void> | null = null;
const SEGMENTED_PREVIEW_FALLBACK_KEY = 'serpent.segmentedPreviewFallbacks.v1';
const SEGMENTED_PREVIEW_FALLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SEGMENTED_PREVIEW_FALLBACK_RECORDS = 512;

type SegmentedPreviewFallbackState = SegmentedFallbackFinalState | 'claimed';
interface StoredSegmentedPreviewFallback {
  state: SegmentedPreviewFallbackState;
  updatedAt: number;
  notificationsEnabled: boolean;
  reason?: string;
}

const segmentedPreviewFallbacksInFlight = new Set<string>();
let segmentedPreviewFallbackStorageTail: Promise<void> = Promise.resolve();

async function readRecentFolderIds(): Promise<string[]> {
  const values = await browser.storage.local.get(RECENT_FOLDER_IDS_KEY);
  const stored = values[RECENT_FOLDER_IDS_KEY];
  return Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string') : [];
}

async function writeRecentFolderIds(recentFolderIds: string[]): Promise<void> {
  await browser.storage.local.set({ [RECENT_FOLDER_IDS_KEY]: recentFolderIds });
}

async function readRecentCollectionIds(): Promise<string[]> {
  const values = await browser.storage.local.get(RECENT_COLLECTION_IDS_KEY);
  const stored = values[RECENT_COLLECTION_IDS_KEY];
  return Array.isArray(stored) ? stored.filter((entry) => typeof entry === 'string') : [];
}

async function writeRecentCollectionIds(recentCollectionIds: string[]): Promise<void> {
  await browser.storage.local.set({ [RECENT_COLLECTION_IDS_KEY]: recentCollectionIds });
}

function collectionsAsFolderOptions(
  collections: readonly ExtensionCollectionOption[],
): ExtensionFolderOption[] {
  return collections.map((collection) => ({
    folderId: collection.collectionId,
    name: collection.name,
    relativePath: collection.relativePath,
    ...(collection.assetCount === undefined ? {} : { assetCount: collection.assetCount }),
  }));
}

async function createMenuItem(properties: {
  id: string;
  title?: string;
  contexts?: Array<'image' | 'video' | 'page' | 'selection' | 'link'>;
  parentId?: string;
  enabled?: boolean;
  type?: 'normal' | 'separator';
}): Promise<boolean> {
  try {
    await browser.contextMenus.create(properties);
    return true;
  } catch {
    // 重复 id，或父项已经不在。菜单重建不能把这次保存变成失败。
    return false;
  }
}

async function updateMenuItem(
  id: string,
  properties: { title?: string; enabled?: boolean; visible?: boolean },
): Promise<void> {
  try {
    await browser.contextMenus.update(id, properties);
  } catch {
    // 项已被移除或从未创建成功。下次重建会补上。
  }
}

/** Root context-menu title reflects connection so disabled state is obvious. */
function setToolbarIcon(connected: boolean): void {
  const suffix = connected ? '' : '-gray';
  const path: Record<string, string> = {};
  for (const size of ICON_SIZES) {
    path[String(size)] = `icons/icon${suffix}-${size}.png`;
  }
  void browser.action.setIcon({ path }).catch(() => {});
  void browser.action.setTitle({
    title: connected
      ? 'Serpent 已连接'
      : 'Serpent 未连接，请启动桌面应用并打开资源库',
  }).catch(() => {});
}

async function removeMenuItem(id: string): Promise<void> {
  try {
    await browser.contextMenus.remove(id);
  } catch {
    // 项已经不在菜单里。
  }
}

async function createTrackedMenuItem(
  properties: {
    id: string;
    title?: string;
    contexts?: Array<'image' | 'video' | 'page' | 'selection' | 'link'>;
    parentId?: string;
    enabled?: boolean;
    type?: 'normal' | 'separator';
  },
  createdIds: Set<string>,
): Promise<boolean> {
  if (createdIds.has(properties.id)) return false;
  const created = await createMenuItem(properties);
  if (!created) return false;
  dynamicFolderMenuIds.push(properties.id);
  createdIds.add(properties.id);
  return true;
}

async function removeDynamicFolderMenus(): Promise<void> {
  const ids = [...dynamicFolderMenuIds];
  dynamicFolderMenuIds = [];
  for (const id of ids) {
    await removeMenuItem(id);
  }
}

function pageActionMessage(
  menuItemId: string | number,
): Record<string, unknown> | null {
  switch (menuItemId) {
    case 'serpent-page-batch':
      return { type: 'serpent-open-batch' };
    case 'serpent-page-visible':
      return { type: 'serpent-start-capture', mode: 'visible' };
    case 'serpent-page-area':
      return { type: 'serpent-start-capture', mode: 'area' };
    case 'serpent-page-element':
      return { type: 'serpent-start-capture', mode: 'element' };
    case 'serpent-page-full':
      return { type: 'serpent-start-capture', mode: 'page' };
    default:
      return null;
  }
}

async function createStaticMenus(): Promise<void> {
  const connected = connectionState === 'connected';
  await createMenuItem({
    id: MENU_ROOT_ID,
    title: saveMenuTitle(connected),
    contexts: SAVE_MENU_CONTEXTS,
    enabled: connected,
  });
  await createMenuItem({
    id: MENU_PAGE_ID,
    title: 'Serpent',
    contexts: ['page', 'image', 'video'],
  });
  for (const item of PAGE_MENU_ITEMS) {
    await createMenuItem({
      id: item.id,
      parentId: MENU_PAGE_ID,
      title: item.title,
      contexts: ['page', 'image', 'video'],
    });
  }
  pageActionsVisible = true;
  saveMenuVisible = true;
}

/** 采集菜单出现在空白处和图像、视频上；链接、选区、输入框除外。 */
function pageActionsBelong(contexts: readonly string[]): boolean {
  if (contexts.includes('image') || contexts.includes('video')) return true;
  return !contexts.some((context) => (
    context === 'audio'
    || context === 'link'
    || context === 'selection'
    || context === 'editable'
  ));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isCaptureQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
}

/** Chrome 限制 captureVisibleTab 每秒 2 次。整页截图必须串行并留出间隔。 */
async function captureVisibleTabPaced(windowId: number): Promise<string> {
  const run = async (): Promise<string> => {
    const waitFor = nextCaptureAt - Date.now();
    if (waitFor > 0) await delay(waitFor);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
        nextCaptureAt = Date.now() + CAPTURE_GAP_MS;
        return dataUrl;
      } catch (error) {
        nextCaptureAt = Date.now() + (isCaptureQuotaError(error) ? 1000 : CAPTURE_GAP_MS);
        if (!isCaptureQuotaError(error) || attempt === 1) throw error;
        await delay(1000);
      }
    }
    throw new Error('无法截取可见区域');
  };
  const scheduled = captureQueue.then(run);
  captureQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

function storedSelection(
  value: unknown,
  kind: 'image' | 'video',
  previewUrl: string,
  frameId?: number,
): MediaSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const selectionKind = Reflect.get(value, 'kind');
  const selectionId = Reflect.get(value, 'selectionId');
  const documentId = Reflect.get(value, 'documentId');
  const selectionPreview = Reflect.get(value, 'previewUrl');
  const pageUrl = Reflect.get(value, 'pageUrl');
  const candidatesRaw = Reflect.get(value, 'candidates');
  if (
    selectionKind !== kind ||
    typeof selectionId !== 'string' ||
    typeof documentId !== 'string' ||
    selectionPreview !== previewUrl ||
    typeof pageUrl !== 'string' ||
    !Array.isArray(candidatesRaw)
  ) return undefined;

  const candidateList: MediaCandidate[] = candidatesRaw.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const url = Reflect.get(candidate, 'url');
    const candidateKind = Reflect.get(candidate, 'kind');
    const source = Reflect.get(candidate, 'source');
    if (
      typeof url !== 'string' ||
      (candidateKind !== 'image' && candidateKind !== 'video') ||
      candidateKind !== kind ||
      !['site-field', 'srcset', 'known-transform', 'structured-data', 'page-bridge', 'preview'].includes(String(source))
    ) return [];
    if (source !== 'preview') {
      try {
        const protocol = new URL(url).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') return [];
      } catch {
        return [];
      }
    }
    const contentId = Reflect.get(candidate, 'contentId');
    const mediaKey = Reflect.get(candidate, 'mediaKey');
    const mediaIndex = Reflect.get(candidate, 'mediaIndex');
    const width = Reflect.get(candidate, 'width');
    const height = Reflect.get(candidate, 'height');
    return [{
      url,
      kind,
      source: source as MediaCandidate['source'],
      ...(typeof contentId === 'string' ? { contentId } : {}),
      ...(typeof mediaKey === 'string' && /^\d+_\d{1,32}$/.test(mediaKey) ? { mediaKey } : {}),
      ...(typeof mediaIndex === 'number' && Number.isSafeInteger(mediaIndex) ? { mediaIndex } : {}),
      ...(typeof width === 'number' && Number.isFinite(width) ? { width } : {}),
      ...(typeof height === 'number' && Number.isFinite(height) ? { height } : {}),
    }];
  });
  if (!candidateList.some((candidate) => candidate.source === 'preview' && candidate.url === previewUrl)) {
    candidateList.push({ url: previewUrl, kind, source: 'preview' });
  }

  const detailPageUrl = Reflect.get(value, 'detailPageUrl');
  const contentId = Reflect.get(value, 'contentId');
  const mediaKey = Reflect.get(value, 'mediaKey');
  const mediaIndex = Reflect.get(value, 'mediaIndex');
  const previewWidth = Reflect.get(value, 'previewWidth');
  const previewHeight = Reflect.get(value, 'previewHeight');
  const siteAdapter = Reflect.get(value, 'siteAdapter');
  const posterUrl = siteAdapter === 'pinterest'
    ? safePinterestPosterUrl(Reflect.get(value, 'posterUrl'))
    : undefined;
  const siteCapability = Reflect.get(value, 'siteCapability');
  const evidence = Reflect.get(value, 'evidence');
  return {
    selectionId,
    documentId,
    ...(frameId === undefined ? {} : { frameId }),
    kind,
    previewUrl,
    pageUrl,
    ...(typeof detailPageUrl === 'string' ? { detailPageUrl } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(typeof contentId === 'string' ? { contentId } : {}),
    ...(typeof mediaKey === 'string' && /^\d+_\d{1,32}$/.test(mediaKey) ? { mediaKey } : {}),
    ...(typeof mediaIndex === 'number' && Number.isSafeInteger(mediaIndex) ? { mediaIndex } : {}),
    ...(typeof previewWidth === 'number' && Number.isFinite(previewWidth) ? { previewWidth } : {}),
    ...(typeof previewHeight === 'number' && Number.isFinite(previewHeight) ? { previewHeight } : {}),
    ...(typeof siteAdapter === 'string' ? { siteAdapter: siteAdapter as MediaSelection['siteAdapter'] } : {}),
    ...(typeof siteCapability === 'string' ? { siteCapability: siteCapability as MediaSelection['siteCapability'] } : {}),
    candidates: candidateList,
    ...(evidence && typeof evidence === 'object' ? { evidence: evidence as MediaSelection['evidence'] } : {}),
  };
}

function storedContextMedia(value: unknown, frameId?: number): {
  kind: 'image' | 'video';
  mediaUrl: string;
  selection: MediaSelection;
} | null {
  if (!value || typeof value !== 'object') return null;
  const kind = Reflect.get(value, 'kind');
  const mediaUrl = Reflect.get(value, 'mediaUrl');
  if ((kind !== 'image' && kind !== 'video') || typeof mediaUrl !== 'string' || !mediaUrl) {
    return null;
  }
  const rawSelection = Reflect.get(value, 'selection');
  const selection = storedSelection(rawSelection, kind, mediaUrl, frameId);
  if (!selection) return null;
  return { kind, mediaUrl, selection };
}

function pageBridgeAdapterForSelection(selection: MediaSelection): PageBridgeAdapter | undefined {
  if (selection.siteCapability !== 'page-bridge') return undefined;
  const adapter = selection.siteAdapter;
  if (adapter === 'x' && selection.kind === 'video') return 'x-status-media';
  return selection.kind === 'image' && (
    adapter === 'google-images' || adapter === 'duckduckgo-images' || adapter === 'yandex-images'
  ) ? adapter : undefined;
}

function pageBridgeFetcherForFrame(tabId: number, frameId: number): PageBridgeFetcher {
  return async (selection) => {
    const adapter = pageBridgeAdapterForSelection(selection);
    if (
      !adapter || !selection.contentId ||
      selection.previewUrl.length > 4_096 || selection.pageUrl.length > 4_096
    ) return [];
    const selectedContentId = selection.contentId;
    const response = await browser.tabs.sendMessage(tabId, {
      type: 'serpent-page-bridge-candidates',
      adapter,
      contentId: selection.contentId,
      previewUrl: selection.previewUrl,
      pageUrl: selection.pageUrl,
      kind: selection.kind,
      ...(selection.mediaIndex === undefined ? {} : { mediaIndex: selection.mediaIndex }),
      ...(selection.mediaKey ? { mediaKey: selection.mediaKey } : {}),
    }, { frameId }).catch(() => null);
    const rawCandidates = response && typeof response === 'object'
      ? Reflect.get(response, 'candidates')
      : undefined;
    if (!Array.isArray(rawCandidates)) return [];
    return rawCandidates.slice(0, 8).flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const url = Reflect.get(candidate, 'url');
      const contentId = Reflect.get(candidate, 'contentId');
      const kind = Reflect.get(candidate, 'kind');
      const mediaIndex = Reflect.get(candidate, 'mediaIndex');
      if (
        typeof url !== 'string' || contentId !== selectedContentId || url === selection.previewUrl ||
        kind !== selection.kind || (selection.mediaIndex !== undefined && mediaIndex !== selection.mediaIndex)
      ) return [];
      try {
        const parsed = new URL(url);
        if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return [];
      } catch { return []; }
      return [{ url, contentId: selectedContentId, kind: selection.kind, ...(typeof mediaIndex === 'number' ? { mediaIndex } : {}) }];
    });
  };
}

async function linkClickHasMedia(tabId: number | undefined, frameUrl?: string): Promise<boolean> {
  if (tabId == null) return false;
  const media = await browser.tabs.sendMessage(tabId, {
    type: 'serpent-context-media',
    checkOnly: true,
    ...(frameUrl ? { pageUrl: frameUrl } : {}),
  }).catch(() => null);
  return storedContextMedia(media) !== null;
}

async function contextMediaForEvent(info: SerpentContextMenuClickData): Promise<{
  kind: 'image' | 'video';
  mediaUrl: string;
  selection: MediaSelection;
} | null> {
  const tabId = info.tab?.id;
  if (tabId == null || info.frameId === undefined || typeof info.srcUrl !== 'string') return null;
  const value = await browser.tabs.sendMessage(
    tabId,
    {
      type: 'serpent-context-media',
      srcUrl: info.srcUrl,
      pageUrl: info.pageUrl,
    },
    { frameId: info.frameId },
  ).catch(() => null);
  const media = storedContextMedia(value, info.frameId);
  if (!media || media.mediaUrl !== info.srcUrl) return null;
  if (typeof info.pageUrl === 'string' && media.selection.pageUrl !== info.pageUrl) return null;
  return media;
}

function refreshOpenContextMenu(): void {
  const menus = browser.contextMenus as typeof browser.contextMenus & {
    refresh?: () => Promise<void>;
  };
  void menus.refresh?.();
}

async function syncSaveMenuEnabled(connected: boolean): Promise<void> {
  await updateMenuItem(MENU_ROOT_ID, {
    title: saveMenuTitle(connected),
    enabled: connected,
  });
  for (const id of dynamicFolderMenuIds) {
    await updateMenuItem(id, { enabled: connected });
  }
}

async function installMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  await createStaticMenus();
}

/** 创建文件夹菜单项并递归展开其子级（右键菜单的层级树）。 */
async function createFolderSubmenu(
  parentId: string,
  folder: SaveMenuTreeFolder,
  selfTitle: string,
  createdIds: Set<string>,
): Promise<void> {
  const id = folderMenuItemId(folder);
  if (createdIds.has(id)) return;
  const created = await createTrackedMenuItem({
    id,
    parentId,
    title: folder.name,
    contexts: SAVE_MENU_CONTEXTS,
    enabled: true,
  }, createdIds);
  if (!created) return;
  if (folder.children.length > 0 && folder.folderId !== null) {
    // contextMenus 父项点击只展开不保存；子菜单第一行提供保存到当前节点
    // （对齐拖拽树「松开 = 保存进该文件夹/合集」）。
    const selfId = folderMenuSelfId(folder.folderId);
    await createTrackedMenuItem({
      id: selfId,
      parentId: id,
      title: selfTitle,
      contexts: SAVE_MENU_CONTEXTS,
      enabled: true,
    }, createdIds);
  }
  for (const child of folder.children) {
    await createFolderSubmenu(id, child, selfTitle, createdIds);
  }
}

async function createNoticeMenuItem(title: string, createdIds: Set<string>): Promise<void> {
  await createTrackedMenuItem({
    id: MENU_NOTICE_ID,
    parentId: MENU_ROOT_ID,
    title,
    contexts: SAVE_MENU_CONTEXTS,
    enabled: false,
  }, createdIds);
}

async function listSaveTargets(kind: SaveTargetKind): Promise<
  | {
      kind: 'ok';
      folders: ExtensionFolderOption[];
      recentIds: string[];
      browsedIds: string[];
      libraryDisplayName: string;
    }
  | { kind: 'rejected' | 'unreachable' }
> {
  if (kind === 'collection') {
    const outcome = await fetchSerpentCollections();
    if (outcome.kind !== 'ok') return { kind: outcome.kind };
    return {
      kind: 'ok',
      folders: collectionsAsFolderOptions(outcome.collections),
      recentIds: await readRecentCollectionIds(),
      browsedIds: [],
      libraryDisplayName: outcome.libraryDisplayName,
    };
  }

  const outcome = await fetchSerpentFolders();
  if (outcome.kind !== 'ok') return { kind: outcome.kind };
  return {
    kind: 'ok',
    folders: outcome.folders,
    recentIds: await readRecentFolderIds(),
    browsedIds: outcome.recentBrowsedFolderIds,
    libraryDisplayName: outcome.libraryDisplayName,
  };
}

async function refreshFolderMenus(): Promise<void> {
  if (folderMenuRefreshPromise) return folderMenuRefreshPromise;

  folderMenuRefreshPromise = (async () => {
    const connected = connectionState === 'connected';
    await syncSaveMenuEnabled(connected);
    const createdIds = new Set<string>();

    if (!connected) {
      await removeDynamicFolderMenus();
      return;
    }

    const saveTargetKind = await readSaveTargetKind();
    const listed = await listSaveTargets(saveTargetKind);
    if (listed.kind !== 'ok') {
      await removeDynamicFolderMenus();
      if (saveTargetKind === 'collection') {
        await createNoticeMenuItem('无法读取合集', createdIds);
      }
      return;
    }

    await removeDynamicFolderMenus();

    const hints = buildSaveMenuFolderHints(
      listed.folders,
      listed.recentIds,
      listed.browsedIds,
    );
    const selfTitle = saveTargetKind === 'collection' ? '保存到此合集' : '保存到此文件夹';
    const tree = buildSaveMenuTree(listed.folders, hints);
    if (saveTargetKind === 'collection' && tree.length === 0) {
      await createNoticeMenuItem('尚无合集', createdIds);
      return;
    }

    // 文件夹模式与拖拽树一致：最近保存/浏览 → 分割线 → 根目录 → 所有一级目录。
    // 合集模式没有「只保存到根目录」项：选中合集后文件进根目录并加入该合集。
    let rootParentCreated = false;
    const createRootParentMenu = async (): Promise<void> => {
      if (saveTargetKind !== 'folder' || rootParentCreated) return;
      rootParentCreated = true;
      const parentCreated = await createTrackedMenuItem({
        id: MENU_ROOT_PARENT_ID,
        parentId: MENU_ROOT_ID,
        title: '根目录',
        contexts: SAVE_MENU_CONTEXTS,
        enabled: true,
      }, createdIds);
      if (!parentCreated) return;
      await createTrackedMenuItem({
        id: MENU_ROOT_FOLDER_ID,
        parentId: MENU_ROOT_PARENT_ID,
        title: '保存至此',
        contexts: SAVE_MENU_CONTEXTS,
        enabled: true,
      }, createdIds);
    };

    let separatorCreated = false;
    for (const item of tree) {
      if (item.kind === 'separator') {
        if (separatorCreated) continue;
        separatorCreated = true;
        await createTrackedMenuItem({
          id: MENU_SEPARATOR_ID,
          type: 'separator',
          parentId: MENU_ROOT_ID,
          contexts: SAVE_MENU_CONTEXTS,
        }, createdIds);
        await createRootParentMenu();
        continue;
      }
      await createFolderSubmenu(MENU_ROOT_ID, item.folder, selfTitle, createdIds);
    }
    if (!rootParentCreated) {
      await createRootParentMenu();
    }
  })().finally(() => {
    folderMenuRefreshPromise = null;
  });

  return folderMenuRefreshPromise;
}

async function refreshConnectionState(): Promise<void> {
  const outcome = await probeSerpentConnection();
  const nextState = outcome.kind === 'connected' ? 'connected' : 'disconnected';
  connectionState = nextState;
  setToolbarIcon(nextState === 'connected');
  await refreshFolderMenus();
}

/**
 * Fast path for content-script probes: ping only, then reply.
 * Folder contextMenus rebuild is deferred — awaiting it here made
 * `serpent-connection-status` miss sendResponse on large libraries
 * (message port closed → drag menu always showed 未连接 while the
 * toolbar icon was already bright). Serpent-a8mm.
 */
async function probeAndReplyConnectionState(): Promise<'connected' | 'disconnected'> {
  const outcome = await probeSerpentConnection();
  const nextState = outcome.kind === 'connected' ? 'connected' : 'disconnected';
  connectionState = nextState;
  setToolbarIcon(nextState === 'connected');
  void refreshFolderMenus();
  return nextState;
}

function scheduleConnectionChecks(): void {
  void browser.alarms.create(CONNECTION_ALARM, { periodInMinutes: 0.5 });
  void refreshConnectionState();
}

/** 启动/安装路径统一入口：先建菜单，再注册防盗链 Referer 规则，最后开始连接检查。 */
async function bootstrapExtension(): Promise<void> {
  await installMenus();
  await installHotlinkRules();
  scheduleConnectionChecks();
  void recoverSegmentedMediaTransfers();
}

function isFallbackRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseStoredSegmentedPreviewFallbacks(value: unknown): Record<string, StoredSegmentedPreviewFallback> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const records: Record<string, StoredSegmentedPreviewFallback> = {};
  for (const [requestId, raw] of Object.entries(value)) {
    if (!isFallbackRequestId(requestId) || !raw || typeof raw !== 'object') continue;
    const state = Reflect.get(raw, 'state');
    const updatedAt = Reflect.get(raw, 'updatedAt');
    const notificationsEnabled = Reflect.get(raw, 'notificationsEnabled');
    const reason = Reflect.get(raw, 'reason');
    if (
      !['claimed', 'saved', 'pending', 'failed', 'unknown'].includes(String(state))
      || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)
      || typeof notificationsEnabled !== 'boolean'
    ) continue;
    records[requestId] = {
      state: state as SegmentedPreviewFallbackState,
      updatedAt,
      notificationsEnabled,
      ...(typeof reason === 'string' ? { reason: reason.slice(0, 240) } : {}),
    };
  }
  return records;
}

async function updateStoredSegmentedPreviewFallbacks<T>(
  update: (records: Record<string, StoredSegmentedPreviewFallback>) => T,
): Promise<T> {
  const operation = segmentedPreviewFallbackStorageTail.then(async () => {
    const stored = await browser.storage.local.get(SEGMENTED_PREVIEW_FALLBACK_KEY);
    const records = parseStoredSegmentedPreviewFallbacks(stored[SEGMENTED_PREVIEW_FALLBACK_KEY]);
    const result = update(records);
    const expiration = Date.now() - SEGMENTED_PREVIEW_FALLBACK_TTL_MS;
    for (const [requestId, record] of Object.entries(records)) {
      if (record.updatedAt < expiration && record.state !== 'claimed') delete records[requestId];
    }
    const ordered = Object.entries(records).sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    for (const [requestId, record] of ordered) {
      if (Object.keys(records).length <= MAX_SEGMENTED_PREVIEW_FALLBACK_RECORDS) break;
      if (record.state !== 'claimed') delete records[requestId];
    }
    await browser.storage.local.set({ [SEGMENTED_PREVIEW_FALLBACK_KEY]: records });
    return result;
  });
  segmentedPreviewFallbackStorageTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function claimSegmentedPreviewFallback(
  requestId: string,
  behavior: ExtensionSaveBehavior,
): Promise<'claimed' | 'duplicate' | 'unavailable'> {
  if (!isFallbackRequestId(requestId)) return 'unavailable';
  if (segmentedPreviewFallbacksInFlight.has(requestId)) return 'duplicate';
  segmentedPreviewFallbacksInFlight.add(requestId);
  try {
    const claimed = await updateStoredSegmentedPreviewFallbacks((records) => {
      if (Object.hasOwn(records, requestId)) return false;
      records[requestId] = {
        state: 'claimed',
        updatedAt: Date.now(),
        notificationsEnabled: behavior.notificationsEnabled,
      };
      return true;
    });
    if (claimed) return 'claimed';
    segmentedPreviewFallbacksInFlight.delete(requestId);
    return 'duplicate';
  } catch {
    segmentedPreviewFallbacksInFlight.delete(requestId);
    return 'unavailable';
  }
}

async function finishSegmentedPreviewFallback(
  requestId: string,
  state: SegmentedFallbackFinalState,
  reason: string | undefined,
  behavior: ExtensionSaveBehavior,
): Promise<void> {
  try {
    await updateStoredSegmentedPreviewFallbacks((records) => {
      if (!Object.hasOwn(records, requestId)) return;
      records[requestId] = {
        state,
        updatedAt: Date.now(),
        notificationsEnabled: behavior.notificationsEnabled,
        ...(reason ? { reason: reason.slice(0, 240) } : {}),
      };
    });
  } finally {
    segmentedPreviewFallbacksInFlight.delete(requestId);
  }
}

async function settleAbandonedSegmentedPreviewFallbacks(): Promise<void> {
  const abandoned = await updateStoredSegmentedPreviewFallbacks((records) => {
    const pending: Array<{ notificationsEnabled: boolean }> = [];
    for (const [requestId, record] of Object.entries(records)) {
      if (record.state !== 'claimed' || segmentedPreviewFallbacksInFlight.has(requestId)) continue;
      record.state = 'unknown';
      record.updatedAt = Date.now();
      record.reason = '预览回退任务中断，结果未确认；为避免重复导入，扩展不会自动重试。';
      pending.push({ notificationsEnabled: record.notificationsEnabled });
    }
    return pending;
  });
  for (const record of abandoned) {
    showNotification({
      title: '预览回退结果未确认',
      message: '预览回退任务中断，扩展不会自动重试。请检查 Serpent 资源库后再决定是否手动保存。',
    }, record.notificationsEnabled);
  }
}

async function consumeSegmentedRecoveryOutcome(
  outcome: SegmentedRecoveryOutcome,
  handledSourceFailures: Set<string>,
): Promise<void> {
  if (outcome.state !== 'source-failed' || !outcome.fallbackIntent) return;
  handledSourceFailures.add(outcome.requestId);
  const fallbackIntent: SegmentedPreviewFallbackIntent = outcome.fallbackIntent;
  const consumed = await consumeSegmentedPreviewFallback(outcome, {
    claim: claimSegmentedPreviewFallback,
    save: (intent, behavior) => saveMediaViaBrowser(intent, behavior),
    finish: finishSegmentedPreviewFallback,
  });
  if (consumed.kind === 'handled') {
    const notification = consumed.state === 'unknown'
      ? {
          title: '预览回退结果未确认',
          message: consumed.reason || '为避免重复导入，扩展不会自动重试。请检查 Serpent 资源库。',
        }
      : consumed.outcome
        ? notificationForOutcome(consumed.outcome)
        : { title: '预览回退失败', message: consumed.reason || '无法保存当前预览。' };
    showNotification(notification, consumed.intent.behavior.notificationsEnabled);
  } else if (consumed.kind === 'ineligible') {
    showNotification({ title: '视频恢复失败', message: consumed.reason }, fallbackIntent.behavior.notificationsEnabled);
  }
}

async function recoverSegmentedMediaTransfers(): Promise<void> {
  try {
    await settleAbandonedSegmentedPreviewFallbacks();
    if (!(await hasPendingSegmentedMediaTransfers())) {
      await clearSegmentedMediaRecoveryAlarmWhenIdle();
      return;
    }
    await scheduleSegmentedMediaRecoveryAlarm();
    const handledSourceFailures = new Set<string>();
    const outcomes = await resumePendingSegmentedMediaTransfers({
      onOutcome: (outcome) => consumeSegmentedRecoveryOutcome(outcome, handledSourceFailures),
    });
    for (const outcome of outcomes) {
      if (handledSourceFailures.has(outcome.requestId)) continue;
      showNotification(outcome.state === 'saved'
        ? outcome.duplicate
          ? notificationForOutcome({ kind: 'accepted', duplicate: true })
          : { title: '已恢复视频保存', message: '分段传输已完成并导入资源库。' }
        : { title: '视频恢复失败', message: outcome.reason || '分段传输无法恢复。' });
    }
  } catch {
    // Preserve the journal and let the periodic alarm retry after transient worker/network errors.
    await scheduleSegmentedMediaRecoveryAlarm().catch(() => {});
  }
}

function showNotification(notification: UserNotification, notificationsEnabledSnapshot?: boolean): void {
  const enabled = notificationsEnabledSnapshot === undefined
    ? readExtensionSaveBehavior().then((behavior) => behavior.notificationsEnabled)
    : Promise.resolve(notificationsEnabledSnapshot);
  void enabled.then((notificationsEnabled) => {
    if (!notificationsEnabled) return;
    notificationSequence += 1;
    void browser.notifications.create(
      `serpent-save-${Date.now()}-${notificationSequence}`,
      {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: notification.title,
        message: notification.message,
      },
    ).catch(() => {});
  });
}

async function rememberRecentFolder(
  targetFolderId: string | null,
  folders: readonly ExtensionFolderOption[],
): Promise<void> {
  const validFolderIds = new Set(folders.map((folder) => folder.folderId));
  const recentFolderIds = await readRecentFolderIds();
  await writeRecentFolderIds(
    pushRecentFolderId(recentFolderIds, targetFolderId, validFolderIds),
  );
}

async function resolveSaveIntent(
  intent: SaveIntent,
  snapshot?: { targetKind?: SaveTargetKind; preferOriginalMedia?: boolean },
): Promise<SaveIntent | UserNotification> {
  const [kind, preferOriginalMedia] = await Promise.all([
    snapshot?.targetKind ? Promise.resolve(snapshot.targetKind) : readSaveTargetKind(),
    snapshot?.preferOriginalMedia === undefined
      ? readPreferOriginalMedia()
      : Promise.resolve(snapshot.preferOriginalMedia),
  ]);
  const base = {
    kind: intent.kind,
    sourcePageUrl: intent.sourcePageUrl,
    mediaUrl: intent.mediaUrl,
    preferOriginalMedia,
    ...(intent.selection ? { selection: intent.selection } : {}),
  };
  if (kind === 'folder') {
    return {
      ...base,
      ...(intent.targetFolderId !== undefined
        ? { targetFolderId: intent.targetFolderId }
        : {}),
    };
  }

  const collectionId =
    typeof intent.targetCollectionId === 'string' && intent.targetCollectionId
      ? intent.targetCollectionId
      : typeof intent.targetFolderId === 'string' && intent.targetFolderId
        ? intent.targetFolderId
        : undefined;
  if (!collectionId) {
    return {
      title: '无法保存到 Serpent',
      message: '当前为保存到合集，请选择一个合集。',
    };
  }
  return {
    ...base,
    targetFolderId: null,
    targetCollectionId: collectionId,
  };
}

interface PageBlobPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(callback: (message: unknown) => void): void };
  onDisconnect: { addListener(callback: () => void): void };
}

function readPageBlobInFrame(
  tabId: number,
  frameId: number,
  mediaUrl: string,
  intent: SaveIntent,
): Promise<{ body: ArrayBuffer; contentType: string } | { error: string }> {
  const selection = intent.selection;
  if (
    !selection || selection.previewUrl !== mediaUrl || selection.pageUrl !== intent.sourcePageUrl ||
    !mediaUrl.startsWith('blob:') || selection.frameId !== frameId
  ) return Promise.resolve({ error: 'page blob context does not match the selected frame' });

  let port: PageBlobPort;
  try {
    port = browser.tabs.connect(tabId, {
      name: 'serpent-page-blob-read',
      frameId,
    }) as unknown as PageBlobPort;
  } catch {
    return Promise.resolve({ error: 'selected page frame is unavailable' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let output: Uint8Array | undefined;
    let contentType = 'application/octet-stream';
    let expectedSeq = 0;
    let offset = 0;
    const finish = (result: { body: ArrayBuffer; contentType: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* The source frame may already have closed. */ }
      resolve(result);
    };
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      const type = Reflect.get(message, 'type');
      if (type === 'serpent-page-blob-error') {
        const reason = Reflect.get(message, 'reason');
        finish({ error: typeof reason === 'string' ? reason.slice(0, 200) : 'page blob read failed' });
        return;
      }
      if (type === 'serpent-page-blob-meta') {
        const size = Reflect.get(message, 'size');
        const mime = Reflect.get(message, 'contentType');
        if (
          output || typeof size !== 'number' || !Number.isSafeInteger(size) ||
          size <= 0 || size > MAX_BROWSER_FETCH_BYTES
        ) {
          finish({ error: 'page blob size is invalid or exceeds 500 MiB' });
          return;
        }
        output = new Uint8Array(size);
        if (typeof mime === 'string' && mime.length <= 200) contentType = mime;
        return;
      }
      if (type === 'serpent-page-blob-chunk') {
        const seq = Reflect.get(message, 'seq');
        const size = Reflect.get(message, 'size');
        const data = Reflect.get(message, 'data');
        if (
          !output || seq !== expectedSeq || typeof seq !== 'number' ||
          typeof size !== 'number' || !Number.isSafeInteger(size) ||
          size <= 0 || size > 64 * 1024 || typeof data !== 'string' ||
          data.length > 90_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
        ) {
          finish({ error: 'page blob chunk is invalid' });
          return;
        }
        let decoded: string;
        try {
          decoded = atob(data);
        } catch {
          finish({ error: 'page blob chunk encoding is invalid' });
          return;
        }
        if (decoded.length !== size || offset + size > output.length) {
          finish({ error: 'page blob chunk length is invalid' });
          return;
        }
        for (let index = 0; index < size; index += 1) output[offset + index] = decoded.charCodeAt(index);
        offset += size;
        expectedSeq += 1;
        port.postMessage({ type: 'serpent-page-blob-ack', seq });
        return;
      }
      if (type === 'serpent-page-blob-done') {
        const chunks = Reflect.get(message, 'chunks');
        const size = Reflect.get(message, 'size');
        if (!output || chunks !== expectedSeq || size !== offset || offset !== output.length) {
          finish({ error: 'page blob transfer ended before all bytes arrived' });
          return;
        }
        finish({ body: output.buffer as ArrayBuffer, contentType });
      }
    });
    port.onDisconnect.addListener(() => {
      finish({ error: 'selected page frame disconnected during blob read' });
    });
    port.postMessage({
      type: 'serpent-page-blob-read',
      url: mediaUrl,
      pageUrl: selection.pageUrl,
    });
  });
}

async function saveIntentAndNotify(
  intent: SaveIntent,
  options?: {
    quiet?: boolean;
    settle?: boolean;
    targetKind?: SaveTargetKind;
    preferOriginalMedia?: boolean;
    behaviorSnapshot?: ExtensionSaveBehavior;
  },
  pageContext?: { tabId?: number; frameId?: number },
  outcomeSink?: { value: SaveOutcome | null },
  execution?: SaveExecutionOptions,
): Promise<UserNotification> {
  if (outcomeSink) outcomeSink.value = null;
  const resolved = await resolveSaveIntent(intent, options);
  if ('title' in resolved) {
    if (!options?.quiet) showNotification(resolved);
    return resolved;
  }

  const behavior = options?.behaviorSnapshot ?? await readExtensionSaveBehavior();
  const keepDesktopFollowup = !options?.quiet || options.settle === true;
  const effective = keepDesktopFollowup
    ? behavior
    : { ...behavior, focusAppAfterSave: false, revealInLibraryAfterSave: false };
  const blobTabId = pageContext?.tabId;
  const blobFrameId = pageContext?.frameId;
  const pageBlobFetcher: PageBlobFetcher | undefined =
    blobTabId !== undefined && blobFrameId !== undefined
      ? (mediaUrl, blobIntent) => readPageBlobInFrame(blobTabId, blobFrameId, mediaUrl, blobIntent)
      : undefined;
  const pageBridgeFetcher = blobTabId !== undefined && blobFrameId !== undefined
    ? pageBridgeFetcherForFrame(blobTabId, blobFrameId)
    : undefined;
  const outcome = await saveMediaViaBrowser(
    resolved, effective, fetch, pageBlobFetcher, pageBridgeFetcher, undefined, execution,
  );
  if (outcomeSink) outcomeSink.value = outcome;
  if (outcome.kind === 'accepted' && keepDesktopFollowup) {
    if (resolved.targetCollectionId) {
      const collectionsOutcome = await fetchSerpentCollections();
      if (collectionsOutcome.kind === 'ok') {
        const recentCollectionIds = await readRecentCollectionIds();
        await writeRecentCollectionIds(
          pushRecentFolderId(
            recentCollectionIds,
            resolved.targetCollectionId,
            new Set(collectionsOutcome.collections.map((collection) => collection.collectionId)),
          ),
        );
        await refreshFolderMenus().catch(() => {});
      }
    } else {
      const foldersOutcome = await fetchSerpentFolders();
      if (foldersOutcome.kind === 'ok') {
        const folderId =
          typeof resolved.targetFolderId === 'string' ? resolved.targetFolderId : null;
        await rememberRecentFolder(folderId, foldersOutcome.folders);
        await refreshFolderMenus().catch(() => {});
      }
    }
  }
  const notification = notificationForOutcome(outcome);
  if (!options?.quiet) showNotification(notification);
  return notification;
}

function arrayBufferFromDataUrl(dataUrl: string): { contentType: string; body: ArrayBuffer } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match?.[2]) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { contentType: match[1] || 'image/png', body: bytes.buffer };
}

async function savePngDataUrl(
  dataUrl: string,
  filename: string,
  sourcePageUrl: string,
  targetFolderId: string | null | undefined,
  targetCollectionId: string | undefined,
): Promise<UserNotification> {
  const decoded = arrayBufferFromDataUrl(dataUrl);
  if (!decoded) {
    const notification = { title: '无法保存截图', message: '截图数据无效。' };
    showNotification(notification);
    return notification;
  }
  const media: FetchedMedia = {
    body: decoded.body,
    contentType: 'image/png',
    filename: filename.endsWith('.png') ? filename : `${filename}.png`,
  };
  const behavior = await readExtensionSaveBehavior();
  const outcome = await deliverSaveUpload({
    kind: 'image',
    sourcePageUrl,
    mediaUrl: sourcePageUrl,
    ...(targetFolderId === null || typeof targetFolderId === 'string'
      ? { targetFolderId }
      : {}),
    ...(targetCollectionId ? { targetCollectionId } : {}),
  }, media, behavior);
  if (outcome.kind === 'accepted') {
    if (targetCollectionId) {
      const collectionsOutcome = await fetchSerpentCollections();
      if (collectionsOutcome.kind === 'ok') {
        const recentCollectionIds = await readRecentCollectionIds();
        await writeRecentCollectionIds(
          pushRecentFolderId(
            recentCollectionIds,
            targetCollectionId,
            new Set(collectionsOutcome.collections.map((collection) => collection.collectionId)),
          ),
        );
        await refreshFolderMenus().catch(() => {});
      }
    } else if (targetFolderId === null || typeof targetFolderId === 'string') {
      const foldersOutcome = await fetchSerpentFolders();
      if (foldersOutcome.kind === 'ok') {
        await rememberRecentFolder(
          typeof targetFolderId === 'string' ? targetFolderId : null,
          foldersOutcome.folders,
        );
        await refreshFolderMenus().catch(() => {});
      }
    }
  }
  const notification = notificationForOutcome(outcome);
  showNotification(notification);
  return notification;
}

async function saveBatch(
  message: object,
  tabId: number | undefined,
  frameId?: number,
): Promise<{ saved: number; duplicate: number; failed: number; pending: number; skipped: number; stopped?: boolean; message: string }> {
  if (connectionState !== 'connected') {
    const notification = {
      title: '无法保存到 Serpent',
      message: '请先启动 Serpent 桌面应用并打开资源库。',
    };
    showNotification(notification);
    return { saved: 0, duplicate: 0, failed: 0, pending: 0, skipped: 0, message: notification.message };
  }
  const sourcePageUrl = Reflect.get(message, 'sourcePageUrl');
  const items = Reflect.get(message, 'items');
  const targetFolderId = Reflect.get(message, 'targetFolderId');
  const targetCollectionId = Reflect.get(message, 'targetCollectionId');
  if (typeof sourcePageUrl !== 'string' || !Array.isArray(items)) {
    return { saved: 0, duplicate: 0, failed: 0, pending: 0, skipped: 0, message: '保存请求无效' };
  }
  const token = Reflect.get(message, 'token');
  if (
    tabId == null || !Number.isSafeInteger(tabId) ||
    frameId == null || !Number.isSafeInteger(frameId) || frameId < 0 ||
    typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0
  ) return { saved: 0, duplicate: 0, failed: 0, pending: 0, skipped: 0, message: '批量保存身份无效' };
  const jobKey = `${tabId}:${frameId}:${token}`;
  if (batchSaveJobs.has(jobKey)) {
    return { saved: 0, duplicate: 0, failed: 0, pending: 0, skipped: 0, message: '这个批量任务已经在运行' };
  }
  const job: BatchSaveJob = {
    tabId,
    frameId,
    token,
    stopRequested: false,
    halted: false,
    haltMessage: '',
    commitTail: Promise.resolve(),
  };
  batchSaveJobs.set(jobKey, job);

  try {
    const queue = items.slice(0, 200);
    const report = (done: number, total: number) => {
      void browser.tabs.sendMessage(tabId, {
        type: 'serpent-batch-progress',
        token,
        done,
        total,
      }, { frameId }).catch(() => {});
    };
    let targetKindSnapshot: SaveTargetKind;
    let preferOriginalMediaSnapshot: boolean;
    let behaviorSnapshot: ExtensionSaveBehavior;
    try {
      [targetKindSnapshot, preferOriginalMediaSnapshot, behaviorSnapshot] = await Promise.all([
        readSaveTargetKind(),
        readPreferOriginalMedia(),
        readExtensionSaveBehavior(),
      ]);
    } catch (error) {
      const failed = queue.length > 0 ? 1 : 0;
      const skipped = Math.max(0, queue.length - failed);
      const reason = error instanceof Error ? error.message : String(error);
      const summary = `无法读取批量保存设置：${reason}`;
      showNotification({ title: '批量收藏', message: summary });
      return { saved: 0, duplicate: 0, failed, pending: 0, skipped, message: summary };
    }
    let saved = 0;
    let duplicate = 0;
    let savedOriginalOrHigher = 0;
    let savedPreview = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;
    let settled = 0;
    let nextIndex = 0;
    let failureMessage = '';
    const itemSettlements = queue.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve, completed: false };
    });
    const finishItem = (index: number) => {
      const settlement = itemSettlements[index];
      if (!settlement || settlement.completed) return;
      settlement.completed = true;
      settlement.resolve();
    };
    report(0, queue.length);

    const settleProgress = () => {
      settled += 1;
      report(settled, queue.length);
    };
    const fatalOutcome = (outcome: SaveOutcome, kind: 'image' | 'video'): boolean => {
      if (outcome.kind === 'rejected' && kind === 'video' && outcome.failureKind === 'source-invalid') {
        return false;
      }
      return outcome.kind === 'unreachable' || outcome.kind === 'rejected'
        || outcome.kind === 'pending' || outcome.kind === 'transfer_failed';
    };
    const commit = async <T>(index: number, kind: 'image' | 'video', operation: () => Promise<T>): Promise<T> => {
      for (let earlier = 0; earlier < index; earlier += 1) {
        await itemSettlements[earlier]!.promise;
      }
      const previous = job.commitTail;
      let release!: () => void;
      job.commitTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (job.halted) throw new BatchCommitCancelled();
        const result = await operation();
        const resultObject = result && typeof result === 'object' ? result : null;
        const nested = resultObject ? Reflect.get(resultObject, 'outcome') : undefined;
        const outcome = nested && typeof nested === 'object'
          ? nested as unknown as SaveOutcome
          : resultObject && typeof Reflect.get(resultObject, 'kind') === 'string'
            ? resultObject as unknown as SaveOutcome
            : null;
        if (outcome && fatalOutcome(outcome, kind)) {
          job.halted = true;
          job.haltMessage = notificationForOutcome(outcome).message;
        }
        return result;
      } catch (error) {
        if (!(error instanceof BatchCommitCancelled)) {
          job.halted = true;
          job.haltMessage ||= error instanceof Error ? error.message : String(error);
        }
        throw error;
      } finally {
        release();
      }
    };

    const processItem = async (index: number): Promise<void> => {
      try {
      const item = queue[index];
      if (!item || typeof item !== 'object') {
        failed += 1;
        settleProgress();
        return;
      }
      const kind = Reflect.get(item, 'kind');
      const mediaUrl = Reflect.get(item, 'mediaUrl');
      if ((kind !== 'image' && kind !== 'video') || typeof mediaUrl !== 'string') {
        failed += 1;
        settleProgress();
        return;
      }
      const selection = storedSelection(Reflect.get(item, 'selection'), kind, mediaUrl, frameId);
      const itemSourcePageUrl = selection?.pageUrl ?? sourcePageUrl;
      const outcomeSink: { value: SaveOutcome | null } = { value: null };
      let countAsSettled = true;
      try {
        const notification = await saveIntentAndNotify({
          kind,
          sourcePageUrl: itemSourcePageUrl,
          mediaUrl,
          ...(selection ? { selection } : {}),
          ...(targetFolderId === null || typeof targetFolderId === 'string'
            ? { targetFolderId }
            : {}),
          ...(typeof targetCollectionId === 'string' && targetCollectionId
            ? { targetCollectionId }
            : {}),
        }, {
          quiet: true,
          settle: index === queue.length - 1,
          targetKind: targetKindSnapshot,
          preferOriginalMedia: preferOriginalMediaSnapshot,
          behaviorSnapshot,
        }, { tabId, frameId }, outcomeSink, {
          commit: (operation) => commit(index, kind, operation),
        });
        const outcome = outcomeSink.value;
        if (!outcome) {
          failed += 1;
          job.halted = true;
          job.haltMessage = notification.message;
          settleProgress();
          return;
        }
        if (outcome.kind === 'accepted') {
          if (outcome.duplicate) {
            duplicate += 1;
          } else {
            saved += 1;
            if (outcome.savedVersion === 'preview') savedPreview += 1;
            else savedOriginalOrHigher += 1;
          }
        } else if (outcome.kind === 'pending') {
          pending += 1;
        } else {
          failed += 1;
          failureMessage ||= notification.message;
          if (fatalOutcome(outcome, kind)) job.halted = true;
          if (outcome.kind !== 'fetch_failed') {
            job.haltMessage ||= notification.message;
          }
        }
      } catch (error) {
        if (error instanceof BatchCommitCancelled) {
          skipped += 1;
          countAsSettled = false;
        } else if (outcomeSink.value?.kind === 'accepted') {
          if (outcomeSink.value.duplicate) {
            duplicate += 1;
          } else {
            saved += 1;
            if (outcomeSink.value.savedVersion === 'preview') savedPreview += 1;
            else savedOriginalOrHigher += 1;
          }
        } else {
          failed += 1;
          failureMessage ||= error instanceof Error ? error.message : String(error);
          job.halted = true;
          job.haltMessage ||= error instanceof Error ? error.message : String(error);
        }
      }
      if (countAsSettled) settleProgress();
      } finally {
        finishItem(index);
      }
    };

    const worker = async (): Promise<void> => {
      while (!job.stopRequested && !job.halted) {
        const index = nextIndex;
        if (index >= queue.length) return;
        nextIndex += 1;
        await processItem(index);
      }
    };

    const configuredCollectionId = typeof targetCollectionId === 'string' && targetCollectionId
      ? targetCollectionId
      : typeof targetFolderId === 'string' && targetFolderId
        ? targetFolderId
        : undefined;
    if (targetKindSnapshot === 'collection' && !configuredCollectionId && queue.length > 0) {
      failed = 1;
      job.halted = true;
      job.haltMessage = '当前为保存到合集，请选择一个合集。';
      settleProgress();
      skipped += queue.length - 1;
    } else {
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
      if (nextIndex < queue.length) {
        const remaining = queue.length - nextIndex;
        skipped += remaining;
      }
    }

    const stopped = job.stopRequested && !job.halted && skipped > 0;
    const savedSummary = savedPreview > 0
      ? `保存 ${savedOriginalOrHigher} 个原图或较高质量版本、${savedPreview} 个当前预览`
      : `已保存 ${saved} 个文件`;
    const summaryParts = [stopped
      ? `已停止：${savedSummary}，已开始的任务已完成`
      : savedSummary];
    if (pending > 0) summaryParts.push(`${pending} 个视频等待后台恢复`);
    if (duplicate > 0) summaryParts.push(`已跳过重复 ${duplicate} 个`);
    const failureDetail = job.haltMessage || failureMessage;
    if (failed > 0) summaryParts.push(`失败 ${failed} 个${failureDetail ? `。${failureDetail}` : ''}`);
    if (skipped > 0) summaryParts.push(`未执行 ${skipped} 个`);
    const summary = summaryParts.join('，');
    showNotification({ title: '批量收藏', message: summary });
    return { saved, duplicate, failed, pending, skipped, ...(stopped ? { stopped: true } : {}), message: summary };
  } finally {
    if (batchSaveJobs.get(jobKey) === job) batchSaveJobs.delete(jobKey);
  }
}

function requestBatchStop(
  message: object,
  tabId: number | undefined,
  frameId?: number,
): { stopping: boolean; alreadyRequested?: boolean } {
  const token = Reflect.get(message, 'token');
  if (
    tabId == null || !Number.isSafeInteger(tabId) ||
    frameId == null || !Number.isSafeInteger(frameId) || frameId < 0 ||
    typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0
  ) return { stopping: false };
  const job = batchSaveJobs.get(`${tabId}:${frameId}:${token}`);
  if (!job) return { stopping: false };
  const alreadyRequested = job.stopRequested;
  job.stopRequested = true;
  return { stopping: true, alreadyRequested };
}

/** 把保存进度/结果气泡发送到当前标签页（无 content script 时静默忽略）。 */
function notifySaveFeedback(
  tab: { id?: number } | undefined,
  payload:
    | { state: 'saving' }
    | { state: 'done'; title: string; message: string },
  frameId?: number,
): void {
  if (!tab?.id) return;
  void browser.tabs.sendMessage(
    tab.id,
    { type: 'serpent-save-feedback', ...payload },
    frameId === undefined ? undefined : { frameId },
  ).catch(() => {});
}

async function handleContextMenuClick(
  info: SerpentContextMenuClickData,
): Promise<void> {
  const pageMessage = pageActionMessage(info.menuItemId);
  if (pageMessage) {
    const tabId = info.tab?.id;
    if (tabId == null) return;
    try {
      await browser.tabs.sendMessage(tabId, pageMessage, {
        frameId: info.frameId ?? 0,
      });
    } catch {
      showNotification({
        title: '无法在此页面使用',
        message: '请在普通网页上使用采集功能。',
      });
    }
    return;
  }

  if (connectionState !== 'connected') {
    showNotification({
      title: '无法保存到 Serpent',
      message: '请先启动 Serpent 桌面应用并打开资源库。',
    });
    notifySaveFeedback(info.tab, {
      state: 'done',
      title: '无法保存到 Serpent',
      message: '请先启动 Serpent 桌面应用并打开资源库。',
    }, info.frameId);
    return;
  }

  const targetFolderId = parseFolderMenuId(info.menuItemId);
  if (targetFolderId === undefined) return;

  const contextual = await contextMediaForEvent(info);
  let intent = saveIntentFromContextMenu({
    mediaType: info.mediaType,
    pageUrl: info.pageUrl,
    srcUrl: info.srcUrl,
    selection: contextual?.selection,
  });
  if (!intent && contextual) {
    const media = contextual;
    if (media) {
      intent = {
        kind: media.kind,
        sourcePageUrl: media.selection.pageUrl,
        mediaUrl: media.mediaUrl,
        selection: media.selection,
      };
    }
  }
  if (!intent) {
    showNotification({
      title: '无法保存到 Serpent',
      message: '这个媒体或页面不是可下载的 HTTP(S) 地址。',
    });
    notifySaveFeedback(info.tab, {
      state: 'done',
      title: '无法保存到 Serpent',
      message: '这个媒体或页面不是可下载的 HTTP(S) 地址。',
    }, info.frameId);
    return;
  }

  notifySaveFeedback(info.tab, { state: 'saving' }, info.frameId);
  const notification = await saveIntentAndNotify({
    ...intent,
    targetFolderId,
  }, undefined, { tabId: info.tab?.id, frameId: info.frameId });
  notifySaveFeedback(info.tab, {
    state: 'done',
    title: notification.title,
    message: notification.message,
  }, info.frameId);
}

browser.runtime.onInstalled.addListener(() => {
  void bootstrapExtension();
});

browser.runtime.onStartup.addListener(() => {
  void bootstrapExtension();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONNECTION_ALARM) {
    void refreshConnectionState();
  } else if (alarm.name === SEGMENTED_MEDIA_RECOVERY_ALARM) {
    void recoverSegmentedMediaTransfers();
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes[SAVE_TARGET_KIND_KEY]) return;
  void refreshFolderMenus();
});

// Promise-returning onMessage listener: webextension-polyfill resolves the
// promise as the response on both Chromium and Firefox (Firefox's native
// browser.onMessage supports the same contract).
browser.runtime.onMessage.addListener(async (
  message: unknown,
  sender: { tab?: { id?: number }; frameId?: number },
) => {
  if (!message || typeof message !== 'object') return undefined;

  const type = Reflect.get(message, 'type');

  if (type === 'serpent-connection-status') {
    try {
      return { kind: await probeAndReplyConnectionState() };
    } catch {
      return {
        kind: connectionState === 'connected' ? 'connected' : 'disconnected',
      };
    }
  }

  if (type === 'serpent-list-folders') {
    const saveTargetKind = await readSaveTargetKind();
    const outcome = await listSaveTargets(saveTargetKind);
    if (outcome.kind === 'ok') {
      const hints = buildSaveMenuFolderHints(
        outcome.folders,
        outcome.recentIds,
        outcome.browsedIds,
      );
      return {
        kind: 'ok',
        targetKind: saveTargetKind,
        folders: sortFoldersForSaveMenu(outcome.folders, hints),
        recentFolderIds: hints.savedRecentIds,
        recentBrowsedFolderIds: hints.browsedRecentIds,
        libraryDisplayName: outcome.libraryDisplayName,
      };
    }
    return { kind: outcome.kind, targetKind: saveTargetKind };
  }

  if (type === 'serpent-save-request') {
    if (connectionState !== 'connected') {
      const notification = {
        title: '无法保存到 Serpent',
        message: '请先启动 Serpent 桌面应用并打开资源库。',
      };
      showNotification(notification);
      return { notification };
    }

    const intentValue = Reflect.get(message, 'intent');
    if (!intentValue || typeof intentValue !== 'object') {
      return {
        notification: {
          title: '无法保存到 Serpent',
          message: '保存请求无效。',
        },
      };
    }

    const kind = Reflect.get(intentValue, 'kind');
    const sourcePageUrl = Reflect.get(intentValue, 'sourcePageUrl');
    const mediaUrl = Reflect.get(intentValue, 'mediaUrl');
    const targetFolderId = Reflect.get(intentValue, 'targetFolderId');
    const targetCollectionId = Reflect.get(intentValue, 'targetCollectionId');
    if (
      (kind !== 'image' && kind !== 'video') ||
      typeof sourcePageUrl !== 'string' ||
      typeof mediaUrl !== 'string'
    ) {
      return {
        notification: {
          title: '无法保存到 Serpent',
          message: '这个媒体或页面不是可下载的 HTTP(S) 地址。',
        },
      };
    }

    const selection = storedSelection(
      Reflect.get(intentValue, 'selection'),
      kind,
      mediaUrl,
      sender.frameId,
    );

    const saveIntent: SaveIntent = {
      kind,
      sourcePageUrl,
      mediaUrl,
      ...(selection ? { selection } : {}),
      targetFolderId:
        targetFolderId === null || typeof targetFolderId === 'string'
          ? targetFolderId
          : undefined,
      ...(typeof targetCollectionId === 'string' && targetCollectionId
        ? { targetCollectionId }
        : {}),
    };
    const notification = await saveIntentAndNotify(saveIntent, undefined, {
      tabId: sender.tab?.id,
      frameId: sender.frameId,
    });
    return { notification };
  }

  if (type === 'serpent-save-batch') {
    return saveBatch(message, sender.tab?.id, sender.frameId);
  }

  if (type === 'serpent-stop-batch') {
    return requestBatchStop(message, sender.tab?.id, sender.frameId);
  }

  if (type === 'serpent-capture-viewport') {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId == null) throw new Error('无法截取可见区域');
      const dataUrl = await captureVisibleTabPaced(tab.windowId);
      return { dataUrl };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : '无法截取可见区域',
      };
    }
  }

  if (type === 'serpent-save-png') {
    const dataUrl = Reflect.get(message, 'dataUrl');
    const filename = Reflect.get(message, 'filename');
    const sourcePageUrl = Reflect.get(message, 'sourcePageUrl');
    const targetFolderId = Reflect.get(message, 'targetFolderId');
    const targetCollectionId = Reflect.get(message, 'targetCollectionId');
    if (typeof dataUrl !== 'string' || typeof sourcePageUrl !== 'string') {
      return { notification: { title: '无法保存截图', message: '截图数据无效。' } };
    }
    const notification = await savePngDataUrl(
      dataUrl,
      typeof filename === 'string' ? filename : 'serpent-screenshot.png',
      sourcePageUrl,
      targetFolderId === null || typeof targetFolderId === 'string' ? targetFolderId : undefined,
      typeof targetCollectionId === 'string' && targetCollectionId ? targetCollectionId : undefined,
    );
    return { notification };
  }

  return undefined;
});

browser.commands.onCommand.addListener((command) => {
  void (async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId == null) return;
    if (command === 'batch-save') {
      await browser.tabs.sendMessage(tabId, { type: 'serpent-open-batch' }, { frameId: 0 }).catch(() => {});
      return;
    }
    const mode = command === 'capture-area'
      ? 'area'
      : command === 'capture-visible'
        ? 'visible'
        : command === 'capture-page'
          ? 'page'
          : command === 'capture-element'
            ? 'element'
            : null;
    if (!mode) return;
    await browser.tabs.sendMessage(tabId, { type: 'serpent-start-capture', mode }, { frameId: 0 }).catch(() => {});
  })();
});

if (browser.contextMenus.onShown) {
  browser.contextMenus.onShown.addListener((info, tab) => {
    const contexts = info.contexts;
    const showPageActions = pageActionsBelong(contexts);
    const onNativeMedia = contexts.includes('image') || contexts.includes('video');
    void (async () => {
      let showSave = onNativeMedia;
      let saveVisibilityKnown = onNativeMedia;
      if (!onNativeMedia && contexts.includes('link')) {
        showSave = await linkClickHasMedia(tab?.id, info.frameUrl);
        saveVisibilityKnown = true;
      }
      const updates: Promise<void>[] = [];
      if (showPageActions !== pageActionsVisible) {
        pageActionsVisible = showPageActions;
        updates.push(updateMenuItem(MENU_PAGE_ID, { visible: showPageActions }));
      }
      if (saveVisibilityKnown && showSave !== saveMenuVisible) {
        saveMenuVisible = showSave;
        updates.push(updateMenuItem(MENU_ROOT_ID, { visible: showSave }));
      }
      if (updates.length === 0) return;
      await Promise.all(updates);
      refreshOpenContextMenu();
    })();
    if (onNativeMedia) void refreshConnectionState();
  });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  const mediaType =
    info.mediaType === 'image' || info.mediaType === 'video' || info.mediaType === 'audio'
      ? info.mediaType
      : undefined;
  void handleContextMenuClick({
    menuItemId: info.menuItemId,
    mediaType,
    pageUrl: info.pageUrl,
    srcUrl: info.srcUrl,
    frameId: info.frameId,
    // contextMenus 的 tab 是回调第二参数（OnClickData 本身没有 tab）；
    // 之前手写类型把它放在 info 上导致保存反馈气泡收不到 tab。
    tab: tab ? { id: tab.id } : undefined,
  });
});

void bootstrapExtension();
