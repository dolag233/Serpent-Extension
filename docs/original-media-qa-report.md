# 原图与原视频功能 QA 报告

后续补充：此报告下表记录实站检查前的功能快照。2026-11-11 已完成 18 站真实页面逐项尝试，并修复、复测 Dribbble 和 Pixiv；最新逐站结果及限制见[实站汇总](original-media-live-summary.md)。后续扩展定向单测为 29/29，不能用本报告的早期数字替代最新快照。

检查日期：2026-11-11  
代码基线：两个仓库当前 `codex/original-media-download` 工作树；未提交或推送。

## 自动化结果

| 仓库 | 命令 | 结果 |
| --- | --- | --- |
| Serpent-Extension | `npm run typecheck` | 通过 |
| Serpent-Extension | `npm run lint` | 通过 |
| Serpent-Extension | `npm run test:original-media:unit` | 23/23 通过，0 skip；包含 18 个站点适配器的 source-shaped fixtures、X 状态/媒体项关联、坏视频来源回退和恢复 journal 用例 |
| Serpent-Extension | `npm run extension:build` | 通过；Chrome 与 Firefox 产物均生成并经 manifest/build 校验 |
| Serpent-Extension | `npm run test:original-media:browser` | 13/13 通过，0 skip；命令先构建，再启动隔离 Chromium 和本地 fixture 服务 |
| Serpent-Extension | `npx eslint scripts/test-original-media-browser.mjs` | 通过；检查 harness 最终修改 |
| Serpent | `npx vitest run --config vitest.config.ts tests/unit/segmented-media-transfer.test.ts tests/unit/extension-message.test.ts tests/worker/segmented-media.test.ts` | 67/67 通过，0 skip；包含浏览器上传错误分类、分段传输、direct MP4/WebM 校验及真实 FFmpeg fixture |
| Serpent | `npx vitest run --config vitest.config.ts tests/unit/extension-handler.test.ts tests/unit/protocol.test.ts` | 123/123 通过，0 skip |

Serpent 最新 `npx tsc --noEmit` 和本次改动文件的 scoped ESLint 由实现者在功能冻结后运行并报告通过。全仓 `npm run lint` 仍退出 1：11 个错误和 5 个 warning 位于本功能未改动的 renderer 控件/测试文件；原图功能涉及文件的 scoped ESLint 通过。

## 浏览器覆盖范围

Headless harness 通过实际 Alt+右键保存入口验证：默认开关、媒体身份、多图选中项、旧设置迁移、预览模式、无效候选回退、页面 Blob、搜狗/360 合成结果、跨源 iframe、HLS/DASH 分段传输及 MediaSource 拒绝。HLS/DASH 使用本地合成清单和片段，断言实际分段上传内容及路线；这些合成片段不证明公开网站资源可解码。fixture 桌面端是本地 HTTP fake server，不是 Serpent/Electron 实例。

首次 headless 运行在首个保存前遇到连接状态竞态：fixture 已响应连接探测，但背景状态尚未就绪。测试 harness 随后增加等待正常的 `serpent-connection-status` 响应；最终完整运行通过。该同步只在独立测试 harness 中，不改扩展连接或保存实现。Chromium 仅访问 loopback fixture，使用 `--no-proxy-server` 避免系统代理接管本地伪站点；本轮未启动真实站点网络会话。运行后确认没有遗留 `serpent-original-media-*` 临时 profile。

## 尚未验证

- 18 个 adapter 的 fixture 是合成结构数据，不是 18 个当前真实网站的页面、媒体字节和最终入库验证。阶段 B 的逐站实测仍未完成，不能据此宣称全部站点已验收。
- 未验证 Chrome/Edge/Firefox 的真实登录态、受限页面、签名刷新与防盗链；X 视频 bridge 当前为 Chrome MAIN-world 路径，未用真实 X 响应或登录态验证。Firefox 的 bridge 限制以实现审计文档为准。
- 本地浏览器测试没有启动真实桌面应用，也未证明合成 HLS/DASH 可在目标用户媒体库播放。Serpent 的 FFmpeg 单测覆盖源损坏拒绝、分段合并/校验路径；完整生产环境端到端仍需真实应用与经授权的可播放样本验证。

签名 URL 和桌面恢复令牌短期保存在有界 `storage.local` journal 中，是本轮设计基线的明确调整：仅用于本次保存任务及崩溃恢复，终态或过期后清除，不进入 sync、日志或长期来源信息。详见[设计文档](original-media-download-design.md)与[实现审计](original-media-implementation.md)。
