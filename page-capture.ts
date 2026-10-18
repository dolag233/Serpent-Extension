import browser from 'webextension-polyfill';

import { readBatchTarget, readSaveTargetKind } from './preferences';
import { showSaveToast } from './save-bubble';

const MAX_PAGE_CSS_PX = 30_000;

export type CaptureMode = 'visible' | 'area' | 'element' | 'page';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function captureViewport(): Promise<HTMLImageElement> {
  const response = await browser.runtime.sendMessage({
    type: 'serpent-capture-viewport',
  }) as { dataUrl?: string; message?: string };
  if (!response?.dataUrl) {
    throw new Error(response?.message || '无法截取可见区域');
  }
  const image = new Image();
  image.src = response.dataUrl;
  await image.decode();
  return image;
}

async function savePng(dataUrl: string, filename: string): Promise<void> {
  const [kind, target] = await Promise.all([readSaveTargetKind(), readBatchTarget()]);
  const side = kind === 'collection' ? target.collection : target.folder;
  const response = await browser.runtime.sendMessage({
    type: 'serpent-save-png',
    dataUrl,
    filename,
    sourcePageUrl: window.location.href,
    ...(kind === 'collection' && side.known && side.id
      ? { targetFolderId: null, targetCollectionId: side.id }
      : {}),
    ...(kind === 'folder' && side.known ? { targetFolderId: side.id } : {}),
  }) as { notification?: { title: string; message: string } };
  const notification = response?.notification;
  showSaveToast(
    notification?.title ?? '已发送到 Serpent',
    notification?.message ?? '',
  );
}

function cropToDataUrl(
  shot: CanvasImageSource,
  shotWidth: number,
  shotHeight: number,
  rect: DOMRect,
): string {
  const scaleX = shotWidth / window.innerWidth;
  const scaleY = shotHeight / window.innerHeight;
  const canvas = document.createElement('canvas');
  const width = Math.max(1, Math.round(rect.width * scaleX));
  const height = Math.max(1, Math.round(rect.height * scaleY));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建截图画布');
  context.drawImage(
    shot,
    Math.round(rect.left * scaleX),
    Math.round(rect.top * scaleY),
    width,
    height,
    0,
    0,
    width,
    height,
  );
  return canvas.toDataURL('image/png');
}

function hideUi(): HTMLElement[] {
  const hidden: HTMLElement[] = [];
  for (const element of document.querySelectorAll<HTMLElement>('[data-serpent-ui]')) {
    hidden.push(element);
    element.style.visibility = 'hidden';
  }
  return hidden;
}

function restoreUi(elements: readonly HTMLElement[]): void {
  for (const element of elements) element.style.visibility = '';
}

async function captureRect(rect: DOMRect, filename: string): Promise<void> {
  const hidden = hideUi();
  try {
    await wait(40);
    const shot = await captureViewport();
    const dataUrl = cropToDataUrl(shot, shot.naturalWidth, shot.naturalHeight, rect);
    await savePng(dataUrl, filename);
  } finally {
    restoreUi(hidden);
  }
}

