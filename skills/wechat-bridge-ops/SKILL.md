---
name: "wechat-bridge-ops"
description: "Use when operating, diagnosing, or manually intervening in the local Codex Desktop + WeChat / Weixin bridge through its MCP tools, especially for login, session mapping, pending messages, and failed deliveries."
---

# Ops

![WeChat Bridge Icon](./assets/icon.png)

Use this skill when working with the local WeChat / Weixin bridge plugin in the current repository root or the installed plugin runtime.

## Purpose

- Inspect bridge state without touching OpenClaw.
- Confirm which WeChat / Weixin conversation maps to which Codex thread.
- Recover from login expiry, failed replies, or ambiguous pending messages.

## Runtime model

- The always-on runtime is the local daemon, not the plugin bundle.
- The plugin bundle is the Codex-side control plane.
- The MCP server exposes manual tools for login, diagnostics, inspection, and manual WeChat replies.
- The daemon already performs the autonomous `private message -> Codex -> final WeChat / Weixin reply` loop.

## Safety rules

- Treat `wechat_account_id + peer_user_id` as the only valid conversation identity in v1.
- Before sending a manual reply, inspect `list_conversations` or `fetch_updates` and verify the exact peer.
- Do not assume two contacts with similar names are interchangeable.
- Do not use `send_text_message` unless you have a concrete `account_id` and `peer_user_id`.
- Do not attempt image sending in v1. `send_image_message` is a phase-2 placeholder.
- If login has expired, run `login`, scan the QR code, then poll `get_login_status`.

## Recommended operating sequence

1. Call `get_account_state` to confirm there is an active account.
2. If there is no active account, call `login`, scan the QR code, then poll `get_login_status`.
3. Call `fetch_updates` to inspect pending inbound messages if you need to diagnose or manually intervene.
4. Call `list_conversations` if you need the Codex thread mapping.
5. Only then call `send_text_message` or `retry_delivery`.

## Tool notes

- `login`: starts a QR flow and returns `session_key` plus `qrcode_url`.
- `get_login_status`: persists the login on confirmation.
- `fetch_updates`: shows pending messages already captured by the daemon.
- `set_typing_state`: manual override for typing status.
- `get_diagnostics`: inspect recent errors such as `session_expired`, `poll_error`, `reply_failed`.
- `list_conversations`: inspect the persisted WeChat-to-Codex mapping state.

## Known limits

- Private chats only in v1.
- `typing + segmented partial replies + final remainder` only. No token-level streaming and no true generating/finish parity.
- `/append` only works while the active task is running on the app-server backend.
- `/model` and `/effort` are bridge-local runtime overrides; they do not rewrite global Codex config.
- Image sending is not implemented yet.
