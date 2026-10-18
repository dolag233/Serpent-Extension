import browser from 'webextension-polyfill';

import {
  chooseInitialDestination,
  countSelected,
  destinationLabel,
  formatBatchStatus,
  seedSelection,
  type DestinationChoice,
} from './batch-model';
import { buildSaveMenuFolderHints, type ExtensionFolderOption } from './folder-menu';
import { mediaPassesFilter, collectPageMedia, type CollectedMedia } from './page-images';
import {
  BATCH_FORMATS,
  readBatchFilter,
  readBatchTarget,
  rememberBatchTarget,
  writeBatchFilter,
  writeSaveTargetKind,
  type BatchFilterSettings,
} from './preferences';
import {
  buildFolderTree,
  itemsForLevel,
  parentInfoForLevel,
  pickTreeRecentFolderIds,
  type FolderNode,
  type TreeLevel,
  type TreeMenuContext,
} from './radial-menu-model';

const MAX_BATCH = 200;

interface FolderListResponse {
  kind: 'ok';
  targetKind?: 'folder' | 'collection';
  folders: ExtensionFolderOption[];
  recentFolderIds?: string[];
  recentBrowsedFolderIds?: string[];
  libraryDisplayName?: string;
}

const ICONS: Record<string, string> = {
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  all: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 8.2 7 10.2 11 6"/>',
  none: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/>',
  edge: '<path d="M5 2.5H3.5a1 1 0 0 0-1 1V5M11 2.5h1.5a1 1 0 0 1 1 1V5M5 13.5H3.5a1 1 0 0 1-1-1V11M11 13.5h1.5a1 1 0 0 0 1-1V11"/>',
  hd: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M5 10.2 7 8l1.4 1.4L10.2 7 12 9.6"/>',
  detect: '<path d="M1.8 8S4.2 4.6 8 4.6 14.2 8 14.2 8 11.8 11.4 8 11.4 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.6"/>',
  save: '<path d="M8 2.6v6.2M5.6 6.6 8 9.1l2.4-2.5"/><path d="M3.2 11.2h9.6V13.6H3.2z"/>',
  folder: '<path d="M2.2 4.2h3.8l1.2 1.4h6.6v6.6H2.2z"/>',
  layers: '<path d="M8 2.4 13.2 5 8 7.6 2.8 5zM3.2 7.4 8 10l4.8-2.6M3.2 10.2 8 12.8l4.8-2.6"/>',
  back: '<path d="M10 3.5 5.5 8 10 12.5"/>',
  drill: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  film: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M6 3.5v9M10 3.5v9M2.5 6.5h11M2.5 9.5h11"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

const STYLE_TEXT = `
  :host { all: initial; color-scheme: light; }
  .panel {
    position: fixed; z-index: 2147483646; top: 16px; right: 16px;
    width: min(520px, calc(100vw - 24px)); max-height: calc(100vh - 32px);
    display: flex; flex-direction: column;
    background: #f7f7f8; color: #1a1b1e;
    border: 1px solid #e1e2e6; border-radius: 10px;
    box-shadow: 0 16px 40px rgb(0 0 0 / 14%), 0 1px 3px rgb(0 0 0 / 6%);
    font: 13px/1.4 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    overflow: hidden;
  }
  header, footer {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 8px 10px; background: #fff;
  }
  header { border-bottom: 1px solid #e1e2e6; min-height: 40px; }
  footer { border-top: 1px solid #e1e2e6; }
  .sub { margin: 0; color: #5c5f69; font-size: 12px; }
  button, input, select { font: inherit; color: inherit; }
  .ico, .ico * {
    fill: none; stroke: currentColor; stroke-width: 1.5;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .ico { width: 16px; height: 16px; display: block; }
  .tool, .primary, .chip, .dest-back, .dest-drill {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; border-radius: 6px; cursor: pointer; color: #5c5f69;
  }
  .tool { width: 28px; height: 28px; padding: 0; }
  .tool:hover, .dest-back:hover, .dest-drill:hover, .dest-name:hover { background: rgb(0 0 0 / 5.5%); color: #1a1b1e; }
  .tool.is-on { background: color-mix(in srgb, #3b82f6 14%, #fff); color: #1d4ed8; }
  .primary { width: 32px; height: 32px; padding: 0; background: #3b82f6; color: #fff; border-radius: 8px; }
  .primary:hover { background: #2563eb; color: #fff; }
  .tools { display: grid; gap: 8px; padding: 8px 10px; background: #fff; border-bottom: 1px solid #ebecef; }
  .row { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }
  .edge {
    display: inline-flex; align-items: center; gap: 4px; height: 28px;
    margin-left: 4px; padding: 0 8px 0 6px; border-radius: 6px; color: #5c5f69;
  }
  .edge:hover { background: rgb(0 0 0 / 5.5%); }
  .edge-label { font-size: 12px; white-space: nowrap; }
  .edge input {
    width: 46px; padding: 0; border: 0; background: transparent; color: #1a1b1e; outline: none;
  }
  .formats { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    height: 22px; padding: 0 8px; border: 1px solid #e1e2e6; border-radius: 999px;
    background: #fff; color: #5c5f69; font-size: 11px;
  }
  .chip:hover { border-color: #c9cbcf; }
  .chip.is-on { background: color-mix(in srgb, #3b82f6 12%, #fff); border-color: transparent; color: #1d4ed8; }
  .dest { display: grid; gap: 6px; }
  .dest-line { display: flex; align-items: center; gap: 6px; }
  .dest-kind {
    flex: none; height: 32px; padding: 0 8px;
    border: 1px solid #e1e2e6; border-radius: 8px; background: #fff; cursor: pointer;
  }
  .dest-current {
    flex: 1; min-width: 0; height: 32px; display: flex; align-items: center; gap: 8px;
    padding: 0 10px; border-radius: 8px; border: 1px solid #e1e2e6; background: #f7f7f8;
    cursor: pointer; text-align: left; color: #1a1b1e;
  }
  .dest-current:hover { background: #fff; }
  .dest-current .ico { color: #5c5f69; flex: none; }
  .dest-label, .dest-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dest-label { flex: 1; min-width: 0; font-size: 13px; }
  .dest-row, .dest-bar { width: 100%; }
  .dest-tree {
    border: 1px solid #e1e2e6; border-radius: 8px; background: #fff;
    max-height: 220px; overflow: auto;
  }
  .dest-bar, .dest-row { display: flex; align-items: center; }
  .dest-bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ebecef; }
  .dest-name, .dest-back, .dest-drill { border: 0; background: transparent; cursor: pointer; color: #1a1b1e; }
  .dest-name { flex: 1; min-width: 0; padding: 7px 8px; border-radius: 6px; text-align: left; }
  .dest-back, .dest-drill { width: 28px; height: 28px; margin: 2px; color: #5c5f69; }
  .dest-name:disabled { color: #8b8f99; cursor: default; background: transparent; }
  .dest-sep { height: 1px; margin: 4px 8px; background: #ebecef; }
  .grid {
    overflow: auto; display: grid;
    grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
    gap: 10px; padding: 12px;
    background: #f0f1f3;
  }
  .grid:has(.empty) { display: block; }
  .card {
    position: relative; display: block; width: 100%; padding: 0; overflow: hidden;
    border: 1px solid transparent; border-radius: 8px; background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
    cursor: pointer; text-align: left;
  }
  .card.is-on { border-color: #3b82f6; }
  .card img, .card .ph {
    width: 100%; aspect-ratio: 1; object-fit: contain; display: block; background: #f3f4f6;
  }
  .card .ph { display: flex; align-items: center; justify-content: center; color: #8b8f99; }
  .mark {
    position: absolute; top: 6px; left: 6px; width: 16px; height: 16px; box-sizing: border-box;
    border: 1.5px solid #fff; border-radius: 4px; background: rgb(255 255 255 / 92%);
    box-shadow: 0 1px 2px rgb(0 0 0 / 16%);
  }
  .card.is-on .mark { background: #3b82f6; border-color: #3b82f6; }
  .card.is-on .mark::after {
    content: ""; display: block; width: 4px; height: 8px; margin: 1px 0 0 5px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  .meta { padding: 4px 6px 6px; font-size: 11px; color: #8b8f99; }
  .empty { margin: 0; padding: 28px 14px; color: #8b8f99; text-align: center; }
  .progress {
    height: 4px; background: #ebecef; overflow: hidden;
  }
  .progress[hidden] { display: none; }
  .progress.is-busy {
    background-image: linear-gradient(90deg, #ebecef 0%, #dbe7ff 45%, #ebecef 90%);
    background-size: 220% 100%;
    animation: batch-slide 1.1s linear infinite;
  }
  .progress-bar { height: 100%; width: 0; background: #3b82f6; transition: width 160ms ease; }
  .primary:disabled { opacity: 0.45; cursor: default; }
  @keyframes batch-slide {
    from { background-position: 100% 0; }
    to { background-position: -120% 0; }
  }
`;

let host: HTMLDivElement | null = null;
let observer: MutationObserver | null = null;
let detectTimer = 0;
let onKey: ((event: KeyboardEvent) => void) | null = null;
let onDocClick: ((event: MouseEvent) => void) | null = null;
let progressToken = 0;
let batchSaving = false;
let progressTrack: HTMLElement | null = null;
let progressBar: HTMLElement | null = null;
let progressStatus: HTMLElement | null = null;

export function setBatchProgress(token: number, done: number, total: number): void {
  if (token !== progressToken || !progressTrack || !progressBar || !progressStatus) return;
  const safeTotal = Math.max(1, total);
  const clamped = Math.max(0, Math.min(done, safeTotal));
  progressTrack.hidden = false;
  progressTrack.classList.add('is-busy');
  progressBar.style.width = `${(clamped / safeTotal) * 100}%`;
  progressTrack.setAttribute('aria-valuenow', String(Math.round((clamped / safeTotal) * 100)));
  if (clamped < safeTotal) {
    progressStatus.textContent = `正在下载 ${Math.min(clamped + 1, safeTotal)} / ${safeTotal}`;
  }
}

function beginBatchProgress(total: number): number {
  progressToken += 1;
  batchSaving = true;
  const safeTotal = Math.max(1, total);
  if (progressTrack && progressBar && progressStatus) {
    progressTrack.hidden = false;
    progressTrack.classList.add('is-busy');
    progressBar.style.width = '0%';
    progressTrack.setAttribute('aria-valuenow', '0');
    progressTrack.setAttribute('aria-valuemax', '100');
    progressStatus.textContent = `正在下载 1 / ${safeTotal}`;
  }
  return progressToken;
}

function endBatchProgress(): void {
  progressToken += 1;
  batchSaving = false;
  progressTrack?.classList.remove('is-busy');
  if (progressTrack) progressTrack.hidden = true;
  if (progressBar) progressBar.style.width = '0%';
}

function send<T>(message: Record<string, unknown>): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

function closePanel(): void {
  if (onKey) window.removeEventListener('keydown', onKey, true);
  if (onDocClick) document.removeEventListener('click', onDocClick, true);
  onKey = null;
  onDocClick = null;
  observer?.disconnect();
  observer = null;
  endBatchProgress();
  progressTrack = null;
  progressBar = null;
  progressStatus = null;
  host?.remove();
  host = null;
}

export function openBatchPanel(): void {
  closePanel();

  host = document.createElement('div');
  host.setAttribute('data-serpent-ui', 'batch');
  host.attachShadow({ mode: 'open' });
  const shadow = host.shadowRoot;
  if (!shadow) return;
  const style = document.createElement('style');
  style.textContent = STYLE_TEXT;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <header>
      <p class="sub" data-field="status"></p>
      <button type="button" class="tool" data-action="close" title="关闭" aria-label="关闭">${icon('close')}</button>
    </header>
    <div class="progress" data-field="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="下载进度" hidden>
      <div class="progress-bar" data-field="progress-bar"></div>
    </div>
    <div class="tools">
      <div class="row">
        <button type="button" class="tool" data-action="all" title="全选" aria-label="全选">${icon('all')}</button>
        <button type="button" class="tool" data-action="none" title="全不选" aria-label="全不选">${icon('none')}</button>
        <label class="edge" title="最短边">${icon('edge')}<span class="edge-label">最短边</span><input data-field="edge" type="number" min="0" max="8000" step="10" aria-label="最短边"></label>
        <button type="button" class="tool" data-action="hd" title="优先高清" aria-label="优先高清">${icon('hd')}</button>
        <button type="button" class="tool" data-action="detect" title="自动侦测" aria-label="自动侦测">${icon('detect')}</button>
      </div>
      <div class="formats" data-field="formats"></div>
      <div class="dest">
        <div class="dest-line">
          <select class="dest-kind" data-field="dest-kind" aria-label="保存目标">
            <option value="folder">文件夹</option>
            <option value="collection">合集</option>
          </select>
          <button type="button" class="dest-current" data-action="dest-toggle" title="保存位置">
            <span data-field="dest-icon">${icon('folder')}</span>
            <span class="dest-label" data-field="dest-label">正在读取…</span>
          </button>
        </div>
        <div class="dest-tree" data-field="dest-tree" hidden>
          <div class="dest-bar" data-field="dest-bar"></div>
          <div data-field="dest-list"></div>
        </div>
      </div>
    </div>
    <div class="grid" data-field="grid"></div>
    <footer>
      <span class="sub" data-field="foot"></span>
      <button type="button" class="primary" data-action="save" title="保存所选" aria-label="保存所选">${icon('save')}</button>
    </footer>
  `;
  shadow.appendChild(panel);
  document.documentElement.appendChild(host);

  const grid = panel.querySelector<HTMLDivElement>('[data-field="grid"]');
  const status = panel.querySelector<HTMLElement>('[data-field="status"]');
  const foot = panel.querySelector<HTMLElement>('[data-field="foot"]');
  const edgeInput = panel.querySelector<HTMLInputElement>('[data-field="edge"]');
  const formatRow = panel.querySelector<HTMLDivElement>('[data-field="formats"]');
  const destKind = panel.querySelector<HTMLSelectElement>('[data-field="dest-kind"]');
  const destIcon = panel.querySelector<HTMLElement>('[data-field="dest-icon"]');
  const destLabel = panel.querySelector<HTMLElement>('[data-field="dest-label"]');
  const destTree = panel.querySelector<HTMLDivElement>('[data-field="dest-tree"]');
  const destBar = panel.querySelector<HTMLDivElement>('[data-field="dest-bar"]');
  const destList = panel.querySelector<HTMLDivElement>('[data-field="dest-list"]');
  const hdButton = panel.querySelector<HTMLButtonElement>('[data-action="hd"]');
  const detectButton = panel.querySelector<HTMLButtonElement>('[data-action="detect"]');
  const saveButton = panel.querySelector<HTMLButtonElement>('[data-action="save"]');
  progressTrack = panel.querySelector<HTMLElement>('[data-field="progress"]');
  progressBar = panel.querySelector<HTMLElement>('[data-field="progress-bar"]');
  progressStatus = status;
  if (
    !grid || !status || !foot || !edgeInput || !formatRow || !destKind || !destIcon
    || !destLabel || !destTree || !destBar || !destList || !hdButton || !detectButton
    || !saveButton || !progressTrack || !progressBar
  ) return;

  let filter: BatchFilterSettings = {
    minEdge: 200,
    formats: [...BATCH_FORMATS],
    preferHd: true,
  };
  let targetKind: 'folder' | 'collection' = 'folder';
  let items: CollectedMedia[] = [];
  let selected = new Set<string>();
  let detecting = false;
  let level: TreeLevel = { kind: 'root' };
  let context: TreeMenuContext = {
    roots: [],
    recentFolders: [],
    libraryDisplayName: 'Serpent',
    rootSaveEnabled: true,
  };
  let nodes = new Map<string, FolderNode>();
  let destination: DestinationChoice = {
    id: null,
    label: '根目录',
    ready: true,
  };

  const setStatus = (text: string) => {
    status.textContent = text;
  };

  const visibleItems = () => items.filter((item) => mediaPassesFilter(item, filter));

  const updateStatus = () => {
    const shown = visibleItems();
    const picked = countSelected(shown, selected);
    if (!batchSaving) setStatus(formatBatchStatus(picked, shown.length));
    const hidden = items.length - shown.length;
    foot.textContent = hidden > 0 ? `页面共 ${items.length}，已隐藏 ${hidden}` : '';
  };

  const render = () => {
    const shown = visibleItems();
    grid.replaceChildren();
    if (shown.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = items.length === 0 ? '这一页没有可保存的图片或视频' : '当前筛选下没有图片或视频';
      grid.appendChild(empty);
    }
    for (const item of shown) {
      const on = selected.has(item.key);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `card${on ? ' is-on' : ' is-off'}`;
      card.setAttribute('role', 'checkbox');
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      const mark = document.createElement('span');
      mark.className = 'mark';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${item.format} ${item.width || '?'}×${item.height || '?'}`;
      if (item.kind === 'image') {
        const preview = document.createElement('img');
        preview.alt = '';
        preview.referrerPolicy = 'no-referrer';
        preview.src = item.previewUrl;
        card.append(mark, preview, meta);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'ph';
        placeholder.innerHTML = icon('film');
        card.append(mark, placeholder, meta);
      }
      card.addEventListener('click', () => {
        if (selected.has(item.key)) selected.delete(item.key);
        else selected.add(item.key);
        const next = selected.has(item.key);
        card.classList.toggle('is-on', next);
        card.classList.toggle('is-off', !next);
        card.setAttribute('aria-checked', next ? 'true' : 'false');
        updateStatus();
      });
      grid.appendChild(card);
    }
    updateStatus();
  };

  const applyDestination = (id: string | null, label: string) => {
    if (targetKind === 'collection' && !id) return;
    destination = { id, label, ready: targetKind === 'folder' || Boolean(id) };
    destLabel.textContent = label;
    destTree.hidden = true;
    void rememberBatchTarget(targetKind, id);
  };

  const renderDestinationList = () => {
    const parent = parentInfoForLevel(level, context);
    destBar.replaceChildren();
    if (parent.showBack) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'dest-back';
      back.innerHTML = icon('back');
      back.title = '返回';
      back.setAttribute('aria-label', '返回');
      back.addEventListener('click', () => {
        level = parent.backTarget;
        renderDestinationList();
      });
      destBar.append(back);
    }
    const parentButton = document.createElement('button');
    parentButton.type = 'button';
    parentButton.className = 'dest-name';
    const libraryRoot = parent.folderId === null && parent.path === '根目录';
    const canSaveHere = parent.saveEnabled !== false && (typeof parent.folderId === 'string' || libraryRoot);
    const parentLabel = canSaveHere
      ? (parent.folderId
        ? destinationLabel(parent.folderId, nodes, context.libraryDisplayName)
        : `${context.libraryDisplayName} · 根目录`)
      : (parent.saveEnabled === false ? '选择一个合集' : parent.path.split('/').join(' / '));
    parentButton.textContent = parentLabel;
    parentButton.disabled = !canSaveHere;
    parentButton.addEventListener('click', () => {
      if (!canSaveHere) return;
      applyDestination(parent.folderId, parentLabel);
    });
    destBar.append(parentButton);

    destList.replaceChildren();
    for (const item of itemsForLevel(level, context)) {
      if (item.kind === 'separator') {
        const separator = document.createElement('div');
        separator.className = 'dest-sep';
        destList.append(separator);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'dest-row';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'dest-name';
      name.textContent = item.label;
      const canSave = typeof item.folderId === 'string' && item.folderId.length > 0;
      name.addEventListener('click', () => {
        if (canSave && item.folderId) {
          applyDestination(
            item.folderId,
            destinationLabel(item.folderId, nodes, context.libraryDisplayName),
          );
          return;
        }
        if (item.target) {
          level = item.target;
          renderDestinationList();
        }
      });
      row.append(name);
      if (item.expandable && item.target) {
        const drill = document.createElement('button');
        drill.type = 'button';
        drill.className = 'dest-drill';
        drill.innerHTML = icon('drill');
        drill.setAttribute('aria-label', `进入${item.label}`);
        const target = item.target;
        drill.addEventListener('click', () => {
          level = target;
          renderDestinationList();
        });
        row.append(drill);
      }
      destList.append(row);
    }
  };

  const refresh = (selectNew: boolean) => {
    const previous = new Set(items.map((item) => item.key));
    items = collectPageMedia(document, filter.preferHd);
    if (selectNew) {
      for (const item of items) {
        if (!previous.has(item.key) && mediaPassesFilter(item, filter)) selected.add(item.key);
      }
    }
    render();
  };

  const persist = () => {
    void writeBatchFilter(filter);
  };

  const renderFormats = () => {
    formatRow.replaceChildren();
    for (const format of BATCH_FORMATS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = format;
      button.classList.toggle('is-on', filter.formats.includes(format));
      button.addEventListener('click', () => {
        const next = new Set(filter.formats);
        if (next.has(format)) next.delete(format);
        else next.add(format);
        filter = { ...filter, formats: BATCH_FORMATS.filter((entry) => next.has(entry)) };
        button.classList.toggle('is-on', filter.formats.includes(format));
        persist();
        render();
      });
      formatRow.appendChild(button);
    }
  };

  edgeInput.addEventListener('change', () => {
    const value = Number(edgeInput.value);
    filter = {
      ...filter,
      minEdge: Number.isFinite(value) ? Math.max(0, Math.min(8000, Math.floor(value))) : 0,
    };
    edgeInput.value = String(filter.minEdge);
    persist();
    render();
  });

  hdButton.addEventListener('click', () => {
    filter = { ...filter, preferHd: !filter.preferHd };
    hdButton.classList.toggle('is-on', filter.preferHd);
    persist();
    refresh(true);
  });

  const stopDetect = () => {
    detecting = false;
    observer?.disconnect();
    observer = null;
    detectButton.classList.remove('is-on');
  };

  detectButton.addEventListener('click', () => {
    if (detecting) {
      stopDetect();
      return;
    }
    detecting = true;
    detectButton.classList.add('is-on');
    observer = new MutationObserver((records) => {
      const outsidePanel = records.some((record) => {
        const target = record.target;
        const element = target instanceof Element ? target : target.parentElement;
        return element ? !element.closest('[data-serpent-ui]') : true;
      });
      if (!outsidePanel) return;
      window.clearTimeout(detectTimer);
      detectTimer = window.setTimeout(() => refresh(true), 300);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style'],
    });
  });

  const saveSelected = async (): Promise<void> => {
    const picked = visibleItems().filter((item) => selected.has(item.key)).slice(0, MAX_BATCH);
    if (picked.length === 0) {
      setStatus('没有选中的图片或视频');
      return;
    }
    if (!destination.ready || (targetKind === 'collection' && !destination.id)) {
      setStatus('请选择一个合集');
      destTree.hidden = false;
      renderDestinationList();
      return;
    }
    setStatus(`正在下载 1 / ${picked.length}`);
    const token = beginBatchProgress(picked.length);
    saveButton.disabled = true;
    let response: { message?: string } | undefined;
    try {
      response = await send<{ saved: number; failed: number; message: string }>({
        type: 'serpent-save-batch',
        token,
        sourcePageUrl: window.location.href,
        ...(targetKind === 'folder' ? { targetFolderId: destination.id } : {}),
        ...(targetKind === 'collection' && destination.id
          ? { targetFolderId: null, targetCollectionId: destination.id }
          : {}),
        items: picked.map((item) => ({ kind: item.kind, mediaUrl: item.saveUrl })),
      });
    } catch {
      response = { message: '保存失败' };
    }
    saveButton.disabled = false;
    if (progressToken !== token) return;
    endBatchProgress();
    setStatus(response?.message || '保存结束');
  };

  onDocClick = (event: MouseEvent) => {
    if (destTree.hidden) return;
    const insideDest = event.composedPath().some(
      (node) => node instanceof Element && node.classList.contains('dest'),
    );
    if (!insideDest) destTree.hidden = true;
  };
  document.addEventListener('click', onDocClick, true);

  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'close') closePanel();
    else if (action === 'all') {
      for (const item of visibleItems()) selected.add(item.key);
      render();
    } else if (action === 'none') {
      for (const item of visibleItems()) selected.delete(item.key);
      render();
    } else if (action === 'save') {
      if (!batchSaving) void saveSelected();
    } else if (action === 'dest-toggle') {
      destTree.hidden = !destTree.hidden;
      if (!destTree.hidden) renderDestinationList();
    }
  });

  onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  };
  window.addEventListener('keydown', onKey, true);

  const syncDestinationChrome = () => {
    destKind.value = targetKind;
    destIcon.innerHTML = icon(targetKind === 'collection' ? 'layers' : 'folder');
    destLabel.textContent = destination.label;
  };

  let targetLoad = 0;
  const loadTargets = async (): Promise<void> => {
    const generation = ++targetLoad;
    const listed = await send<FolderListResponse | { kind: string; targetKind?: string }>({
      type: 'serpent-list-folders',
    }).catch(() => ({ kind: 'error' as const }));
    if (generation !== targetLoad) return;
    if (listed.kind === 'ok' && 'folders' in listed) {
      targetKind = listed.targetKind === 'collection' ? 'collection' : 'folder';
      const tree = buildFolderTree(listed.folders);
      nodes = tree.byId;
      const hints = buildSaveMenuFolderHints(
        listed.folders,
        Array.isArray(listed.recentFolderIds) ? listed.recentFolderIds : [],
        Array.isArray(listed.recentBrowsedFolderIds) ? listed.recentBrowsedFolderIds : [],
      );
      const recentIds = pickTreeRecentFolderIds(hints.savedRecentIds, hints.browsedRecentIds);
      const libraryDisplayName = listed.libraryDisplayName?.trim() || 'Serpent';
      context = {
        roots: tree.roots,
        recentFolders: recentIds
          .map((folderId) => tree.byId.get(folderId))
          .filter((node): node is FolderNode => node !== undefined),
        libraryDisplayName,
        rootSaveEnabled: targetKind !== 'collection',
      };
      const memory = await readBatchTarget();
      if (generation !== targetLoad) return;
      const side = targetKind === 'collection' ? memory.collection : memory.folder;
      destination = chooseInitialDestination({
        kind: targetKind,
        known: side.known,
        memoryId: side.id,
        nodes,
        recentIds,
        libraryDisplayName,
      });
    } else {
      nodes = new Map();
      const failedKind = 'targetKind' in listed ? listed.targetKind : undefined;
      targetKind = failedKind === 'collection' ? 'collection' : 'folder';
      context = {
        roots: [],
        recentFolders: [],
        libraryDisplayName: 'Serpent',
        rootSaveEnabled: targetKind !== 'collection',
      };
      destination = targetKind === 'collection'
        ? { id: null, label: '无法读取合集', ready: false }
        : { id: null, label: 'Serpent · 根目录', ready: true };
    }
    syncDestinationChrome();
    if (!destTree.hidden) renderDestinationList();
  };

  let kindWrite = 0;
  destKind.addEventListener('change', () => {
    const next = destKind.value === 'collection' ? 'collection' : 'folder';
    if (next === targetKind) return;
    const generation = ++kindWrite;
    level = { kind: 'root' };
    destTree.hidden = true;
    destLabel.textContent = '正在读取…';
    void (async () => {
      await writeSaveTargetKind(next);
      if (generation !== kindWrite) return;
      await loadTargets();
    })();
  });

  void (async () => {
    filter = await readBatchFilter();
    edgeInput.value = String(filter.minEdge);
    hdButton.classList.toggle('is-on', filter.preferHd);
    renderFormats();
    await loadTargets();
    items = collectPageMedia(document, filter.preferHd);
    selected = seedSelection(items, (item) => mediaPassesFilter(item, filter));
    render();
  })();
}
