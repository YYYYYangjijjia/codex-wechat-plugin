import { z } from "zod";

import type { PendingMessageRecord } from "../state/sqlite-state-store.js";

type JsonContent = Record<string, unknown>;

export type BridgeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonContent;
  isError?: boolean | undefined;
};

export type BridgeToolDefinition = {
  description: string;
  inputSchema: z.ZodRawShape;
  execute(args: Record<string, unknown>): Promise<BridgeToolResult>;
};

export type BridgeToolRegistry = Record<string, BridgeToolDefinition>;

export type BridgeToolService = {
  login(accountId?: string): Promise<{ sessionKey: string; qrcodeUrl: string; message: string }>;
  getLoginStatus(sessionKey: string): Promise<Record<string, unknown>>;
  listConversations(): unknown[];
  peekPendingMessages(statuses?: PendingMessageRecord["status"][]): PendingMessageRecord[];
  sendTextMessage(input: { accountId: string; peerUserId: string; text: string; contextToken?: string | undefined }): Promise<{ messageId: string; status?: "queued" | "sent"; queuedReason?: string | undefined }>;
  sendFileMessage(input: {
    accountId: string;
    peerUserId: string;
    filePath: string;
    contextToken?: string | undefined;
    captionText?: string | undefined;
  }): Promise<{ messageId: string; kind: "image" | "file"; status?: "queued" | "sent"; queuedReason?: string | undefined }>;
  setTypingState(input: { accountId: string; peerUserId: string; state: "start" | "stop"; typingTicket?: string | undefined }): Promise<{ status: string }>;
  retryDelivery(pendingMessageId: number): Promise<{ pendingMessageId: number; status: string }>;
  getDiagnostics(limit?: number): unknown[];
  getAccountState(): unknown[];
  getRuntimeInfo?(): {
    workspaceDir: string;
    stateDir: string;
    databasePath: string;
    installedPluginRoot: string;
    readingInstalledRuntime: boolean;
  };
};

const pendingStatusSchema = z.enum(["pending", "sent", "failed"]);

