# Architecture

## Goal
Run a local bridge on the user's Windows machine so WeChat private messages can reach Codex, receive one final response, and remain isolated per contact.

## Top-level shape
The project has three runtime-facing components:
- `wechat-bridge-daemon`: the only always-on process; owns login state, polling, conversation mapping, Codex invocation, and outbound replies
- local MCP server: exposes diagnostics and manual control tools to Codex Desktop
- Codex plugin bundle: packages MCP wiring and operational skills for Codex Desktop

## Why this is not an OpenClaw plugin
OpenClaw-specific host abstractions are intentionally removed. This bridge only targets the Codex Desktop scenario and therefore keeps the minimal architecture needed for that scenario.

## Component responsibilities

### Weixin client layer
Responsibilities:
- QR login start/wait
- authenticated protocol calls
- request/response typing
- update fetch
- message send
- typing send/cancel
- upload URL support for future media work

Non-responsibilities:
- conversation routing
- dedupe policy
- Codex invocation

### SQLite state store
Core tables:
- `accounts`
- `conversations`
- `poll_state`
- `inbound_message_dedupe`
- `pending_messages`
- `deliveries`
- `diagnostic_events`

Stored concerns:
- account/login metadata
- durable update cursor
- durable context token cache
- stable conversation mapping
- dedupe keys for inbound messages
- outbound delivery attempts and retry state
- structured diagnostics

### Conversation router
Responsibilities:
- accept inbound private-chat events
- derive `conversation_key = wechat_account_id + peer_user_id`
- ensure distinct contacts never share history
- create or reuse Codex-side conversation metadata

### Codex runner
Interface:
- accept a conversation identity and prompt payload
- start Codex execution
- stream internal progress events to the daemon
- return a final response or failure

V1 implementation:
- `ExecCodexRunner` backed by `codex exec`

Future implementation:
- `AppServerCodexRunner`

### Reply orchestrator
Responsibilities:
- own one inbound message job lifecycle
- mark diagnostics and delivery attempts
- start typing keepalive
- call Codex runner
- stop typing
- send one final text reply
- persist success/failure outcome

## Runtime flow
1. Daemon starts and opens SQLite state.
2. Daemon restores accounts and per-account poll state.
3. Daemon begins long-poll `getupdates` loop.
4. Each inbound message is filtered to private chats only.
5. Daemon deduplicates by durable inbound key.
6. Daemon captures and persists `context_token`.
7. Daemon resolves the stable `conversation_key`.
8. Reply orchestrator starts typing keepalive.
9. Codex runner invokes `codex exec` with the conversation context.
10. When Codex finishes, daemon sends one final text reply using the persisted context token.
11. Delivery state and diagnostics are stored.

## Safety policy
- Private chats only in v1.
- No shared conversation buckets.
- No partial streaming text into WeChat.
- No silent failure on missing context token, expired session, or outbound errors.
- No automatic support for group chat until explicitly designed.

## MCP surface
The MCP server is a control plane, not the autonomous engine. Expected tools:
- `login`
- `get_login_status`
- `list_conversations`
- `fetch_updates`
- `send_text_message`
- `send_image_message` phase-2 placeholder
- `set_typing_state`
- `retry_delivery`
- `get_diagnostics`
- `get_account_state`

## Plugin bundle surface
The plugin bundle should do two things well:
- make the MCP server easy for Codex Desktop to use locally
- instruct Codex not to misuse the bridge, especially not to reply to the wrong WeChat peer

## Known trade-offs
- `codex exec` is chosen for stability over deeper thread control.
- `node:sqlite` avoids an extra native dependency but is still experimental in Node 22.
- Media support is intentionally secondary to a correct text path.
