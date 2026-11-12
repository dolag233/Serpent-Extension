import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

let server;
let migration;
let saveClient;
let pageBridgeData;
let dashParser;
let hlsParser;
let segmentedUrl;
let siteResolution;
let pinterestVideoResolution;
let detailResolution;
let hotlinkSites;
let segmentedPreviewFallback;

class FixtureImage {
  constructor(ownerDocument, attributes = {}) {
    this.tagName = 'IMG';
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }));
    this.srcset = attributes.srcset || '';
  }

  closest(selector) {
    let current = this.parentElement;
    while (current) {
      if (current.tagName === 'A' && (selector === 'a' || selector === 'a[href]' || selector.includes('a[href*='))) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  getAttribute(name) {
    return this.attributes.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  }
  querySelectorAll() { return []; }
}

function fixtureAnchor(href, children = []) {
  return {
    tagName: 'A',
    href,
    parentElement: null,
    attributes: [{ name: 'href', value: href }],
    children,
    getAttribute(name) { return name.toLowerCase() === 'href' ? href : null; },
    querySelectorAll(selector) {
      if (selector === 'img,video') return children.flatMap((child) => (
        child.tagName === 'IMG' || child.tagName === 'VIDEO' ? [child] : child.querySelectorAll?.(selector) ?? []
      ));
      if (selector === 'a[href]') return [];
      return [];
    },
  };
}

function fixturePicture(image, srcsets = []) {
  const sources = srcsets.map((srcset) => ({
    tagName: 'SOURCE',
    srcset,
    getAttribute(name) { return name.toLowerCase() === 'srcset' ? srcset : null; },
  }));
  return {
    tagName: 'PICTURE',
    parentElement: null,
    attributes: [],
    children: [image, ...sources],
    getAttribute() { return null; },
    querySelectorAll(selector) {
      if (selector === 'source[srcset]') return sources;
      if (selector === 'img,video') return [image];
      if (selector === 'a[href]') return [];
      return [];
    },
  };
}

function fixtureContainer(children = [], anchors = []) {
  return {
    tagName: 'DIV',
    parentElement: null,
    attributes: [],
    children,
    anchors,
    getAttribute() { return null; },
    querySelectorAll(selector) {
      if (selector === 'img,video') return children.flatMap((child) => (
        child.tagName === 'IMG' || child.tagName === 'VIDEO' ? [child] : child.querySelectorAll?.(selector) ?? []
      ));
      if (selector === 'a[href]') return anchors;
      return [];
    },
  };
}

class FixtureScript {
  constructor(textContent, id = '') {
    this.textContent = textContent;
    this.id = id;
    this.isConnected = true;
  }
}

class FixtureMutationObserver {
  observe() {}
  disconnect() {}
}

Object.assign(globalThis, {
  HTMLImageElement: FixtureImage,
  HTMLScriptElement: FixtureScript,
  MutationObserver: FixtureMutationObserver,
});

before(async () => {
  server = await createServer({
    configFile: false,
    root: process.cwd(),
    resolve: { alias: { 'webextension-polyfill': fileURLToPath(new URL('./webextension-polyfill-stub.mjs', import.meta.url)) } },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  migration = await server.ssrLoadModule('/media-resolution/preferences.ts');
  pageBridgeData = await server.ssrLoadModule('/media-resolution/page-bridge-data.ts');
  dashParser = await server.ssrLoadModule('/segmented-dash.ts');
  hlsParser = await server.ssrLoadModule('/segmented-hls.ts');
  segmentedUrl = await server.ssrLoadModule('/segmented-url.ts');
  siteResolution = await server.ssrLoadModule('/media-resolution/resolve.ts');
  pinterestVideoResolution = await server.ssrLoadModule('/media-resolution/pinterest-video.ts');
  detailResolution = await server.ssrLoadModule('/media-resolution/detail.ts');
  hotlinkSites = await server.ssrLoadModule('/hotlink-sites.ts');
  segmentedPreviewFallback = await server.ssrLoadModule('/media-resolution/segmented-preview-fallback.ts');
});

after(async () => {
  await server?.close();
});

function storageStub(initial) {
  const values = structuredClone(initial);
  const writes = [];
  return {
    values,
    writes,
    async get() { return structuredClone(values); },
    async set(update) {
      writes.push(structuredClone(update));
      Object.assign(values, structuredClone(update));
    },
  };
}

test('preference migration defaults on and writes the new key once', async () => {
  const storage = storageStub({});
  assert.equal(await migration.migratePreferOriginalMedia(storage), true);
  assert.deepEqual(storage.values, { preferOriginalMedia: true });
  assert.equal(await migration.migratePreferOriginalMedia(storage), true);
  assert.equal(storage.writes.length, 1);
});

test('legacy false migrates while preserving old batch filters', async () => {
  const legacy = { preferHd: false, minEdge: 720, formats: ['png', 'webp'], custom: 'kept' };
  const storage = storageStub({ serpentBatchFilter: legacy });
  assert.equal(await migration.migratePreferOriginalMedia(storage), false);
  assert.equal(storage.values.preferOriginalMedia, false);
  assert.deepEqual(storage.values.serpentBatchFilter, legacy);
});

test('an explicit new preference wins over the legacy value', async () => {
  const storage = storageStub({ preferOriginalMedia: false, serpentBatchFilter: { preferHd: true } });
  assert.equal(await migration.migratePreferOriginalMedia(storage), false);
  assert.equal(storage.writes.length, 0);
});

test('page bridge parsers keep image-search candidates tied to a result id', () => {
  const google = pageBridgeData.parseGoogleImageRecords(String.raw`
    "google-thumb-7",["https:\/\/encrypted-tbn0.gstatic.com/images?q%3Dx",120,80],
    ["https:\/\/images.example/items/7-original.jpg",1600,1200]
  `);
  assert.deepEqual(google, [{
    contentId: 'google-thumb-7',
    urls: ['https://images.example/items/7-original.jpg'],
  }]);

  const ddg = pageBridgeData.parseDuckDuckGoImageRecords(JSON.stringify({ results: [
    { id: 'OIP-result-7', thumbnail: 'https://tse1.mm.bing.net/th?id=OIP-result-7', image: 'https://images.example/ddg/7.jpg' },
    { id: 'OIP-result-8', image: 'https://images.example/ddg/8.jpg' },
  ] }));
  assert.equal(ddg.find((item) => item.contentId === 'OIP-result-7')?.urls[0], 'https://images.example/ddg/7.jpg');
  assert.equal(pageBridgeData.pageBridgeKeyFromPreview(
    'duckduckgo-images',
    'https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Ftse1.mm.bing.net%2Fth%3Fid%3DOIP-result-7',
  ), 'OIP-result-7');

  const yandex = pageBridgeData.parseYandexImageRecords({ initialState: { entities: {
    'entity-7': {
      image: 'https://avatars.mds.yandex.net/i?id=yandex-thumb-7',
      origUrl: 'https://images.example/yandex/7.jpg',
      viewerData: { dups: [{ url: 'https://images.example/yandex/7-dup.jpg' }] },
    },
    'entity-8': {
      image: 'https://avatars.mds.yandex.net/i?id=yandex-thumb-8',
      origUrl: 'https://images.example/yandex/8.jpg',
    },
  } } });
  assert.equal(yandex.find((item) => item.contentId === 'yandex-thumb-7')?.urls.length, 2);
  assert.equal(pageBridgeData.pageBridgeKeyFromPreview(
    'yandex-images',
    'https://avatars.mds.yandex.net/i?id=yandex-thumb-7&n=13',
  ), 'yandex-thumb-7');

  const pageUrl = 'https://www.google.com/search?tbm=isch&q=landscape';
  const request = {
    type: 'serpent-page-bridge-request',
    requestId: 'fixture-request-7',
    adapter: 'google-images',
    contentId: 'google-thumb-7',
    previewUrl: 'https://encrypted-tbn0.gstatic.com/images?q%3Dx',
    pageUrl,
  };
  assert.deepEqual(pageBridgeData.resolvePageBridgeRequest(
    request,
    'google-images',
    pageUrl,
    google,
  ), {
    type: 'serpent-page-bridge-response',
    requestId: 'fixture-request-7',
    adapter: 'google-images',
    contentId: 'google-thumb-7',
    previewUrl: request.previewUrl,
    urls: ['https://images.example/items/7-original.jpg'],
    kind: 'image',
  });
  assert.deepEqual(pageBridgeData.resolvePageBridgeRequest(
    { ...request, contentId: 'missing-result' },
    'google-images',
    pageUrl,
    google,
  )?.urls, []);
  assert.equal(pageBridgeData.resolvePageBridgeRequest(
    request,
    'google-images',
    'https://other.example/page',
    google,
  ), undefined);
});

test('X bridge keeps variants scoped to the selected status and media item', () => {
  const status = (statusId, media) => ({
    rest_id: statusId,
    legacy: { id_str: statusId, extended_entities: { media } },
  });
  const video = (mediaKey, preview, stem, bitrate) => ({
    media_key: mediaKey,
    type: 'video',
    preview_image_url: preview,
    video_info: { variants: [
      { content_type: 'video/mp4', bitrate, url: `https://video.twimg.com/${stem}-720.mp4?tag=1` },
      { content_type: 'video/mp4', bitrate: Math.floor(bitrate / 2), url: `https://video.twimg.com/${stem}-480.mp4?tag=1` },
      { content_type: 'application/x-mpegURL', url: `https://video.twimg.com/${stem}/playlist.m3u8?tag=1` },
      { content_type: 'video/mp4', bitrate: 999999, url: 'https://attacker.example/global-highest.mp4' },
    ] },
  });
  const records = pageBridgeData.parseXStatusVideoRecords({ data: {
    tweetResult: { result: status('42', [
      video('7_100', 'https://pbs.twimg.com/ext_tw_video_thumb/100/pu/img/a.jpg', 'ext_tw_video/100/pu/vid/avc1', 1200000),
      video('7_200', 'https://pbs.twimg.com/ext_tw_video_thumb/200/pu/img/b.jpg', 'ext_tw_video/200/pu/vid/avc1', 800000),
    ]) },
    unrelatedTweet: status('43', [
      video('7_300', 'https://pbs.twimg.com/ext_tw_video_thumb/300/pu/img/c.jpg', 'ext_tw_video/300/pu/vid/avc1', 8000000),
    ]),
  } });
  assert.equal(records.length, 3);

  const pageUrl = 'https://x.com/user/status/42';
  const request = {
    type: 'serpent-page-bridge-request', requestId: 'x-video-fixture',
    adapter: 'x-status-media', contentId: '42', kind: 'video', mediaIndex: 1,
    previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/200/pu/img/b.jpg', pageUrl,
  };
  const selected = pageBridgeData.resolvePageBridgeRequest(request, 'x-status-media', pageUrl, [], records);
  assert.deepEqual(selected?.urls, [
    'https://video.twimg.com/ext_tw_video/200/pu/vid/avc1-720.mp4?tag=1',
    'https://video.twimg.com/ext_tw_video/200/pu/vid/avc1-480.mp4?tag=1',
    'https://video.twimg.com/ext_tw_video/200/pu/vid/avc1/playlist.m3u8?tag=1',
  ]);
  assert.equal(selected?.kind, 'video');
  assert.equal(selected?.mediaIndex, 1);

  const otherStatus = pageBridgeData.resolvePageBridgeRequest({ ...request, contentId: '43' }, 'x-status-media', pageUrl, [], records);
  assert.deepEqual(otherStatus?.urls, [], 'another Tweet cannot contribute a higher bitrate variant');
  const selectedByOrdinal = pageBridgeData.resolvePageBridgeRequest({ ...request, mediaIndex: 0 }, 'x-status-media', pageUrl, [], records);
  assert.equal(selectedByOrdinal?.urls[0], 'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1-720.mp4?tag=1');
  const unknownPreview = pageBridgeData.resolvePageBridgeRequest({
    ...request, mediaIndex: undefined, previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/unknown.jpg',
  }, 'x-status-media', pageUrl, [], records);
  assert.deepEqual(unknownPreview?.urls, [], 'an unknown preview without ordinal or media key is ambiguous');
  const mismatchedMediaKey = pageBridgeData.resolvePageBridgeRequest({
    ...request, mediaIndex: undefined, mediaKey: '7_100',
  }, 'x-status-media', pageUrl, [], records);
  assert.deepEqual(mismatchedMediaKey?.urls, [
    'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1-720.mp4?tag=1',
    'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1-480.mp4?tag=1',
    'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1/playlist.m3u8?tag=1',
  ]);
});

test('X selection derives its status ID and ordinal from the selected Tweet card', () => {
  const pageUrl = 'https://x.com/home';
  const doc = fixtureDocument(pageUrl);
  const anchor = { getAttribute: () => '/person/status/42' };
  const selectedVideo = {
    tagName: 'VIDEO', ownerDocument: doc, attributes: [], parentElement: null,
    querySelectorAll() { return []; },
    closest(selector) {
      if (selector === '[data-testid="tweet"]' || selector === 'article') return tweet;
      if (selector.includes('videoPlayer')) return selectedSlot;
      return null;
    },
    getAttribute() { return null; },
  };
  const otherVideo = { tagName: 'VIDEO' };
  const otherSlot = {
    attributes: [],
    getAttribute: (name) => name === 'data-testid' ? 'videoPlayer' : null,
    querySelectorAll: (selector) => selector === 'img,video' ? [otherVideo] : [],
  };
  const selectedSlot = {
    attributes: [],
    getAttribute: (name) => name === 'data-testid' ? 'videoPlayer' : null,
    querySelectorAll: (selector) => selector === 'img,video' ? [selectedVideo] : [],
  };
  const tweet = {
    attributes: [], parentElement: null,
    getAttribute() { return null; },
    querySelectorAll(selector) {
      if (selector === 'a[href*="/status/"]') return [anchor, anchor];
      if (selector === '[data-testid="tweetPhoto"], [data-testid="videoPlayer"]') return [otherSlot, selectedSlot];
      if (selector === 'img,video') return [otherVideo, selectedVideo];
      return [];
    },
  };
  selectedVideo.parentElement = selectedSlot;
  selectedSlot.parentElement = tweet;
  otherSlot.parentElement = tweet;
  const selection = siteResolution.buildMediaSelection({
    element: selectedVideo,
    kind: 'video',
    previewUrl: 'https://video.twimg.com/ext_tw_video/42/preview.mp4',
    pageUrl,
  });
  assert.equal(selection.contentId, '42');
  assert.equal(selection.mediaIndex, 1);
  assert.equal(selection.siteAdapter, 'x');
  assert.equal(selection.siteCapability, 'page-bridge');
});

test('all 18 site adapters have a source-shaped selected-item fixture', () => {
  const expectedAdapters = [
    'baidu-images', 'bing-images', 'google-images', 'sogou-images', '360-images',
    'yandex-images', 'duckduckgo-images', 'pinterest', 'huaban', 'behance', 'zcool',
    'dribbble', 'artstation', 'xiaohongshu', 'instagram', 'weibo', 'pixiv', 'x',
  ];
  assert.deepEqual(siteResolution.siteAdapterCapabilities().map(({ id }) => id), expectedAdapters);

  const expectCandidate = (selection, url, source, label) => {
    const candidate = selection.candidates.find((item) => item.url === url);
    assert(candidate, `${label}: selected item's candidate should be present`);
    assert.equal(candidate.source, source, `${label}: candidate evidence should be classified`);
  };

  const baiduOriginal = 'https://images.example/items/baidu-42.jpg';
  expectCandidate(
    { candidates: backgroundImageCandidates(
      'https://image.baidu.com/search/index?word=cat',
      'https://image.baidu.com/it/u=https%3A%2F%2Fimages.example%2Fitems%2Fbaidu-42.jpg&fm=253',
    ) },
    baiduOriginal,
    'known-transform',
    'Baidu encoded image proxy',
  );

  const bingOriginal = 'https://images.example/items/bing-42.jpg';
  const bingPreview = 'https://tse1.mm.bing.net/th?id=bing-thumb-42';
  const bing = fixtureSiteSelection({
    adapterPageUrl: 'https://www.bing.com/images/search?q=cat',
    previewUrl: bingPreview,
    attributes: { m: JSON.stringify({ murl: bingOriginal, turl: bingPreview, purl: 'https://source.example/item/42' }) },
  });
  expectCandidate(bing, bingOriginal, 'site-field', 'Bing result murl');

  const sogouPreview = 'https://img01.sogoucdn.com/app/a/10010016/42_thumb.jpg';
  const sogouOriginal = 'https://img01.sogoucdn.com/app/a/10010016/42_original.jpg';
  const sogou = fixtureSiteSelection({
    adapterPageUrl: 'https://pic.sogou.com/pics?query=cat',
    previewUrl: sogouPreview,
    scripts: [new FixtureScript(`window.__INITIAL_STATE__ = ${JSON.stringify({
      searchList: { searchList: [{
        docId: 'sogou-doc-42', index: 2, thumbUrl: sogouPreview,
        picUrl: sogouOriginal, oriPicUrl: sogouOriginal,
      }] },
    })};`)],
  });
  expectCandidate(sogou, sogouOriginal, 'site-field', 'Sogou searchList result');
  assert.equal(sogou.contentId, 'sogou-doc-42');
  assert.equal(sogou.mediaIndex, 2);

  const soPreview = 'https://p0.ssl.qhimg.com/t01/42_thumb.jpg';
  const soOriginal = 'https://p0.ssl.qhimg.com/t01/42.jpg';
  const so = fixtureSiteSelection({
    adapterPageUrl: 'https://image.so.com/i?q=cat',
    previewUrl: soPreview,
    scripts: [new FixtureScript(JSON.stringify({ list: [{
      id: 'so-42', index: 3, thumb: soPreview, img: soOriginal, link: 'https://source.example/42',
    }] }), 'initData')],
  });
  expectCandidate(so, soOriginal, 'site-field', '360 initData result');
  assert.equal(so.contentId, 'so-42');

  const pinterestPreview = 'https://i.pinimg.com/736x/12/34/pin-42.jpg?token=preserved';
  const pinterestOriginal = 'https://i.pinimg.com/originals/12/34/pin-42.jpg?token=preserved';
  expectCandidate(
    { candidates: backgroundImageCandidates('https://www.pinterest.com/pin/42/', pinterestPreview) },
    pinterestOriginal,
    'known-transform',
    'Pinterest pinimg size path',
  );

  for (const { page, previewPath, expectedPath } of [
    {
      page: 'https://www.pinterest.ca/pin/42/',
      previewPath: '60x60_RS',
      expectedPath: 'originals',
    },
    {
      page: 'https://uk.pinterest.co.uk/pin/42/',
      previewPath: '600x315',
      expectedPath: 'originals',
    },
    {
      page: 'https://br.pinterest.com/pin/42/',
      previewPath: '170x',
      expectedPath: 'originals',
    },
  ]) {
    const pathPreview = `https://i.pinimg.com/${previewPath}/12/34/pin-42.jpg`;
    const pathOriginal = `https://i.pinimg.com/${expectedPath}/12/34/pin-42.jpg`;
    assert.equal(siteResolution.siteAdapterForUrl(page), 'pinterest');
    expectCandidate(
      { candidates: backgroundImageCandidates(page, pathPreview) },
      pathOriginal,
      'known-transform',
      `Pinterest ${previewPath} pinimg size path`,
    );
  }
  assert.equal(siteResolution.siteAdapterForUrl('https://evilpinterest.com/pin/42/'), undefined);

  const huabanPreview = 'https://gd-hbimg-edge.huaban.com/huaban-key-42_fw240webp?preview=1';
  const huabanOriginal = 'https://gd-hbimg-edge.huaban.com/huaban-key-42?auth_key=fixture-signature';
  const huaban = fixtureSiteSelection({
    adapterPageUrl: 'https://huaban.com/boards/102625833',
    previewUrl: huabanPreview,
    pinHref: '/pins/42',
    attributes: { srcset: `${huabanPreview.replace('_fw240webp', '_fw480webp')} 2x` },
    scripts: [new FixtureScript(JSON.stringify({ props: { pageProps: { serverSidePins: [
      { pin_id: 42, file: { key: 'huaban-key-42', type: 'image/jpeg', url: huabanOriginal } },
      { pin_id: 43, file: { key: 'other-pin-key', type: 'image/jpeg', url: 'https://gd-hbimg-edge.huaban.com/other-pin-key?auth_key=other' } },
    ] } } }), '__NEXT_DATA__')],
  });
  expectCandidate(huaban, huabanOriginal, 'site-field', 'Huaban selected pin file.url');
  assert.equal(huaban.contentId, '42');
  assert.equal(huaban.candidates.some((candidate) => candidate.url.includes('other-pin-key')), false);
  assert.equal(huaban.candidates.some((candidate) => candidate.url.includes('_fw480webp')), true);
  const unverifiedHuabanCandidates = backgroundImageCandidates(
    'https://huaban.com/boards/42',
    'https://img.huabanimg.com/small/pin-42.jpg?token=preserved',
  );
  assert.deepEqual(unverifiedHuabanCandidates.map((candidate) => candidate.source), ['preview']);

  const lateHuabanPin = fixtureSiteSelection({
    adapterPageUrl: 'https://huaban.com/boards/102625833',
    previewUrl: 'https://gd-hbimg-edge.huaban.com/late-pin-key_fw240webp?auth_key=late-token#preview',
    pinHref: '/pins/44',
  });
  assert.equal(lateHuabanPin.contentId, '44');
  expectCandidate(
    lateHuabanPin,
    'https://gd-hbimg-edge.huaban.com/late-pin-key?auth_key=late-token#preview',
    'known-transform',
    'Huaban late-loaded Pin key transform',
  );

  const huabanMismatchedPreview = fixtureSiteSelection({
    adapterPageUrl: 'https://huaban.com/boards/102625833',
    previewUrl: 'https://gd-hbimg-edge.huaban.com/another-pin-key_fw240webp?preview=1',
    pinHref: '/pins/42',
    scripts: [new FixtureScript(JSON.stringify({ props: { pageProps: { serverSidePins: [
      { pin_id: 42, file: { key: 'huaban-key-42', url: huabanOriginal } },
    ] } } }), '__NEXT_DATA__')],
  });
  assert.equal(huabanMismatchedPreview.candidates.some((candidate) => candidate.url === huabanOriginal), false);

  const behancePreview = 'https://mir-s3-cdn-cf.behance.net/project_modules/max_808/asset-42.png';
  const behanceOriginal = 'https://mir-s3-cdn-cf.behance.net/project_modules/source/asset-42.png';
  expectCandidate(
    { candidates: backgroundImageCandidates('https://www.behance.net/gallery/42', behancePreview) },
    behanceOriginal,
    'known-transform',
    'Behance source module path',
  );
  const behanceCoverTransformPreview = 'https://mir-s3-cdn-cf.behance.net/projects/404/cover-42.jpg';
  const behanceCoverTransform = backgroundImageCandidates(
    'https://www.behance.net/gallery/42',
    behanceCoverTransformPreview,
  );
  expectCandidate(
    { candidates: behanceCoverTransform },
    'https://mir-s3-cdn-cf.behance.net/projects/original/cover-42.jpg',
    'known-transform',
    'Behance cover path stays in the project cover family',
  );
  assert.equal(behanceCoverTransform.some((candidate) => candidate.url.includes('/project_modules/')), false);

  const behanceProjectId = '248952145';
  const behanceCoverPreview = 'https://mir-s3-cdn-cf.behance.net/projects/max_808_webp/4a0741248952145.Y3JvcCw3NTksNTk0LDMyOSwyMjM.jpg';
  const behanceCoverOriginal = 'https://mir-s3-cdn-cf.behance.net/projects/original/4a0741248952145.Y3JvcCw3NTksNTk0LDMyOSwyMjM.jpg';
  const behanceCoverOriginalWebp = 'https://mir-s3-cdn-cf.behance.net/projects/original_webp/4a0741248952145.Y3JvcCw3NTksNTk0LDMyOSwyMjM.jpg';
  const behanceModulePreview = 'https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/cec024248952145.69fcc1052be55.jpg';
  const behanceModuleSource = 'https://mir-s3-cdn-cf.behance.net/project_modules/source/cec024248952145.69fcc1052be55.jpg';
  const behanceModuleMax = 'https://mir-s3-cdn-cf.behance.net/project_modules/max_3840_webp/cec024248952145.69fcc1052be55.jpg';
  const behanceModuleFsLow = 'https://mir-s3-cdn-cf.behance.net/project_modules/fs_webp/cec024248952145.69fcc1052be55.jpg';
  const behanceModuleLower = 'https://mir-s3-cdn-cf.behance.net/project_modules/1200_webp/cec024248952145.69fcc1052be55.jpg';
  const behanceModuleOtherOrigin = 'https://assets.behance.net/project_modules/source/cec024248952145.69fcc1052be55.jpg';
  const behanceModuleOtherExtension = 'https://mir-s3-cdn-cf.behance.net/project_modules/source/cec024248952145.69fcc1052be55.png';
  const behanceModuleOtherCase = 'https://mir-s3-cdn-cf.behance.net/project_modules/source/CEC024248952145.69fcc1052be55.jpg';
  const behanceModuleOtherFamily = 'https://mir-s3-cdn-cf.behance.net/projects/original/cec024248952145.69fcc1052be55.jpg';
  const behanceState = {
    project: { project: {
      id: Number(behanceProjectId),
      covers: { allAvailable: [
        { url: behanceCoverOriginal, type: 'JPG', width: null },
        { url: behanceCoverOriginalWebp, type: 'WEBP', width: null },
      ] },
      modules: [
        { id: 1441502389, projectId: Number(behanceProjectId), __typename: 'ImageModule', src: 'https://mir-s3-cdn-cf.behance.net/project_modules/disp/cec024248952145.69fcc1052be55.jpg', imageSizes: { allAvailable: [
          { url: behanceModuleFsLow, width: 1600, type: 'WEBP' },
          { url: behanceModuleLower, width: 1200, type: 'WEBP' },
          { url: 'https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/cec024248952145.69fcc1052be55.jpg', width: 1400, type: 'WEBP' },
          { url: behanceModuleMax, width: 3000, type: 'WEBP' },
          { url: behanceModuleSource, width: 1000, type: 'JPG' },
          { url: behanceModuleOtherOrigin, width: 5000, type: 'JPG' },
          { url: behanceModuleOtherExtension, width: 5000, type: 'JPG' },
          { url: behanceModuleOtherCase, width: 5000, type: 'JPG' },
          { url: behanceModuleOtherFamily, width: 5000, type: 'JPG' },
        ] } },
        { id: 1441502377, projectId: Number(behanceProjectId), __typename: 'ImageModule', imageSizes: { allAvailable: [
          { url: `${behanceModuleSource}?other-module=1`, width: 3000, type: 'JPG' },
        ] } },
        { id: 1441502400, projectId: Number(behanceProjectId), __typename: 'TextModule', imageSizes: { allAvailable: [
          { url: 'https://cdn.example.invalid/project_modules/source/cec024248952145.69fcc1052be55.jpg', width: 9000, type: 'JPG' },
        ] } },
      ],
    } },
  };
  const behanceScript = new FixtureScript(JSON.stringify(behanceState), 'beconfig-store_state');
  const behanceCover = fixtureSiteSelection({
    adapterPageUrl: 'https://www.behance.net/',
    previewUrl: behanceCoverPreview,
    scripts: [behanceScript],
    pictureSrcsets: [
      `${behanceCoverPreview} 1x, https://mir-s3-cdn-cf.behance.net/projects/404_webp/4a0741248952145.Y3JvcCw3NTksNTk0LDMyOSwyMjM.jpg 0.5x`,
    ],
    coverLinks: [
      `/gallery/${behanceProjectId}/Festival-Compana-2025-Visual-Identity?tracking_source=feed`,
      `/gallery/${behanceProjectId}/Festival-Compana-2025-Visual-Identity?tracking_source=cover`,
    ],
  });
  assert.equal(behanceCover.siteAdapter, 'behance');
  assert.equal(behanceCover.contentId, `behance:${behanceProjectId}:cover`);
  assert.deepEqual(
    behanceCover.candidates.filter((candidate) => candidate.source === 'site-field').map((candidate) => candidate.url),
    [behanceCoverOriginal, behanceCoverOriginalWebp],
    'the project cover uses the same-filename original cover fields, never a body module source',
  );
  assert.equal(behanceCover.candidates.some((candidate) => candidate.url.includes('/projects/404_webp/')), false,
    'lower-density cover srcset variants are not candidates');
  assert.equal(behanceCover.candidates.some((candidate) => candidate.url.includes('/project_modules/')), false,
    'cover assets cannot resolve through the body-module family');

  const behanceModule = fixtureSiteSelection({
    adapterPageUrl: `https://www.behance.net/gallery/${behanceProjectId}/Festival-Compana-2025-Visual-Identity`,
    previewUrl: behanceModulePreview,
    scripts: [behanceScript],
    anchorHref: `/gallery/${behanceProjectId}/Festival-Compana-2025-Visual-Identity/modules/1441502389`,
    previewWidth: 1400,
    pictureSrcsets: [
      `${behanceModulePreview} 1x, ${behanceModuleLower} 0.8x, ${behanceModuleFsLow} 1.37x, https://mir-s3-cdn-cf.behance.net/project_modules/2800_webp/cec024248952145.69fcc1052be55.jpg 2x, ${behanceModuleMax} 2.14x`,
    ],
  });
  assert.equal(behanceModule.contentId, `behance:${behanceProjectId}:module:1441502389`);
  const behanceModuleFields = behanceModule.candidates.filter((candidate) => candidate.source === 'site-field');
  assert.deepEqual(behanceModuleFields.map((candidate) => candidate.url), [
    behanceModuleSource, behanceModuleMax, behanceModuleFsLow,
  ]);
  assert.equal(behanceModuleFields.every((candidate) => candidate.contentId === behanceModule.contentId), true);
  assert.equal(behanceModule.candidates.some((candidate) => candidate.url === behanceModuleLower), false,
    `a lower state rendition cannot fall back as an upgrade after source failure: ${JSON.stringify(behanceModule.candidates)}`);
  assert.equal(behanceModule.candidates.some((candidate) => candidate.url.includes('?other-module=1')), false,
    'another module with the same file name cannot contribute its URL');
  assert.equal(behanceModule.candidates.some((candidate) => candidate.url.includes('cdn.example.invalid')), false,
    'untrusted CDN origins cannot contribute image variants');
  for (const rejected of [
    behanceModuleOtherOrigin,
    behanceModuleOtherExtension,
    behanceModuleOtherCase,
    behanceModuleOtherFamily,
  ]) {
    assert.equal(behanceModule.candidates.some((candidate) => candidate.url === rejected), false,
      `Behance variants must match the complete same-origin, same-family filename: ${rejected}`);
  }
  assert.equal(behanceModule.candidates.some((candidate) => candidate.url.includes('/project_modules/2800_webp/')), true,
    'the larger srcset entry remains available after state originals fail');
  assert.equal(behanceModule.candidates.some((candidate) => candidate.url.includes('/project_modules/fs_webp/')), true,
    'a density descriptor above currentSrc remains available');
  assert.equal(behanceModule.candidates.filter((candidate) => candidate.url === behanceModulePreview).length, 1);
  assert.equal(behanceModule.candidates.find((candidate) => candidate.url === behanceModulePreview)?.source, 'preview',
    'the exact preview appears only as the last-resort fallback');
  assert.equal(behanceModule.candidates.some((candidate) => (
    candidate.url === behanceModulePreview && candidate.source === 'srcset'
  )), false, 'the current 1x preview descriptor is not retried as an upgrade');

  const zcoolPreview = 'https://img.zcool.cn/community/42_small.jpg';
  const zcoolOriginal = 'https://img.zcool.cn/community/42.jpg';
  const zcool = fixtureSiteSelection({
    adapterPageUrl: 'https://www.zcool.com.cn/work/42.html',
    previewUrl: zcoolPreview,
    scripts: [new FixtureScript(JSON.stringify({ project: { productImages: [{
      id: 'zcool-42', index: 0, url: zcoolPreview, urlBig: zcoolOriginal,
    }] } }), '__NEXT_DATA__')],
  });
  expectCandidate(zcool, zcoolOriginal, 'site-field', 'Zcool productImages item');
  assert.equal(zcool.contentId, 'zcool-42');

  const dribbblePreview = 'https://cdn.dribbble.com/users/42/screenshots/42/asset_teaser.png';
  const dribbbleOriginal = 'https://cdn.dribbble.com/users/42/screenshots/42/asset.png';
  expectCandidate(
    { candidates: backgroundImageCandidates('https://dribbble.com/shots/42', dribbblePreview) },
    dribbbleOriginal,
    'known-transform',
    'Dribbble teaser suffix',
  );

  const dribbbleResized = 'https://cdn.dribbble.com/userupload/example/file/asset.jpg?resize=752x&vertical=center&token=fixture';
  const dribbbleUnscaled = 'https://cdn.dribbble.com/userupload/example/file/asset.jpg?token=fixture';
  const dribbbleDerived = backgroundImageCandidates(
    'https://dribbble.com/shots/42',
    dribbbleResized,
  );
  assert(dribbbleDerived.some((candidate) => candidate.url === dribbbleUnscaled));
  assert.equal(
    backgroundImageCandidates(
      'https://dribbble.com/shots/42',
      'https://cdn.dribbble.com/userupload/example/file/asset.jpg?resize=752x&format=webp&sig=fixture',
    ).some((candidate) => candidate.url === 'https://cdn.dribbble.com/userupload/example/file/asset.jpg?format=webp&sig=fixture'),
    true,
    'remove only the observed resize and its positioning option while preserving unrelated query parameters',
  );

  const artstationPreview = 'https://cdnb.artstation.com/p/assets/images/images/103/967/261/small_square/-adamas-a.jpg?1794372450';
  const artstation8k = 'https://cdnb.artstation.com/p/assets/images/images/103/967/261/8k/-adamas-a.jpg?1794372450';
  const artstation4k = 'https://cdnb.artstation.com/p/assets/images/images/103/967/261/4k/-adamas-a.jpg?1794372450';
  const artstationLarge = 'https://cdna.artstation.com/p/assets/images/images/103/967/261/large/-adamas-a.jpg?1794372450';
  const artstation = fixtureSiteSelection({
    adapterPageUrl: 'https://www.artstation.com/artwork/fixture-project',
    previewUrl: artstationPreview,
    attributes: {
      'data-large': artstationLarge,
      'data-original': 'https://cdnb.artstation.com/p/assets/images/images/999/888/777/original/another-asset.jpg?wrong=1',
    },
  });
  expectCandidate(artstation, artstation8k, 'known-transform', 'ArtStation small_square to 8k');
  expectCandidate(artstation, artstation4k, 'known-transform', 'ArtStation small_square to 4k');
  expectCandidate(artstation, artstationLarge, 'site-field', 'ArtStation small_square to large');
  assert.equal(artstation.contentId, undefined, 'ArtStation asset URLs identify the selected image independently of project slug');
  assert.equal(artstation.candidates.some((candidate) => candidate.url.includes('another-asset.jpg')), false);
  assert(artstation.candidates.every((candidate) => candidate.mediaKey === artstation.candidates[0]?.mediaKey));

  const datedSmall = 'https://cdnb.artstation.com/p/assets/images/images/103/949/088/20261110084147/smaller_square/fixture-date.jpg?sig=kept';
  const dated8k = 'https://cdnb.artstation.com/p/assets/images/images/103/949/088/20261110084147/8k/fixture-date.jpg?sig=kept';
  const datedSelection = fixtureSiteSelection({
    adapterPageUrl: 'https://www.artstation.com/artwork/fixture-project',
    previewUrl: datedSmall,
  });
  expectCandidate(datedSelection, dated8k, 'known-transform', 'ArtStation smaller_square with dated folder');

  const artstationLargePreview = 'https://cdna.artstation.com/p/assets/images/images/065/951/556/large/chenshuli-01-ue5a.jpg?1691640211';
  const artstationLargeSelection = fixtureSiteSelection({
    adapterPageUrl: 'https://www.artstation.com/artwork/fixture-project',
    previewUrl: artstationLargePreview,
  });
  assert(artstationLargeSelection.candidates.some((candidate) => candidate.url
    === 'https://cdna.artstation.com/p/assets/images/images/065/951/556/8k/chenshuli-01-ue5a.jpg?1691640211'));
  assert(artstationLargeSelection.candidates.some((candidate) => candidate.url
    === 'https://cdna.artstation.com/p/assets/images/images/065/951/556/4k/chenshuli-01-ue5a.jpg?1691640211'));
  assert.equal(artstationLargeSelection.candidates.some((candidate) => (
    candidate.url === artstationLargePreview && candidate.source !== 'preview'
  )), false);
  assert.deepEqual(
    backgroundImageCandidates('https://www.artstation.com/artwork/fixture',
      'https://cdnb.artstation.com/p/assets/images/images/1/2/3/8k/fixture.jpg?token=kept')
      .map((candidate) => candidate.url),
    ['https://cdnb.artstation.com/p/assets/images/images/1/2/3/8k/fixture.jpg?token=kept'],
    'an 8k preview must not produce a lower 4k or large candidate',
  );
  assert.deepEqual(
    backgroundImageCandidates('https://www.artstation.com/artwork/fixture',
      'https://cdnb.artstation.com/p/assets/images/images/1/2/3/4k/fixture.jpg?token=kept')
      .map((candidate) => candidate.url),
    [
      'https://cdnb.artstation.com/p/assets/images/images/1/2/3/8k/fixture.jpg?token=kept',
      'https://cdnb.artstation.com/p/assets/images/images/1/2/3/4k/fixture.jpg?token=kept',
    ],
    'a 4k preview may only try 8k before falling back to itself',
  );
  assert.equal(backgroundImageCandidates('https://www.artstation.com/artwork/fixture',
    'https://cdnb.artstation.com.evil.test/p/assets/images/images/1/2/3/small_square/fixture.jpg')
    .some((candidate) => candidate.source !== 'preview'), false);
  assert.equal(siteResolution.siteAdapterForUrl('https://evilartstation.com/artwork/42'), undefined);

  const xhsPreview = 'https://sns-img-bd.xhscdn.com/42_small.jpg';
  const xhsOriginal = 'https://sns-img-bd.xhscdn.com/42.jpg';
  const xhs = fixtureSiteSelection({
    adapterPageUrl: 'https://www.xiaohongshu.com/explore/42',
    previewUrl: xhsPreview,
    scripts: [new FixtureScript(`window.__INITIAL_STATE__ = ${JSON.stringify({ noteData: {
      noteId: 'xhs-42', imageList: [{ id: 'xhs-image-42', index: 0, url: xhsPreview, original: xhsOriginal }],
    } })};`)],
  });
  expectCandidate(xhs, xhsOriginal, 'site-field', 'Xiaohongshu imageList item');
  assert.equal(xhs.contentId, 'xhs-image-42');

  const instagramPreview = 'https://scontent.example.net/media/42_small.jpg';
  const instagramOriginal = 'https://scontent.example.net/media/42.jpg';
  const instagram = fixtureSiteSelection({
    adapterPageUrl: 'https://www.instagram.com/p/42/',
    previewUrl: instagramPreview,
    scripts: [new FixtureScript(`window._sharedData = ${JSON.stringify({
      pk: 'instagram-42', display_url: instagramPreview,
      image_versions2: { candidates: [{ url: instagramOriginal }] },
    })};`)],
  });
  expectCandidate(instagram, instagramOriginal, 'site-field', 'Instagram selected media object');
  assert.equal(instagram.contentId, 'instagram-42');

  const weiboPreview = 'https://wx4.sinaimg.cn/thumb180/42.jpg?token=preserved';
  const weiboOriginal = 'https://wx4.sinaimg.cn/large/42.jpg?token=preserved';
  expectCandidate(
    { candidates: backgroundImageCandidates('https://weibo.com/42', weiboPreview) },
    weiboOriginal,
    'known-transform',
    'Weibo Sina image path',
  );

  const pixivPreview = 'https://i.pximg.net/img-master/img/2026/01/01/00/00/00/42_p0_master1200.jpg';
  const pixivOriginal = 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/42_p0.jpg';
  expectCandidate(
    { candidates: backgroundImageCandidates('https://www.pixiv.net/artworks/42', pixivPreview) },
    pixivOriginal,
    'known-transform',
    'Pixiv original page image',
  );

  const xPreview = 'https://pbs.twimg.com/media/Abc42.jpg?format=jpg&name=small';
  const xOriginal = 'https://pbs.twimg.com/media/Abc42.jpg?format=jpg&name=orig';
  expectCandidate(
    { candidates: backgroundImageCandidates('https://x.com/user/status/42', xPreview) },
    xOriginal,
    'known-transform',
    'X original image size parameter',
  );
});

const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WmcAAAAASUVORK5CYII=',
  'base64',
)).buffer;
const videoMp4Buffer = readFileSync(new URL('../test-fixtures/short-valid.mp4', import.meta.url));
const videoMp4 = videoMp4Buffer.buffer.slice(
  videoMp4Buffer.byteOffset,
  videoMp4Buffer.byteOffset + videoMp4Buffer.byteLength,
);

function damageMp4PayloadPreservingBoxes(buffer) {
  const bytes = new Uint8Array(buffer.slice(0));
  let cursor = 0;
  while (cursor + 8 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, bytes.byteLength - cursor);
    let boxSize = view.getUint32(0, false);
    const type = String.fromCharCode(...bytes.subarray(cursor + 4, cursor + 8));
    let headerSize = 8;
    if (boxSize === 1) {
      if (cursor + 16 > bytes.byteLength) break;
      const large = new DataView(bytes.buffer, bytes.byteOffset + cursor + 8, 8);
      boxSize = large.getUint32(4, false);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = bytes.byteLength - cursor;
    }
    if (boxSize < headerSize || cursor + boxSize > bytes.byteLength) break;
    if (type === 'mdat') {
      bytes.fill(0, cursor + headerSize, cursor + boxSize);
      return bytes.buffer;
    }
    cursor += boxSize;
  }
  throw new Error('the real MP4 fixture has no bounded mdat box');
}