function toToolResult(structuredContent: JsonContent, isError = false): BridgeToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export function createBridgeToolRegistry(service: BridgeToolService): BridgeToolRegistry {
  return {
    login: {
      description: "Start a WeChat QR login flow and return a session key plus QR code URL.",
      inputSchema: {
        account_id: z.string().trim().min(1).optional(),
      },
      async execute(args) {
        const parsed = z.object({ account_id: z.string().trim().min(1).optional() }).parse(args);
        const result = await service.login(parsed.account_id);
        return toToolResult({
          session_key: result.sessionKey,
          qrcode_url: result.qrcodeUrl,
          message: result.message,
        });
      },
    },
    get_login_status: {
      description: "Check whether a previously created QR login session has been confirmed.",
      inputSchema: {
        session_key: z.string().trim().min(1),
      },
      async execute(args) {
        const parsed = z.object({ session_key: z.string().trim().min(1) }).parse(args);
        const result = await service.getLoginStatus(parsed.session_key);
        return toToolResult(result);
      },
    },
    list_conversations: {
      description: "List known WeChat conversation mappings and their Codex thread ids.",
      inputSchema: {},
      async execute() {
        return toToolResult({ conversations: service.listConversations() });
      },
    },
    fetch_updates: {
      description: "Inspect pending inbound WeChat messages already captured by the daemon.",
      inputSchema: {
        status: z.array(pendingStatusSchema).optional(),
      },
      async execute(args) {
        const parsed = z.object({ status: z.array(pendingStatusSchema).optional() }).parse(args);
        return toToolResult({ updates: service.peekPendingMessages(parsed.status) });
      },
    },
    send_text_message: {
      description: "Send a final text reply into a specific WeChat private chat.",
      inputSchema: {
        account_id: z.string().trim().min(1),
        peer_user_id: z.string().trim().min(1),
        text: z.string().min(1),
        context_token: z.string().trim().min(1).optional(),
      },
      async execute(args) {
        const parsed = z.object({
          account_id: z.string().trim().min(1),
          peer_user_id: z.string().trim().min(1),
          text: z.string().min(1),
          context_token: z.string().trim().min(1).optional(),
        }).parse(args);
        const result = await service.sendTextMessage({
          accountId: parsed.account_id,
          peerUserId: parsed.peer_user_id,
          text: parsed.text,
          contextToken: parsed.context_token,
        });
        return toToolResult({
          message_id: result.messageId,
          status: result.status ?? "sent",
          ...(result.queuedReason ? { queued_reason: result.queuedReason } : {}),
        });
      },
    },
    send_image_message: {
      description: "Send a local image file into a specific WeChat private chat.",
      inputSchema: {
        account_id: z.string().trim().min(1),
        peer_user_id: z.string().trim().min(1),
        image_path: z.string().trim().min(1),
        context_token: z.string().trim().min(1).optional(),
        caption_text: z.string().min(1).optional(),
      },
      async execute(args) {
        const parsed = z.object({
          account_id: z.string().trim().min(1),
          peer_user_id: z.string().trim().min(1),
          image_path: z.string().trim().min(1),
          context_token: z.string().trim().min(1).optional(),
          caption_text: z.string().min(1).optional(),
        }).parse(args);
        const result = await service.sendFileMessage({
          accountId: parsed.account_id,
          peerUserId: parsed.peer_user_id,
          filePath: parsed.image_path,
          contextToken: parsed.context_token,
          captionText: parsed.caption_text,
        });
        return toToolResult({
          message_id: result.messageId,
          status: result.status ?? "sent",
          kind: result.kind,
          ...(result.queuedReason ? { queued_reason: result.queuedReason } : {}),
        });
      },
    },
    send_file_message: {
      description: "Send a local file attachment into a specific WeChat private chat.",
      inputSchema: {
        account_id: z.string().trim().min(1),
        peer_user_id: z.string().trim().min(1),
        file_path: z.string().trim().min(1),
        context_token: z.string().trim().min(1).optional(),
        caption_text: z.string().min(1).optional(),
      },
      async execute(args) {
        const parsed = z.object({
          account_id: z.string().trim().min(1),
          peer_user_id: z.string().trim().min(1),
          file_path: z.string().trim().min(1),
          context_token: z.string().trim().min(1).optional(),
          caption_text: z.string().min(1).optional(),
        }).parse(args);
        const result = await service.sendFileMessage({
          accountId: parsed.account_id,
          peerUserId: parsed.peer_user_id,
          filePath: parsed.file_path,
          contextToken: parsed.context_token,
          captionText: parsed.caption_text,
        });
        return toToolResult({
          message_id: result.messageId,
          status: result.status ?? "sent",
          kind: result.kind,
          ...(result.queuedReason ? { queued_reason: result.queuedReason } : {}),
        });
      },
    },
    set_typing_state: {
      description: "Manually start or stop WeChat typing status for a chat.",
      inputSchema: {
        account_id: z.string().trim().min(1),
        peer_user_id: z.string().trim().min(1),
        state: z.enum(["start", "stop"]),
        typing_ticket: z.string().trim().min(1).optional(),
      },
      async execute(args) {
        const parsed = z.object({
          account_id: z.string().trim().min(1),
          peer_user_id: z.string().trim().min(1),
          state: z.enum(["start", "stop"]),
          typing_ticket: z.string().trim().min(1).optional(),
        }).parse(args);
        const result = await service.setTypingState({
          accountId: parsed.account_id,
          peerUserId: parsed.peer_user_id,
          state: parsed.state,
          typingTicket: parsed.typing_ticket,
        });
        return toToolResult(result);
      },
    },
    retry_delivery: {
      description: "Retry a failed or pending delivery from the persistent outbound queue.",
      inputSchema: {
        pending_message_id: z.number().int().positive(),
      },
      async execute(args) {
        const parsed = z.object({ pending_message_id: z.number().int().positive() }).parse(args);
        const result = await service.retryDelivery(parsed.pending_message_id);
        return toToolResult({
          pending_message_id: result.pendingMessageId,
          status: result.status,
        });
      },
    },
    get_diagnostics: {
      description: "Read recent bridge diagnostics such as login errors, session expiry, and send failures.",
      inputSchema: {
        limit: z.number().int().positive().max(500).optional(),
      },
      async execute(args) {
        const parsed = z.object({ limit: z.number().int().positive().max(500).optional() }).parse(args);
        return toToolResult({ diagnostics: service.getDiagnostics(parsed.limit) });
      },
    },
    get_account_state: {
      description: "List persisted WeChat account records and login state.",
      inputSchema: {},
      async execute() {
        const accounts = redactAccountRecords(service.getAccountState());
        const runtime = service.getRuntimeInfo?.();
        return toToolResult({
          accounts,
          ...(runtime ? { runtime } : {}),
          ...(accounts.length === 0 && runtime
            ? {
                warnings: [
                  runtime.readingInstalledRuntime
                    ? "No account records were found in the installed WeChat Bridge runtime database."
                    : "No account records were found, and this MCP server is not reading the installed WeChat Bridge runtime database.",
                ],
              }
            : {}),
        });
      },
    },
  };
}

function redactAccountRecords(accounts: unknown[]): unknown[] {
  return accounts.map((account) => {
    if (!account || typeof account !== "object") {
      return account;
    }
    const record = account as Record<string, unknown>;
    if (!("token" in record)) {
      return record;
    }
    const { token, ...rest } = record;
    return {
      ...rest,
      tokenPresent: typeof token === "string" && token.length > 0,
    };
  });
}
