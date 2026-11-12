# 原图支持的逐站真实数据测试

日期：2026-11-11。18 个指定网站均已逐项尝试；这不等于 18 站通过。

## 测试边界

使用当前构建扩展、隔离 Chromium、真实公开页面和真实公网媒体，通过扩展的 Alt+右键入口保存到本机隔离接收端，再用 Sharp 检查媒体格式、像素和字节数。没有写入用户的正式资源库，也没有完成真实 Serpent 应用入库的整条链路。页面验证、文件下载、原图识别与入库分开记录。

Pinterest 另有一项明确的例外：匿名页面没有渲染作品图，因此用当前真实 Chrome 页面读取到的图片元素、srcset 和原图字段做数据重放，扩展实际下载的仍是真实 CDN 文件；这不是匿名实站页面交互通过。

所有测试均未自动完成验证码或账号重新验证。Behance、ArtStation 额外使用现有 Chrome 做只读对照，分别遇到账号重验和安全检查。

## 第一轮结果

| 网站 | 实际结果 | 文件证据或阻断 |
| --- | --- | --- |
| 百度图片 | 下载成功，原图未通过 | 914×500 JPEG；结果详情有不同来源图地址，但最终保存了百度 CDN 预览 |
| 必应图片 | 操作受阻，未下载 | 详情浮层/iframe 拦住 Alt+右键；未收到上传 |
| Google 图片 | 验证受阻 | 人机验证页面，没有测试结果图片 |
| 搜狗图片 | 下载成功，原图未通过 | 340×191 JPEG，与选中预览相同 |
| 360 图片 | 下载成功，原图未通过 | 400×712 JPEG，仍是 `400__` CDN 版本 |
| Yandex 图片 | 访问受阻 | 登录/同意页面挡在结果之前 |
| DuckDuckGo 图片 | 验证受阻 | 人机验证；验证页面素材不计为搜索图片 |
| Pinterest | 真实数据重放确认原图 | 预览 234×133 JPG，实际扩展下载 811×460 PNG、584,139 B；使用页面明确的 originals 地址 |
| 花瓣 | 访问受阻 | Pin 与首页在代理/直连检查中均返回 HTTP 405 |
| Behance | 访问/账号重验受阻 | 隔离浏览器 403；现有 Chrome 要求 Adobe 账号重新验证 |
| 站酷 | 未获得作品页面 DOM | 两个真实公开作品地址返回最小文档，无可选作品图 |
| Dribbble | 确认降采样缺陷 | 页面 currentSrc 为 1024×1024，实际保存 752×752 JPEG；同资产无 resize 地址可得到 1200×1200 WebP |
| ArtStation | 页面交互受阻；CDN DOM重放确认同资产8k高分候选 | 实站页面仍403/安全检查；匿名结构重放以扩展批量入口保存真实CDN的 5246×2503 JPEG（预览为800×800），3192541 B；不声称原始上传文件 |
| 小红书 | 下载成功，原图未通过 | 640×855 WebP；最终 URL、尺寸与预览相同，反馈为 preview |
| Instagram | 保存入口未成功 | 页面图像可见，Alt+右键与一次坐标重试均无上传 |
| 微博 | 已确认升档，原始上传文件未确认 | 480×853 预览升至 1080×1920 JPEG、71,677 B；最终为 large 候选 |
| Pixiv | 下载失败 | 页面 master1200 图片可见，扩展提示无法下载，未收到媒体字节 |
| X | 页面访问失败 | 公开状态页导航失败，未测试到图片保存 |

第一轮只有 Pinterest 的真实 DOM 重放明确匹配到声明的原图；微博证明下载到更大版本，其余成功下载不能被算成原图通过。Dribbble 与 Pixiv 的后续修复/复测结果另外补记，不能抹去第一轮失败证据。

ArtStation 后续修复和证据见[设计与素材站记录](original-media-live-portfolio.md)：保留首次页面403/安全检查记录；同一公开 CDN 资产的最小DOM重放通过扩展批量保存确认了8k高分候选，不等于匿名作品页或上传原图验收。

## 针对性修复与真实扩展复测

以下复测使用修复后重新构建的扩展、同一公开作品与真实 CDN 文件，仍经隔离接收端保存并检查字节，不写正式资源库。

| 网站 | 修复 | 实际扩展复测 |
| --- | --- | --- |
| Dribbble | 仅为同一 Dribbble CDN 资产移除已验证的 resize/vertical 参数并提高无缩放候选优先级；跳过比当前预览更小的 resize 候选 | 保存 1200×1200 JPEG、588,086 B，高于 currentSrc 的 1024×1024；之前错误选择的 752×752 版本不再上传。此项确认无缩放/更高质量版本，不推断上传者原始文件字节。 |
| Pixiv | 实测同一原图无 Referer 为 403，Pixiv 认可的 Referer 为 200；扩展自身请求复用 DNR registry 注入该 Referer | 实际保存 `/img-original/` 的 1754×2800 JPEG、6,635,384 B，反馈为 candidate；此前 master1200 预览为 752×1200。 |
| ArtStation | 按严格资产路径保留同一数值资产ID、可选14位日期目录和精确文件名；候选只按 `8k → 4k → large` 升档并保留完整查询串 | 脱敏结构的 batch fixture 覆盖 `small_square`、`smaller_square`、dated path、large current image及失败回退（3 candidate、1 preview）。另用最小捕获DOM和真实CDN做一次扩展保存：800×800缩略图升到5246×2503 JPEG、3,192,541 B；这证明可用8k rendition，不证明上传者原文件。 |

修复后：`npm run typecheck`、改动文件Scoped ESLint、31 项 Node 单测、Chrome/Firefox 构建通过；Dribbble/Pixiv 实站保存复测和 ArtStation CDN DOM重放保存通过。两份分组报告保留了首次失败及后续成功，不以新结果覆盖历史证据。

## 剩余处理

- 百度、搜狗、360、小红书需要继续完善原图提取；现阶段只能确认其预览保存路径。
- 必应与 Instagram 需要继续检查真实页面中的保存入口交互。
- 登录、人机验证和网络访问阻断需要在合法可访问环境中继续验证，不能用合成数据补记为实站通过。

## 详细证据与复跑脚本

- [搜索站点逐项记录](original-media-live-search.md)
- [设计与素材站逐项记录](original-media-live-portfolio.md)
- [社交站点逐项记录](original-media-live-social.md)
- 复跑脚本：`scripts/test-original-media-live-search.mjs`、`scripts/test-original-media-live-portfolio.mjs`、`scripts/test-original-media-live-social.mjs`；共用 `scripts/original-media-live-core.mjs`。

原始页面、浏览器配置及下载媒体只在本地忽略的测试目录中短期使用，任务结束清理；报告不包含用户账号、Cookie、签名路径或本机环境数据。
