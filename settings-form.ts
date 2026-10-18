import browser from 'webextension-polyfill';

import {
  DRAG_RADIAL_MENU_ENABLED_KEY,
  dragRadialMenuEnabledFromStored,
  FOCUS_APP_AFTER_SAVE_KEY,
  focusAppAfterSaveFromStored,
  NOTIFICATIONS_ENABLED_KEY,
  notificationsEnabledFromStored,
  REVEAL_IN_LIBRARY_AFTER_SAVE_KEY,
  revealInLibraryAfterSaveFromStored,
  SAVE_TARGET_KIND_KEY,
  saveTargetKindFromStored,
  writeDragRadialMenuEnabled,
  writeFocusAppAfterSave,
  writeNotificationsEnabled,
  writeRevealInLibraryAfterSave,
  writeSaveTargetKind,
  type SaveTargetKind,
} from './preferences';

function setStatus(message: string): void {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.kind = 'success';
}

function bindToggle(
  checkbox: HTMLInputElement | null,
  write: (enabled: boolean) => Promise<void>,
): void {
  checkbox?.addEventListener('change', () => {
    void write(checkbox.checked).then(() => {
      setStatus('已保存');
    });
  });
}

function bindSaveTarget(radio: HTMLInputElement | null, kind: SaveTargetKind): void {
  radio?.addEventListener('change', () => {
    if (!radio.checked) return;
    void writeSaveTargetKind(kind).then(() => {
      setStatus('已保存');
    });
  });
}

/** 选项页与工具栏弹出面板共用同一组控件 id。 */
export function bindExtensionSettings(): void {
  const notificationsCheckbox = document.getElementById(
    'notifications-enabled',
  ) as HTMLInputElement | null;
  const focusAppCheckbox = document.getElementById(
    'focus-app-after-save',
  ) as HTMLInputElement | null;
  const revealInLibraryCheckbox = document.getElementById(
    'reveal-in-library-after-save',
  ) as HTMLInputElement | null;
  const dragRadialMenuCheckbox = document.getElementById(
    'drag-radial-menu-enabled',
  ) as HTMLInputElement | null;
  const saveTargetFolderRadio = document.getElementById(
    'save-target-folder',
  ) as HTMLInputElement | null;
  const saveTargetCollectionRadio = document.getElementById(
    'save-target-collection',
  ) as HTMLInputElement | null;

  bindSaveTarget(saveTargetFolderRadio, 'folder');
  bindSaveTarget(saveTargetCollectionRadio, 'collection');
  bindToggle(notificationsCheckbox, writeNotificationsEnabled);
  bindToggle(focusAppCheckbox, writeFocusAppAfterSave);
  bindToggle(revealInLibraryCheckbox, writeRevealInLibraryAfterSave);
  bindToggle(dragRadialMenuCheckbox, writeDragRadialMenuEnabled);

  void browser.storage.sync.get([
    NOTIFICATIONS_ENABLED_KEY,
    FOCUS_APP_AFTER_SAVE_KEY,
    REVEAL_IN_LIBRARY_AFTER_SAVE_KEY,
    DRAG_RADIAL_MENU_ENABLED_KEY,
    SAVE_TARGET_KIND_KEY,
  ]).then((values) => {
    if (notificationsCheckbox) {
      notificationsCheckbox.checked = notificationsEnabledFromStored(
        values[NOTIFICATIONS_ENABLED_KEY],
      );
    }
    if (focusAppCheckbox) {
      focusAppCheckbox.checked = focusAppAfterSaveFromStored(
        values[FOCUS_APP_AFTER_SAVE_KEY],
      );
    }
    if (revealInLibraryCheckbox) {
      revealInLibraryCheckbox.checked = revealInLibraryAfterSaveFromStored(
        values[REVEAL_IN_LIBRARY_AFTER_SAVE_KEY],
      );
    }
    if (dragRadialMenuCheckbox) {
      dragRadialMenuCheckbox.checked = dragRadialMenuEnabledFromStored(
        values[DRAG_RADIAL_MENU_ENABLED_KEY],
      );
    }
    const saveTargetKind = saveTargetKindFromStored(values[SAVE_TARGET_KIND_KEY]);
    if (saveTargetFolderRadio) saveTargetFolderRadio.checked = saveTargetKind === 'folder';
    if (saveTargetCollectionRadio) {
      saveTargetCollectionRadio.checked = saveTargetKind === 'collection';
    }
  });
}