function response({ status = 200, contentType = 'image/png', body = png, url = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get(name) {
      if (name.toLowerCase() === 'content-type') return contentType;
      if (name.toLowerCase() === 'content-length') return String(body.byteLength);
      return null;
    } },
    body: null,
    async arrayBuffer() { return body; },
    async text() { return ''; },
    async blob() { return new Blob([body], { type: contentType }); },
  };
}

test('HTTP 202 duplicate marker is bounded, optional, and preserved as an accepted result', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const responseBodies = [
    '{"status":"accepted","duplicate":true}',
    '{"status":"accepted","duplicate":false}',
    'not json',
    '',
    `${' '.repeat(4_097)}{"duplicate":true}`,
  ];
  const intent = {
    kind: 'image',
    sourcePageUrl: 'https://site.example/gallery/item-42',
    mediaUrl: 'https://media.example/image.png',
    preferOriginalMedia: false,
  };
  const behavior = { notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false };

  for (const [index, body] of responseBodies.entries()) {
    const fetchFn = async (input) => {
      const url = String(input);
      if (!url.endsWith('/save-upload')) return response({ url });
      return {
        status: 202,
        ok: true,
        url,
        headers: { get(name) {
          if (name.toLowerCase() === 'content-length') return String(new TextEncoder().encode(body).byteLength);
          return null;
        } },
        body: null,
        async text() { return body; },
        async arrayBuffer() { return new ArrayBuffer(0); },
        async blob() { return new Blob(); },
      };
    };
    const outcome = await saveClient.saveMediaViaBrowser(intent, behavior, fetchFn);
    assert.deepEqual(outcome, {
      kind: 'accepted',
      savedVersion: 'preview',
      ...(index === 0 ? { duplicate: true } : {}),
    });
    if (index === 0) {
      assert.equal(saveClient.notificationForOutcome(outcome).title, '已跳过重复文件');
      assert.match(saveClient.notificationForOutcome(outcome).message, /未重复保存/u);
    }
  }
});

