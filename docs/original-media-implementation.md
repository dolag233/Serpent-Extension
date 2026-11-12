# 原图与原视频实现审计

后续更新：以下逐站表保留实现阶段的证据快照。18 站真实页面尝试与 Dribbble/Pixiv 修复后的下载结果，统一见[实站测试汇总](original-media-live-summary.md)；没有把访问受阻或预览保存写成原图验收通过。

记录日期：2026-11-10。本文按当前扩展源码与已执行检查记录实现状态。适配器注册、静态源码样本和测试通过分别列出；它们都不等于真实网站原图已验证。

设计基线见[原图与原视频下载设计](original-media-download-design.md)，公开源码和站点字段记录见[来源研究](original-media-source-research.md)。

## 阶段状态

| 阶段 | 当前实现 | 证据与缺口 |
| --- | --- | --- |
| 0 站点取样 | 已查阅固定版本的 Hover Zoom+、gallery-dl、yt-dlp、Image Max URL；另有搜狗与 360 当前结果 JSON 样本记录。 | 搜狗静态页面 `__INITIAL_STATE__.searchList.searchList` 样本含 `docId/index/picUrl/oriPicUrl/thumbUrl`；360 `#initData.list` 样本含 `id/index/img/thumb/thumb_bak`。两者只证明结构字段存在，不证明元素映射和媒体字节。 |
| A 统一保存语义 | 已实现全局开关迁移、精确 `currentSrc` 预览、右键/Alt/拖拽/批量的 selection、候选校验后回退、来源失败与普通导入失败的 typed 区分、原来源 URL 元数据脱敏。直接视频候选只有桌面明确返回 `source-invalid` 才会退回 exact preview；普通导入失败/未知结果不重试。 | 扩展 Node 定向单测 23/23；typecheck 与 lint 通过。媒体有效性依赖有限格式头/容器检查；真实网站 JPEG/SVG 样本覆盖仍不足。 |
| B 站点支持 | 18 个站点均有注册项，已实现一组明确的局部字段/路径规则和受限详情页 HTML/JSON-LD 解析。 | 站点注册不算 18 站通过。下表逐项列当前来源机制、fixture 和真实站验证。部分适配仍只对特定 DOM 或已声明路径有效。 |
| C 视频闭环 | HLS 与静态 DASH 使用 XML/playlist parser、浏览器分段下载、桌面合并、journal 恢复与单次签名链接刷新；background 在 install/startup 调用恢复，并由周期 recovery alarm 重试。桌面只把明确的媒体合并/探测/解码校验失败标为 `source-invalid`；source failure 只有 DELETE 清理确认后才可回退。恢复后可用 journal 中冻结的 exact HTTP(S) preview 进行一次回退；`fallbackRequestId` 持久去重，上传与新分段会话都校验冻结的资源库 ID。`pending`、`committing`、导入失败/未知、已完成和 blob/data preview 不触发恢复回退。 | 扩展 Node 定向测试 23/23；桌面相关单测和最终浏览器 QA 账目由独立复核更新。覆盖 DASH XML namespace/entity/paired/self-closing/template inheritance、X 当前帖视频候选类型与媒体项绑定、direct typed source-invalid exact-preview fallback、签名 URL 刷新身份、未完成同路径分片替换、IPv4-mapped IPv6 私网拒绝，以及 `committing/complete` 恢复不重复提交。仍需对照真实站点浏览器与最终入库结果。直播、DRM、加密流和 Pixiv Ugoira 不计为支持。 |
| D 长尾 | 有保守 WordPress、MediaWiki、JSON-LD、详情页一次跟进及常用图床规则。 | 尚未复用固定版本 Image Max URL 规则子集，也没有通用引擎的独立 fixture 集。未知字段和无法唯一对齐的结果应退回当前预览。 |

## 18 个站点逐项状态

“Fixture”列指仓库里已经存在的自动化数据/用例；“真实页面”列只记录可复核的真实站点证据，不把上游源码示例说成本站点实测。

