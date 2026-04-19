---
name: "deliver-file"
description: "Use when the user explicitly wants one or more local files or images delivered to WeChat / Weixin through the local bridge."
---

# Deliver File

![WeChat Bridge Icon](./assets/icon.png)

Use this skill when a user explicitly asks Codex to send one or more local files back to WeChat / Weixin through the installed bridge runtime.

## Core model

This skill handles file delivery, not file creation.

- First decide whether the user explicitly authorized WeChat / Weixin delivery in the current task.
- Then identify the exact local file path or paths to send.
- Then call the bridge MCP tool that matches the artifact type.

Do not treat "generate a PDF" as equivalent to "send the PDF to WeChat". Delivery requires explicit user intent.

## When to use it

- The current WeChat turn explicitly says to send the generated artifact back to WeChat / Weixin.
- A desktop Codex session explicitly says to send a local file or image to the user's WeChat / Weixin chat.
- Bridge guidance in the prompt tells you that delivery is authorized for this turn.

## Hard rules

- Do not send any file unless the user explicitly asked for WeChat / Weixin delivery.
- Prefer explicit absolute file paths.
- Do not guess unrelated files from the workspace.
- If file creation, patch writing, export, or rendering failed, do not attempt delivery. First confirm the artifact really exists on disk.
- If the route is ambiguous, inspect the bridge state first instead of sending blindly.
- Prefer the fixed local script entrypoint first:

```powershell
node skills/deliver-file/scripts/send_wechat_file.mjs --file C:\absolute\path\to\artifact.pdf
```

- Use `send_image_message` for images when you already have direct tool access.
- Use `send_file_message` for PDFs, text files, Word files, zip files, and other non-image attachments when you already have direct tool access.
- If a send succeeds in a bridge-authorized turn, append one exact marker line to the final answer:

```text
[[WECHAT_DELIVERED:<absolute-path>]]
```

- Only emit the marker after a real successful send.
- Do not emit that marker in unrelated sessions that were not instructed to use it.

## Recommended flow

1. Confirm the current task really includes explicit WeChat / Weixin delivery.
2. Identify the exact local file path to send.
3. Confirm the file really exists on disk and is the intended artifact.
4. Run the fixed script:

```powershell
node skills/deliver-file/scripts/send_wechat_file.mjs --file C:\absolute\path\to\artifact.pdf
```

5. If needed, inspect `get_account_state` or `list_conversations` to confirm the route.
6. If you already have direct tool access, you may call `send_image_message` or `send_file_message` directly instead of the script.
7. If the send succeeds and the prompt explicitly asked for delivery markers, append `[[WECHAT_DELIVERED:<absolute-path>]]` to the final answer.
8. If the send fails, explain the failure clearly and fall back to a text result when appropriate.

## Tool guidance

- `send_image_message`
  Use for `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`.
- `send_file_message`
  Use for `.pdf`, `.txt`, `.md`, `.doc`, `.docx`, `.zip`, and other general file attachments.
- `list_conversations`
  Use when you need to inspect the current bridge route.
- `get_account_state`
  Use when you need to confirm there is an active logged-in account.

## Failure handling

- If the file does not exist, do not send anything. Report that the expected artifact was not created.
- If the model saw a patch/apply/write/export error earlier in the turn, treat that as a creation failure until the file is visibly present on disk.
- If the bridge lacks a fresh reply context, explain that WeChat / Weixin needs a new inbound message before retrying.
- If delivery fails after the artifact is generated, still provide the textual result when possible instead of silently failing.
