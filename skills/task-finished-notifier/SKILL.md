---
name: "task-finished-notifier"
description: "Use when any Codex session finishes a task and you need to push a structured Task Finished notification into a WeChat / Weixin chat through the local bridge runtime."
---

# Task Finished Notifier

![WeChat Bridge Icon](./assets/icon.png)

Use this skill when work is complete in any Codex session and you need to push a structured completion notice into WeChat / Weixin through the installed bridge runtime.

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

When this skill runs inside a normal Codex Desktop session and you do not pass `--session-id`, it will automatically use the current `CODEX_THREAD_ID` as the source session id when available.

## What this skill is for

- Send one completion notification after a meaningful task finishes.
- Keep the message format stable across runs.
- Preserve Chinese text and emoji by using a UTF-8-safe payload path.
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
- Prefer explicit `--session-id` and `--session-name` values from the session that completed the work when you have them.
- Otherwise rely on the current Codex Desktop session id auto-detection before falling back to `unknown`.
- Only use bridge-side session metadata as an explicit fallback when you intentionally want to report the mapped WeChat session instead.
- **Do not pass Chinese text directly through shell command-line arguments.**
- **Do not rely on the Windows shell or PowerShell default encoding to preserve Chinese.**
- When any field contains Chinese, emoji, or other non-ASCII content, write a UTF-8 JSON payload file first and pass it with `--payload-file`.
- Keep the shell command itself ASCII-safe and let the script read UTF-8 content from disk.

## Recommended sending path

1. Write a UTF-8 JSON payload file.
2. Invoke the script with `--payload-file <path>`.
3. Use `--dry-run` first if you need to inspect the final text.

Example payload file:

```json
{
  "overview": "已修复 /use-record 切换 session 时的 app-server 初始化恢复问题。",
  "results": "AppServerCodexRunner 现在会在 Not initialized 时自动重置并重试一次；安装版已同步。",
  "nextStep": "请在微信里再次执行 /use-record videofm0302 进行验证。",
  "sessionId": "<source-session-id>",
  "sessionName": "<source-session-name>"
}
```

Example invocation:

```powershell
node skills/task-finished-notifier/scripts/send_task_finished_notification.mjs --payload-file C:\temp\task-finished.json
```

Useful flags:

- `--dry-run`: print the final message without sending it.
- `--payload-file <path>`: read UTF-8 JSON content instead of passing non-ASCII text through shell arguments.
- `--session-id <id>`: explicit source session id to include in the message.
- `--session-name <name>`: explicit source session name to include in the message.
- `--account-id <id>` / `--peer-user-id <id>`: target a specific WeChat / Weixin conversation instead of the latest known one.
- `--use-bridge-session`: only when you intentionally want to use the latest bridge-side mapped session as fallback metadata.

## Safety notes

- The script sends through the installed plugin runtime under `~/.codex/plugins/codex-wechat-bridge`.
- The target WeChat / Weixin conversation still requires a fresh valid reply context.
- If the bridge returns `ret=-2`, wait for a fresh inbound message in that chat and retry.
