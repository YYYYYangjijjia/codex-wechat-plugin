# Testing

## Automated Checks

```powershell
npm run test
npm run typecheck
npm run build
```

## What the Automated Suite Covers

- QR login state parsing and timeout handling
- persistent cursor and context-token storage
- conversation mapping and isolation
- app-server runner behavior and fallback behavior
- bridge command parsing and local command handling
- attachment ingress download and prompt construction
- delivery recording and diagnostics persistence
- MCP tool dispatch

## Manual Verification

### Core runtime
1. Start the tray or daemon.
2. Run `npm run login` and complete QR login.
3. Send a private WeChat message.
4. Confirm a reply arrives.
5. Restart the daemon and confirm recovery.

### WeChat control commands
Verify these work locally and do not go through normal model generation:
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

### Attachments
1. Send an image.
2. Send a file.
3. Confirm files appear under `.cache/wechat-bridge/inbound-attachments/`.
4. Confirm the resulting prompt includes attachment metadata and local paths.

### Session behavior
1. Switch to another Codex session with `/use-session <id>`.
2. Confirm `/session` shows the switched workspace.
3. Run `/newsession` and confirm the next normal message starts a fresh session.

### Runtime controls
1. Use the tray to restart the daemon.
2. Confirm the daemon gets a new PID and healthy status.
3. If needed, verify with `npm run dev:status`.

## Known Runtime Constraint

Manual sends and some lifecycle notifications depend on a fresh WeChat reply context.
If a send fails with `ret=-2`, send a fresh inbound WeChat message first and retry.

## Acceptance Summary

A release candidate is ready when:
- automated checks pass
- plugin install works from `npm run install:plugin`
- tray install works from `npm run install:tray`
- QR login works
- a private message roundtrip works
- session switching works
- attachment ingress works
- tray daemon restart works
