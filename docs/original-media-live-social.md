# 社交站点原图真实页面实测

实测日期：2026-11-11。每站尝试访问一个公开贴文/作品页面；页面可访问并出现图像时，通过扩展 Alt+右键入口向临时本机接收端保存。没有调用私有下载 API、登录或读取/导出账号 Cookie。

页面 HTML、截图、浏览器临时配置和媒体字节仅存在于仓库 `test-results/live-social/` 下的单次运行目录，并在脚本 `finally` 清理。报告不保留 CDN 查询参数或页面令牌。

| 站点 | 页面样本 | 结果 | DOM currentSrc | 页面预览尺寸 | 实收媒体 / savedVersion | 字节 | 文件尺寸 | 页面原图候选证据 | 最终媒体路径 | 说明 |
|---|---|---|---:|---:|---|---:|---:|---|---|---|
| 小红书 | [公开页面](https://xhslink.com/a/RVjdnIaGmsi2) | saved | `https://sns-web-i10.rednotecdn.com/[临时签名路径省略]` | 640×855 | image / image/webp / preview | 45014 | 640×855 | 扩展反馈 `savedVersion=preview`；实收 URL 与 DOM currentSrc 相同、文件尺寸与预览相同；页面结构化/srcset 其他候选 0 个。 | `https://sns-web-i10.rednotecdn.com/[临时签名路径省略]` | Alt+右键保存成功，但本次只确认预览回退，未确认升至原图。 |
| Instagram | [公开页面](https://www.instagram.com/p/DeJ28eTxo4s/) | no-upload | `https://scontent-nrt1-2.cdninstagram.com/v/t51.82787-15/838879752_18633093571001809_7013098794556155636_n.jpg` | 2000×1872 | — | — | — | 页面结构化/srcset 其他候选 0 个。 | — | 可见 DOM 图像；定位器 Alt+右键超时，坐标 Alt+右键重试也未送达接收端；无扩展反馈。 |
| 微博 | [公开页面](https://weibo.com/2/detail/5335211736565127) | saved | `https://wx2.sinaimg.cn/orj480/008gzdv8ly1iiy85lq6oxj30u01hcwg5.jpg` | 480×853 | image / image/jpeg / candidate | 71677 | 1080×1920 | 扩展反馈 savedVersion=candidate；按扩展候选版本保存。 | `https://wx2.sinaimg.cn/large/008gzdv8ly1iiy85lq6oxj30u01hcwg5.jpg` | 扩展反馈 savedVersion=candidate；按扩展候选版本保存。 扩展 Alt+右键已将页面选中图像送达临时接收端。 |
| Pixiv | [公开页面](https://www.pixiv.net/artworks/119611543) | no-upload | `https://i.pximg.net/img-master/img/2024/06/14/00/00/25/119611543_p0_master1200.jpg` | 752×1200 | — | — | — | 按 DOM currentSrc 推导的候选为 `https://i.pximg.net/img-original/img/2024/06/14/00/00/25/119611543_p0.jpg`。 | — | 扩展提示“浏览器无法下载该媒体”，未向临时接收端送达字节；没有确认图片文件是否可降级保存。 |
| Pixiv targeted rerun | [同一公开页面](https://www.pixiv.net/artworks/119611543) | saved | `https://i.pximg.net/img-master/img/2024/06/14/00/00/25/119611543_p0_master1200.jpg` | 752×1200 | image / image/jpeg / candidate | 6,635,384 | 1754×2800 | DOM-derived `/img-original/` candidate; targeted proxy probe returned HTTP 403 without Referer and HTTP 200 with the tested Pixiv site Referer. | `https://i.pximg.net/img-original/img/2024/06/14/00/00/25/119611543_p0.jpg` | After registering the observed accepted Pixiv Referer for extension-origin CDN requests, the extension uploaded the original-path JPEG. The candidate response returned HTTP 200 and the isolated receiver captured 1754×2800 bytes. |
| X | [公开页面](https://x.com/NASA/status/1956376225074552934) | blocked | — | — | — | — | — | 原图候选未确认；页面结构化/srcset 候选 0 个。 | — | 原图候选未确认；页面结构化/srcset 候选 0 个。 页面导航失败：page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at <url> |

文件尺寸由临时接收的实际媒体字节经 Sharp 读取；DOM currentSrc 与原图候选只记录清理 query 后的路径。savedVersion 来自扩展保存后的页面反馈提示；若提示未暴露版本则记为 unknown。Pixiv 的原始失败记录保留在上表；随后的单站重测通过相同 Alt+右键浏览器扩展路径完成，临时 profile 和实际媒体字节已由 runner 清理。
