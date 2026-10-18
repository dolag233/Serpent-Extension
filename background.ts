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
  readSaveTargetKind,
  SAVE_TARGET_KIND_KEY,
  type SaveTargetKind,
} from './preferences';
import {
  fetchSerpentCollections,
  fetchSerpentFolders,
  notificationForOutcome,
  probeSerpentConnection,
  saveIntentFromContextMenu,
  saveMediaViaBrowser,
  type ExtensionCollectionOption,
  type SaveIntent,
  type UserNotification,
} from './save-client';

interface SerpentContextMenuClickData {
  menuItemId: string | number;
  mediaType?: 'image' | 'video' | 'audio';
  pageUrl?: string;
  srcUrl?: string;
  tab?: { id?: number };
}

const MENU_ROOT_ID = 'serpent-save';
const MENU_ROOT_FOLDER_ID = 'serpent-save-root';
const MENU_SEPARATOR_ID = 'serpent-save-sep';
const MENU_NOTICE_ID = 'serpent-save-notice';
const CONNECTION_ALARM = 'serpent-connection-check';
const ICON_SIZES = [32, 48, 64, 128] as const;

let notificationSequence = 0;
let connectionState: 'connected' | 'disconnected' = 'disconnected';
let dynamicFolderMenuIds: string[] = [];
let folderMenuRefreshPromise: Promise<void> | null = null;

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
  contexts?: Array<'image' | 'video'>;
  parentId?: string;
  enabled?: boolean;
  type?: 'normal' | 'separator';
}): Promise<void> {
  await browser.contextMenus.create(properties);
}

async function updateMenuItem(
  id: string,
  properties: { title?: string; enabled?: boolean },
): Promise<void> {
  await browser.contextMenus.update(id, properties);
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
  await browser.contextMenus.remove(id);
}

async function removeDynamicFolderMenus(): Promise<void> {
  const ids = [...dynamicFolderMenuIds];
  dynamicFolderMenuIds = [];
  for (const id of ids) {
    await removeMenuItem(id);
  }
}

async function createStaticMenus(): Promise<void> {
  const connected = connectionState === 'connected';
  await createMenuItem({
    id: MENU_ROOT_ID,
    title: saveMenuTitle(connected),
    contexts: ['image', 'video'],
    enabled: connected,
  });
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
): Promise<void> {
  const id = folderMenuItemId(folder);
  dynamicFolderMenuIds.push(id);
  await createMenuItem({
    id,
    parentId,
    title: folder.name,
    contexts: ['image', 'video'],
    enabled: true,
  });
  if (folder.children.length > 0 && folder.folderId !== null) {
    // contextMenus 父项点击只展开不保存；子菜单第一行提供保存到当前节点
    // （对齐拖拽树「松开 = 保存进该文件夹/合集」）。
    const selfId = folderMenuSelfId(folder.folderId);
    dynamicFolderMenuIds.push(selfId);
    await createMenuItem({
      id: selfId,
      parentId: id,
      title: selfTitle,
      contexts: ['image', 'video'],
      enabled: true,
    });
  }
  for (const child of folder.children) {
    await createFolderSubmenu(id, child, selfTitle);
  }
}

