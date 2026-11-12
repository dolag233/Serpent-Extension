export const PREFER_ORIGINAL_MEDIA_KEY = 'preferOriginalMedia';
export const BATCH_FILTER_KEY = 'serpentBatchFilter';

export interface SyncStorageLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export function preferOriginalMediaFromStored(value: unknown): boolean {
  return value !== false;
}

/** Migrate the old batch-only preference once while preserving all other filter fields. */
export async function migratePreferOriginalMedia(
  storage: SyncStorageLike,
): Promise<boolean> {
  const values = await storage.get([PREFER_ORIGINAL_MEDIA_KEY, BATCH_FILTER_KEY]);
  if (Object.hasOwn(values, PREFER_ORIGINAL_MEDIA_KEY)) {
    const current = preferOriginalMediaFromStored(values[PREFER_ORIGINAL_MEDIA_KEY]);
    if (typeof values[PREFER_ORIGINAL_MEDIA_KEY] !== 'boolean') {
      await storage.set({ [PREFER_ORIGINAL_MEDIA_KEY]: current });
    }
    return current;
  }

  const legacy = values[BATCH_FILTER_KEY];
  const legacyValue = legacy && typeof legacy === 'object'
    ? Reflect.get(legacy, 'preferHd')
    : undefined;
  const migrated = typeof legacyValue === 'boolean' ? legacyValue : true;
  await storage.set({ [PREFER_ORIGINAL_MEDIA_KEY]: migrated });
  return migrated;
}
