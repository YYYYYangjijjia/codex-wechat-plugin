# Codex WeChat Bridge

**English** | [简体中文](./README_CN.md)

<p align="center">
  <img src="./assets/desktop/codex_wechat_desktop_round.png" alt="Codex WeChat Bridge icon" width="140" />
</p>

[![Platform](https://img.shields.io/badge/platform-Windows%2011-0078D6)](https://www.microsoft.com/windows)
[![Runtime](https://img.shields.io/badge/runtime-Node%2022-339933)](https://nodejs.org/)
[![Codex](https://img.shields.io/badge/Codex-Desktop-111111)](https://developers.openai.com/codex/plugins/build)
[![WeChat / Weixin](https://img.shields.io/badge/WeChat%20%2F%20Weixin-private%20chat-07C160)](https://www.wechat.com/)
[![Tray](https://img.shields.io/badge/UI-Windows%20tray-4B5563)](#windows-tray-and-shortcut)
[![Launcher](https://img.shields.io/badge/Launch-desktop%20shortcut-2563EB)](#windows-tray-and-shortcut)

Windows-first local bridge that connects WeChat / Weixin private chats to Codex Desktop through a local daemon, a local MCP server, and a Codex plugin bundle.

This repository is the source of truth for:
- the WeChat / Weixin bridge daemon
- the local MCP server
- the Codex plugin bundle
- the Windows tray companion and desktop launcher

Once installed and logged in, the bridge can:
- receive private WeChat / Weixin messages
- keep each contact isolated in its own mapped Codex session
- route messages through Codex
- send replies back to WeChat / Weixin
- expose bridge controls from both WeChat / Weixin and Codex

## Who This Is For

This project is aimed at:

- heavy personal Codex users
- Codex Desktop users on Windows
- users who want WeChat / Weixin access to Codex without installing OpenClaw as a separate runtime
- users who occasionally need to control the Codex session running on their computer from WeChat / Weixin on their phone
- users who need the WeChat / Weixin bridge side to inspect and switch Codex sessions explicitly

The intended operating model is:
- Codex runs on the desktop
- WeChat / Weixin acts as a remote private-chat control and reply surface
- the bridge keeps the WeChat / Weixin chat mapped to a session-aware Codex workflow

## Compatibility

- **Primary supported environment:** Windows 11
- **Windows tray + desktop shortcut:** Windows-only
- **Core daemon / MCP runtime:** Node.js-based and mostly portable in principle, but this repository is currently packaged, tested, and documented as a Windows-first local plugin
- **WeChat / Weixin scope:** private chats only in v1

## Features

### Implemented
- QR login with persisted login state
- private-chat receive/reply loop
- Codex app-server primary backend with `codex exec` fallback
- WeChat session mapping, rebinding, and diagnostics
- quoted-message inbound awareness for single-message WeChat replies
- inbound attachment ingress for images and files into a local cache directory
- WeChat-side session switching and session inspection
- segmented partial replies to avoid long periods of silent waiting, plus optional full summary via `/final`
- structured block handling for fenced code, tables, lists, and attachment-style outputs
- inbound image and file caching under the plugin runtime cache directory, with attachment-aware prompt injection
- WeChat-side control commands such as `/help`, `/session`, `/use-session`, `/append`, `/stop`, `/status`, `/quota`, `/model`, `/effort`, `/skills`
- model / reasoning-effort overrides from WeChat
- optional final-summary toggle from WeChat
- Windows tray controls for daemon lifecycle and status
- desktop shortcut / launcher without keeping a terminal window open

### Not Yet Implemented
- group chat support
- inbound voice-only message understanding
- outbound image / file sending parity back to WeChat
- merged chat-history forwarding support
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
```

Then:
1. Restart Codex Desktop.
2. Run `npm run login` once to start QR login.
3. Scan the QR code and send a private message to the connected WeChat chat.

Optional on Windows, if a tray entrypoint is desired:

```powershell
npm run install:tray
```

This installs the tray launcher and creates the desktop shortcut automatically.

Then:
- double-click the desktop shortcut `WeChat Bridge`
- or run `npm run tray`

`npm run install:plugin` stages a trimmed runtime copy into:
- `~/.codex/plugins/codex-wechat-bridge`

and updates:
- `~/.agents/plugins/marketplace.json`

### For Codex Agent

If a Codex agent is browsing this repository and needs to install it into the local Codex client, use:

- follow the official Codex plugin installation model first:
  - [Codex plugins](https://developers.openai.com/codex/plugins)
  - [Build plugins](https://developers.openai.com/codex/plugins/build)
- then apply this repository's local install commands:

```powershell
npm install
npm run build
npm run install:plugin
```

Optional on Windows, if a tray entrypoint is desired:

```powershell
npm run install:tray
```

Then:

1. Fully restart Codex Desktop so the local marketplace is reloaded.
2. Confirm that `WeChat Bridge` appears in the plugin list.
3. If the plugin does not appear or does not load correctly after following the official Codex plugin flow, use the official `Plugin Eval` plugin as a diagnostic step before changing local plugin files by hand.

Suggested local verification flow for an agent:

```powershell
npm run install:plugin
```

Then in Codex Desktop:
- restart the app
- verify `WeChat Bridge` appears in the plugin list
- if needed, use `Plugin Eval` to evaluate the installed plugin at:
  - `~/.codex/plugins/codex-wechat-bridge`

Optional on Windows, if tray controls are needed:

```powershell
npm run install:tray
```

## Windows Tray And Shortcut

If a Windows tray entrypoint is desired, install the optional tray launcher and desktop shortcut:

```powershell
npm run install:tray
```

This installs both pieces together; no separate shortcut setup is required.

This generates:
- a launcher executable under the installed plugin runtime:
  - `~/.codex/plugins/codex-wechat-bridge/artifacts/launcher/WeChat Bridge Tray.exe`
- a desktop shortcut named `WeChat Bridge`

The generated `WeChat Bridge` shortcut launches the **installed plugin runtime** under `~/.codex/plugins/codex-wechat-bridge`, which is the intended usage model for Codex Desktop.

The tray is an optional Windows operator entrypoint:
- start / stop / restart daemon
- inspect status
- keep the bridge available without an open terminal window

For MCP:
- the bridge MCP server is a **stdio MCP server**
- Codex Desktop starts it on demand when the plugin is used
- the tray exposes **Reset MCP Connection** and **Stop Current MCP Processes** actions rather than pretending to run a standalone MCP daemon
- a fresh MCP connection is created by Codex Desktop on the next plugin use

## Usage

The primary usage model is:

- install the plugin into Codex Desktop through the steps in [Install](#install)
- let Codex Desktop load and use the plugin directly
- operate the bridge from WeChat and, optionally, from the Windows tray entrypoint

### Optional Windows Tray Entrypoint

If a local desktop entrypoint is desired on Windows:

```powershell
npm run install:tray
```

Then:
- double-click the desktop shortcut `WeChat Bridge`
- or launch the installed tray runtime manually

This is optional. The tray is a convenience entrypoint for bridge status inspection and daemon lifecycle control; it is not required for plugin installation.

### Local Operator Commands

These are local maintenance commands, not the primary end-user usage flow:

```powershell
npm run login
npm run status
npm run build
npm run test
npm run typecheck
```

### WeChat Commands

- `/help` - show the available bridge commands.
- `/pwd` - show the current workspace for this WeChat chat.
- `/session` - show the current backend, session id, latest session name, and mapped workspace.
- `/new-session [name]` - clear the current session binding and optionally name the next newly created session.
- `/newsession` - legacy alias for `/new-session`.
- `/use-session <id>` - bind this WeChat chat to a specific Codex session.
- `/test-session` - switch this chat to the configured shared test session.
- `/test-session bind <id>` - bind or replace the shared test session id.
- `/test-session quit` - leave the shared test session and return to the latest recorded non-test session.
- `/test-session unbind` - clear the shared test session binding.
- `/append <text>` - append steering text to the currently running task when supported.
- `/stop` - stop the currently running task for this chat.
- `/pending` - show the current backlog review state for this chat.
- `/pending continue` - continue processing the current backlog review items.
- `/pending clear` - discard the current backlog review items.
- `/model [id|default]` - inspect or override the model used for new turns.
- `/effort [level|default]` - inspect or override the reasoning effort used for new turns.
- `/final [on|off|default]` - control whether a final full-summary message is sent.
- `/quota` - read the latest Codex rate-limit snapshot.
- `/skills` - list the currently installed local and plugin skills.
- `/status` - show bridge health, account state, and recent reply status.
- `/diagnostics [n]` - show the most recent diagnostic events.
- `/threads` - show recent WeChat-to-Codex conversation mappings.
- `/sessions [n]` - list available Codex app-server sessions, including their latest live names.
- `/ls [path]` - list files in the current workspace or a relative subdirectory.

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
- [`skills/wechat-bridge-ops/SKILL.md`](./skills/wechat-bridge-ops/SKILL.md): bundled operational skill (`codex-wechat-bridge:ops`)
- [`skills/task-finished-notifier/SKILL.md`](./skills/task-finished-notifier/SKILL.md): bundled completion-notification skill (`codex-wechat-bridge:task-finished-notifier`)
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

This project references the public Tencent `openclaw-weixin` repository for protocol clues, state-machine behavior, and media-handling ideas:

- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)

Additional analysis for this repository is documented in:

- [docs/reference-analysis.md](./docs/reference-analysis.md)

The resulting implementation is rebuilt for Codex Desktop as a local plugin + daemon workflow.

It is:
- not an OpenClaw plugin
- not dependent on OpenClaw at runtime
- not a wrapper around the original project
