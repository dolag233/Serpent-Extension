import browser from 'webextension-polyfill';

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
