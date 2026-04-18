# Codex WeChat Bridge

[English](./README.md) | **简体中文**

[![Platform](https://img.shields.io/badge/platform-Windows%2011-0078D6)](https://www.microsoft.com/windows)
[![Runtime](https://img.shields.io/badge/runtime-Node%2022-339933)](https://nodejs.org/)
[![Codex](https://img.shields.io/badge/Codex-Desktop-111111)](https://developers.openai.com/codex/plugins/build)
[![WeChat](https://img.shields.io/badge/WeChat-private%20chat-07C160)](https://www.wechat.com/)
[![Tray](https://img.shields.io/badge/UI-Windows%20tray-4B5563)](#windows-tray-and-shortcut)
[![Launcher](https://img.shields.io/badge/Launch-desktop%20shortcut-2563EB)](#windows-tray-and-shortcut)

这是一个 **Windows-first** 的本地桥接项目，用于把 **微信私聊**接入 **Codex Desktop**。运行形态由本地 daemon、本地 MCP server、Codex plugin bundle 组成。

这个仓库是以下内容的源码主仓：
- WeChat bridge daemon
- 本地 MCP server
- Codex plugin bundle
- Windows 托盘程序与桌面快捷方式

安装并登录后，这个桥接可以：
- 接收微信私聊消息
- 按联系人隔离并映射到各自的 Codex session
- 将消息路由给 Codex 处理
- 将回复回发到微信
- 同时从微信端和 Codex 端暴露桥接控制能力

## 适用人群

这个项目主要面向：

- 高频个人 Codex 使用者
- 在 Windows 上使用 Codex Desktop 的用户
- 不想为了接入微信单独安装 OpenClaw 的用户
- 偶尔需要通过手机端微信操控电脑上 Codex 的用户
- 需要在微信桥接端检查和切换 Codex session 的用户

推荐的使用模型是：
- Codex 在桌面端运行
- 微信作为远程私聊控制和回复界面
- 桥接层负责把微信聊天绑定到带 session 感知的 Codex 工作流

## 兼容性

- **主要支持环境：**Windows 11
- **Windows tray + desktop shortcut：**仅 Windows
- **Core daemon / MCP runtime：**底层是 Node.js，理论上有一定可移植性，但当前打包、测试和文档都按 Windows-first 本地插件来组织
- **微信范围：**当前 v1 仅支持私聊

## 功能

### 当前已支持
- 扫码登录，且登录态可持久化
- 微信私聊收发主链路
- 以 Codex app-server 为主、`codex exec` 为 fallback 的运行模式
- 会话映射、重绑定与诊断
- 单条微信引用消息的入站感知
- 图片/文件入站并下载到本地缓存目录
- 微信侧 session 检查与切换
- 分段输出与可选 `/final` 汇总
- 微信侧控制命令，如 `/help`、`/session`、`/use-session`、`/append`、`/stop`、`/status`、`/quota`、`/model`、`/effort`、`/skills`
- Windows 托盘控制 daemon 生命周期与状态
- 桌面快捷方式 / launcher，无需长期保留终端窗口

### 当前暂不支持
- 群聊支持
- 纯语音入站理解
- 向微信回发图片 / 文件
- 聊天记录转发支持
- 超出当前本地运行守护范围之外的长期无人值守硬化

## 架构

```text
WeChat <---> wechat-bridge-daemon <---> codex app-server / codex exec
                          |
                          +--> SQLite state + runtime caches
                          |
                          +--> local MCP server <---> Codex Desktop plugin
                          |
                          +--> Windows tray companion
```

## 安装

### 给人类用户

```powershell
git clone <repo-url> codex-wechat-plugin
cd codex-wechat-plugin
npm install
npm run build
npm run install:plugin
```

然后：
1. 完全重启 Codex Desktop。
2. 运行 `npm run login` 启动二维码登录。
3. 微信扫码。
4. 在绑定后的微信私聊里发送一条消息。

可选的 Windows tray / 桌面快捷方式：

```powershell
npm run install:tray
```

之后可以：
- 双击桌面快捷方式 `WeChat Bridge`
- 或运行 `npm run tray`

`npm run install:plugin` 会把裁剪后的运行时复制到：
- `~/.codex/plugins/codex-wechat-bridge`

并更新：
- `~/.agents/plugins/marketplace.json`

### 给 Codex Agent

如果 Codex agent 正在浏览这个仓库，并需要把它安装到本机 Codex 客户端中，请按这个顺序做：

- 先遵循官方 Codex plugin 指引：
  - [Codex plugins](https://developers.openai.com/codex/plugins)
  - [Build plugins](https://developers.openai.com/codex/plugins/build)
- 再执行本仓库的本地安装命令：

```powershell
npm install
npm run build
npm run install:plugin
```

Windows 下如果需要 tray 入口，再额外执行：

```powershell
npm run install:tray
```

然后：
1. 完全重启 Codex Desktop，让本地 marketplace 重新加载。
2. 确认插件列表里出现 `WeChat Bridge`。
3. 如果按官方流程安装后仍然不显示或加载异常，再用官方 `Plugin Eval` 插件去检查安装目录里的实际 plugin bundle，而不是直接手改本地文件。

## Windows Tray 与桌面快捷方式

如果你需要 Windows 托盘入口，可以安装可选的 tray launcher 和桌面快捷方式：

```powershell
npm run install:tray
```

它会生成：
- 安装版运行目录下的 launcher：
  - `~/.codex/plugins/codex-wechat-bridge/artifacts/launcher/WeChat Bridge Tray.exe`
- 桌面快捷方式：
  - `WeChat Bridge`

这个快捷方式会直接启动**安装版**运行目录：
- `~/.codex/plugins/codex-wechat-bridge`

tray 是一个**可选**的 Windows 操作入口，可以：
- start / stop / restart daemon
- 查看状态
- 无需长期保留终端窗口

关于 MCP：
- 当前 bridge MCP 是 **stdio MCP server**
- 它由 Codex Desktop 在使用插件时按需拉起
- tray 提供的是 **Reset MCP Connection** 与 **Stop Current MCP Processes**
- 新的 MCP 连接会在下次使用插件时由 Codex Desktop 重建

## 使用

### 本地命令

```powershell
npm run build
npm run install:plugin
npm run login
npm run test
npm run typecheck
```

Windows 下如需 tray：

```powershell
npm run install:tray
```

### 微信侧命令

- `/help`
- `/pwd`
- `/session`
- `/newsession`
- `/use-session <id>`
- `/append <text>`
- `/stop`
- `/pending [continue|clear]`
- `/model [id|default]`
- `/effort [level|default]`
- `/final [on|off|default]`
- `/quota`
- `/skills`
- `/status`
- `/diagnostics [n]`
- `/threads`
- `/sessions [n]`
- `/ls [path]`

## 附件

图片和文件入站后会被缓存到安装版运行目录下的本地缓存：

```text
.cache/wechat-bridge/inbound-attachments/
```

桥接会把附件元数据和本地路径注入给 Codex prompt。这个缓存属于运行时状态，默认不会纳入 git。

## 仓库结构

- [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json)：插件清单
- [`.mcp.json`](./.mcp.json)：本地 MCP 配置
- [`src/cli/daemon.ts`](./src/cli/daemon.ts)：daemon 入口
- [`src/cli/mcp-server.ts`](./src/cli/mcp-server.ts)：MCP server 入口
- [`scripts/install-codex-plugin.ps1`](./scripts/install-codex-plugin.ps1)：本地 Codex plugin 安装脚本
- [`scripts/install-tray-launcher.ps1`](./scripts/install-tray-launcher.ps1)：tray + 桌面快捷方式安装脚本
- [`skills/wechat-bridge-ops/SKILL.md`](./skills/wechat-bridge-ops/SKILL.md)：内置操作技能
- [`docs/human-guide.md`](./docs/human-guide.md)：面向操作用户的文档
- [`docs/codex-agent-guide.md`](./docs/codex-agent-guide.md)：面向 Codex agent 的文档
- [`docs/architecture.md`](./docs/architecture.md)：架构说明
- [`docs/reference-analysis.md`](./docs/reference-analysis.md)：参考实现分析
- [`docs/testing.md`](./docs/testing.md)：自动化与手工验证文档

## 验证

当前本地验证覆盖：
- 自动化测试
- typecheck
- build 验证
- 扫码登录与私聊 roundtrip 手工验证
- 微信控制命令验证
- session 切换验证
- 图片 / 文件入站验证

## 限制

- 当前只支持私聊
- 尚未实现出站媒体回发
- 部分手动发送与系统通知仍依赖 fresh WeChat reply context
- Node 22 的 `node:sqlite` 仍属于 experimental

## 参考

本项目在协议线索、状态机行为和媒体处理思路上参考了 Tencent 的公开项目 `openclaw-weixin`：

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)

本仓库的补充分析见：

- [docs/reference-analysis.md](./docs/reference-analysis.md)

最终成品是为 Codex Desktop 重建的一套本地 plugin + daemon 工作流。

它：
- 不是 OpenClaw plugin
- 运行时不依赖 OpenClaw
- 不是对原项目的简单包装