| 站点 | 当前提取路径 | Fixture 证据 | 真实页面验证 | 当前限制 |
| --- | --- | --- | --- | --- |
| 百度图片 | 选中卡片的 `onclick`/`m` 字段、已知 `/it/u=` 代理 URL、局部锚点参数。 | Node fixture 覆盖已识别代理 URL 解码；未覆盖真实卡片 DOM。 | 未实测下载。 | 百度结果字段和来源站访问性未核验；没有专用视频规则。 |
| 必应图片 | 当前锚点/局部 `m` JSON 中 `murl`，已知链接参数 `mediaurl/imgurl`。 | Node fixture 覆盖卡片 `murl` JSON。 | 未实测下载。 | 只接受所选卡片字段；视频封面不视作视频源。 |
| Google 图片 | DOM `data-tbnid/docid` 身份；Chrome MAIN-world 在当前 image-search 页读取有界 inline scripts 和同源 `/search?tbm=isch`、`/async/` 响应，按配对 `tbnid` 取原图 tuple；isolated content script 只把确切选中 ID 的结果交后台。 | Node 合成 tuple + request/response message fixture；保存端 fixture 验证 ID 过滤、偏好关闭时不查询。无现场捕获响应 fixture。 | 未实测真实动态滚动、下载字节或 Chrome MAIN-world 与隔离世界联通。 | 无目标 `data-tbnid`、响应结构变更、超 2 MiB 响应或非 `.google.com` 页面会退预览；Firefox 115 没有此 MAIN-world bridge。 |
| 搜狗图片 | 读取 `__INITIAL_STATE__.searchList.searchList[]`，只在当前 `currentSrc` 唯一匹配该条 `thumbUrl/picUrl/oriPicUrl` 时取同条候选。 | Node 与 headless harness 有合成 `searchList` fixture。 | 2026-11-10 静态 HTML 样本有 47 条结果字段；未实测浏览器元素映射或下载字节。 | 只支持能唯一映射的当前结果；状态变化或缩略图重复时回退预览。 |
| 360 图片 | 读取 `#initData.list`，当前缩略 URL 唯一命中 `thumb/thumb_bak/_thumb/img` 后取同条 `img`；不读取 `commercialImages`。 | Node 与 headless harness 有合成 `#initData` fixture。 | 2026-11-10 静态 HTML 样本有 123 条结果字段；未实测浏览器元素映射或下载字节。 | `img` 是同条目候选，不保证上传者原文件；无法唯一命中则回退。 |
| Yandex 图片 | Chrome MAIN-world 有界读取同源 `/images/search?format=json` 响应、指定 JSON script 和少量 `[data-state]`，把 `entities.image` 的 thumbnail ID 与同实体 `origUrl/viewerData` 关联。 | Node 合成 entities/parser + 精确 request/response message fixture；无现场捕获响应 fixture。 | 未实测动态页面、下载或页面实际 state selector 的稳定性。 | 仅在 preview 的 `id` 可与唯一 entity 对齐时返回；重复/缺失 ID、超限 body 和 Firefox 115 回退预览。 |
| DuckDuckGo 图片 | Chrome MAIN-world 仅观察同源 `/i.js` JSON 响应，按选中 preview 包装的缩略图 ID 映射同结果 `image`；`/iu/?u=` 预览代理不再作为升档来源。 | Node 合成 `/i.js` records/parser + 精确 request/response message fixture；无现场捕获响应 fixture。 | 未实测动态结果或下载。 | ID 缺失/不一致、XHR 路径变化、超限 body 和 Firefox 115 回退预览。 |
| Pinterest | 同一 pinimg URL 的已知尺寸目录映射到 `originals`，保留 query；局部字段候选。 | Node fixture 覆盖 `736x` 到 `originals` 且保留 query。 | 未实测真实 pin。 | 不根据 Pin/视频海报猜视频；HLS 由分段路径处理。签名过期正常回退。 |
| 花瓣 | 仅对已识别 huaban 图床，将 `/small/` 改为 `/large/`，保留 query。 | Node fixture 覆盖 huaban 图床尺寸路径。 | 未实测真实 pin。 | 改路径可 404；视频没有专用页面状态提取。 |
| Behance | 局部来源字段与已知图片 URL 尺寸变体。 | Node fixture 覆盖 `max_808` 到 `source` 模块路径。 | 未实测项目页。 | 项目模块 ID/序号关系尚无独立 fixture；不推断嵌入播放器视频。 |
| 站酷 | `#__NEXT_DATA__` 内 `productImages` 条目与所选预览 URL 相符时取同一对象的 URL。 | Node fixture 覆盖带 `id/url/urlBig` 的 `productImages` 项；修正了从 `script#__NEXT_DATA__` 读取而非在 JSON 正文搜索脚本 ID。 | 未实测详情页。 | 未覆盖项目列表/视频播放器；`urlBig` 仍是候选。 |
| Dribbble | 已知同一 CDN 文件名/路径变体。 | Node fixture 覆盖 `_teaser` 文件名后缀去除。 | 未实测 shot。 | 仅静态图 URL 规则；动图与视频需要分开的元素证据。 |
| ArtStation | 同一资产路径的 known size 变体。 | Node fixture 覆盖 `/small/` 到 `/large/`。 | 未实测作品页。 | project hash/asset 序号关系未独立验证；交互 3D 不当作视频。 |
| 小红书 | 初始 state 中与当前预览 URL 唯一关联的 `imageList`/video stream 对象。 | Node fixture 覆盖 `__INITIAL_STATE__.noteData.imageList`，按预览唯一映射对应原图。 | 未实测公开笔记或签名 URL。 | 动态接口、登录态、短期签名和多图序号覆盖未验证；不猜签名。 |
| Instagram | 页面结构数据里与当前预览相同的 `display_url`、`image_versions2` 或 `video_versions` 所在对象。 | Node fixture 覆盖 `_sharedData` 中同一对象的 `display_url/image_versions2`。 | 未实测登录态页面。 | 轮播子项和临时 CDN 签名尚无真实样本验证；候选无明确同项 URL 时回退。 |
| 微博 | 局部字段/已知图床尺寸路径转换；保留原 query，Referer DNR 限于扩展自身 initiator。 | Node fixture 覆盖新浪图床 `/thumb180/` 规则与 query 保留。 | 未实测防盗链请求。 | 访客校验、登录态和视频 variants 未验证；Referer 能力需浏览器实测。 |
| Pixiv | 作品页 `_pN` 序号识别与已知 original URL 规则。 | Node fixture 覆盖 `img-master` 到 `img-original` 与 `_master1200` 清理。 | 未实测作品页。 | 用户态/API 与 Ugoira 帧包转换未实现；不能以封面代替动画。 |
| X | 图片沿用同一 `pbs.twimg.com/media` 的 `name=orig` 规则。Chrome MAIN-world 仅读有界、同源白名单 status/Tweet GraphQL 响应，从每个 status 自己的 `extended_entities.media[]` 读取 `media_key`、`preview_image_url` 和 `video_info.variants`；以选中 Tweet 的 status ID 加 media key、卡片媒体序号或唯一 preview URL 对应单个视频媒体项。只接受 `video.twimg.com` 的 MP4/HLS variant，并保留为 `kind: video`。 | Node fixture 覆盖同帖两个视频项、另帖更高码率视频隔离、MP4/HLS 变体筛选、DOM status ID/ordinal 提取及 video 类型进入保存；direct source-invalid 用真实短 MP4 fixture 的损坏 `mdat` 模拟 typed 回退。均为合成响应/选择 fixture，不是 X 的现场响应录制。 | 未实测真实公开或登录态 X 帖子、浏览器响应桥接、媒体下载字节或桌面入库。 | 无 status ID 或媒体无法唯一对应时回退预览；仅允许当前白名单 GraphQL/status 响应结构。Firefox 115 未注册 MAIN-world bridge，故不宣称该浏览器支持此 X variants 路径。 |

