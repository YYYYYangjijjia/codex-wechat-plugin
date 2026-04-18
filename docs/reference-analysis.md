# Reference Analysis: `openclaw-weixin`

## Scope and method
This document analyzes the upstream reference implementation at `_reference/openclaw-weixin/`.

Facts in this document come from the copied source tree and upstream README. Statements marked as **inference** are design conclusions for this Codex Desktop bridge.

## 1. Entrypoints, package metadata, module structure, dependencies

### Package metadata
Facts from `package.json`:
- Package name: `@tencent-weixin/openclaw-weixin`
- Type: ESM (`"type": "module"`)
- Engine: `node >=22`
- Main published files include `src/`, `index.ts`, `openclaw.plugin.json`, and README files
- Runtime dependencies: `qrcode-terminal`, `zod`
- Dev/test dependencies include `openclaw`, `typescript`, `vitest`, `silk-wasm`

### Host entrypoints
Facts:
- `openclaw.plugin.json` declares the plugin id `openclaw-weixin`
- `index.ts` exports OpenClaw plugin registration
- `src/channel.ts` is the core OpenClaw channel implementation

### Module structure
Observed top-level module areas under `src/`:
- `api/`: protocol request/response typing and HTTP client wrappers
- `auth/`: QR login, account persistence, account indexing, pairing/auth helpers
- `cdn/`: upload and crypto helpers for media/CDN transport
- `config/`: OpenClaw config schema helpers
- `media/`: media download, MIME detection, voice transcode
- `messaging/`: inbound parsing, context token persistence, outbound send, markdown filtering, slash commands
- `monitor/`: long-poll loop and inbound dispatch orchestration
- `storage/`: state-dir and sync-buffer persistence
- `util/`: logging, random ids, redaction
- `runtime.ts`: OpenClaw runtime accessors
- `compat.ts`: OpenClaw host version compatibility checks

### Architectural read
Inference:
- The upstream codebase mixes two categories of logic:
  - portable protocol/client logic for WeChat transport
  - OpenClaw host-integration logic for routing, config reloads, command authorization, session storage, reply dispatch, and runtime facilities
- The first category is reusable for this project. The second category is not.

## 2. Functional capability list
Facts observed in README and source:
- QR-code login
- Local persistence of account credentials
- Multi-account registration/indexing
- Long-poll update fetch via `getupdates`
- Text inbound/outbound message flow
- Context-token-aware reply behavior
- Typing indicator via `getconfig` + `sendtyping`
- Media download/decrypt for inbound media
- Media upload/send for image, video, and file outbound flows
- Error handling and session-expiry pauses
- Debug-mode timing traces
- Reference support for private chats; group support is not the primary path

## 3. External protocol and interfaces
The README and `src/api/types.ts` identify these backend endpoints:
- `ilink/bot/getupdates`
- `ilink/bot/sendmessage`
- `ilink/bot/getuploadurl`
- `ilink/bot/getconfig`
- `ilink/bot/sendtyping`
- QR login endpoints under `ilink/bot/get_bot_qrcode` and `ilink/bot/get_qrcode_status`

Common headers built by `src/api/api.ts`:
- `Content-Type: application/json`
- `AuthorizationType: ilink_bot_token`
- `Authorization: Bearer <token>` when logged in
- `X-WECHAT-UIN`: random base64-encoded uint32
- `iLink-App-Id`
- `iLink-App-ClientVersion`
- optional `SKRouteTag`

## 4. Login flow
Facts from `src/auth/login-qr.ts` and `src/channel.ts`:
- Login starts by calling `get_bot_qrcode` against `https://ilinkai.weixin.qq.com`
- The response returns QR code data and a QR image/content URL
- The plugin keeps an in-memory active-login map with TTL
- It polls `get_qrcode_status` until status changes
- Status values include:
  - `wait`
  - `scaned`
  - `confirmed`
  - `expired`
  - `scaned_but_redirect`
- On redirect it switches polling base URL
- On confirm it receives `bot_token`, `ilink_bot_id`, optional base URL, and `ilink_user_id`
- `src/channel.ts` normalizes the account id, saves credentials locally, clears stale accounts for the same user id, and triggers OpenClaw channel reload

Inference for migration:
- The QR protocol and local persistence idea are portable.
- OpenClaw-specific account normalization/reload hooks are not needed; this project should replace them with its own state store and daemon lifecycle.

## 5. Message receive flow
Facts from `src/monitor/monitor.ts`:
- The runtime long-polls `getupdates`
- It persists and reloads `get_updates_buf`
- It respects server-suggested `longpolling_timeout_ms`
- It handles API errors, including a special session-expired error path
- For each inbound message, it fetches cached typing config per user and passes the message to `processOneMessage`

