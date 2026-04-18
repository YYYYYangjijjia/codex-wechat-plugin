import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type PollState = {
  accountId: string;
  cursor: string;
  nextTimeoutMs?: number | undefined;
};

export type AccountRecord = {
  accountId: string;
  token?: string | undefined;
  baseUrl: string;
  linkedUserId?: string | undefined;
  loginState: "active" | "expired" | "pending";
  createdAt: string;
  updatedAt: string;
};

export type ConversationRecord = {
  conversationKey: string;
  accountId: string;
  peerUserId: string;
  runnerBackend?: "exec" | "app_server" | undefined;
  runnerThreadId?: string | undefined;
  runnerCwd?: string | undefined;
  codexThreadId?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type DiagnosticEvent = {
  id: number;
  code: string;
  accountId?: string | undefined;
  detail?: string | undefined;
  createdAt: string;
};

export type PendingMessageRecord = {
  id: number;
  conversationKey: string;
  accountId: string;
  peerUserId: string;
  contextToken?: string | undefined;
  prompt: string;
  runnerBackend?: "exec" | "app_server" | undefined;
  runnerThreadId?: string | undefined;
  runnerCwd?: string | undefined;
  threadId?: string | undefined;
  status: "pending" | "sent" | "failed" | "interrupted";
  errorMessage?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryRecord = {
  id: number;
  conversationKey: string;
  status: string;
  errorMessage?: string | undefined;
  prompt?: string | undefined;
  finalMessage?: string | undefined;
  peerUserId?: string | undefined;
  contextToken?: string | undefined;
  threadId?: string | undefined;
  createdAt: string;
};

export type StateStore = {
  close(): void;
  savePollState(state: PollState): void;
  getPollState(accountId: string): PollState | undefined;
  saveContextToken(entry: { accountId: string; peerUserId: string; contextToken: string }): void;
  getContextToken(accountId: string, peerUserId: string): string | undefined;
  resolveConversation(input: { accountId: string; peerUserId: string }): ConversationRecord;
  clearConversationThread(conversationKey: string): void;
  updateConversationThread(
    conversationKey: string,
    thread:
      | string
        | {
            runnerBackend: "exec" | "app_server";
            runnerThreadId: string;
            runnerCwd?: string | undefined;
        },
  ): void;
  listConversations(): ConversationRecord[];
  upsertAccount(entry: { accountId: string; token?: string | undefined; baseUrl: string; linkedUserId?: string | undefined; loginState: "active" | "expired" | "pending" }): void;
  getAccount(accountId: string): AccountRecord | undefined;
  listAccounts(): AccountRecord[];
  recordInboundMessage(entry: { accountId: string; peerUserId: string; messageKey: string }): boolean;
  enqueuePendingMessage(entry: {
    conversationKey: string;
    accountId: string;
    peerUserId: string;
    contextToken?: string | undefined;
    prompt: string;
    thread?:
      | string
        | {
            runnerBackend: "exec" | "app_server";
            runnerThreadId: string;
            runnerCwd?: string | undefined;
        }
      | undefined;
  }): number;
  getPendingMessage(id: number): PendingMessageRecord | undefined;
  listPendingMessages(statuses?: Array<PendingMessageRecord["status"]>): PendingMessageRecord[];
  markPendingMessageStatus(
    id: number,
    update: {
      status: PendingMessageRecord["status"];
      thread?:
        | string
        | {
            runnerBackend: "exec" | "app_server";
            runnerThreadId: string;
            runnerCwd?: string | undefined;
          }
        | undefined;
      errorMessage?: string | undefined;
    },
  ): void;
  recordDeliveryAttempt(entry: { conversationKey: string; status: string; errorMessage?: string | undefined; prompt?: string | undefined; finalMessage?: string | undefined; peerUserId?: string | undefined; contextToken?: string | undefined; threadId?: string | undefined }): void;
  listDeliveries(limit?: number): DeliveryRecord[];
  saveRuntimeState(key: string, value: unknown): void;
  getRuntimeState(key: string): unknown;
  recordDiagnostic(entry: { code: string; accountId?: string | undefined; detail?: string | undefined }): void;
  listDiagnostics(limit?: number): DiagnosticEvent[];
};

function buildConversationKey(accountId: string, peerUserId: string): string {
  return `${accountId}:${peerUserId}`;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function createStateStore(input: { databasePath: string }): StateStore {
  ensureParentDir(input.databasePath);
  const db = new DatabaseSync(input.databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      token TEXT,
      base_url TEXT NOT NULL,
      linked_user_id TEXT,
      login_state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_state (
      account_id TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      next_timeout_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS context_tokens (
      account_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      PRIMARY KEY (account_id, peer_user_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      conversation_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      runner_backend TEXT,
      runner_thread_id TEXT,
      runner_cwd TEXT,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_message_dedupe (
      account_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      message_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, message_key)
    );

    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      context_token TEXT,
      prompt TEXT NOT NULL,
      runner_backend TEXT,
      runner_thread_id TEXT,
      runner_cwd TEXT,
      thread_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      prompt TEXT,
      final_message TEXT,
      peer_user_id TEXT,
      context_token TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagnostic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      account_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_state (
      state_key TEXT PRIMARY KEY,
      json_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  for (const statement of [
    `ALTER TABLE conversations ADD COLUMN runner_backend TEXT`,
    `ALTER TABLE conversations ADD COLUMN runner_thread_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN runner_cwd TEXT`,
    `ALTER TABLE pending_messages ADD COLUMN runner_backend TEXT`,
    `ALTER TABLE pending_messages ADD COLUMN runner_thread_id TEXT`,
    `ALTER TABLE pending_messages ADD COLUMN runner_cwd TEXT`,
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Existing databases will already have these columns after the first successful migration.
    }
  }

  const upsertAccountStmt = db.prepare(`
    INSERT INTO accounts (account_id, token, base_url, linked_user_id, login_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      token = excluded.token,
      base_url = excluded.base_url,
      linked_user_id = excluded.linked_user_id,
      login_state = excluded.login_state,
      updated_at = excluded.updated_at
  `);
  const getAccountStmt = db.prepare(`SELECT account_id, token, base_url, linked_user_id, login_state, created_at, updated_at FROM accounts WHERE account_id = ?`);
  const listAccountsStmt = db.prepare(`SELECT account_id, token, base_url, linked_user_id, login_state, created_at, updated_at FROM accounts ORDER BY updated_at DESC`);
  const savePollStateStmt = db.prepare(`
    INSERT INTO poll_state (account_id, cursor, next_timeout_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor, next_timeout_ms = excluded.next_timeout_ms
  `);
  const getPollStateStmt = db.prepare(`SELECT account_id, cursor, next_timeout_ms FROM poll_state WHERE account_id = ?`);
  const saveContextTokenStmt = db.prepare(`
    INSERT INTO context_tokens (account_id, peer_user_id, context_token)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, peer_user_id) DO UPDATE SET context_token = excluded.context_token
  `);
  const getContextTokenStmt = db.prepare(`SELECT context_token FROM context_tokens WHERE account_id = ? AND peer_user_id = ?`);
  const getConversationStmt = db.prepare(`SELECT conversation_key, account_id, peer_user_id, runner_backend, runner_thread_id, runner_cwd, codex_thread_id, created_at, updated_at FROM conversations WHERE conversation_key = ?`);
  const insertConversationStmt = db.prepare(`
    INSERT INTO conversations (conversation_key, account_id, peer_user_id, runner_backend, runner_thread_id, runner_cwd, codex_thread_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);
  const updateConversationThreadStmt = db.prepare(`UPDATE conversations SET runner_backend = ?, runner_thread_id = ?, runner_cwd = ?, codex_thread_id = ?, updated_at = ? WHERE conversation_key = ?`);
  const clearConversationThreadStmt = db.prepare(`UPDATE conversations SET runner_backend = NULL, runner_thread_id = NULL, runner_cwd = NULL, codex_thread_id = NULL, updated_at = ? WHERE conversation_key = ?`);
  const listConversationsStmt = db.prepare(`SELECT conversation_key, account_id, peer_user_id, runner_backend, runner_thread_id, runner_cwd, codex_thread_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC`);
  const insertInboundMessageStmt = db.prepare(`
    INSERT OR IGNORE INTO inbound_message_dedupe (account_id, peer_user_id, message_key, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertPendingMessageStmt = db.prepare(`
    INSERT INTO pending_messages (conversation_key, account_id, peer_user_id, context_token, prompt, runner_backend, runner_thread_id, runner_cwd, thread_id, status, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
  `);
  const getPendingMessageStmt = db.prepare(`SELECT id, conversation_key, account_id, peer_user_id, context_token, prompt, runner_backend, runner_thread_id, runner_cwd, thread_id, status, error_message, created_at, updated_at FROM pending_messages WHERE id = ?`);
  const listPendingMessagesStmt = db.prepare(`SELECT id, conversation_key, account_id, peer_user_id, context_token, prompt, runner_backend, runner_thread_id, runner_cwd, thread_id, status, error_message, created_at, updated_at FROM pending_messages ORDER BY updated_at DESC`);
  const updatePendingMessageStmt = db.prepare(`UPDATE pending_messages SET status = ?, runner_backend = ?, runner_thread_id = ?, runner_cwd = ?, thread_id = ?, error_message = ?, updated_at = ? WHERE id = ?`);
  const insertDeliveryStmt = db.prepare(`
    INSERT INTO deliveries (conversation_key, status, error_message, prompt, final_message, peer_user_id, context_token, thread_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listDeliveriesStmt = db.prepare(`SELECT id, conversation_key, status, error_message, prompt, final_message, peer_user_id, context_token, thread_id, created_at FROM deliveries ORDER BY id DESC LIMIT ?`);
  const upsertRuntimeStateStmt = db.prepare(`
    INSERT INTO runtime_state (state_key, json_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET json_value = excluded.json_value, updated_at = excluded.updated_at
  `);
  const getRuntimeStateStmt = db.prepare(`SELECT json_value FROM runtime_state WHERE state_key = ?`);
  const insertDiagnosticStmt = db.prepare(`INSERT INTO diagnostic_events (code, account_id, detail, created_at) VALUES (?, ?, ?, ?)`);
  const listDiagnosticsStmt = db.prepare(`SELECT id, code, account_id, detail, created_at FROM diagnostic_events ORDER BY id DESC LIMIT ?`);

  function mapAccountRow(row: { account_id: string; token: string | null; base_url: string; linked_user_id: string | null; login_state: string; created_at: string; updated_at: string }): AccountRecord {
    return {
      accountId: row.account_id,
      token: row.token ?? undefined,
      baseUrl: row.base_url,
      linkedUserId: row.linked_user_id ?? undefined,
      loginState: row.login_state as AccountRecord["loginState"],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapConversationRow(row: { conversation_key: string; account_id: string; peer_user_id: string; runner_backend: string | null; runner_thread_id: string | null; runner_cwd: string | null; codex_thread_id: string | null; created_at: string; updated_at: string }): ConversationRecord {
    return {
      conversationKey: row.conversation_key,
      accountId: row.account_id,
      peerUserId: row.peer_user_id,
      runnerBackend: (row.runner_backend as ConversationRecord["runnerBackend"]) ?? undefined,
      runnerThreadId: row.runner_thread_id ?? row.codex_thread_id ?? undefined,
      runnerCwd: row.runner_cwd ?? undefined,
      codexThreadId: row.codex_thread_id ?? row.runner_thread_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapPendingMessageRow(row: { id: number; conversation_key: string; account_id: string; peer_user_id: string; context_token: string | null; prompt: string; runner_backend: string | null; runner_thread_id: string | null; runner_cwd: string | null; thread_id: string | null; status: string; error_message: string | null; created_at: string; updated_at: string }): PendingMessageRecord {
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      accountId: row.account_id,
      peerUserId: row.peer_user_id,
      contextToken: row.context_token ?? undefined,
      prompt: row.prompt,
      runnerBackend: (row.runner_backend as PendingMessageRecord["runnerBackend"]) ?? undefined,
      runnerThreadId: row.runner_thread_id ?? row.thread_id ?? undefined,
      runnerCwd: row.runner_cwd ?? undefined,
      threadId: row.thread_id ?? row.runner_thread_id ?? undefined,
      status: row.status as PendingMessageRecord["status"],
      errorMessage: row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    close(): void {
      db.close();
    },
    upsertAccount(entry) {
      const existing = this.getAccount(entry.accountId);
      const now = new Date().toISOString();
      upsertAccountStmt.run(
        entry.accountId,
        entry.token ?? existing?.token ?? null,
        entry.baseUrl,
        entry.linkedUserId ?? existing?.linkedUserId ?? null,
        entry.loginState,
        existing?.createdAt ?? now,
        now,
      );
    },
    getAccount(accountId: string): AccountRecord | undefined {
      const row = getAccountStmt.get(accountId) as { account_id: string; token: string | null; base_url: string; linked_user_id: string | null; login_state: string; created_at: string; updated_at: string } | undefined;
      return row ? mapAccountRow(row) : undefined;
    },
    listAccounts(): AccountRecord[] {
      const rows = listAccountsStmt.all() as Array<{ account_id: string; token: string | null; base_url: string; linked_user_id: string | null; login_state: string; created_at: string; updated_at: string }>;
      return rows.map(mapAccountRow);
    },
    savePollState(state: PollState): void {
      savePollStateStmt.run(state.accountId, state.cursor, state.nextTimeoutMs ?? null);
    },
    getPollState(accountId: string): PollState | undefined {
      const row = getPollStateStmt.get(accountId) as { account_id: string; cursor: string; next_timeout_ms: number | null } | undefined;
      if (!row) return undefined;
      return {
        accountId: row.account_id,
        cursor: row.cursor,
        nextTimeoutMs: row.next_timeout_ms ?? undefined,
      };
    },
    saveContextToken(entry: { accountId: string; peerUserId: string; contextToken: string }): void {
      saveContextTokenStmt.run(entry.accountId, entry.peerUserId, entry.contextToken);
    },
    getContextToken(accountId: string, peerUserId: string): string | undefined {
      const row = getContextTokenStmt.get(accountId, peerUserId) as { context_token: string } | undefined;
      return row?.context_token;
    },
    resolveConversation(inputConversation: { accountId: string; peerUserId: string }): ConversationRecord {
      const conversationKey = buildConversationKey(inputConversation.accountId, inputConversation.peerUserId);
      const existing = getConversationStmt.get(conversationKey) as { conversation_key: string; account_id: string; peer_user_id: string; runner_backend: string | null; runner_thread_id: string | null; runner_cwd: string | null; codex_thread_id: string | null; created_at: string; updated_at: string } | undefined;
      if (existing) return mapConversationRow(existing);
      const now = new Date().toISOString();
      insertConversationStmt.run(conversationKey, inputConversation.accountId, inputConversation.peerUserId, now, now);
      return {
        conversationKey,
        accountId: inputConversation.accountId,
        peerUserId: inputConversation.peerUserId,
        createdAt: now,
        updatedAt: now,
      };
    },
    updateConversationThread(conversationKey, thread): void {
      const runnerBackend = typeof thread === "string" ? "exec" : thread.runnerBackend;
      const runnerThreadId = typeof thread === "string" ? thread : thread.runnerThreadId;
      const runnerCwd = typeof thread === "string" ? null : thread.runnerCwd ?? null;
      updateConversationThreadStmt.run(runnerBackend, runnerThreadId, runnerCwd, runnerThreadId, new Date().toISOString(), conversationKey);
    },
    clearConversationThread(conversationKey: string): void {
      clearConversationThreadStmt.run(new Date().toISOString(), conversationKey);
    },
    listConversations(): ConversationRecord[] {
      const rows = listConversationsStmt.all() as Array<{ conversation_key: string; account_id: string; peer_user_id: string; runner_backend: string | null; runner_thread_id: string | null; runner_cwd: string | null; codex_thread_id: string | null; created_at: string; updated_at: string }>;
      return rows.map(mapConversationRow);
    },
    recordInboundMessage(entry: { accountId: string; peerUserId: string; messageKey: string }): boolean {
      const result = insertInboundMessageStmt.run(entry.accountId, entry.peerUserId, entry.messageKey, new Date().toISOString());
      return result.changes > 0;
    },
    enqueuePendingMessage(entry): number {
      const now = new Date().toISOString();
      const runnerBackend = typeof entry.thread === "string" ? "exec" : entry.thread?.runnerBackend ?? null;
      const runnerThreadId = typeof entry.thread === "string" ? entry.thread : entry.thread?.runnerThreadId ?? null;
      const runnerCwd = typeof entry.thread === "string" ? null : entry.thread?.runnerCwd ?? null;
      const result = insertPendingMessageStmt.run(
        entry.conversationKey,
        entry.accountId,
        entry.peerUserId,
        entry.contextToken ?? null,
        entry.prompt,
        runnerBackend,
        runnerThreadId,
        runnerCwd,
        runnerThreadId,
        now,
        now,
      );
      return Number(result.lastInsertRowid);
    },
    getPendingMessage(id: number): PendingMessageRecord | undefined {
      const row = getPendingMessageStmt.get(id) as { id: number; conversation_key: string; account_id: string; peer_user_id: string; context_token: string | null; prompt: string; runner_backend: string | null; runner_thread_id: string | null; runner_cwd: string | null; thread_id: string | null; status: string; error_message: string | null; created_at: string; updated_at: string } | undefined;
      return row ? mapPendingMessageRow(row) : undefined;
    },
    listPendingMessages(statuses?: Array<PendingMessageRecord["status"]>): PendingMessageRecord[] {
      const rows = listPendingMessagesStmt.all() as Array<{ id: number; conversation_key: string; account_id: string; peer_user_id: string; context_token: string | null; prompt: string; runner_backend: string | null; runner_thread_id: string | null; runner_cwd: string | null; thread_id: string | null; status: string; error_message: string | null; created_at: string; updated_at: string }>;
      const mapped = rows.map(mapPendingMessageRow);
      if (!statuses || statuses.length === 0) {
        return mapped;
      }
      const allowed = new Set(statuses);
      return mapped.filter((row) => allowed.has(row.status));
    },
    markPendingMessageStatus(id: number, update: { status: PendingMessageRecord["status"]; thread?: string | { runnerBackend: "exec" | "app_server"; runnerThreadId: string; runnerCwd?: string | undefined } | undefined; errorMessage?: string }): void {
      const existing = this.getPendingMessage(id);
      const runnerBackend = typeof update.thread === "string"
        ? "exec"
        : update.thread?.runnerBackend ?? existing?.runnerBackend ?? null;
      const runnerThreadId = typeof update.thread === "string"
        ? update.thread
        : update.thread?.runnerThreadId ?? existing?.runnerThreadId ?? existing?.threadId ?? null;
      const runnerCwd = typeof update.thread === "string"
        ? existing?.runnerCwd ?? null
        : update.thread?.runnerCwd ?? existing?.runnerCwd ?? null;
      updatePendingMessageStmt.run(
        update.status,
        runnerBackend,
        runnerThreadId,
        runnerCwd,
        runnerThreadId,
        update.errorMessage ?? null,
        new Date().toISOString(),
        id,
      );
    },
    recordDeliveryAttempt(entry) {
      insertDeliveryStmt.run(
        entry.conversationKey,
        entry.status,
        entry.errorMessage ?? null,
        entry.prompt ?? null,
        entry.finalMessage ?? null,
        entry.peerUserId ?? null,
        entry.contextToken ?? null,
        entry.threadId ?? null,
        new Date().toISOString(),
      );
    },
    listDeliveries(limit = 50): DeliveryRecord[] {
      const rows = listDeliveriesStmt.all(limit) as Array<{ id: number; conversation_key: string; status: string; error_message: string | null; prompt: string | null; final_message: string | null; peer_user_id: string | null; context_token: string | null; thread_id: string | null; created_at: string }>;
      return rows.map((row) => ({
        id: row.id,
        conversationKey: row.conversation_key,
        status: row.status,
        errorMessage: row.error_message ?? undefined,
        prompt: row.prompt ?? undefined,
        finalMessage: row.final_message ?? undefined,
        peerUserId: row.peer_user_id ?? undefined,
        contextToken: row.context_token ?? undefined,
        threadId: row.thread_id ?? undefined,
        createdAt: row.created_at,
      }));
    },
    saveRuntimeState(key: string, value: unknown): void {
      upsertRuntimeStateStmt.run(key, JSON.stringify(value), new Date().toISOString());
    },
    getRuntimeState(key: string): unknown {
      const row = getRuntimeStateStmt.get(key) as { json_value: string } | undefined;
      if (!row) {
        return undefined;
      }
      try {
        return JSON.parse(row.json_value) as unknown;
      } catch {
        return undefined;
      }
    },
    recordDiagnostic(entry): void {
      insertDiagnosticStmt.run(entry.code, entry.accountId ?? null, entry.detail ?? null, new Date().toISOString());
    },
    listDiagnostics(limit = 100): DiagnosticEvent[] {
      const rows = listDiagnosticsStmt.all(limit) as Array<{ id: number; code: string; account_id: string | null; detail: string | null; created_at: string }>;
      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        accountId: row.account_id ?? undefined,
        detail: row.detail ?? undefined,
        createdAt: row.created_at,
      }));
    },
  };
}

export { buildConversationKey };