## 通用链路与浏览器边界

- 预览固定为 `img.currentSrc`/`video.currentSrc`。`srcset` 只作为升级候选；关闭全局开关后不查详情、不读取升档候选。
- 图片候选来源、内容 ID 和媒体序号随同 selection 传递。祖先状态 JSON 只在目标媒体 URL/身份可唯一对应时使用，无法证明对应关系就不入候选。
- 详情页最多跟进一次，通过浏览器网络请求取有界 HTML，使用 `parse5` 读取同身份图片、JSON-LD 和明确媒体字段；不执行详情页 JavaScript。桥接结果先加入候选，再合并详情页候选；Node fixture 确认失败的站点字段后仍会尝试桥候选，避免详情页合并覆盖桥结果。
- 下载限制为 500 MiB；坏 MIME、HTML/JSON/XML、清单伪装和不完整/不可识别媒体不会进入 `/save-upload`。candidate 失败可退回 exact preview；桌面导入失败不换候选重复导入。
- 分段恢复记录保存在 `browser.storage.local`，最长保留 12 小时；为了续传会临时包含源清单/未完成分片的签名 URL 查询参数和桌面会话 bearer token，不保存网站 Cookie 或网站 `Authorization` header。完成、终止或过期后移除记录。恢复时最多重取一次 HLS master/MPD；只有 representation/track identity、片段数量/时长/range 和同一媒体资源路径都匹配，才替换未完成分片 URL。资源路径或轨道身份变化时清理会话并按源失败处理；清理未确认前不允许预览回退。
- HTTP(S) 媒体在后台请求。普通同源 `blob:` 由选中 frame 页侧读取并以 64 KiB 有背压块传输到后台，单项不超过 500 MiB；不整文件 base64。直接 `srcObject instanceof MediaSource` 会拒绝。`video.src=URL.createObjectURL(MediaSource)` 的浏览器内部关联无法由标准 DOM API 直接读取，当前依赖其不可读/容器验证失败，仍需 harness 实测确认不会误保存。
- content script 注入所有可访问 frame；原生右键以浏览器 `frameId` 查询并保存 selection。快捷键、popup 的批量/页面工具显式发给主 frame，避免多 frame 重复打开面板。
- DNR Referer 规则通过扩展 origin hostname 的 `initiatorDomains` 与 CDN host 边界限定。Firefox 最低版本仍为 115；DNR 动态规则从 Firefox 113 起提供。Chrome MAIN-world page bridge 已接入 Google/DDG/Yandex 的指定同源读取，以及 X 白名单 status/Tweet 响应视频读取；Firefox 115 不注册该脚本，这四站在 Firefox 仍仅依赖 DOM/初始页面字段。桥接内容仍来自网页并不可信，后台只接受同一 ID、kind 和媒体序号的 HTTP(S) 候选，最终仍做媒体字节校验。

