---
name: "task-finished-notifier"
description: "Use when sending a Task Finished notice to WeChat / Weixin."
---

# Task Finished Notifier

![WeChat Bridge Icon](./assets/icon.png)

Send one structured completion notice to WeChat / Weixin through the installed bridge runtime.

## Required Semantics

- `Session ID` and `Session Name` describe the Codex session where the work happened.
- Delivery route is separate from source session. Do not use the current bridge mapping as the source session unless it is actually the source.
- If account state is empty, first verify the installed global runtime database:
  `C:\Users\<you>\.codex\plugins\codex-wechat-bridge\state\bridge.sqlite`.
- Empty accounts from cache, repo, or temp plugin paths indicate a runtime-path bug, not automatic logout.

## Fixed Format

```text
<💡Task Finished>:
- Session ID: ...
- Session Name: ...
- Task Overview: ...
- Final Results: ...
- Next Step: ...
- Timestamp: YYYY-MM-DD HH:mm:ss
```

Labels stay English. Content should usually be Chinese. Timestamp is Beijing time, 24-hour format, without writing "北京时间".

## UTF-8 Rule

Mandatory: Chinese and emoji must go through a UTF-8 JSON payload file.

- Do not pass Chinese or emoji through shell flags.
- Do not embed Chinese directly in a PowerShell command.
- Do not rely on console code pages or PowerShell defaults.
- If you use `--overview`, `--results`, `--next-step`, or `--session-name` with Chinese, you are using this skill incorrectly.

## Execution

Write a UTF-8 JSON payload file, then run an ASCII-safe command:

```powershell
node skills/task-finished-notifier/scripts/send_task_finished_notification.mjs --payload-file C:\path\to\task-finished.json
```

Preview:

```powershell
node skills/task-finished-notifier/scripts/send_task_finished_notification.mjs --payload-file C:\path\to\task-finished.json --dry-run
```

If WeChat returns `ret=-2`, wait for a fresh inbound WeChat message and retry, or let queued delivery handle it.
