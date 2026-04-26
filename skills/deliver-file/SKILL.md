---
name: "deliver-file"
description: "Use when explicitly sending local files or images to WeChat / Weixin."
---

# Deliver File

![WeChat Bridge Icon](./assets/icon.png)

Send existing local files to WeChat / Weixin through the installed bridge runtime. This skill does not create files.

## Hard Rules

- Send nothing unless the current task explicitly authorizes WeChat / Weixin delivery.
- Do not treat "generate/export a file" as permission to send it.
- Confirm the exact local file exists before delivery.
- Prefer absolute paths. Do not guess unrelated workspace files.
- If the route is ambiguous, inspect bridge state before sending.
- If account state is empty, first confirm the runtime database is the installed global one:
  `C:\Users\<you>\.codex\plugins\codex-wechat-bridge\state\bridge.sqlite`.
- Treat empty accounts from cache, repo, or temp plugin paths as a runtime-path bug, not proof of logout.

## Default Entry

Prefer the fixed script:

```powershell
node skills/deliver-file/scripts/send_wechat_file.mjs --file C:\absolute\path\to\artifact.pdf
```

If direct MCP tools are already available:

- Use `send_image_message` for `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`.
- Use `send_file_message` for `.pdf`, `.txt`, `.md`, `.doc`, `.docx`, `.zip`, and other attachments.

## Success Marker

Only after a real successful send in a bridge-authorized turn, append:

```text
[[WECHAT_DELIVERED:<absolute-path>]]
```

Never emit this marker for unrelated sessions or failed sends.

## Failure Handling

- If the artifact does not exist, report that it was not created.
- If file generation/export had an error earlier in the turn, verify the file on disk before sending.
- If WeChat reply context is stale, explain that a fresh inbound WeChat message is needed before retry.
- If delivery fails after generation, still provide the text result when useful.
