type InboundMessage = {
  message_id?: number;
  from_user_id?: string;
  context_token?: string;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
  }>;
};

type PollResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: InboundMessage[];
};

type DaemonStateStore = {
  recordInboundMessage(entry: { accountId: string; peerUserId: string; messageKey: string }): boolean;
  saveContextToken(entry: { accountId: string; peerUserId: string; contextToken: string }): void;
  resolveConversation(input: { accountId: string; peerUserId: string }): {
    conversationKey: string;
    runnerBackend?: "exec" | "app_server" | undefined;
    runnerThreadId?: string | undefined;
    codexThreadId?: string | undefined;
  };
  updateConversationThread(conversationKey: string, codexThreadId: string): void;
};

type DiagnosticsRecorder = {
  record(event: { code: string; accountId: string; detail?: string | undefined }): void;
};

type ReplyOrchestrator = {
  handleInboundMessage(input: {
    conversationKey: string;
    threadId?: string | undefined;
    accountId: string;
    peerUserId: string;
    contextToken: string;
    prompt: string;
  }): Promise<{ threadId: string }>;
};

const SESSION_EXPIRED_ERROR = -14;

function extractTextPrompt(message: InboundMessage): string {
  for (const item of message.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text;
    }
  }
  return "";
}

function buildMessageKey(message: InboundMessage): string {
  return `dup-${String(message.message_id ?? "unknown")}`;
}

export function createWechatBridgeDaemon(input: {
  stateStore: DaemonStateStore;
  replyOrchestrator: ReplyOrchestrator;
  diagnostics: DiagnosticsRecorder;
}) {
  return {
    async handlePollResult(params: { accountId: string; response: PollResponse }): Promise<{ status: "ok" | "session_paused" }> {
      const { accountId, response } = params;

      if (response.errcode === SESSION_EXPIRED_ERROR || response.ret === SESSION_EXPIRED_ERROR) {
        input.diagnostics.record({
          code: "session_expired",
          accountId,
          detail: response.errmsg,
        });
        return { status: "session_paused" };
      }

      for (const message of response.msgs ?? []) {
        const peerUserId = message.from_user_id;
        if (!peerUserId) {
          continue;
        }

        const wasNew = input.stateStore.recordInboundMessage({
          accountId,
          peerUserId,
          messageKey: buildMessageKey(message),
        });
        if (!wasNew) {
          continue;
        }

        if (message.context_token) {
          input.stateStore.saveContextToken({
            accountId,
            peerUserId,
            contextToken: message.context_token,
          });
        }

        const conversation = input.stateStore.resolveConversation({ accountId, peerUserId });
        const result = await input.replyOrchestrator.handleInboundMessage({
          conversationKey: conversation.conversationKey,
          threadId: conversation.runnerBackend ? (conversation.runnerThreadId ?? conversation.codexThreadId) : undefined,
          accountId,
          peerUserId,
          contextToken: message.context_token ?? "",
          prompt: extractTextPrompt(message),
        });
        input.stateStore.updateConversationThread(conversation.conversationKey, result.threadId);
      }

      return { status: "ok" };
    },
  };
}