function mountOverlay(mode: 'area' | 'element'): void {
  const host = document.createElement('div');
  host.setAttribute('data-serpent-ui', 'capture');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .shade { position: fixed; inset: 0; z-index: 2147483646; cursor: crosshair; background: rgba(0,0,0,.15); }
    .box { position: fixed; border: 2px solid #8fd0ff; background: rgba(143,208,255,.2); pointer-events: none; }
    .hint {
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      background: #1a1e21; color: #e8ebe8; border-radius: 999px; padding: 8px 14px;
      font: 12px/1.4 system-ui, "Segoe UI", sans-serif;
    }
  `;
  const shade = document.createElement('div');
  shade.className = 'shade';
  const box = document.createElement('div');
  box.className = 'box';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = mode === 'area'
    ? '拖出区域。按住 Ctrl 或 ⌘ 吸附元素。Esc 取消'
    : '单击要截取的元素。Esc 取消';
  shadow.append(style, shade, box, hint);
  document.documentElement.appendChild(host);

  const close = () => host.remove();
  const placeBox = (rect: DOMRect) => {
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close();
      window.removeEventListener('keydown', onKey, true);
    }
  };
  window.addEventListener('keydown', onKey, true);

  if (mode === 'element') {
    shade.addEventListener('mousemove', (event) => {
      host.style.visibility = 'hidden';
      const target = document.elementFromPoint(event.clientX, event.clientY);
      host.style.visibility = '';
      if (!target || target === document.documentElement || target === document.body) return;
      placeBox(target.getBoundingClientRect());
    });
    shade.addEventListener('click', (event) => {
      host.style.visibility = 'hidden';
      const target = document.elementFromPoint(event.clientX, event.clientY);
      host.style.visibility = '';
      close();
      window.removeEventListener('keydown', onKey, true);
      if (!target) return;
      void captureElement(target).catch((error: unknown) => {
        showSaveToast('截图失败', error instanceof Error ? error.message : String(error));
      });
    });
    return;
  }

  let startX = 0;
  let startY = 0;
  let dragging = false;
  shade.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.ctrlKey || event.metaKey) {
      host.style.visibility = 'hidden';
      const target = document.elementFromPoint(event.clientX, event.clientY);
      host.style.visibility = '';
      close();
      window.removeEventListener('keydown', onKey, true);
      if (!target) return;
      void captureElement(target).catch((error: unknown) => {
        showSaveToast('截图失败', error instanceof Error ? error.message : String(error));
      });
      return;
    }
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    placeBox(new DOMRect(startX, startY, 0, 0));
  });
  shade.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    placeBox(new DOMRect(
      Math.min(startX, event.clientX),
      Math.min(startY, event.clientY),
      Math.abs(event.clientX - startX),
      Math.abs(event.clientY - startY),
    ));
  });
  shade.addEventListener('mouseup', (event) => {
    if (!dragging) return;
    dragging = false;
    const rect = new DOMRect(
      Math.min(startX, event.clientX),
      Math.min(startY, event.clientY),
      Math.abs(event.clientX - startX),
      Math.abs(event.clientY - startY),
    );
    close();
    window.removeEventListener('keydown', onKey, true);
    if (rect.width < 4 || rect.height < 4) return;
    void captureRect(rect, 'serpent-area.png').catch((error: unknown) => {
      showSaveToast('截图失败', error instanceof Error ? error.message : String(error));
    });
  });
}

async function captureElement(element: Element): Promise<void> {
  element.scrollIntoView({ block: 'start', inline: 'nearest' });
  await wait(80);
  const rect = element.getBoundingClientRect();
  if (rect.height <= window.innerHeight + 1) {
    await captureRect(rect, 'serpent-element.png');
    return;
  }
  const hidden = hideUi();
  try {
    const scaleShot = await captureViewport();
    const scaleX = scaleShot.naturalWidth / window.innerWidth;
    const left = Math.max(0, rect.left);
    const width = Math.min(window.innerWidth - left, rect.width);
    const total = Math.min(rect.height, MAX_PAGE_CSS_PX);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scaleX));
    canvas.height = Math.max(1, Math.round(total * (scaleShot.naturalHeight / window.innerHeight)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建截图画布');
    const startY = window.scrollY;
    let covered = 0;
    while (covered < total) {
      window.scrollTo(window.scrollX, startY + covered);
      await wait(160);
      const shot = await captureViewport();
      const scaleY = shot.naturalHeight / window.innerHeight;
      const sliceHeight = Math.min(window.innerHeight, total - covered);
      context.drawImage(
        shot,
        Math.round(left * scaleX),
        0,
        Math.round(width * scaleX),
        Math.round(sliceHeight * scaleY),
        0,
        Math.round(covered * scaleY),
        Math.round(width * scaleX),
        Math.round(sliceHeight * scaleY),
      );
      covered += sliceHeight;
    }
    window.scrollTo(window.scrollX, startY);
    await savePng(canvas.toDataURL('image/png'), 'serpent-element.png');
  } finally {
    restoreUi(hidden);
  }
}

async function capturePage(): Promise<void> {
  const hidden = hideUi();
  const startX = window.scrollX;
  const startY = window.scrollY;
  try {
    const pageHeight = Math.min(
      MAX_PAGE_CSS_PX,
      Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    );
    const probe = await captureViewport();
    const scaleY = probe.naturalHeight / window.innerHeight;
    const canvas = document.createElement('canvas');
    canvas.width = probe.naturalWidth;
    canvas.height = Math.max(1, Math.round(pageHeight * scaleY));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建截图画布');
    let y = 0;
    while (y < pageHeight) {
      window.scrollTo(0, y);
      await wait(180);
      const actual = window.scrollY;
      const shot = await captureViewport();
      context.drawImage(shot, 0, Math.round(actual * scaleY));
      if (window.innerHeight <= 0) break;
      const next = actual + window.innerHeight;
      if (next <= y) break;
      y = next;
    }
    window.scrollTo(startX, startY);
    await savePng(canvas.toDataURL('image/png'), 'serpent-page.png');
  } finally {
    restoreUi(hidden);
  }
}

export function startCapture(mode: CaptureMode): void {
  if (mode === 'visible') {
    const hidden = hideUi();
    void (async () => {
      try {
        await wait(40);
        const shot = await captureViewport();
        const canvas = document.createElement('canvas');
        canvas.width = shot.naturalWidth;
        canvas.height = shot.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建截图画布');
        context.drawImage(shot, 0, 0);
        await savePng(canvas.toDataURL('image/png'), 'serpent-visible.png');
      } catch (error) {
        showSaveToast('截图失败', error instanceof Error ? error.message : String(error));
      } finally {
        restoreUi(hidden);
      }
    })();
    return;
  }
  if (mode === 'page') {
    void capturePage().catch((error: unknown) => {
      showSaveToast('截图失败', error instanceof Error ? error.message : String(error));
    });
    return;
  }
  mountOverlay(mode);
}