function fixtureDocument(pageUrl, scripts = []) {
  return {
    baseURI: pageUrl,
    location: { href: pageUrl },
    scripts,
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (selector === 'script#initData') return scripts.find((script) => script.id === 'initData') ?? null;
      if (selector === 'script#__NEXT_DATA__') return scripts.find((script) => script.id === '__NEXT_DATA__') ?? null;
      return null;
    },
  };
}

function fixtureSiteSelection({
  adapterPageUrl,
  previewUrl,
  scripts = [],
  attributes = {},
  pinHref,
  anchorHref,
  pictureSrcsets,
  coverLinks = [],
  previewWidth,
  previewHeight,
}) {
  const ownerDocument = fixtureDocument(adapterPageUrl, scripts);
  const image = new FixtureImage(ownerDocument, attributes);
  let mediaRoot = image;
  if (pictureSrcsets) {
    mediaRoot = fixturePicture(image, pictureSrcsets);
    image.parentElement = mediaRoot;
  }
  if (anchorHref) {
    const anchor = fixtureAnchor(new URL(anchorHref, adapterPageUrl).href, [mediaRoot]);
    mediaRoot.parentElement = anchor;
    image.anchor = anchor;
    mediaRoot = anchor;
  }
  if (coverLinks.length > 0) {
    const anchors = coverLinks.map((href) => fixtureAnchor(new URL(href, adapterPageUrl).href));
    const container = fixtureContainer([mediaRoot], anchors);
    mediaRoot.parentElement = container;
    for (const anchor of anchors) anchor.parentElement = container;
  }
  if (pinHref) {
    const pinAnchor = {
      tagName: 'A',
      href: new URL(pinHref, adapterPageUrl).href,
      parentElement: null,
      attributes: [{ name: 'href', value: pinHref }],
      getAttribute(name) { return name === 'href' ? pinHref : null; },
      querySelectorAll(selector) { return selector === 'img,video' ? [image] : []; },
    };
    image.pinAnchor = pinAnchor;
    image.parentElement = pinAnchor;
  }
  return siteResolution.buildMediaSelection({
    element: image,
    kind: 'image',
    previewUrl,
    pageUrl: adapterPageUrl,
    ...(previewWidth ? { previewWidth } : {}),
    ...(previewHeight ? { previewHeight } : {}),
  });
}

