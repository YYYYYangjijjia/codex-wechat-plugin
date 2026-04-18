# Codex Agent Guide

## Purpose

Use this plugin when Codex should operate the locally installed WeChat bridge runtime.

The plugin exposes:
- a bundled skill: `wechat-bridge-ops`
- an MCP server: `wechat-bridge`
- a daemon-driven runtime that handles inbound WeChat messages and outbound replies

The intended runtime root is the installed plugin directory:
- `~/.codex/plugins/codex-wechat-bridge`

## Install Sequence For Codex Agent

First, follow the official Codex plugin model:

- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Build plugins](https://developers.openai.com/codex/plugins/build)

Then apply this repository-specific install sequence:

1. `npm install`
2. `npm run build`
3. `npm run install:plugin`
4. optional on Windows: `npm run install:tray`
5. fully restart Codex Desktop
6. confirm that `WeChat Bridge` appears in the local plugin list

Do not assume Codex Desktop will hot-reload the local marketplace without a full restart.

## If Desktop Does Not Recognize The Plugin

Use evidence, not guesses.

Recommended checks:
- verify the installed runtime exists at:
  - `~/.codex/plugins/codex-wechat-bridge`
- verify the local marketplace file exists at:
  - `~/.agents/plugins/marketplace.json`
- fully restart Codex Desktop after installation changes

If the plugin still does not appear or seems malformed, the recommended next step is:
- install the official `Plugin Eval` plugin
- evaluate the installed local plugin bundle at:
  - `~/.codex/plugins/codex-wechat-bridge`

This is a fallback diagnostic step after following the official Codex plugin flow. It is preferred over ad hoc manifest edits, because `Plugin Eval` gives install-surface feedback on the actual staged runtime bundle rather than on the mutable source tree alone.

## Runtime Model

The daemon is the autonomous engine.

The plugin bundle is the Codex-side control plane.

That distinction matters:
- MCP is for diagnostics, login, session inspection, and manual intervention
- the daemon owns the normal `private message -> Codex -> reply` loop

## What an Agent Should Assume

- Each WeChat conversation is isolated by `wechat_account_id + peer_user_id`
- The current chat may already be bound to an app-server session
- `/use-session <id>` can explicitly rebind the WeChat chat to another Codex session
- attachments arrive as local cached files under `.cache/wechat-bridge/inbound-attachments/`
- attachment paths in prompts are local file paths, not remote URLs

## MCP Usage

Primary tools:
- `get_account_state`
- `login`
- `get_login_status`
- `fetch_updates`
- `list_conversations`
- `send_text_message`
- `retry_delivery`
- `set_typing_state`
- `get_diagnostics`

Use MCP when you need to:
- confirm active login state
- inspect pending updates
- verify the WeChat-to-session mapping
- debug failed deliveries
- manually intervene in a specific chat

## Safe Operating Pattern

1. Confirm the account is active.
2. Inspect conversation state before sending anything manually.
3. Prefer the existing mapped session unless the user explicitly switches it.
4. Treat attachment paths as local inputs and reason about them accordingly.
5. Do not assume a stale manual reply context is reusable.

## Reply-Context Constraint

Manual sends depend on a fresh WeChat reply context.

If a manual send fails with `ret=-2`, the correct interpretation is:
- the current reply context is stale
- a fresh inbound WeChat message is needed before retrying

Do not treat `ret=-2` as a transport failure.

## Structured Output Behavior

Current bridge behavior is:
- normal prose may stream as segmented partial chunks
- structured blocks (fenced blocks, code-like blocks, tables, directories, lists) are sent as intact blocks rather than being aggressively split
- `/final on|off|default` controls whether a final full-summary message is emitted in addition to the segmented output
- turning `final` off should not remove the underlying answer content

## WeChat-Side Commands

User-facing WeChat control commands include:
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

## Attachment Handling

Inbound image/file messages are normalized into a shared attachment ingress path.

For the current bridge version:
- attachments are downloaded and cached locally
- the prompt sent to Codex includes the local file path and attachment type
- outbound attachment sending is still not part of the stable public workflow

## Recommended Agent Behavior

- Use `wechat-bridge-ops` when available
- Avoid replying manually unless the mapping is unambiguous
- Prefer diagnosis over guessing when a reply fails
- Use the current session workspace, not the bridge root, when reasoning about `/pwd` or `/session`
