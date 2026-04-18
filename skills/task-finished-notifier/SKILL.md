---
name: "codex-wechat-bridge:task-finished-notifier"
description: "Use when any Codex session finishes a task and you need to push a structured Task Finished notification into a WeChat / Weixin chat through the local bridge runtime."
---

# Task Finished Notifier

![WeChat Bridge Icon](./assets/icon.png)

Use this skill when a task is complete in any Codex session and you want to push a structured completion notice into WeChat / Weixin through the installed bridge runtime.

## Core model

This skill separates two different things:

1. **Source session**
- the Codex session where the work actually happened
- this is what `Session ID` and `Session Name` should describe
- pass these values explicitly when you know them

2. **Delivery route**
- the WeChat / Weixin chat that should receive the notification
- this is handled by the local bridge runtime through an existing valid reply context

Do not confuse the bridge-side mapped conversation session with the source Codex session that produced the work.

## What this skill is for

- Send a single completion notification after finishing a meaningful task.
- Keep the message format stable across runs.
- Use UTF-8-safe Node code instead of ad-hoc shell text so Chinese content and emoji are preserved.
- Allow any Codex session to push a result to WeChat / Weixin, as long as the bridge has a valid delivery route.

## Required message format

```text
<💡Task Finished>:
- Session ID: ...
- Session Name: ...
- Task Overview: ...
- Final Results: ...
- Next Step: ...
- Timestamp: YYYY-MM-DD HH:mm:ss
```

## Rules

- Keep the field labels exactly as shown above.
- Use Chinese for `Task Overview`, `Final Results`, and `Next Step` when talking to the user.
- Use Beijing time (`Asia/Shanghai`) and 24-hour format for `Timestamp`.
- Prefer explicit `--session-id` and `--session-name` values from the session that completed the work.
- Only use bridge-side session metadata as an explicit fallback when you intentionally want to report the mapped WeChat session instead.

## How to send

Run the bundled script:

```powershell
node skills/task-finished-notifier/scripts/send_task_finished_notification.mjs \
  --overview "已完成任务概述" \
  --results "最终结果概述" \
  --next-step "建议的下一步" \
  --session-id "<source-session-id>" \
  --session-name "<source-session-name>"
```

Useful flags:

- `--dry-run`: print the final message without sending it.
- `--session-id <id>`: explicit source session id to include in the message.
- `--session-name <name>`: explicit source session name to include in the message.
- `--account-id <id>` / `--peer-user-id <id>`: target a specific WeChat / Weixin conversation instead of the latest known one.
- `--use-bridge-session`: only when you intentionally want to use the latest bridge-side mapped session as fallback metadata.

## Safety notes

- The script sends through the installed plugin runtime under `~/.codex/plugins/codex-wechat-bridge`.
- The target WeChat / Weixin conversation still requires a fresh valid reply context.
- If the bridge returns `ret=-2`, wait for a fresh inbound message in that chat and retry.
