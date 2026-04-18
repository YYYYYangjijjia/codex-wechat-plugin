# Codex WeChat Bridge

[![Platform](https://img.shields.io/badge/platform-Windows%2011-0078D6)](https://www.microsoft.com/windows)
[![Runtime](https://img.shields.io/badge/runtime-Node%2022-339933)](https://nodejs.org/)
[![Codex](https://img.shields.io/badge/Codex-Desktop-111111)](https://developers.openai.com/codex/plugins/build)
[![WeChat](https://img.shields.io/badge/WeChat-private%20chat-07C160)](https://www.wechat.com/)
[![Tray](https://img.shields.io/badge/UI-Windows%20tray-4B5563)](#windows-tray-and-shortcut)
[![Launcher](https://img.shields.io/badge/Launch-desktop%20shortcut-2563EB)](#windows-tray-and-shortcut)

Windows-first local bridge that connects WeChat private chats to Codex Desktop through a local daemon, a local MCP server, and a Codex plugin bundle.

This repository is the source of truth for:
- the WeChat bridge daemon
- the local MCP server
- the Codex plugin bundle
- the Windows tray companion and desktop launcher

Once installed and logged in, the bridge can:
- receive private WeChat messages
- keep each contact isolated in its own mapped Codex session
- route messages through Codex
- send replies back to WeChat
- expose bridge controls from both WeChat and Codex

## Compatibility

- **Primary supported environment:** Windows 11
- **Windows tray + desktop shortcut:** Windows-only
- **Core daemon / MCP runtime:** Node.js-based and mostly portable in principle, but this repository is currently packaged, tested, and documented as a Windows-first local plugin
- **WeChat scope:** private chats only in v1

## Features

### Implemented
- QR login with persisted login state
- private-chat receive/reply loop
- Codex app-server primary backend with `codex exec` fallback
- WeChat session mapping, rebinding, and diagnostics
- segmented partial replies plus optional full summary via `/final`
- WeChat-side control commands such as `/help`, `/session`, `/use-session`, `/append`, `/stop`, `/status`, `/quota`, `/model`, `/effort`, `/skills`
- inbound attachment ingress for images and files into a local cache directory
- Windows tray controls for daemon lifecycle and status
- desktop shortcut / launcher without keeping a terminal window open

### Not Yet Implemented
- group chat support
- outbound image/file sending parity
- full long-term unattended hardening beyond the current local runtime guardrails

## Architecture

```text
WeChat <---> wechat-bridge-daemon <---> codex app-server / codex exec
                          |
                          +--> SQLite state + runtime caches
                          |
                          +--> local MCP server <---> Codex Desktop plugin
                          |
                          +--> Windows tray companion
```

## Install

### For Humans

```powershell
git clone <repo-url> codex-wechat-plugin
cd codex-wechat-plugin
npm install
npm run build
npm run install:plugin
npm run install:tray
```

Then:
1. Restart Codex Desktop.
2. Double-click the desktop shortcut `WeChat Bridge`, or run `npm run tray`.
3. Run `npm run login` once to start QR login.
4. Scan the QR code and send a private message to the connected WeChat chat.

`npm run install:plugin` stages a trimmed runtime copy into:
- `~/.codex/plugins/codex-wechat-bridge`

and updates:
- `~/.agents/plugins/marketplace.json`

### For Codex Agent

If a Codex agent is browsing this repository and needs to install it into the local Codex client, use:

```powershell
npm install
npm run build
npm run install:plugin
```

If the Windows tray launcher and desktop shortcut are also needed:

```powershell
npm run install:tray
```

After installation, restart Codex Desktop so the local marketplace is reloaded.

## Windows Tray And Shortcut

Install the Windows tray launcher and desktop shortcut:

```powershell
npm run install:tray
```

This generates:
- a launcher executable under the installed plugin runtime:
  - `~/.codex/plugins/codex-wechat-bridge/artifacts/launcher/WeChat Bridge Tray.exe`
- a desktop shortcut named `WeChat Bridge`

The generated `WeChat Bridge` shortcut launches the **installed plugin runtime** under `~/.codex/plugins/codex-wechat-bridge`, which is the intended usage model for Codex Desktop.

The tray is intended to be the normal operator entrypoint on Windows:
- start / stop / restart daemon
- inspect status
- keep the bridge available without an open terminal window

For MCP:
- the bridge MCP server is a **stdio MCP server**
- Codex Desktop starts it on demand when the plugin is used
- the tray exposes **Reset MCP Connection** and **Stop Current MCP Processes** actions rather than pretending to run a standalone MCP daemon
- a fresh MCP connection is created by Codex Desktop on the next plugin use

## Usage

### Local Commands

```powershell
npm run build
npm run install:plugin
npm run install:tray
npm run login
npm run test
npm run typecheck
```

### WeChat Commands

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

## Attachments

Inbound image and file messages are downloaded into a local cache directory relative to the installed plugin runtime:

```text
.cache/wechat-bridge/inbound-attachments/
```

The bridge injects attachment metadata and local paths into the Codex prompt. This cache is runtime state and is intentionally gitignored.

## Repository Layout

- [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json): plugin manifest
- [`.mcp.json`](./.mcp.json): local MCP wiring
- [`src/cli/daemon.ts`](./src/cli/daemon.ts): daemon entrypoint
- [`src/cli/mcp-server.ts`](./src/cli/mcp-server.ts): MCP server entrypoint
- [`scripts/install-codex-plugin.ps1`](./scripts/install-codex-plugin.ps1): local Codex plugin installer
- [`scripts/install-tray-launcher.ps1`](./scripts/install-tray-launcher.ps1): tray + desktop shortcut installer
- [`skills/wechat-bridge-ops/SKILL.md`](./skills/wechat-bridge-ops/SKILL.md): bundled operational skill
- [`docs/human-guide.md`](./docs/human-guide.md): operator-oriented guide
- [`docs/codex-agent-guide.md`](./docs/codex-agent-guide.md): Codex-agent-oriented guide
- [`docs/architecture.md`](./docs/architecture.md): architecture summary
- [`docs/reference-analysis.md`](./docs/reference-analysis.md): upstream reference analysis
- [`docs/testing.md`](./docs/testing.md): automated and manual validation guide

## Verification

Current local validation includes:
- automated tests
- type-checking
- build verification
- manual QR login and private-chat roundtrip verification
- WeChat control-command verification
- session switching verification
- attachment ingress verification for image and file messages

## Limits

- private chats only
- outbound media parity is not implemented
- manual sends and some system pushes still depend on a fresh WeChat reply context
- Node 22 `node:sqlite` remains experimental

## Reference

Tencent's `openclaw-weixin` was used as a protocol and state-machine reference during development. See:
- [docs/reference-analysis.md](./docs/reference-analysis.md)