function backgroundImageCandidates(pageUrl, previewUrl) {
  const ownerDocument = fixtureDocument(pageUrl);
  return siteResolution.selectionForBackgroundImage(
    { tagName: 'DIV', ownerDocument },
    previewUrl,
    pageUrl,
  ).candidates;
}

function imageIntent(preferOriginalMedia = true) {
  const previewUrl = 'https://media.example/thumb/selected.jpg?preview=1';
  return {
    kind: 'image',
    sourcePageUrl: 'https://site.example/gallery/item-42',
    mediaUrl: previewUrl,
    preferOriginalMedia,
    selection: {
      selectionId: 'selection-1',
      documentId: 'document-1',
      kind: 'image',
      previewUrl,
      pageUrl: 'https://site.example/gallery/item-42',
      contentId: 'item-42',
      candidates: [{
        url: 'https://media.example/full/selected.jpg?quality=original',
        kind: 'image',
        source: 'site-field',
        contentId: 'item-42',
      }],
    },
  };
}

test('Pinterest batch candidates prefer derived originals from resize src and data-srcset fields', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const stem = 'sample-pin';
  const path = `a1/b2/c3/${stem}`;
  const previewUrl = `https://i.pinimg.com/236x/${path}.jpg`;
  const originalUrl = `https://i.pinimg.com/originals/${path}.png`;
  const guessedOriginalUrl = `https://i.pinimg.com/originals/${path}.jpg`;
  const selection = fixtureSiteSelection({
    adapterPageUrl: 'https://www.pinterest.ca/pin/100000000000000001/',
    previewUrl,
    attributes: {
      'data-src': `https://i.pinimg.com/736x/${path}.jpg`,
      'data-srcset': `https://i.pinimg.com/1200x/${path}.jpg 1200w`,
      srcset: `${previewUrl} 1x, ${originalUrl} 4x`,
    },
  });
  assert.equal(selection.siteAdapter, 'pinterest');
  assert(selection.candidates.some((candidate) => candidate.url === originalUrl));

  const intent = {
    kind: 'image',
    sourcePageUrl: selection.pageUrl,
    mediaUrl: previewUrl,
    preferOriginalMedia: true,
    selection,
  };
  const calls = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === originalUrl || url === previewUrl) return response({ url });
    if (url.endsWith('/save-upload')) {
      assert.equal(init.body.byteLength, png.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected Pinterest candidate request: ${url}`);
  };

  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, fetchFn);

  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'candidate' });
  assert.equal(calls[0], originalUrl, 'an explicit originals.png srcset URL must beat a derived originals.jpg guess');
  assert.equal(calls.includes(`https://i.pinimg.com/736x/${path}.jpg`), false);
  assert.equal(calls.includes(guessedOriginalUrl), false);
});

test('Behance source images use only higher same-module renditions and return to the exact preview on failure', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const projectId = '248952145';
  const moduleId = '1441502389';
  const previewUrl = 'https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/module-qa.69fcc1052be55.jpg';
  const sourceUrl = 'https://mir-s3-cdn-cf.behance.net/project_modules/source/module-qa.69fcc1052be55.jpg';
  const largestUrl = 'https://mir-s3-cdn-cf.behance.net/project_modules/max_3840_webp/module-qa.69fcc1052be55.jpg';
  const lowerUrl = 'https://mir-s3-cdn-cf.behance.net/project_modules/fs_webp/module-qa.69fcc1052be55.jpg';
  const state = { project: { project: {
    id: Number(projectId),
    modules: [{
      id: Number(moduleId), projectId: Number(projectId), __typename: 'ImageModule',
      imageSizes: { allAvailable: [
        { url: sourceUrl, width: 900, type: 'JPG' },
        { url: largestUrl, width: 3000, type: 'WEBP' },
        { url: lowerUrl, width: 1200, type: 'WEBP' },
      ] },
    }],
  } } };
  const selection = fixtureSiteSelection({
    adapterPageUrl: `https://www.behance.net/gallery/${projectId}/portfolio`,
    previewUrl,
    previewWidth: 1400,
    anchorHref: `/gallery/${projectId}/portfolio/modules/${moduleId}`,
    scripts: [new FixtureScript(JSON.stringify(state), 'beconfig-store_state')],
    pictureSrcsets: [`${previewUrl} 1x, ${lowerUrl} 0.8x, ${largestUrl} 2x`],
  });
  assert.equal(selection.candidates.some((candidate) => candidate.url === sourceUrl), true,
    'an explicit source field remains eligible even when its declared width is below the displayed width');
  assert.equal(selection.candidates.some((candidate) => candidate.url === lowerUrl), false,
    'a lower-size same-asset variant is excluded');

  const intent = {
    kind: 'image', sourcePageUrl: selection.pageUrl, mediaUrl: previewUrl,
    preferOriginalMedia: true, selection,
  };
  const calls = [];
  let sourceAborted = false;
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === sourceUrl) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          sourceAborted = true;
          reject(new Error('response headers timed out'));
        }, { once: true });
      });
    }
    if (url === previewUrl) return response({ url });
    if (url === largestUrl) return response({ status: 404, url });
    if (url.endsWith('/save-upload')) {
      assert.equal(init.body.byteLength, png.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected Behance candidate request: ${url}`);
  };
  const behavior = {
    notificationsEnabled: true,
    focusAppAfterSave: false,
    revealInLibraryAfterSave: false,
  };
  const result = await saveClient.saveMediaViaBrowser(
    intent,
    behavior,
    fetchFn,
    undefined,
    undefined,
    undefined,
    { candidateHeadersTimeoutMs: 10 },
  );
  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(sourceAborted, true, 'a stalled Behance candidate request is aborted after its header deadline');
  assert.deepEqual(calls.filter((url) => [sourceUrl, largestUrl, lowerUrl, previewUrl].includes(url)),
    [sourceUrl, largestUrl, previewUrl]);

  const offCalls = [];
  const offResult = await saveClient.saveMediaViaBrowser({ ...intent, preferOriginalMedia: false }, behavior, async (input) => {
    const url = String(input);
    offCalls.push(url);
    if (url === previewUrl) return response({ url });
    if (url.endsWith('/save-upload')) return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    throw new Error(`preference-off tried a Behance upgrade: ${url}`);
  });
  assert.deepEqual(offResult, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(offCalls.includes(sourceUrl), false);
});

test('ArtStation ranks same-asset 8k before 4k and large fields, then saves the first available rendition', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const base = 'https://cdnb.artstation.com/p/assets/images/images/103/967/261/';
  const stem = '-fixture-image.jpg?cache=preserved';
  const previewUrl = `${base}small_square/${stem}`;
  const eightK = `${base}8k/${stem}`;
  const fourK = `${base}4k/${stem}`;
  const large = `${base}large/${stem}`;
  const selection = fixtureSiteSelection({
    adapterPageUrl: 'https://www.artstation.com/artwork/fixture-project',
    previewUrl,
    attributes: {
      'data-large': large,
      srcset: `${large} 1200w, ${fourK} 4000w, ${eightK} 8000w`,
    },
  });
  const intent = {
    kind: 'image', sourcePageUrl: selection.pageUrl, mediaUrl: previewUrl,
    preferOriginalMedia: true, selection,
  };
  const candidateCalls = [];
  let uploads = 0;
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    if (url === eightK || url === fourK || url === large) candidateCalls.push(url);
    if (url === eightK) return response({ status: 404, url });
    if (url === fourK) return response({ url });
    if (url.endsWith('/save-upload')) {
      uploads += 1;
      assert.equal(init.body.byteLength, png.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected ArtStation candidate request: ${url}`);
  };
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, fetchFn);
  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'candidate' });
  assert.deepEqual(candidateCalls, [eightK, fourK]);
  assert.equal(uploads, 1);
});

test('ArtStation does not downgrade and falls back to preview when higher paths fail', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const base = 'https://cdna.artstation.com/p/assets/images/images/065/951/556/';
  const previewUrl = `${base}large/fixture-image.jpg?stamp=7`;
  const eightK = `${base}8k/fixture-image.jpg?stamp=7`;
  const fourK = `${base}4k/fixture-image.jpg?stamp=7`;
  const selection = fixtureSiteSelection({
    adapterPageUrl: 'https://www.artstation.com/artwork/fixture-project',
    previewUrl,
  });
  const calls = [];
  const uploads = [];
  const intent = {
    kind: 'image', sourcePageUrl: selection.pageUrl, mediaUrl: previewUrl,
    preferOriginalMedia: true, selection,
  };
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === eightK || url === fourK) return response({ status: 404, url });
    if (url === previewUrl) return response({ url });
    if (url.endsWith('/save-upload')) {
      uploads.push(init.body);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected ArtStation fallback request: ${url}`);
  };
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, fetchFn);
  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'preview' });
  assert.deepEqual(calls.filter((url) => url === eightK || url === fourK || url === previewUrl), [eightK, fourK, previewUrl]);
  assert.equal(uploads.length, 1);

  const bestPreview = 'https://cdna.artstation.com/p/assets/images/images/1/2/3/8k/fixture-image.jpg';
  const lowVariant = 'https://cdnb.artstation.com/p/assets/images/images/1/2/3/large/fixture-image.jpg';
  const bestSelection = fixtureSiteSelection({
    adapterPageUrl: 'https://www.artstation.com/artwork/fixture-project',
    previewUrl: bestPreview,
    attributes: { 'data-large': lowVariant },
  });
  const bestCalls = [];
  await saveClient.saveMediaViaBrowser({
    kind: 'image', sourcePageUrl: bestSelection.pageUrl, mediaUrl: bestPreview,
    preferOriginalMedia: true, selection: bestSelection,
  }, { notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false }, async (input) => {
    const url = String(input);
    bestCalls.push(url);
    if (url === bestPreview) return response({ url });
    if (url.endsWith('/save-upload')) return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    throw new Error(`an 8k preview must not fetch a lower rendition: ${url}`);
  });
  assert.deepEqual(bestCalls, [bestPreview, 'http://127.0.0.1:19876/save-upload']);

  const videoPreview = 'https://media.example/artstation/preview.mp4';
  const videoCandidate = 'https://media.example/artstation/video.mp4';
  const videoCalls = [];
  const videoSelection = {
    selectionId: 'artstation-video', documentId: 'artstation-video-document',
    kind: 'video', previewUrl: videoPreview, pageUrl: 'https://www.artstation.com/artwork/fixture-project',
    siteAdapter: 'artstation', siteCapability: 'verified-url-pattern',
    candidates: [
      { url: videoCandidate, kind: 'video', source: 'site-field' },
      { url: videoPreview, kind: 'video', source: 'preview' },
    ],
  };
  const videoResult = await saveClient.saveMediaViaBrowser({
    kind: 'video', sourcePageUrl: videoSelection.pageUrl, mediaUrl: videoPreview,
    preferOriginalMedia: true, selection: videoSelection,
  }, { notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false }, async (input) => {
    const url = String(input);
    videoCalls.push(url);
    if (url === videoCandidate || url === videoPreview) {
      return response({ contentType: 'video/mp4', body: videoMp4, url });
    }
    if (url.endsWith('/save-upload')) return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    throw new Error(`ArtStation video candidate should remain eligible: ${url}`);
  });
  assert.deepEqual(videoResult, { kind: 'accepted', savedVersion: 'candidate' });
  assert(videoCalls.includes(videoCandidate));
});

test('Dribbble saves an unscaled same-asset URL before larger variants and skips variants below currentSrc', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const stem = 'asset-fixture';
  const assetPath = `https://cdn.dribbble.com/userupload/fixture/file/${stem}.jpg`;
  const previewUrl = `${assetPath}?resize=1024x&vertical=center`;
  const unscaledUrl = assetPath;
  const smallerUrl = `${assetPath}?resize=752x&vertical=center`;
  const largerUrl = `${assetPath}?resize=1200x&vertical=center`;
  const selection = fixtureSiteSelection({
    adapterPageUrl: 'https://dribbble.com/shots/fixture',
    previewUrl,
    previewWidth: 1024,
    previewHeight: 1024,
    attributes: {
      'data-src': smallerUrl,
      srcset: `${previewUrl} 1024w, ${largerUrl} 1200w`,
    },
  });
  assert(selection.candidates.some((candidate) => candidate.url === unscaledUrl));
  assert(selection.candidates.some((candidate) => candidate.url === largerUrl && candidate.width === 1200));

  const intent = {
    kind: 'image',
    sourcePageUrl: selection.pageUrl,
    mediaUrl: previewUrl,
    preferOriginalMedia: true,
    selection,
  };
  const calls = [];
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === unscaledUrl) return response({ status: 404, contentType: 'text/plain', body: new ArrayBuffer(0), url });
    if (url === largerUrl) return response({ url });
    if (url === smallerUrl) return response({ url });
    if (url === previewUrl) return response({ url });
    if (url.endsWith('/save-upload')) {
      assert.equal(init.body.byteLength, png.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected Dribbble candidate request: ${url}`);
  });

  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'candidate' });
  assert.deepEqual(calls.slice(0, 2), [unscaledUrl, largerUrl]);
  assert.equal(calls.includes(smallerUrl), false, 'a resize below the displayed currentSrc must not be tried as an upgrade');
});

test('Pixiv CDN Referer rule matches only extension-origin requests and uses the probed accepted Referer', () => {
  const rules = hotlinkSites.buildHotlinkDnrRules(hotlinkSites.HOTLINK_SITES, 'fixture-extension-id');
  const rule = rules.find((candidate) => candidate.condition.urlFilter === '||pximg.net^');
  assert(rule, 'Pixiv CDN rule should cover the pximg.net root and its subdomains');
  assert.deepEqual(rule.action.requestHeaders, [{
    header: 'referer',
    operation: 'set',
    value: 'https://www.pixiv.net/',
  }]);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(rule.condition.initiatorDomains, ['fixture-extension-id']);
});

test('Pinterest page relay records the exact original URL when its extension differs from the preview', () => {
  const pageUrl = 'https://www.pinterest.ca/pin/100000000000000001/';
  const previewUrl = 'https://i.pinimg.com/236x/a1/b2/c3/sample-pin.jpg';
  const originalUrl = 'https://i.pinimg.com/originals/a1/b2/c3/sample-pin.png';
  const relayResponse = {
    data: {
      v3GetPinQueryv2: {
        data: {
          entityId: '100000000000000001',
          imageSpec_236x: { url: previewUrl },
          images_orig: { url: originalUrl },
          images_736x: { url: 'https://i.pinimg.com/736x/a1/b2/c3/sample-pin.jpg' },
        },
      },
    },
  };
  const selection = fixtureSiteSelection({
    adapterPageUrl: pageUrl,
    previewUrl,
    scripts: [new FixtureScript(
      `window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%7D", ${JSON.stringify(relayResponse)});`,
    )],
    attributes: {
      'data-src': 'https://i.pinimg.com/736x/a1/b2/c3/sample-pin.jpg',
    },
  });

  assert.equal(selection.siteAdapter, 'pinterest');
  assert.equal(selection.contentId, '100000000000000001');
  assert.equal(selection.candidates[0]?.url, originalUrl);
  assert.equal(selection.candidates[0]?.source, 'site-field');
});

