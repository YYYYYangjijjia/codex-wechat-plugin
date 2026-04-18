# Setup

## Requirements
- Windows 11
- Node.js 22+
- npm
- git
- local `codex` CLI installed and authenticated

Check the local toolchain:

```powershell
node -v
npm -v
git --version
codex --version
```

## Install Dependencies

```powershell
npm install
```

## Build the Project

```powershell
npm run build
```

## Install the Codex Plugin

Use the official Codex plugin installation model as the baseline reference:

- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Build plugins](https://developers.openai.com/codex/plugins/build)

```powershell
npm run install:plugin
```

This script:
- creates or updates `~/.agents/plugins/marketplace.json`
- copies a trimmed plugin runtime into `~/.codex/plugins/codex-wechat-bridge` and installs production dependencies there
- registers the plugin in the local marketplace

Restart Codex Desktop after installation.

If the plugin still does not appear after following the official flow:
- verify the staged runtime under `~/.codex/plugins/codex-wechat-bridge`
- verify `~/.agents/plugins/marketplace.json`
- optionally use the official `Plugin Eval` plugin against the installed runtime bundle for install-surface diagnostics

## Install the Tray Launcher and Desktop Shortcut

```powershell
npm run install:tray
```

This installs the launcher under:
- `~/.codex/plugins/codex-wechat-bridge/artifacts/launcher/WeChat Bridge Tray.exe`

and creates a desktop shortcut:
- `WeChat Bridge`

The shortcut is intended to launch the installed plugin runtime, not the repository working tree.

## Repository-Side Development Runtime

Start the daemon:

```powershell
npm run dev:daemon
```

Start the MCP server for local debugging:

```powershell
npm run dev:mcp
```

Check local runtime status:

```powershell
npm run dev:status
```

## Runtime State

The installed plugin runtime keeps state under its own root, typically:
- `~/.codex/plugins/codex-wechat-bridge/state/`
- `~/.codex/plugins/codex-wechat-bridge/.cache/`
- `~/.codex/plugins/codex-wechat-bridge/artifacts/`

The repository working tree keeps separate local development state under gitignored directories:
- `state/`
- `.cache/`
- `artifacts/`

The attachment cache lives under:

```text
.cache/wechat-bridge/inbound-attachments/
```

## Reference Material

The public repo documents Tencent's `openclaw-weixin` reference analysis in:
- `docs/reference-analysis.md`

A local vendor copy can be created separately for protocol study, but it is not required for normal plugin use.

