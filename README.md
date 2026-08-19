# Serpent 浏览器扩展

> 仓库：[dolag233/Serpent-Extension](https://github.com/dolag233/Serpent-Extension) · 桌面应用：[dolag233/Serpent](https://github.com/dolag233/Serpent)

在 Chrome、Edge 等 Chromium 浏览器与 Firefox 中把网页图片或视频保存到正在运行的 Serpent 桌面应用。媒体由**浏览器侧下载**（携带 Cookie 与页面 Referer）再上传到本机 Serpent，可绕过多数防盗链限制；只要 Serpent 在运行且已打开资源库，扩展即可连接（本机 127.0.0.1）。

## 安装（Chromium：Chrome / Edge）

> 扩展尚未上架 Chrome/Edge Web Store，需要手动加载（开发者模式）。安装完成后**不会自动更新**——新版本发布后重新下载 zip 并点扩展卡片上的「刷新」即可。

1. 在 [Releases](https://github.com/dolag233/Serpent-Extension/releases) 下载最新的 `serpent-extension-<版本>.zip`（Chromium 版）。
2. 解压到一个固定文件夹（例如 `文档/Serpent-extension`），文件夹内需直接包含 `manifest.json`。
3. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
4. 打开右上角「开发者模式」。
5. 点击「加载已解压的扩展程序」，选择第 2 步解压出的文件夹。

也可在 Serpent 桌面应用的设置页点击「下载浏览器扩展」并跟随分步指引（应用会帮你解压，最后两步仍需在浏览器完成）。

### 更新（Chromium）

下载新版本 zip → 解压覆盖 → `chrome://extensions` 中点扩展卡片上的刷新按钮（或移除后重新加载）。

## 安装（Firefox）

> Firefox 版同样尚未上架 AMO（addons.mozilla.org），需要临时加载。Firefox 115+（Manifest V3 事件页）。

1. 在 [Releases](https://github.com/dolag233/Serpent-Extension/releases) 下载最新的 `serpent-extension-firefox-<版本>.zip`。
2. 解压到一个固定文件夹（例如 `文档/Serpent-extension-firefox`），文件夹内需直接包含 `manifest.json`。
3. Firefox 打开 `about:debugging#/runtime/this-firefox`。
4. 点击「临时载入附加组件」，选择第 2 步文件夹内的 `manifest.json`。

注意：

- **临时加载的扩展在 Firefox 重启后会失效**，需要重新加载；正式使用需打包签名后通过 AMO 安装（后续发布流程）。
- 与 Chromium 版功能对齐（右键菜单、拖拽树状菜单、选项页、保存气泡）；后台采用事件页而非 service worker（Firefox MV3 差异）。

### 更新（Firefox）

下载新版本 zip → 解压覆盖 → `about:debugging#/runtime/this-firefox` 中点击「重新载入」。

## 使用

1. 启动 Serpent 并打开一个资源库。
2. 扩展工具栏图标在已连接时会变为彩色；未连接时保持灰色。
3. 在网页图片或视频上右键，选择「保存到 Serpent」，选择目标文件夹（最近保存/浏览 → 分割线 → 全部一级目录，子文件夹可逐级展开）。
4. **拖拽图片时自动展开树状保存菜单**：第一级显示最近保存/浏览文件夹与全部一级目录，悬停有子文件夹的目录右侧 `›` 进入下一级；左侧 `‹` 返回；面板外松开或 Esc 退出。拖拽保存与右键保存均会显示「正在保存到 Serpent」气泡反馈。

## 开发

```bash
npm ci
npm run extension:build   # 产物在 dist/extension/（含 manifest、编译脚本与图标）
npm run typecheck
```

加载方式同安装步骤（选择 `dist/extension/`）。发布：打 `v*` tag 触发 CI，自动构建并上传 Release（zip + SHA-256）。

## 功能开关

扩展选项页（右键扩展图标 → 选项）可关闭「拖拽网页图片/视频时显示保存菜单」。

## 安全

本扩展仅连接本机 Serpent（`127.0.0.1`，固定端口回退探测），无远程服务器。手动加载的扩展未经商店审查，请仅从本仓库 Releases 下载。