test('Pinterest PWS state matches nested pin and carousel images without treating video thumbnail folders as originals', () => {
  const pageUrl = 'https://br.pinterest.com/pin/100000000000000002/';
  const selectedPreview = 'https://i.pinimg.com/236x/aa/bb/cc/carousel-child.jpg';
  const selectedOriginal = 'https://i.pinimg.com/originals/aa/bb/cc/carousel-child.png';
  const parentPreview = 'https://i.pinimg.com/236x/11/22/33/parent-image.jpg';
  const parentOriginal = 'https://i.pinimg.com/originals/11/22/33/parent-image.png';
  const videoCover = 'https://i.pinimg.com/videos/thumbnails/originals/44/55/66/video.0000000.jpg';
  const initialProps = {
    initialReduxState: {
      pins: {
        '100000000000000002': {
          entityId: '100000000000000002',
          images: {
            orig: { url: parentOriginal },
            '236x': { url: parentPreview },
          },
          carousel_data: [{
            images: {
              orig: { url: selectedOriginal },
              '236x': { url: selectedPreview },
            },
          }],
        },
        '100000000000000003': {
          entityId: '100000000000000003',
          images: {
            orig: { url: videoCover },
            '236x': { url: videoCover },
          },
        },
      },
    },
  };
  const feedCopy = {
    resources: {
      UserHomefeedResource: {
        data: [{
          entityId: '100000000000000002',
          images: {
            orig: { url: selectedOriginal },
            '236x': { url: selectedPreview },
          },
        }],
      },
    },
  };
  const docScript = new FixtureScript(JSON.stringify(initialProps), '__PWS_INITIAL_PROPS__');
  const feedScript = new FixtureScript(JSON.stringify(feedCopy), '__PWS_DATA__');
  const childSelection = fixtureSiteSelection({
    adapterPageUrl: pageUrl,
    previewUrl: selectedPreview,
    scripts: [docScript, feedScript],
  });
  const videoSelection = fixtureSiteSelection({
    adapterPageUrl: pageUrl,
    previewUrl: videoCover,
    scripts: [docScript, feedScript],
  });

  assert.equal(childSelection.candidates[0]?.url, selectedOriginal);
  assert.equal(videoSelection.candidates.some((candidate) => candidate.url === videoCover && candidate.source !== 'preview'), false);
});

test('Pinterest PWS data resources retain each feed pin original by its matching preview', () => {
  const pageUrl = 'https://pinterest.ca/search/pins/';
  const previewUrl = 'https://i.pinimg.com/236x/ab/cd/ef/feed-pin.jpg';
  const originalUrl = 'https://i.pinimg.com/originals/ab/cd/ef/feed-pin.png';
  const pwsData = {
    resources: {
      UserHomefeedResource: {
        data: [{
          entityId: '100000000000000004',
          images: {
            orig: { url: originalUrl },
            '236x': { url: previewUrl },
          },
        }],
      },
    },
  };
  const selection = fixtureSiteSelection({
    adapterPageUrl: pageUrl,
    previewUrl,
    scripts: [new FixtureScript(JSON.stringify(pwsData), '__PWS_DATA__')],
  });

  assert.equal(selection.candidates[0]?.url, originalUrl);
});

test('Pinterest video variants stay within the exact pin and poster-matched carousel slot', () => {
  const pinId = '1065382855646497154';
  const otherPinId = '1109574426963774185';
  const posterUrl = 'https://i.pinimg.com/236x/50/da/ee/50daee6fe6c3ffd0bd6072774a8de721.jpg';
  const otherPoster = 'https://i.pinimg.com/236x/f5/2b/18/f52b18b1d3e02b1f4fe87ed685ac1f5e.jpg';
  const mp4 = 'https://v1.pinimg.com/videos/iht/expMp4/a8/b6/9a/a8b69af284ccc8f093943919bf10f762_720w.mp4';
  const lowerMp4 = 'https://v1.pinimg.com/videos/iht/expMp4/a8/b6/9a/a8b69af284ccc8f093943919bf10f762_360w.mp4';
  const hls = 'https://v1.pinimg.com/videos/iht/hls/4e/a6/41/4ea641fa2407ce222835d7834abccb46.m3u8';
  const unrelated = 'https://v1.pinimg.com/videos/iht/expMp4/unrelated_2160w.mp4';
  const state = { initialReduxState: { pins: {
    [pinId]: {
      entityId: pinId,
      videos: { video_list: { V_2160P: { url: unrelated, width: 3840, height: 2160 } } },
      carousel_data: { carousel_slots: [
        { images: { '236x': { url: posterUrl } }, videos: { video_list: {
          V_HLSV4: { url: hls, width: 720, height: 960 },
          V_360P: { url: lowerMp4, width: 360, height: 480 },
          V_720P: { url: mp4, width: 720, height: 960 },
        } } },
        { images: { '236x': { url: 'https://i.pinimg.com/236x/11/22/33/image-slot.jpg' } } },
        { images: { '236x': { url: otherPoster } }, videos: { video_list: {
          V_720P: { url: 'https://v1.pinimg.com/videos/iht/expMp4/slot-three_720w.mp4', width: 720, height: 960 },
        } } },
      ] },
    },
    [otherPinId]: {
      entityId: otherPinId,
      carousel_data: { carousel_slots: [{
        images: { '236x': { url: otherPoster } }, videos: { video_list: {
          V_2160P: { url: unrelated, width: 3840, height: 2160 },
        } },
      }] },
    },
  } } };
  const match = pinterestVideoResolution.pinterestVideoForSelection(state, {
    contentId: pinId,
    posterUrl,
  }, 'https://www.pinterest.com/');

  assert.deepEqual(match?.candidates.map((candidate) => candidate.url), [mp4, lowerMp4, hls]);
  assert(match?.candidates.every((candidate) => candidate.contentId === pinId && candidate.kind === 'video'));
  assert(match?.candidates.every((candidate) => candidate.mediaIndex === 0));
  assert.equal(match?.candidates.some((candidate) => candidate.url === unrelated), false);
  assert.equal(pinterestVideoResolution.pinterestVideoForSelection(state, {
    contentId: pinId,
    posterUrl: 'https://i.pinimg.com/236x/aa/bb/cc/not-this-pin.jpg',
  }, 'https://www.pinterest.com/'), undefined);
  assert.equal(pinterestVideoResolution.pinterestVideoForSelection(state, {
    contentId: pinId,
  }, 'https://www.pinterest.com/'), undefined, 'Pin ID alone cannot choose an unassociated video slot');
});

test('Pinterest detail PWS HTML resolves only the selected pin video slot and orders MP4 before HLS', async () => {
  const pinId = '1065382855646497154';
  const posterUrl = 'https://i.pinimg.com/236x/50/da/ee/50daee6fe6c3ffd0bd6072774a8de721.jpg';
  const mp4 = 'https://v1.pinimg.com/videos/iht/expMp4/selected_720w.mp4';
  const hls = 'https://v1.pinimg.com/videos/iht/hls/selected.m3u8';
  const otherPinId = '1109574426963774185';
  const unrelated = 'https://v1.pinimg.com/videos/iht/expMp4/unrelated_2160w.mp4';
  const state = { initialReduxState: { pins: {
    [pinId]: { entityId: pinId, videos: null, carousel_data: { carousel_slots: [
      { images: { '236x': { url: posterUrl } }, videos: { video_list: {
        V_HLSV4: { url: hls, width: 720, height: 960 },
        V_720P: { url: mp4, width: 720, height: 960 },
      } } },
      { images: { '236x': { url: 'https://i.pinimg.com/236x/11/22/33/image.jpg' } } },
    ] } },
    [otherPinId]: { entityId: otherPinId, carousel_data: { carousel_slots: [{
      images: { '236x': { url: 'https://i.pinimg.com/236x/f5/2b/18/other.jpg' } },
      videos: { video_list: { V_2160P: { url: unrelated, width: 3840, height: 2160 } } },
    }] } },
  } } };
  const html = `<!doctype html><script id="__PWS_INITIAL_PROPS__" type="application/json">${JSON.stringify(state)}</script>`;
  const detailUrl = `https://www.pinterest.com/pin/${pinId}/`;
  const intent = {
    kind: 'video',
    sourcePageUrl: 'https://www.pinterest.com/',
    mediaUrl: 'blob:https://www.pinterest.com/fixture',
    preferOriginalMedia: true,
    selection: {
      selectionId: 'pinterest-video-selection',
      documentId: 'pinterest-video-document',
      kind: 'video',
      previewUrl: 'blob:https://www.pinterest.com/fixture',
      pageUrl: 'https://www.pinterest.com/',
      detailPageUrl: detailUrl,
      posterUrl,
      contentId: pinId,
      siteAdapter: 'pinterest',
      candidates: [{ url: 'blob:https://www.pinterest.com/fixture', kind: 'video', source: 'preview' }],
    },
  };
  const calls = [];
  const candidates = await detailResolution.followSelectedMediaDetail(intent, async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      body: null,
      async text() { return html; },
    };
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, detailUrl);
  assert.equal(calls[0]?.init?.credentials, 'include');
  assert.deepEqual(candidates.map((candidate) => candidate.url), [mp4, hls]);
  assert(candidates.every((candidate) => candidate.contentId === pinId && candidate.mediaIndex === 0));
  assert.equal(candidates.some((candidate) => candidate.url === unrelated || candidate.url === posterUrl), false);
});

test('Behance detail state resolves only the selected project module asset', async () => {
  const projectId = '248952145';
  const moduleId = '1441502389';
  const filename = 'cec024248952145.69fcc1052be55.jpg';
  const previewUrl = `https://mir-s3-cdn-cf.behance.net/project_modules/1400_webp/${filename}`;
  const sourceUrl = `https://mir-s3-cdn-cf.behance.net/project_modules/source/${filename}`;
  const detailUrl = `https://www.behance.net/gallery/${projectId}/fixture`;
  const detailIntent = (contentId, preview = previewUrl) => ({
    kind: 'image',
    sourcePageUrl: 'https://www.behance.net/',
    mediaUrl: preview,
    preferOriginalMedia: true,
    selection: {
      selectionId: 'behance-detail-selection',
      documentId: 'behance-detail-document',
      kind: 'image',
      previewUrl: preview,
      pageUrl: 'https://www.behance.net/',
      detailPageUrl: detailUrl,
      contentId,
      siteAdapter: 'behance',
      candidates: [{ url: preview, kind: 'image', source: 'preview' }],
    },
  });
  const detailState = ({ id = projectId, module = moduleId, family = 'project_modules' } = {}) => ({
    project: { project: {
      id: Number(id),
      modules: [{
        id: Number(module),
        projectId: Number(id),
        __typename: 'ImageModule',
        imageSizes: { allAvailable: [{
          url: `https://mir-s3-cdn-cf.behance.net/${family}/source/${filename}`,
          width: 3000,
          type: 'JPG',
        }] },
      }],
    } },
  });
  const resolveDetail = async (intent, state) => detailResolution.followSelectedMediaDetail(intent, async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    body: null,
    async text() {
      return `<script id="beconfig-store_state" type="application/json">${JSON.stringify(state)}</script>`;
    },
  }));

  const contentId = `behance:${projectId}:module:${moduleId}`;
  const positive = await resolveDetail(detailIntent(contentId), detailState());
  assert.deepEqual(positive.map((candidate) => candidate.url), [sourceUrl]);
  assert.equal(positive[0]?.contentId, contentId);
  assert.equal(positive[0]?.width, 3000);

  assert.deepEqual(
    await resolveDetail(detailIntent(contentId), detailState({ family: 'projects' })),
    [],
    'a matching basename in the project-cover family cannot satisfy a module selection',
  );
  assert.deepEqual(
    await resolveDetail(detailIntent(contentId), detailState({ id: '248952146' })),
    [],
    'a matching module basename from another project cannot satisfy the selected project identity',
  );
  assert.deepEqual(
    await resolveDetail(detailIntent(contentId), detailState({ module: '1441502377' })),
    [],
    'a matching module basename from another module cannot satisfy the selected module identity',
  );
  assert.deepEqual(
    await resolveDetail(detailIntent(undefined), detailState()),
    [],
    'without the encoded project/module identity, generic basename matching is skipped',
  );
});

