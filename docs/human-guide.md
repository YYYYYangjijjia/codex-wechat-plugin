# Human Guide

## Prerequisites
- Windows 11
- Node.js 22+
- npm
- git
- local `codex` CLI installed and authenticated
- WeChat account able to scan the login QR code

Check the local toolchain:

```powershell
node -v
npm -v
git --version
codex --version
```

## 1. Clone and Build

```powershell
git clone <repo-url> codex-wechat-plugin
cd codex-wechat-plugin
npm install
npm run build
```

## 2. Install into Codex Desktop

```powershell
npm run install:plugin
```

What this does:
- creates or updates `~/.agents/plugins/marketplace.json`
- copies a trimmed plugin runtime into `~/.codex/plugins/codex-wechat-bridge` and installs production dependencies there
- registers the plugin as installed by default in the local marketplace

Restart Codex Desktop after this step.

## 3. Install the Tray and Desktop Shortcut

```powershell
npm run install:tray
```

This creates:
- `~/.codex/plugins/codex-wechat-bridge/artifacts/launcher/WeChat Bridge Tray.exe`
- a desktop shortcut named `WeChat Bridge`

## 4. Start the Runtime

Recommended:
- double-click the `WeChat Bridge` desktop shortcut

Manual alternative:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME/.codex/plugins/codex-wechat-bridge/scripts/wechat-bridge-tray.ps1" -RepoRoot "$HOME/.codex/plugins/codex-wechat-bridge"
```

The tray companion can start, stop, and restart:
- the bridge daemon
- the MCP connection lifecycle used by Codex Desktop

Important:
- the MCP server is a stdio MCP server, not a standalone background daemon
- Codex Desktop starts it on demand when the plugin is used
- the tray offers **Reset MCP Connection** and **Stop Current MCP Processes**
- the next plugin use in Codex Desktop creates the fresh MCP connection

## 5. Connect WeChat

```powershell
npm run login
```

Then:
1. scan the QR code from WeChat
2. wait for the account to become active
3. send a private message to the connected bot/chat

## 6. Normal Usage

After connection, a normal private message should flow through:
1. WeChat message arrives
2. daemon fetches the update
3. Codex runs on the mapped session
4. typing and partial chunks may be sent back
5. final reply is sent back to WeChat

## WeChat Control Commands

The following are handled locally by the bridge rather than going through normal model generation:
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

## Attachment Cache

Inbound image and file messages are cached under:

```text
.cache/wechat-bridge/inbound-attachments/
```

This cache is local runtime state. It is safe to clear when the bridge is stopped.

## Verification Checklist

Run local checks:

```powershell
npm run test
npm run typecheck
npm run build
```

Suggested manual checks:
1. QR login works
2. a private text message gets a reply
3. `/help`, `/status`, `/session`, and `/skills` respond locally
4. tray can restart the daemon
5. image and file attachments appear in `.cache/wechat-bridge/inbound-attachments/`

## Troubleshooting

### Plugin does not appear in Codex Desktop
- rerun `npm run install:plugin`
- restart Codex Desktop fully
- verify `~/.agents/plugins/marketplace.json` exists

### Tray opens but actions do nothing
- rerun `npm run install:tray`
- restart the tray after reinstalling the plugin
- check `npm run build`
- use the tray `Show Status` action or inspect `~/.codex/plugins/codex-wechat-bridge/state/`

### Manual send or system notification fails with `ret=-2`
- the WeChat reply context is stale
- send a fresh inbound WeChat message to refresh context, then retry

