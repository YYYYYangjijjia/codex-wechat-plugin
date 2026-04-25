---
name: "task-finished-notifier"
description: "Use when any Codex session finishes a task and you need to push a structured Task Finished notification into a WeChat / Weixin chat through the local bridge runtime."
---

# Task Finished Notifier

![WeChat Bridge Icon](./assets/icon.png)

Use this skill only to send one structured completion notice into WeChat / Weixin through the installed local bridge runtime.

## What matters

- `Session ID` and `Session Name` must describe the Codex session where the work actually happened.
- The WeChat / Weixin delivery route is separate. Do not confuse the bridge-side mapped chat with the source Codex session.
- The message format is fixed. Do not rewrite the field labels.

## Fixed message format

```text
<Task Finished with leading light-bulb emoji>:
- Session ID: ...
- Session Name: ...
- Task Overview: ...
- Final Results: ...
- Next Step: ...
- Timestamp: YYYY-MM-DD HH:mm:ss
```

## UTF-8 rule

This rule is mandatory.

- If any field contains Chinese, emoji, or any other non-ASCII text, do not pass that content through shell flags.
- Do not embed Chinese directly in a PowerShell command.
- Do not rely on Windows shell defaults, PowerShell defaults, console code pages, or luck.
- Chinese and emoji notification content must be written to a UTF-8 JSON payload file first.
- Then call the notifier with an ASCII-safe shell command that uses `--payload-file`.

If you pass Chinese through CLI flags, you are using this skill incorrectly and should stop immediately.

## Required execution pattern

Use this pattern by default:

1. Write a UTF-8 JSON payload file on disk.
2. Keep the shell command ASCII-safe.
3. Invoke the notifier with `--payload-file`.

```powershell
node skills/task-finished-notifier/scripts/send_task_finished_notification.mjs --payload-file C:\path\to\task-finished.json
```

Optional preview:

```powershell
node skills/task-finished-notifier/scripts/send_task_finished_notification.mjs --payload-file C:\path\to\task-finished.json --dry-run
```

## Do not do this

- Do not use `--overview`, `--results`, `--next-step`, or `--session-name` for Chinese or emoji content.
- Do not generate a shell command that contains Chinese text directly.
- Do not claim "it should be fine this time".

## Payload example

```json
{
  "overview": "Write Chinese text into this UTF-8 JSON file, not into CLI flags.",
  "results": "The notifier reads Chinese content only from --payload-file.",
  "nextStep": "Keep the shell command ASCII-safe to avoid mojibake.",
  "sessionId": "<source-session-id>",
  "sessionName": "<source-session-name>"
}
```

## Operational notes

- Use Chinese for `Task Overview`, `Final Results`, and `Next Step` when talking to the user.
- `Timestamp` must use Beijing time (`Asia/Shanghai`) and 24-hour format.
- The script sends through the installed plugin runtime under `~/.codex/plugins/codex-wechat-bridge`.
- If the bridge returns `ret=-2`, wait for a fresh inbound WeChat message and retry or let the queued delivery logic handle it.