test('invalid original candidate falls back to the exact preview and uploads once', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const intent = imageIntent(true);
  const calls = [];
  const uploads = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === intent.selection.candidates[0].url) {
      return response({ contentType: 'text/html', body: new TextEncoder().encode('<html>blocked</html>').buffer, url });
    }
    if (url === intent.mediaUrl) return response({ url });
    if (url.endsWith('/save-upload')) {
      uploads.push({ url, body: init.body });
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, fetchFn);

  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(calls.filter((url) => url === intent.selection.candidates[0].url).length, 1);
  assert.equal(calls.filter((url) => url === intent.mediaUrl).length, 1);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.byteLength, png.byteLength);
});

test('fetched blob preview keeps blob provenance in the desktop upload metadata', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const sourcePageUrl = 'https://frame.example.com/watch/42';
  const blobUrl = 'blob:https://frame.example.com/f03a6ed0-7fa5-4e76-9eb9-176a39f65e47';
  const originalUrl = 'https://media.example.com/video/original.mp4';
  const uploads = [];
  const result = await saveClient.saveMediaViaBrowser({
    kind: 'video',
    sourcePageUrl,
    mediaUrl: blobUrl,
    preferOriginalMedia: true,
    selection: {
      selectionId: 'blob-video-selection',
      documentId: 'blob-video-document',
      kind: 'video',
      previewUrl: blobUrl,
      pageUrl: sourcePageUrl,
      candidates: [
        { url: originalUrl, kind: 'video', source: 'site-field' },
        { url: blobUrl, kind: 'video', source: 'preview' },
      ],
    },
  }, {
    notificationsEnabled: true,
    focusAppAfterSave: false,
    revealInLibraryAfterSave: false,
  }, async (input, init = {}) => {
    const url = String(input);
    if (url === originalUrl) {
      return response({ status: 404, contentType: 'text/plain', body: new ArrayBuffer(0), url });
    }
    if (!url.endsWith('/save-upload')) throw new Error(`unexpected request: ${url}`);
    uploads.push({
      sourcePageUrl: decodeURIComponent(init.headers['X-Serpent-Source-Page-Url']),
      mediaUrl: decodeURIComponent(init.headers['X-Serpent-Media-Url']),
      body: init.body,
    });
    return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
  }, async (requestedBlobUrl) => {
    assert.equal(requestedBlobUrl, blobUrl);
    return { body: videoMp4, contentType: 'video/mp4' };
  }, undefined, async () => ({ state: 'unsupported' }));

  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'preview' });
  assert.deepEqual(uploads.map(({ sourcePageUrl: page, mediaUrl }) => ({ sourcePageUrl: page, mediaUrl })), [
    { sourcePageUrl, mediaUrl: blobUrl },
  ]);
  assert.equal(uploads[0]?.body.byteLength, videoMp4.byteLength);
});

test('strict preview mode never fetches the upgrade candidate', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const intent = imageIntent(false);
  const calls = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === intent.mediaUrl) return response({ url });
    if (url.endsWith('/save-upload')) {
      assert.equal(init.body.byteLength, png.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, fetchFn);

  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(calls.includes(intent.selection.candidates[0].url), false);
  assert.equal(calls.filter((url) => url === intent.mediaUrl).length, 1);
});

test('a typed direct-video source failure falls through to only the exact preview', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const original = 'https://video.twimg.com/ext_tw_video/42/pu/vid/avc1/720x720/first.mp4?tag=1';
  const otherUpgrade = 'https://video.twimg.com/ext_tw_video/42/pu/vid/avc1/1080x1080/second.mp4?tag=1';
  const preview = 'https://video.twimg.com/ext_tw_video/42/pu/vid/avc1/480x480/preview.mp4?tag=1';
  const damagedVideoMp4 = damageMp4PayloadPreservingBoxes(videoMp4);
  const intent = {
    kind: 'video',
    sourcePageUrl: 'https://x.com/user/status/42',
    mediaUrl: preview,
    preferOriginalMedia: true,
    selection: {
      selectionId: 'x-video-selection', documentId: 'x-video-document', kind: 'video',
      previewUrl: preview, pageUrl: 'https://x.com/user/status/42', contentId: '42', mediaIndex: 0,
      candidates: [
        { url: original, kind: 'video', source: 'page-bridge', contentId: '42', mediaIndex: 0 },
        { url: otherUpgrade, kind: 'video', source: 'structured-data', contentId: '42', mediaIndex: 0 },
        { url: preview, kind: 'video', source: 'preview', contentId: '42', mediaIndex: 0 },
      ],
    },
  };
  const calls = [];
  const uploadedUrls = [];
  const uploadedSizes = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === original) return response({ contentType: 'video/mp4', body: damagedVideoMp4, url });
    if (url === preview || url === otherUpgrade) {
      return response({ contentType: 'video/mp4', body: videoMp4, url });
    }
    if (url.endsWith('/save-upload')) {
      const metadata = init.headers['X-Serpent-Media-Url'];
      uploadedUrls.push(decodeURIComponent(metadata));
      uploadedSizes.push(init.body.byteLength);
      if (uploadedUrls.length === 1) return {
        status: 422, ok: false, headers: { get: () => 'application/json' },
        async text() { return JSON.stringify({ reason: 'worker probe rejected MP4', failureKind: 'source-invalid' }); },
      };
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, fetchFn, undefined, undefined, async () => ({ state: 'unsupported' }));
  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'preview' });
  assert.deepEqual(uploadedUrls, [original, preview]);
  assert.deepEqual(uploadedSizes, [damagedVideoMp4.byteLength, videoMp4.byteLength]);
  assert.equal(calls.includes(otherUpgrade), false, 'after source-invalid, only the frozen preview is tried');

  const previewCalls = [];
  const previewRejected = await saveClient.saveMediaViaBrowser({
    ...intent,
    preferOriginalMedia: false,
    selection: { ...intent.selection, candidates: [{ ...intent.selection.candidates[2] }] },
  }, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, async (input) => {
    const url = String(input);
    previewCalls.push(url);
    if (url === preview) return response({ contentType: 'video/mp4', body: videoMp4, url });
    if (url.endsWith('/save-upload')) return {
      status: 422, ok: false, headers: { get: () => 'application/json' },
      async text() { return JSON.stringify({ reason: 'preview itself is invalid', failureKind: 'source-invalid' }); },
    };
    throw new Error(`unexpected request: ${url}`);
  }, undefined, undefined, async () => ({ state: 'unsupported' }));
  assert.deepEqual(previewRejected, { kind: 'fetch_failed', reason: 'preview itself is invalid' });
  assert.equal(previewCalls.filter((url) => url.endsWith('/save-upload')).length, 1);

  const importCalls = [];
  const importRejected = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, async (input) => {
    const url = String(input);
    importCalls.push(url);
    if (url === original) return response({ contentType: 'video/mp4', body: videoMp4, url });
    if (url.endsWith('/save-upload')) return {
      status: 422, ok: false, headers: { get: () => 'application/json' },
      async text() { return JSON.stringify({ reason: 'desktop import failed after source validation' }); },
    };
    throw new Error(`unexpected request: ${url}`);
  }, undefined, undefined, async () => ({ state: 'unsupported' }));
  assert.deepEqual(importRejected, {
    kind: 'rejected', status: 422, reason: 'desktop import failed after source validation',
  });
  assert.equal(importCalls.includes(preview), false, 'ordinary import failures cannot trigger preview fallback');
});