## 自动化与人工验证账目

当前 Node 定向测试共 23 项，覆盖偏好迁移、候选 HTML 回退、关闭开关、18 个站点适配注册及 source-shaped 图片字段/路径 fixture、Google/DDG/Yandex 解析、X 同帖多媒体与跨帖隔离、X status/ordinal selection、桥接身份过滤、video 类型保存、direct source-invalid 的精确 preview 回退与普通 import rejection 控制组、桥接候选与详情页候选合并，以及 DASH XML、HLS identity refresh、分片 URL 合并、IPv4-mapped IPv6 guard、journal 恢复终态和 source-invalid exact-preview fallback。fixture 依据已查阅的公开结构精简构造，不是线上响应录制，不证明真实网站当前结构可解析，也不证明浏览器 MAIN-world 与隔离世界在线联通。

Headless Chrome harness 由独立测试代理维护，覆盖偏好/回退、blob、搜狗、360、跨源 iframe、HLS、DASH、预览模式和 MediaSource 拒绝；浏览器检查结果以该代理回报为准。没有在本轮启动前台浏览器。尚无 18 站逐站线上页面、原媒体字节和入库结果的验证记录。构建、桌面 unit pass、Node fixture 与 browser harness pass 应分开统计，不能合计为“18 站支持”。