async function createNoticeMenuItem(title: string): Promise<void> {
  dynamicFolderMenuIds.push(MENU_NOTICE_ID);
  await createMenuItem({
    id: MENU_NOTICE_ID,
    parentId: MENU_ROOT_ID,
    title,
    contexts: ['image', 'video'],
    enabled: false,
  });
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

    if (!connected) {
      await removeDynamicFolderMenus();
      return;
    }

    const saveTargetKind = await readSaveTargetKind();
    const listed = await listSaveTargets(saveTargetKind);
    if (listed.kind !== 'ok') {
      await removeDynamicFolderMenus();
      if (saveTargetKind === 'collection') {
        await createNoticeMenuItem('无法读取合集');
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
      await createNoticeMenuItem('尚无合集');
      return;
    }

    // 文件夹模式与拖拽树一致：最近保存/浏览 → 分割线 → 根目录 → 所有一级目录。
    // 合集模式没有「只保存到根目录」项：选中合集后文件进根目录并加入该合集。
    let rootParentCreated = false;
    const createRootParentMenu = async (): Promise<void> => {
      if (saveTargetKind !== 'folder' || rootParentCreated) return;
      rootParentCreated = true;
      dynamicFolderMenuIds.push(MENU_ROOT_PARENT_ID);
      await createMenuItem({
        id: MENU_ROOT_PARENT_ID,
        parentId: MENU_ROOT_ID,
        title: '根目录',
        contexts: ['image', 'video'],
        enabled: true,
      });
      dynamicFolderMenuIds.push(MENU_ROOT_FOLDER_ID);
      await createMenuItem({
        id: MENU_ROOT_FOLDER_ID,
        parentId: MENU_ROOT_PARENT_ID,
        title: '保存至此',
        contexts: ['image', 'video'],
        enabled: true,
      });
    };

    let separatorCreated = false;
    for (const item of tree) {
      if (item.kind === 'separator') {
        if (separatorCreated) continue;
        separatorCreated = true;
        dynamicFolderMenuIds.push(MENU_SEPARATOR_ID);
        await createMenuItem({
          id: MENU_SEPARATOR_ID,
          type: 'separator',
          parentId: MENU_ROOT_ID,
          contexts: ['image', 'video'],
        });
        await createRootParentMenu();
        continue;
      }
      await createFolderSubmenu(MENU_ROOT_ID, item.folder, selfTitle);
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
}

function showNotification(notification: UserNotification): void {
  void readExtensionSaveBehavior().then((behavior) => {
    if (!behavior.notificationsEnabled) return;
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
): Promise<SaveIntent | UserNotification> {
  const kind = await readSaveTargetKind();
  if (kind === 'folder') {
    return {
      kind: intent.kind,
      sourcePageUrl: intent.sourcePageUrl,
      mediaUrl: intent.mediaUrl,
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
    kind: intent.kind,
    sourcePageUrl: intent.sourcePageUrl,
    mediaUrl: intent.mediaUrl,
    targetFolderId: null,
    targetCollectionId: collectionId,
  };
}

async function saveIntentAndNotify(intent: SaveIntent): Promise<UserNotification> {
  const resolved = await resolveSaveIntent(intent);
  if ('title' in resolved) {
    showNotification(resolved);
    return resolved;
  }

  const behavior = await readExtensionSaveBehavior();
  const outcome = await saveMediaViaBrowser(resolved, behavior);
  if (outcome.kind === 'accepted') {
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
        await refreshFolderMenus();
      }
    } else {
      const foldersOutcome = await fetchSerpentFolders();
      if (foldersOutcome.kind === 'ok') {
        const folderId =
          typeof resolved.targetFolderId === 'string' ? resolved.targetFolderId : null;
        await rememberRecentFolder(folderId, foldersOutcome.folders);
        await refreshFolderMenus();
      }
    }
  }
  const notification = notificationForOutcome(outcome);
  showNotification(notification);
  return notification;
}

/** 把保存进度/结果气泡发送到当前标签页（无 content script 时静默忽略）。 */
function notifySaveFeedback(
  tab: { id?: number } | undefined,
  payload:
    | { state: 'saving' }
    | { state: 'done'; title: string; message: string },
): void {
  if (!tab?.id) return;
  void browser.tabs.sendMessage(
    tab.id,
    { type: 'serpent-save-feedback', ...payload },
  ).catch(() => {});
}

async function handleContextMenuClick(
  info: SerpentContextMenuClickData,
): Promise<void> {
  if (connectionState !== 'connected') {
    showNotification({
      title: '无法保存到 Serpent',
      message: '请先启动 Serpent 桌面应用并打开资源库。',
    });
    notifySaveFeedback(info.tab, {
      state: 'done',
      title: '无法保存到 Serpent',
      message: '请先启动 Serpent 桌面应用并打开资源库。',
    });
    return;
  }

  const targetFolderId = parseFolderMenuId(info.menuItemId);
  if (targetFolderId === undefined) return;

  const intent = saveIntentFromContextMenu({
    mediaType: info.mediaType,
    pageUrl: info.pageUrl,
    srcUrl: info.srcUrl,
  });
  if (!intent) {
    showNotification({
      title: '无法保存到 Serpent',
      message: '这个媒体或页面不是可下载的 HTTP(S) 地址。',
    });
    notifySaveFeedback(info.tab, {
      state: 'done',
      title: '无法保存到 Serpent',
      message: '这个媒体或页面不是可下载的 HTTP(S) 地址。',
    });
    return;
  }

  notifySaveFeedback(info.tab, { state: 'saving' });
  const notification = await saveIntentAndNotify({
    ...intent,
    targetFolderId,
  });
  notifySaveFeedback(info.tab, {
    state: 'done',
    title: notification.title,
    message: notification.message,
  });
}

browser.runtime.onInstalled.addListener(() => {
  void bootstrapExtension();
});

browser.runtime.onStartup.addListener(() => {
  void bootstrapExtension();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CONNECTION_ALARM) return;
  void refreshConnectionState();
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes[SAVE_TARGET_KIND_KEY]) return;
  void refreshFolderMenus();
});

// Promise-returning onMessage listener: webextension-polyfill resolves the
// promise as the response on both Chromium and Firefox (Firefox's native
// browser.onMessage supports the same contract).
browser.runtime.onMessage.addListener(async (message: unknown) => {
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

    const saveIntent: SaveIntent = {
      kind,
      sourcePageUrl,
      mediaUrl,
      targetFolderId:
        targetFolderId === null || typeof targetFolderId === 'string'
          ? targetFolderId
          : undefined,
      ...(typeof targetCollectionId === 'string' && targetCollectionId
        ? { targetCollectionId }
        : {}),
    };
    const notification = await saveIntentAndNotify(saveIntent);
    return { notification };
  }

  return undefined;
});

if (browser.contextMenus.onShown) {
  browser.contextMenus.onShown.addListener((info) => {
    if (info.contexts.includes('image') || info.contexts.includes('video')) {
      void refreshConnectionState();
    }
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
    // contextMenus 的 tab 是回调第二参数（OnClickData 本身没有 tab）；
    // 之前手写类型把它放在 info 上导致保存反馈气泡收不到 tab。
    tab: tab ? { id: tab.id } : undefined,
  });
});

void bootstrapExtension();