test('Pinterest MP4 candidate saves as video and a failed stream never uploads its poster', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const posterUrl = 'https://i.pinimg.com/236x/50/da/ee/poster.jpg';
  const previewUrl = 'blob:https://www.pinterest.com/feed-video';
  const mp4Url = 'https://v1.pinimg.com/videos/iht/expMp4/selected_720w.mp4';
  const failedUrl = 'https://v1.pinimg.com/videos/iht/expMp4/unavailable_720w.mp4';
  const intent = {
    kind: 'video',
    sourcePageUrl: 'https://www.pinterest.com/',
    mediaUrl: previewUrl,
    preferOriginalMedia: true,
    selection: {
      selectionId: 'pinterest-save-video', documentId: 'pinterest-video-document',
      kind: 'video', previewUrl, pageUrl: 'https://www.pinterest.com/',
      posterUrl, contentId: '1065382855646497154', siteAdapter: 'pinterest',
      candidates: [
        { url: mp4Url, kind: 'video', source: 'site-field', contentId: '1065382855646497154', mediaIndex: 0 },
        { url: previewUrl, kind: 'video', source: 'preview', contentId: '1065382855646497154', mediaIndex: 0 },
      ],
    },
  };
  const uploaded = [];
  const calls = [];
  const saved = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === mp4Url) return response({ contentType: 'video/mp4', body: videoMp4, url });
    if (url.endsWith('/save-upload')) {
      uploaded.push({ url: decodeURIComponent(init.headers['X-Serpent-Media-Url']), body: init.body });
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected Pinterest video request: ${url}`);
  });
  assert.deepEqual(saved, { kind: 'accepted', savedVersion: 'candidate' });
  assert.deepEqual(uploaded.map((item) => item.url), [mp4Url]);
  assert.equal(uploaded[0]?.body.byteLength, videoMp4.byteLength);
  assert.equal(calls.includes(posterUrl), false);

  const hlsUrl = 'https://v1.pinimg.com/videos/iht/hls/selected.m3u8';
  const segmentedCalls = [];
  const hlsResult = await saveClient.saveMediaViaBrowser({
    ...intent,
    selection: { ...intent.selection, candidates: [
      { url: hlsUrl, kind: 'video', source: 'site-field', contentId: intent.selection.contentId, mediaIndex: 0 },
      { url: previewUrl, kind: 'video', source: 'preview', contentId: intent.selection.contentId, mediaIndex: 0 },
    ] },
  }, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, async (input) => { throw new Error(`HLS must use segmented transfer: ${String(input)}`); },
  undefined,
  undefined,
  async (_intent, candidate) => {
    segmentedCalls.push(candidate.url);
    return { state: 'saved' };
  });
  assert.deepEqual(hlsResult, { kind: 'accepted', savedVersion: 'candidate' });
  assert.deepEqual(segmentedCalls, [hlsUrl]);

  const failedCalls = [];
  const failedUploads = [];
  const failedIntent = {
    ...intent,
    selection: { ...intent.selection, candidates: [
      { url: failedUrl, kind: 'video', source: 'site-field', contentId: intent.selection.contentId, mediaIndex: 0 },
      { url: previewUrl, kind: 'video', source: 'preview', contentId: intent.selection.contentId, mediaIndex: 0 },
    ] },
  };
  const failed = await saveClient.saveMediaViaBrowser(failedIntent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, async (input, init = {}) => {
    const url = String(input);
    failedCalls.push(url);
    if (url === failedUrl) return response({ status: 404, contentType: 'text/plain', body: new ArrayBuffer(0), url });
    if (url.endsWith('/save-upload')) failedUploads.push(init.body);
    throw new Error(`unexpected Pinterest failure-path request: ${url}`);
  }, async () => ({ error: 'current MSE preview is unavailable' }));
  assert.deepEqual(failed, { kind: 'fetch_failed', reason: 'current MSE preview is unavailable' });
  assert.deepEqual(failedCalls.filter((url) => url.startsWith('https://')), [failedUrl]);
  assert.equal(failedUploads.length, 0);
  assert.equal(failedCalls.includes(posterUrl), false, 'the image poster must never be fetched or uploaded as a video');
});

test('page bridge results are requested only for enabled exact-identity selections', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const intent = imageIntent(true);
  intent.selection.siteAdapter = 'google-images';
  intent.selection.siteCapability = 'page-bridge';
  intent.selection.contentId = 'google-result-7';
  intent.selection.candidates = [{
    url: intent.selection.previewUrl,
    kind: 'image',
    source: 'preview',
    contentId: 'google-result-7',
  }];
  const originalUrl = 'https://images.example/google/7.jpg';
  const calls = [];
  const fetched = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === originalUrl || url === intent.mediaUrl) {
      return response({ url });
    }
    if (url.endsWith('/save-upload')) {
      fetched.push(init.body);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  let bridgeCalls = 0;
  const fetchBridge = async (selection) => {
    bridgeCalls += 1;
    assert.equal(selection.contentId, 'google-result-7');
    return [
      { url: originalUrl, contentId: 'google-result-7' },
      { url: 'https://images.example/google/8.jpg', contentId: 'google-result-8' },
    ];
  };
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, fetchFn, undefined, fetchBridge);
  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'candidate' });
  assert.equal(bridgeCalls, 1);
  assert.equal(calls.includes(originalUrl), true);
  assert.equal(calls.includes('https://images.example/google/8.jpg'), false);
  assert.equal(fetched.length, 1);

  const previewOnly = { ...intent, preferOriginalMedia: false };
  bridgeCalls = 0;
  const offCalls = [];
  const offFetch = async (input) => {
    const url = String(input);
    offCalls.push(url);
    if (url === intent.mediaUrl) return response({ url });
    if (url.endsWith('/save-upload')) return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    throw new Error(`unexpected request: ${url}`);
  };
  const offResult = await saveClient.saveMediaViaBrowser(previewOnly, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, offFetch, undefined, fetchBridge);
  assert.deepEqual(offResult, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(bridgeCalls, 0);
  assert.equal(offCalls.includes(originalUrl), false);
});

test('X bridge candidates keep video kind and matching Tweet media ordinal through save', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const preview = 'https://pbs.twimg.com/ext_tw_video_thumb/200/pu/img/b.jpg';
  const bridgedVideo = 'https://video.twimg.com/ext_tw_video/200/pu/vid/avc1/720x720/200.mp4?tag=1';
  const calls = [];
  const intent = {
    kind: 'video', sourcePageUrl: 'https://x.com/user/status/42', mediaUrl: preview, preferOriginalMedia: true,
    selection: {
      selectionId: 'x-video-bridge', documentId: 'x-video-doc', kind: 'video', previewUrl: preview,
      pageUrl: 'https://x.com/user/status/42', contentId: '42', mediaIndex: 1,
      siteAdapter: 'x', siteCapability: 'page-bridge',
      candidates: [{ url: preview, kind: 'video', source: 'preview', contentId: '42', mediaIndex: 1 }],
    },
  };
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true, focusAppAfterSave: false, revealInLibraryAfterSave: false,
  }, async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === bridgedVideo || url === preview) return response({ contentType: 'video/mp4', body: videoMp4, url });
    if (url.endsWith('/save-upload')) return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    throw new Error(`unexpected request: ${url}`);
  }, undefined, async (selection) => {
    assert.equal(selection.kind, 'video');
    assert.equal(selection.contentId, '42');
    assert.equal(selection.mediaIndex, 1);
    return [
      { url: 'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1/720.mp4', contentId: '42', kind: 'video', mediaIndex: 0 },
      { url: bridgedVideo, contentId: '42', kind: 'video', mediaIndex: 1 },
      { url: 'https://images.example/not-video.png', contentId: '42', kind: 'image', mediaIndex: 1 },
    ];
  }, async () => ({ state: 'unsupported' }));
  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'candidate' });
  assert.equal(calls.includes(bridgedVideo), true);
  assert.equal(calls.includes(preview), false);
  assert.equal(calls.includes('https://video.twimg.com/ext_tw_video/100/pu/vid/avc1/720.mp4'), false);
  assert.equal(calls.includes('https://images.example/not-video.png'), false);
});

test('page bridge candidates survive the later detail-page candidate merge', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const previewUrl = 'https://media.example/assets/asset-42_thumb.jpg';
  const bridgeUrl = 'https://media.example/assets/bridge-candidate-42.jpg';
  const detailUrl = 'https://media.example/assets/asset-42.jpg';
  const siteUrl = 'https://media.example/assets/site-candidate-42.jpg';
  const intent = {
    kind: 'image',
    sourcePageUrl: 'https://www.google.com/search?tbm=isch&q=asset-42',
    mediaUrl: previewUrl,
    preferOriginalMedia: true,
    selection: {
      selectionId: 'bridge-detail-selection',
      documentId: 'bridge-detail-document',
      kind: 'image',
      previewUrl,
      pageUrl: 'https://www.google.com/search?tbm=isch&q=asset-42',
      detailPageUrl: 'https://publisher.example/items/asset-42',
      contentId: 'google-result-42',
      siteAdapter: 'google-images',
      siteCapability: 'page-bridge',
      candidates: [
        { url: siteUrl, kind: 'image', source: 'site-field', contentId: 'google-result-42' },
        { url: previewUrl, kind: 'image', source: 'preview', contentId: 'google-result-42' },
      ],
    },
  };
  const calls = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === intent.selection.detailPageUrl) {
      return {
        status: 200,
        ok: true,
        url,
        headers: { get(name) {
          if (name.toLowerCase() === 'content-type') return 'text/html; charset=utf-8';
          return null;
        } },
        body: null,
        async text() {
          return `<html><body><img src="${previewUrl}" data-original="${detailUrl}"></body></html>`;
        },
      };
    }
    if (url === siteUrl || url === detailUrl) return response({ status: 404, contentType: 'text/plain', body: new ArrayBuffer(0), url });
    if (url === bridgeUrl || url === previewUrl) return response({ url });
    if (url.endsWith('/save-upload')) {
      assert.equal(init.body.byteLength, png.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  let bridgeCalls = 0;
  const result = await saveClient.saveMediaViaBrowser(intent, {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  }, fetchFn, undefined, async (selection) => {
    bridgeCalls += 1;
    assert.equal(selection.contentId, 'google-result-42');
    return [{ url: bridgeUrl, contentId: 'google-result-42' }];
  });

  assert.deepEqual(result, { kind: 'accepted', savedVersion: 'candidate' });
  assert.equal(bridgeCalls, 1);
  assert(calls.includes(bridgeUrl), `bridge candidate should remain after detail candidates are merged: ${calls.join(', ')}`);
  assert(calls.includes(intent.selection.detailPageUrl), 'the selected detail page should be followed once');
  assert(calls.includes(detailUrl), 'the detail page should contribute its identity-matching original');
  assert.equal(calls.filter((url) => url.endsWith('/save-upload')).length, 1);
});

test('confirmed source-invalid recovery saves only the frozen preview once', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const behavior = {
    notificationsEnabled: true,
    focusAppAfterSave: false,
    revealInLibraryAfterSave: true,
  };
  const previewUrl = 'https://cdn.example/watch/preview.mp4?signature=frozen';
  const fallbackIntent = {
    fallbackRequestId: '11111111-2222-4333-8444-555555555555',
    expectedLibraryId: 'library-frozen-42',
    kind: 'video',
    sourcePageUrl: 'https://site.example/watch/42',
    mediaUrl: previewUrl,
    targetFolderId: null,
    targetCollectionId: 'collection-frozen-42',
    behavior,
    allowRecoveryFallback: false,
  };
  const recovery = {
    requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    state: 'source-failed',
    reason: 'selected source segment returned HTTP 403',
    fallbackIntent,
  };
  const records = new Map();
  let claims = 0;
  let saves = 0;
  let finishes = 0;
  let mediaFetches = 0;
  let uploadHeaders;
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/capabilities')) return response({ url, contentType: 'application/json', body: new ArrayBuffer(0) });
    if (url === previewUrl) {
      mediaFetches += 1;
      return response({ url, contentType: 'video/mp4', body: videoMp4 });
    }
    if (url.endsWith('/save-upload')) {
      uploadHeaders = init.headers;
      return response({ status: 202, url, contentType: 'application/json', body: new ArrayBuffer(0) });
    }
    throw new Error(`unexpected recovery request: ${url}`);
  };
  const dependencies = {
    async claim(requestId) {
      claims += 1;
      if (records.has(requestId)) return 'duplicate';
      records.set(requestId, { state: 'claimed' });
      return 'claimed';
    },
    async save(intent, frozenBehavior) {
      saves += 1;
      assert.deepEqual(intent, {
        kind: 'video',
        sourcePageUrl: fallbackIntent.sourcePageUrl,
        mediaUrl: previewUrl,
        preferOriginalMedia: false,
        expectedLibraryId: fallbackIntent.expectedLibraryId,
        allowRecoveryFallback: false,
        targetFolderId: null,
        targetCollectionId: 'collection-frozen-42',
      });
      assert.deepEqual(frozenBehavior, behavior);
      return saveClient.saveMediaViaBrowser(intent, frozenBehavior, fetchFn);
    },
    async finish(requestId, state) {
      finishes += 1;
      records.set(requestId, { state });
    },
  };

  for (const state of ['saved', 'failed', 'pending']) {
    const ignored = await segmentedPreviewFallback.consumeSegmentedPreviewFallback(
      { ...recovery, state }, dependencies,
    );
    assert.deepEqual(ignored, { kind: 'ignored' });
  }
  assert.equal(saves, 0, 'complete, failed, and pending outcomes must not initiate fallback');

  const completed = await segmentedPreviewFallback.consumeSegmentedPreviewFallback(recovery, dependencies);
  assert.equal(completed.kind, 'handled');
  assert.equal(completed.state, 'saved');
  assert.deepEqual(completed.outcome, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(mediaFetches, 1, 'only the frozen exact preview should be downloaded');
  assert.equal(uploadHeaders['X-Serpent-Expected-Library-Id'], 'library-frozen-42');
  assert.equal(uploadHeaders['X-Serpent-Target-Folder-Id'], 'null');
  assert.equal(uploadHeaders['X-Serpent-Target-Collection-Id'], 'collection-frozen-42');
  assert.equal(uploadHeaders['X-Serpent-Focus-App-After-Save'], 'false');
  assert.equal(uploadHeaders['X-Serpent-Reveal-In-Library'], 'true');
  assert.equal(records.get(fallbackIntent.fallbackRequestId).state, 'saved');
  assert.equal(claims, 1);
  assert.equal(saves, 1);
  assert.equal(finishes, 1);

  const duplicate = await segmentedPreviewFallback.consumeSegmentedPreviewFallback(recovery, dependencies);
  assert.deepEqual(duplicate, { kind: 'duplicate' });
  assert.equal(saves, 1, 'a persisted fallback id must not upload the preview twice');
});

test('blob previews fail explicitly and uncertain preview uploads are never retried', async () => {
  const behavior = { notificationsEnabled: false, focusAppAfterSave: true, revealInLibraryAfterSave: false };
  const baseIntent = {
    fallbackRequestId: '22222222-3333-4444-8555-666666666666',
    expectedLibraryId: 'library-frozen-42',
    kind: 'video',
    sourcePageUrl: 'https://site.example/watch/42',
    mediaUrl: 'https://cdn.example/preview.mp4',
    behavior,
    allowRecoveryFallback: false,
  };
  const records = new Map();
  let saves = 0;
  const dependencies = {
    async claim(requestId) {
      if (records.has(requestId)) return 'duplicate';
      records.set(requestId, { state: 'claimed' });
      return 'claimed';
    },
    async save() {
      saves += 1;
      return { kind: 'unreachable' };
    },
    async finish(requestId, state, reason) {
      records.set(requestId, { state, reason });
    },
  };
  const blob = await segmentedPreviewFallback.consumeSegmentedPreviewFallback({
    requestId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    state: 'source-failed',
    reason: 'source failed',
    fallbackIntent: { ...baseIntent, mediaUrl: 'blob:https://site.example/id' },
  }, dependencies);
  assert.equal(blob.kind, 'ineligible');
  assert.match(blob.reason, /预览地址/);
  assert.equal(saves, 0);

  const unavailable = {
    requestId: 'cccccccc-dddd-4eee-8fff-000000000000',
    state: 'source-failed',
    reason: 'source failed',
    fallbackIntent: baseIntent,
  };
  const first = await segmentedPreviewFallback.consumeSegmentedPreviewFallback(unavailable, dependencies);
  assert.equal(first.kind, 'handled');
  assert.equal(first.state, 'unknown');
  assert.equal(records.get(baseIntent.fallbackRequestId).state, 'unknown');
  const repeated = await segmentedPreviewFallback.consumeSegmentedPreviewFallback(unavailable, dependencies);
  assert.deepEqual(repeated, { kind: 'duplicate' });
  assert.equal(saves, 1, 'an upload with unknown result must not be retried');
});

test('only a cleanly cancelled source failure may fall back from segmented video', async () => {
  saveClient ??= await server.ssrLoadModule('/save-client.ts');
  const previewUrl = 'https://media.example/preview.mp4';
  const manifestUrl = 'https://media.example/original.m3u8';
  const intent = {
    kind: 'video',
    sourcePageUrl: 'https://site.example/watch/42',
    mediaUrl: previewUrl,
    preferOriginalMedia: true,
    selection: {
      selectionId: 'video-selection',
      documentId: 'video-document',
      kind: 'video',
      previewUrl,
      pageUrl: 'https://site.example/watch/42',
      contentId: 'video-42',
      candidates: [
        { url: manifestUrl, kind: 'video', source: 'site-field', contentId: 'video-42' },
        { url: previewUrl, kind: 'video', source: 'preview', contentId: 'video-42' },
      ],
    },
  };
  const calls = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (url === previewUrl) return response({ url, contentType: 'video/mp4', body: videoMp4 });
    if (url.endsWith('/save-upload')) {
      assert.equal(init.body.byteLength, videoMp4.byteLength);
      return response({ status: 202, contentType: 'application/json', body: new ArrayBuffer(0), url });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const behavior = {
    notificationsEnabled: true,
    focusAppAfterSave: true,
    revealInLibraryAfterSave: true,
  };
  const sourceFailed = async (_intent, candidate) => candidate.url === manifestUrl
    ? { state: 'source-failed', reason: 'source returned HTTP 403' }
    : { state: 'not-segmented' };
  const fallbackResult = await saveClient.saveMediaViaBrowser(
    intent,
    behavior,
    fetchFn,
    undefined,
    undefined,
    sourceFailed,
  );
  assert.deepEqual(fallbackResult, { kind: 'accepted', savedVersion: 'preview' });
  assert.equal(calls.includes(manifestUrl), false);
  assert.equal(calls.filter((url) => url === previewUrl).length, 1);

  const pendingCalls = [];
  const pendingResult = await saveClient.saveMediaViaBrowser(
    intent,
    behavior,
    async (input) => {
      pendingCalls.push(String(input));
      throw new Error('pending segmented transfer must stop candidate fetch');
    },
    undefined,
    undefined,
    async () => ({ state: 'pending', reason: 'desktop temporarily offline' }),
  );
  assert.deepEqual(pendingResult, { kind: 'pending', reason: 'desktop temporarily offline' });
  assert.deepEqual(pendingCalls, []);

  const terminalResult = await saveClient.saveMediaViaBrowser(
    intent,
    behavior,
    async () => { throw new Error('terminal desktop failure must not fetch preview'); },
    undefined,
    undefined,
    async () => ({ state: 'failed', reason: 'desktop import rejected' }),
  );
  assert.deepEqual(terminalResult, { kind: 'transfer_failed', reason: 'desktop import rejected' });
});

test('DASH parser handles XML namespaces, entities, paired and self-closing templates, and inheritance', () => {
  const ns = 'urn:mpeg:dash:schema:mpd:2011';
  const paired = `<?xml version="1.0"?>
    <dash:MPD xmlns:dash="${ns}" type="static" mediaPresentationDuration="PT4S">
      <dash:BaseURL>https://cdn.example/base/</dash:BaseURL>
      <dash:Period>
        <dash:BaseURL>period/</dash:BaseURL>
        <dash:SegmentTemplate media="seg&amp;part-$Number%03d$.m4s" initialization="init-$RepresentationID$.mp4" duration="2"/>
        <dash:AdaptationSet contentType="video" mimeType="video/mp4">
          <dash:BaseURL>video/</dash:BaseURL>
          <dash:Representation id="v&amp;1" bandwidth="1000" width="640" height="360">
            <dash:BaseURL>high/</dash:BaseURL>
            <dash:SegmentTemplate duration="2"></dash:SegmentTemplate>
          </dash:Representation>
        </dash:AdaptationSet>
      </dash:Period>
    </dash:MPD>`;
  const plan = dashParser.resolveDashMediaPlan(paired, 'https://origin.example/watch/movie.mpd');
  assert.equal(plan.plans[0].init.url, 'https://cdn.example/base/period/video/high/init-v&1.mp4');
  assert.deepEqual(plan.plans[0].parts.map((part) => part.url), [
    'https://cdn.example/base/period/video/high/seg&part-001.m4s',
    'https://cdn.example/base/period/video/high/seg&part-002.m4s',
  ]);

  const selfClosing = paired.replace('<dash:SegmentTemplate duration="2"></dash:SegmentTemplate>', '<dash:SegmentTemplate duration="2"/>');
  assert.equal(dashParser.resolveDashMediaPlan(selfClosing, 'https://origin.example/watch/movie.mpd').plans[0].parts.length, 2);

  const inherited = paired.replace('<dash:SegmentTemplate duration="2"></dash:SegmentTemplate>', '')
    .replace('<dash:SegmentTemplate media="seg&amp;part-$Number%03d$.m4s" initialization="init-$RepresentationID$.mp4" duration="2"/>', '')
    .replace('<dash:Period>', '<dash:Period><dash:SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4" duration="2"/>');
  assert.equal(dashParser.resolveDashMediaPlan(inherited, 'https://origin.example/watch/movie.mpd').plans[0].parts[1].url,
    'https://cdn.example/base/period/video/high/seg-2.m4s');
});

test('DASH parser rejects dynamic, malformed, DRM, and external-entity manifests', () => {
  const base = '<MPD type="static" mediaPresentationDuration="PT1S"><Period><AdaptationSet contentType="video"><Representation id="v" bandwidth="1" width="1" height="1"><SegmentTemplate initialization="i.mp4" media="s-$Number$.m4s" duration="1"/></Representation></AdaptationSet></Period></MPD>';
  assert.throws(() => dashParser.resolveDashMediaPlan(base.replace('static', 'dynamic'), 'https://cdn.example/a.mpd'));
  assert.throws(() => dashParser.resolveDashMediaPlan(base.slice(0, -5), 'https://cdn.example/a.mpd'));
  assert.throws(() => dashParser.resolveDashMediaPlan(base.replace('<Representation', '<ContentProtection schemeIdUri="x"/><Representation'), 'https://cdn.example/a.mpd'));
  assert.throws(() => dashParser.resolveDashMediaPlan(`<!DOCTYPE MPD [<!ENTITY x "y">]>${base}`, 'https://cdn.example/a.mpd'));
});

test('HLS signed URL refresh preserves the frozen representation identity', async () => {
  const manifestUrl = 'https://cdn.example/watch/master.m3u8?token=old';
  const pageUrl = 'https://site.example/watch/42';
  const playlist = (token) => `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg-1.m4s?token=${token}\n#EXT-X-ENDLIST`;
  let token = 'old';
  const fetchFn = async () => new Response(playlist(token), { status: 200 });
  const original = await hlsParser.resolveHlsMediaPlan(manifestUrl, pageUrl, fetchFn);
  token = 'new';
  const refreshed = await hlsParser.resolveHlsMediaPlan(manifestUrl, pageUrl, fetchFn, undefined, undefined, original.identity);
  assert.equal(refreshed.identity, original.identity);
  assert.equal(refreshed.plans[0].parts[0].url, 'https://cdn.example/watch/seg-1.m4s?token=new');
});

