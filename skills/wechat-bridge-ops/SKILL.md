---
name: "wechat-bridge-ops"
description: "Use when diagnosing or operating the local WeChat / Weixin bridge."
---

# Ops

![WeChat Bridge Icon](./assets/icon.png)

Operate the local WeChat / Weixin bridge runtime. This plugin is independent of OpenClaw.

## Runtime Model

- The daemon runs the autonomous private-message loop.
- The plugin MCP exposes login, diagnostics, session mapping, pending review, and manual send tools.
- MCP is not a manually long-running background service.

## Safety Rules

- v1 identity is `wechat_account_id + peer_user_id`.
- Before manual send, verify the exact peer with `list_conversations` or `fetch_updates`.
- Do not assume similar contact names are interchangeable.
- Do not call `send_text_message`, `send_image_message`, or `send_file_message` without concrete `account_id` and `peer_user_id`.
- If login expired, run `login`, scan the QR code, then poll `get_login_status`.

## Normal Sequence

1. `get_account_state`
2. `fetch_updates` when diagnosing pending inbound messages
3. `list_conversations` when checking Codex thread mapping
4. `get_diagnostics` for recent bridge/runtime errors
5. Manual send or `retry_delivery` only after the route is verified

## Limits

- Private chats only.
- `/append` only works while the active task is on the app-server backend.
- `/model` and `/effort` are bridge-local overrides for new turns.
- Outbound delivery can still require a fresh valid WeChat reply context.
