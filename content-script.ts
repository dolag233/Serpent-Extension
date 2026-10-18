import browser from 'webextension-polyfill';

import { openBatchPanel, setBatchProgress } from './batch-panel';
import { resolveMediaTargetAtPoint } from './media-target';
import { startCapture, type CaptureMode } from './page-capture';
import {
  DRAG_RADIAL_MENU_ENABLED_KEY,
  dragRadialMenuEnabledFromStored,
  readDragRadialMenuEnabled,
} from './preferences';
import { applyDragGhostThumbnail, startRadialSaveMenu } from './radial-menu';
import { showSaveToast } from './save-bubble';

// 右键菜单保存（background.ts）通过此消息把「保存中/保存结果」反馈到当前页面。
// 同步处理、不回复：background 端 tabs.sendMessage 已用 catch 吞掉无响应错误。
let lastContextMedia: { kind: 'image' | 'video'; mediaUrl: string } | null = null;

browser.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return undefined;
  const type = Reflect.get(message, 'type');
  if (type === 'serpent-context-media') {
    return Promise.resolve(lastContextMedia);
  }
  if (type === 'serpent-batch-progress') {
    const done = Reflect.get(message, 'done');
    const total = Reflect.get(message, 'total');
    const token = Reflect.get(message, 'token');
    if (typeof done === 'number' && typeof total === 'number' && typeof token === 'number') {
      setBatchProgress(token, done, total);
    }
    return undefined;
  }
  if (type === 'serpent-save-feedback') {
    if (Reflect.get(message, 'state') === 'saving') {
      showSaveToast('正在保存到 Serpent', '发送中…');
    } else {
      showSaveToast(Reflect.get(message, 'title'), Reflect.get(message, 'message'));
    }
    return undefined;
  }
  if (type === 'serpent-open-batch') {
    openBatchPanel();
    return Promise.resolve({ ok: true });
  }
  if (type === 'serpent-start-capture') {
    const mode = Reflect.get(message, 'mode');
    if (mode === 'visible' || mode === 'area' || mode === 'element' || mode === 'page') {
      startCapture(mode as CaptureMode);
      return Promise.resolve({ ok: true });
    }
  }
  return undefined;
});

document.addEventListener('contextmenu', (event) => {
  const media = resolveMediaTargetAtPoint(
    document,
    event.clientX,
    event.clientY,
    event.composedPath(),
  );
  lastContextMedia = media;
  if (!event.altKey || !media) return;
  event.preventDefault();
  event.stopPropagation();
  showSaveToast('正在保存到 Serpent', '发送中…');
  void browser.runtime.sendMessage({
    type: 'serpent-save-request',
    intent: {
      kind: media.kind,
      sourcePageUrl: window.location.href,
      mediaUrl: media.mediaUrl,
    },
  }).then((response: unknown) => {
    const notification = response && typeof response === 'object'
      ? Reflect.get(response, 'notification')
      : undefined;
    const title = notification && typeof notification === 'object'
      ? Reflect.get(notification, 'title')
      : '已发送到 Serpent';
    const message = notification && typeof notification === 'object'
      ? Reflect.get(notification, 'message')
      : '';
    showSaveToast(
      typeof title === 'string' ? title : '已发送到 Serpent',
      typeof message === 'string' ? message : '',
    );
  }).catch(() => {
    showSaveToast('无法保存到 Serpent', '扩展后台没有响应');
  });
}, true);

// 右键保存走 Chrome 扩展原生 contextMenus（background.ts），不拦截页面右键，
// 避免浮层菜单替换整站原生菜单（Serpent-ak94 / 用户反馈 2026-07-26）。

// Serpent-c0ml / REQ-EXT-005：拖拽图片/视频时展开树状保存菜单（全站点生效）。
// 可在扩展设置中关闭；内容脚本侧缓存开关并监听变更，避免每次 dragstart 都读存储。
let radialMenuEnabled = true;
void readDragRadialMenuEnabled().then((enabled) => {
  radialMenuEnabled = enabled;
});
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const change = changes[DRAG_RADIAL_MENU_ENABLED_KEY];
  if (change) {
    radialMenuEnabled = dragRadialMenuEnabledFromStored(change.newValue);
  }
});

// 不 preventDefault——原生拖拽照常进行，轮盘只是顺路的保存菜单。
document.addEventListener(
  'dragstart',
  (event) => {
    if (!radialMenuEnabled) return;
    const media = resolveMediaTargetAtPoint(
      document,
      event.clientX,
      event.clientY,
      event.composedPath(),
    );
    if (!media) return;
    applyDragGhostThumbnail(event);
    void startRadialSaveMenu(event.clientX, event.clientY, media);
  },
  true,
);