test('journal URL refresh replaces only incomplete same-path segments', async () => {
  const mediaTransfer = await server.ssrLoadModule('/media-transfer.ts');
  const current = [{
    kind: 'video',
    init: { url: 'https://cdn.example/init.mp4?token=old' },
    parts: [
      { url: 'https://cdn.example/part-1.m4s?token=old', durationMs: 1000 },
      { url: 'https://cdn.example/part-2.m4s?token=old', durationMs: 1000 },
    ],
  }];
  const refreshed = [{
    kind: 'video',
    init: { url: 'https://cdn.example/init.mp4?token=new' },
    parts: [
      { url: 'https://cdn.example/part-1.m4s?token=new', durationMs: 1000 },
      { url: 'https://cdn.example/part-2.m4s?token=new', durationMs: 1000 },
    ],
  }];
  const snapshot = {
    segments: [
      { id: 'v-init', receivedBytes: 4, complete: true },
      { id: 'v-000000', receivedBytes: 4, complete: true },
      { id: 'v-000001', receivedBytes: 2, complete: false },
    ],
  };
  const merged = mediaTransfer.mergeRefreshedSegmentUrls(current, refreshed, snapshot);
  assert.equal(merged[0].init.url, current[0].init.url);
  assert.equal(merged[0].parts[0].url, current[0].parts[0].url);
  assert.equal(merged[0].parts[1].url, refreshed[0].parts[1].url);

  const changedPath = [{ ...refreshed[0], parts: [{ ...refreshed[0].parts[0] }, {
    ...refreshed[0].parts[1], url: 'https://cdn.example/other-2.m4s?token=new',
  }] }];
  assert.equal(mediaTransfer.mergeRefreshedSegmentUrls(current, changedPath, snapshot), undefined);
});

test('segmented media URL guard rejects private IPv4-mapped IPv6 and local ranges', () => {
  const rejected = [
    'http://127.0.0.1/media.mpd',
    'http://[::1]/media.mpd',
    'http://[::]/media.mpd',
    'http://[fc00::1]/media.mpd',
    'http://[fe80::1]/media.mpd',
    'http://[::ffff:127.0.0.1]/media.mpd',
    'http://[::ffff:7f00:1]/media.mpd',
    'http://[::ffff:10.2.3.4]/media.mpd',
    'http://[::ffff:0a02:304]/media.mpd',
  ];
  for (const url of rejected) assert.equal(segmentedUrl.isSafeRemoteMediaUrl(url), false, url);
  assert.equal(segmentedUrl.isSafeRemoteMediaUrl('https://cdn.example/media.mpd'), true);
  assert.equal(segmentedUrl.isSafeRemoteMediaUrl('http://[::ffff:0808:0808]/media.mpd'), true);
});

test('restored committing and complete journals do not submit a second desktop import', async () => {
  const mediaTransfer = await server.ssrLoadModule('/media-transfer.ts');
  for (const startingStatus of ['committing', 'complete']) {
    const requestId = startingStatus === 'committing'
      ? '44444444-4444-4444-8444-444444444444'
      : '55555555-5555-4555-8555-555555555555';
    const sessionId = startingStatus === 'committing'
      ? '66666666-6666-4666-8666-666666666666'
      : '77777777-7777-4777-8777-777777777777';
    const values = {
      'serpent.segmentedMediaTransfers.v1': {
        [requestId]: {
          version: 1,
          requestId,
          sessionId,
          token: 'x'.repeat(40),
          endpoint: 'http://127.0.0.1:19876',
          sourcePageUrl: 'https://site.example/watch/42',
          protocol: 'hls-fmp4',
          tracks: [{ kind: 'video', parts: [{ url: 'https://cdn.example/part.m4s', durationMs: 1000 }] }],
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          recoveryAttempts: 0,
        },
      },
    };
    const storage = {
      async get(key) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
      async set(update) { Object.assign(values, structuredClone(update)); },
      async remove(key) { delete values[key]; },
    };
    let snapshotCalls = 0;
    let commitCalls = 0;
    let importCalls = 0;
    const fetchFn = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      if (url.pathname === '/capabilities') return new Response(JSON.stringify({ segmentedMediaUpload: {
        version: 1, maxAssetBytes: 500 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, protocols: ['hls-fmp4'],
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/commit')) { commitCalls += 1; importCalls += 1; return new Response('{}'); }
      if (method === 'GET' && /\/media-transfer\/sessions\//u.test(url.pathname)) {
        snapshotCalls += 1;
        const status = startingStatus === 'complete' || snapshotCalls > 1 ? 'complete' : 'committing';
        return new Response(JSON.stringify({
          sessionId, status, receivedBytes: 4, maxAssetBytes: 500 * 1024 * 1024,
          chunkBytes: 4 * 1024 * 1024, segments: [],
          ...(status === 'complete' ? { duplicate: true } : {}),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected recovery request: ${method} ${url}`);
    };
    const observed = [];
    const result = await mediaTransfer.resumePendingSegmentedMediaTransfers({
      fetchFn,
      journalStorage: storage,
      onOutcome: async (outcome) => { observed.push(outcome); },
    });
    assert.deepEqual(result, [{ requestId, state: 'saved', duplicate: true }]);
    assert.deepEqual(observed, result, 'journal recovery notifications receive the duplicate flag');
    assert.equal(commitCalls, 0);
    assert.equal(importCalls, 0);
    assert.equal(snapshotCalls, startingStatus === 'complete' ? 1 : 2);
    assert.equal(values['serpent.segmentedMediaTransfers.v1'], undefined);
  }
});

test('completed cancellation preserves duplicate when its follow-up snapshot is unavailable', async () => {
  const mediaTransfer = await server.ssrLoadModule('/media-transfer.ts');
  const requestId = '88888888-8888-4888-8888-888888888889';
  const sessionId = '99999999-9999-4999-8999-999999999998';
  const values = {
    'serpent.segmentedMediaTransfers.v1': {
      [requestId]: {
        version: 1,
        requestId,
        sessionId,
        token: 'x'.repeat(40),
        endpoint: 'http://127.0.0.1:19876',
        sourcePageUrl: 'https://site.example/watch/42',
        protocol: 'hls-fmp4',
        tracks: [{ kind: 'video', parts: [{ url: 'https://cdn.example/part.m4s', durationMs: 1_000 }] }],
        cancelRequested: true,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        recoveryAttempts: 0,
      },
    },
  };
  const storage = {
    async get(key) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    async set(update) { Object.assign(values, structuredClone(update)); },
    async remove(key) { delete values[key]; },
  };
  let snapshotCalls = 0;
  let cancelCalls = 0;
  let uploadCalls = 0;
  let commitCalls = 0;
  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.pathname === '/capabilities') return new Response(JSON.stringify({ segmentedMediaUpload: {
      version: 1, maxAssetBytes: 500 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, protocols: ['hls-fmp4'],
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && /\/media-transfer\/sessions\//u.test(url.pathname)) {
      snapshotCalls += 1;
      if (snapshotCalls > 1) return new Response('{"reason":"snapshot unavailable"}', { status: 503 });
      return new Response(JSON.stringify({
        sessionId,
        status: 'uploading',
        receivedBytes: 4,
        maxAssetBytes: 500 * 1024 * 1024,
        chunkBytes: 4 * 1024 * 1024,
        segments: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'DELETE') {
      cancelCalls += 1;
      return new Response(JSON.stringify({
        status: 'ok', state: 'complete', cleanupFailed: false, duplicate: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'PUT') { uploadCalls += 1; return new Response('{}'); }
    if (url.pathname.endsWith('/commit')) { commitCalls += 1; return new Response('{}'); }
    throw new Error(`unexpected recovery request: ${method} ${url}`);
  };

  const result = await mediaTransfer.resumePendingSegmentedMediaTransfers({ fetchFn, journalStorage: storage });
  assert.deepEqual(result, [{ requestId, state: 'saved', duplicate: true }]);
  assert.equal(snapshotCalls, 2, 'the first GET observes uploading; the confirming GET may fail');
  assert.equal(cancelCalls, 1);
  assert.equal(uploadCalls, 0, 'a completed cancellation does not submit another chunk');
  assert.equal(commitCalls, 0, 'a completed cancellation does not submit another import');
  assert.equal(values['serpent.segmentedMediaTransfers.v1'], undefined);
});

test('source-invalid recovery dispatches one frozen preview fallback after confirmed cleanup', async () => {
  const mediaTransfer = await server.ssrLoadModule('/media-transfer.ts');
  const requestId = '88888888-8888-4888-8888-888888888888';
  const sessionId = '99999999-9999-4999-8999-999999999999';
  const values = {
    'serpent.segmentedMediaTransfers.v1': {
      [requestId]: {
        version: 1,
        requestId,
        sessionId,
        token: 'x'.repeat(40),
        endpoint: 'http://127.0.0.1:19876',
        sourcePageUrl: 'https://site.example/watch/42',
        protocol: 'hls-fmp4',
        tracks: [{ kind: 'video', parts: [{ url: 'https://cdn.example/part.m4s', durationMs: 1000 }] }],
        fallbackPreview: {
          fallbackRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          kind: 'video',
          sourcePageUrl: 'https://site.example/watch/42',
          mediaUrl: 'https://cdn.example/preview.mp4?sig=short-lived',
          allowRecoveryFallback: false,
          behavior: { focusAppAfterSave: true, revealInLibraryAfterSave: false, notificationsEnabled: true },
        },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        recoveryAttempts: 0,
      },
    },
  };
  const storage = {
    async get(key) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    async set(update) { Object.assign(values, structuredClone(update)); },
    async remove(key) { delete values[key]; },
  };
  let snapshotCalls = 0;
  let deleteCalls = 0;
  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.pathname === '/capabilities') return new Response(JSON.stringify({ segmentedMediaUpload: {
      version: 1, maxAssetBytes: 500 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, protocols: ['hls-fmp4'],
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && /\/media-transfer\/sessions\//u.test(url.pathname)) {
      snapshotCalls += 1;
      return new Response(JSON.stringify({
        sessionId,
        status: 'failed',
        failureKind: 'source-invalid',
        reason: 'probe rejected source media',
        libraryId: 'library-original',
        targetFolderId: 'folder-original',
        receivedBytes: 4,
        maxAssetBytes: 500 * 1024 * 1024,
        chunkBytes: 4 * 1024 * 1024,
        segments: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'DELETE') {
      deleteCalls += 1;
      return new Response(JSON.stringify({
        status: 'ok', state: 'failed', cleanupFailed: false, failureKind: 'source-invalid',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected recovery request: ${method} ${url}`);
  };
  const firstDispatch = [];
  const first = await mediaTransfer.resumePendingSegmentedMediaTransfers({
    fetchFn,
    journalStorage: storage,
    onOutcome: async (outcome) => {
      firstDispatch.push(outcome);
      throw new Error('simulate a crash before the fallback consumer acknowledges the intent');
    },
  });
  assert.equal(first[0].state, 'source-failed');
  assert.equal(first[0].fallbackIntent.expectedLibraryId, 'library-original');
  assert.equal(first[0].fallbackIntent.targetFolderId, 'folder-original');
  assert.equal(first[0].fallbackIntent.allowRecoveryFallback, false);
  assert.equal(first[0].fallbackIntent.mediaUrl, 'https://cdn.example/preview.mp4?sig=short-lived');
  assert.equal(snapshotCalls, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(values['serpent.segmentedMediaTransfers.v1'][requestId].fallbackClaimed, true);

  const secondDispatch = [];
  const second = await mediaTransfer.resumePendingSegmentedMediaTransfers({
    fetchFn,
    journalStorage: storage,
    onOutcome: async (outcome) => { secondDispatch.push(outcome); },
  });
  assert.equal(second[0].fallbackIntent.fallbackRequestId, first[0].fallbackIntent.fallbackRequestId);
  assert.equal(secondDispatch[0].fallbackIntent.expectedLibraryId, 'library-original');
  assert.equal(snapshotCalls, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(values['serpent.segmentedMediaTransfers.v1'], undefined);
  assert.equal(firstDispatch[0].state, 'source-failed');
});
