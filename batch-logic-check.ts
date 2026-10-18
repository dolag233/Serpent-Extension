import {
  batchTargetFromStored,
  chooseInitialDestination,
  countSelected,
  formatBatchStatus,
  seedSelection,
} from './batch-model';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const nodes = new Map([
  ['folder-a', { name: '参考', path: '设计/参考' }],
  ['folder-b', { name: '截图', path: '截图' }],
  ['col-1', { name: '灵感', path: '灵感' }],
]);

const stored = batchTargetFromStored({ folderId: null, collectionId: 'col-1' });
assert(stored.folder.known && stored.folder.id === null, '根目录记忆要保留 null');
assert(stored.collection.known && stored.collection.id === 'col-1', '合集记忆要读出 id');
assert(!batchTargetFromStored(undefined).folder.known, '空存储不算已记住');

const rememberedRoot = chooseInitialDestination({
  kind: 'folder',
  known: true,
  memoryId: null,
  nodes,
  recentIds: ['folder-a'],
  libraryDisplayName: '资料库',
});
assert(rememberedRoot.id === null && rememberedRoot.ready, '记住的根目录不应被最近项覆盖');
assert(rememberedRoot.label === '资料库 · 根目录', '根目录标签应带资源库名');

const rememberedFolder = chooseInitialDestination({
  kind: 'folder',
  known: true,
  memoryId: 'folder-a',
  nodes,
  recentIds: ['folder-b'],
  libraryDisplayName: '资料库',
});
assert(rememberedFolder.id === 'folder-a', '有效记忆优先于最近项');
assert(rememberedFolder.label === '设计 / 参考', '路径用空格斜杠展示');

const stale = chooseInitialDestination({
  kind: 'folder',
  known: true,
  memoryId: 'missing',
  nodes,
  recentIds: ['folder-b'],
  libraryDisplayName: '资料库',
});
assert(stale.id === 'folder-b', '失效记忆退回最近项');

const freshFolder = chooseInitialDestination({
  kind: 'folder',
  known: false,
  memoryId: null,
  nodes,
  recentIds: [],
  libraryDisplayName: '资料库',
});
assert(freshFolder.id === null && freshFolder.ready, '文件夹模式默认可保存到根目录');

const freshCollection = chooseInitialDestination({
  kind: 'collection',
  known: false,
  memoryId: null,
  nodes,
  recentIds: [],
  libraryDisplayName: '资料库',
});
assert(!freshCollection.ready && freshCollection.id === null, '合集模式未选择时不能保存');

const recentCollection = chooseInitialDestination({
  kind: 'collection',
  known: false,
  memoryId: null,
  nodes,
  recentIds: ['col-1'],
  libraryDisplayName: '资料库',
});
assert(recentCollection.id === 'col-1' && recentCollection.ready, '合集模式用最近合集作为默认');

const items = [
  { key: 'a' },
  { key: 'b' },
  { key: 'c' },
  { key: 'tiny' },
];
const selected = seedSelection(items, (item) => item.key !== 'tiny');
const shown = items.filter((item) => item.key !== 'tiny');
const picked = countSelected(shown, selected);
assert(picked === 3 && shown.length === 3, '默认应选中全部通过筛选的项');
assert(formatBatchStatus(picked, shown.length) === '已选 3 / 3', '计数应与可见选中项一致');
assert(countSelected(shown, new Set()) === 0, '空选择才是 0');
assert(formatBatchStatus(0, shown.length) === '已选 0 / 3', '未选中时分子为 0');

console.log('batch-logic-check ok');