Facts from `src/messaging/process-message.ts` and `src/messaging/inbound.ts`:
- It extracts text from `item_list`
- It downloads media if present
- It converts upstream `WeixinMessage` into an internal context object
- It stores `context_token` keyed by account + peer
- It resolves routing/session inside OpenClaw and records inbound session state

Inference for migration:
- The durable cursor, long-poll retry policy, and context-token persistence are directly reusable design ideas.
- OpenClaw routing/session recording must be replaced by this project's own `conversation_key` mapping.

## 6. Message send flow
Facts from `src/messaging/send.ts`:
- Outbound text send wraps one `WeixinMessage`
- Text send sets `message_type = BOT`
- Text send sets `message_state = FINISH`
- Outbound sends include `context_token` when available
- Media send is split so each `MessageItem` is sent in its own request

Facts from `src/channel.ts` and `src/messaging/send-media.ts`:
- Media path supports local files and remote URLs
- Media is routed by MIME type to image/video/file upload helpers
- Missing `contextToken` is warned about, not silently invented

## 7. Typing / generating / finish handling
Facts:
- `src/api/types.ts` defines `MessageState.NEW`, `MessageState.GENERATING`, and `MessageState.FINISH`
- `src/api/types.ts` also defines `TypingStatus.TYPING` and `TypingStatus.CANCEL`
- `src/messaging/process-message.ts` uses `getconfig` to obtain a `typing_ticket`
- During reply generation it sends typing keepalives and then cancels typing
- `src/messaging/send.ts` still sends final messages with `message_state = FINISH`

Inference:
- The upstream implementation does not appear to rely on a stable WeChat-side incremental `GENERATING` text stream for the main reply path.
- For this project, `typing + final answer` is the correct v1 parity target.

## 8. Media upload flow
Facts from README and `src/cdn/upload.ts` / `src/messaging/send-media.ts`:
- Media upload requires `getuploadurl` first
- File metadata includes plaintext size, MD5, ciphertext size, and thumbnail metadata when needed
- Upload uses AES-128-ECB encryption and CDN parameters
- Returned CDN references are then embedded into outbound `MessageItem` payloads

Migration conclusion:
- The protocol path is portable but materially more complex than text.
- V1 should stabilize text first and keep image/media as either a limited addition or phase 2.

## 9. Multi-account and conversation isolation
Facts from `src/auth/accounts.ts` and README:
- The plugin keeps a persistent account index and per-account credential files
- It supports multiple logged-in accounts
- It removes stale accounts that share the same linked user id after a fresh login
- README explicitly recommends stricter dm scope for multi-account isolation
- Context tokens are stored per `accountId:userId`

Inference for this project:
- The minimum safe isolation key is `wechat_account_id + peer_user_id`
- V1 can still run one practical account, but the storage model should not assume only one forever

## 10. OpenClaw-coupled implementation areas
Strong host coupling appears in:
- `src/channel.ts` implementing `ChannelPlugin`
- `openclaw.plugin.json`
- `compat.ts` host version checks
- OpenClaw config schema, config runtime, and channel reload logic
- OpenClaw routing/session store integration
- OpenClaw command authorization and pairing helpers
- OpenClaw reply dispatch and typing callback helpers
- OpenClaw runtime and temp-dir helpers

These parts should not be copied into the final runtime.

## 11. Migratable logic for Codex plugin + MCP + daemon
Reusable concepts and patterns:
- QR login status machine
- authenticated Weixin HTTP client wrappers
- durable `get_updates_buf` persistence
- durable `context_token` persistence by account + peer
- request/response typing for Weixin protocol entities
- long-poll retry/backoff structure
- explicit send path that never fakes success on missing context
- media architecture boundaries, even if not fully implemented in v1

## 12. Migration risks and replacement strategy
### Main risks
- Real login/session behavior may depend on upstream server behavior that cannot be fully mocked from source review alone.
- `node:sqlite` is acceptable for v1 but remains experimental in Node 22.
- `codex exec` is stable, but it is not the same as controlling an active Desktop thread.
- Media parity is meaningfully more complex than text parity.

### Replacement strategy
- Replace OpenClaw routing/session logic with a SQLite-backed `conversation_key` mapping.
- Replace OpenClaw daemon/gateway with a local `wechat-bridge-daemon`.
- Replace OpenClaw control plane with a local MCP server plus Codex plugin bundle.
- Replace OpenClaw reply dispatcher with a daemon-owned `reply-orchestrator` that drives `typing`, calls Codex, and sends one final text message.
- Keep a thin `CodexRunner` adapter so `codex exec` can be swapped for `app-server` later.

## Final migration conclusion
The upstream project is best treated as a **protocol and state-machine reference**, not as a reusable host integration. The viable Codex/Desktop rebuild is:
- daemon for autonomous inbound handling
- MCP server for control and diagnostics
- Codex plugin bundle for local integration
- no OpenClaw runtime dependency at all