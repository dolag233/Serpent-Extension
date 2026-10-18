export const BATCH_TARGET_KEY = 'serpentBatchTarget';

export type BatchTargetSide = {
  readonly known: boolean;
  readonly id: string | null;
};

export type BatchTargetState = {
  readonly folder: BatchTargetSide;
  readonly collection: BatchTargetSide;
};

export type DestinationChoice = {
  readonly id: string | null;
  readonly label: string;
  readonly ready: boolean;
};

type NamedPath = {
  readonly name: string;
  readonly path: string;
};

function readStoredId(
  value: unknown,
  key: string,
): BatchTargetSide {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
    return { known: false, id: null };
  }
  const raw = Reflect.get(value, key);
  if (raw === null) return { known: true, id: null };
  if (typeof raw === 'string' && raw.length > 0) return { known: true, id: raw };
  return { known: false, id: null };
}

export function batchTargetFromStored(value: unknown): BatchTargetState {
  return {
    folder: readStoredId(value, 'folderId'),
    collection: readStoredId(value, 'collectionId'),
  };
}

export function destinationLabel(
  id: string | null,
  nodes: ReadonlyMap<string, NamedPath>,
  libraryDisplayName: string,
): string {
  const library = libraryDisplayName.trim() || 'Serpent';
  if (!id) return `${library} · 根目录`;
  const node = nodes.get(id);
  if (!node) return id;
  return (node.path || node.name).split('/').join(' / ');
}

/**
 * 打开批量面板时的保存位置。
 * 已记住的目标优先；文件夹模式可以记住根目录（id 为 null）。
 * 没有记忆时用最近保存，再退到根目录。合集模式没有根目录这一项。
 */
export function chooseInitialDestination(args: {
  kind: 'folder' | 'collection';
  known: boolean;
  memoryId: string | null;
  nodes: ReadonlyMap<string, NamedPath>;
  recentIds: readonly string[];
  libraryDisplayName: string;
}): DestinationChoice {
  const labelFor = (id: string | null) =>
    destinationLabel(id, args.nodes, args.libraryDisplayName);
  if (args.known && args.memoryId && args.nodes.has(args.memoryId)) {
    return { id: args.memoryId, label: labelFor(args.memoryId), ready: true };
  }
  if (args.known && args.kind === 'folder' && args.memoryId === null) {
    return { id: null, label: labelFor(null), ready: true };
  }
  for (const id of args.recentIds) {
    if (args.nodes.has(id)) {
      return { id, label: labelFor(id), ready: true };
    }
  }
  if (args.kind === 'folder') {
    return { id: null, label: labelFor(null), ready: true };
  }
  return { id: null, label: '选择合集', ready: false };
}

export function seedSelection<T extends { key: string }>(
  items: readonly T[],
  passes: (item: T) => boolean,
): Set<string> {
  const selected = new Set<string>();
  for (const item of items) {
    if (passes(item)) selected.add(item.key);
  }
  return selected;
}

export function countSelected(
  shown: readonly { key: string }[],
  selected: ReadonlySet<string>,
): number {
  let picked = 0;
  for (const item of shown) {
    if (selected.has(item.key)) picked += 1;
  }
  return picked;
}

export function formatBatchStatus(picked: number, shown: number): string {
  return `已选 ${picked} / ${shown}`;
}
