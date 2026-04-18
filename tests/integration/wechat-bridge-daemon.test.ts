import { createWechatBridgeDaemon } from "../../src/daemon/wechat-bridge-daemon.js";

describe("wechat bridge daemon", () => {
  test("deduplicates inbound messages before invoking the reply orchestrator", async () => {
    const handled: string[] = [];
    const diagnostics: string[] = [];
    const daemon = createWechatBridgeDaemon({
      stateStore: {
        recordInboundMessage({ messageKey }: { messageKey: string }) {
          if (messageKey === "dup-1") return handled.length === 0;
          return true;
        },
        saveContextToken() {},
        resolveConversation() {
          return { conversationKey: "acct-1:user-a@im.wechat", codexThreadId: undefined };
        },
        updateConversationThread() {},
      },
      replyOrchestrator: {
        async handleInboundMessage(input: { prompt: string }) {
          handled.push(input.prompt);
          return { threadId: "thread-1", finalMessage: "done", outboundMessageId: "msg-1" };
        },
      },
      diagnostics: {
        record(event: { code: string }) {
          diagnostics.push(event.code);
        },
      },
    });

    await daemon.handlePollResult({
      accountId: "acct-1",
      response: {
        ret: 0,
        msgs: [
          { message_id: 1, from_user_id: "user-a@im.wechat", item_list: [{ type: 1, text_item: { text: "hello" } }], context_token: "ctx-1" },
          { message_id: 1, from_user_id: "user-a@im.wechat", item_list: [{ type: 1, text_item: { text: "hello" } }], context_token: "ctx-1" },
        ],
      },
    });

    expect(handled).toEqual(["hello"]);
    expect(diagnostics).toEqual([]);
  });

  test("records session-expired diagnostics and skips message handling", async () => {
    const handled: string[] = [];
    const diagnostics: string[] = [];
    const daemon = createWechatBridgeDaemon({
      stateStore: {
        recordInboundMessage() { return true; },
        saveContextToken() {},
        resolveConversation() { return { conversationKey: "acct-1:user-a@im.wechat", codexThreadId: undefined }; },
        updateConversationThread() {},
      },
      replyOrchestrator: {
        async handleInboundMessage(input: { prompt: string }) {
          handled.push(input.prompt);
          return { threadId: "thread-1", finalMessage: "done", outboundMessageId: "msg-1" };
        },
      },
      diagnostics: {
        record(event: { code: string }) {
          diagnostics.push(event.code);
        },
      },
    });

    const result = await daemon.handlePollResult({
      accountId: "acct-1",
      response: {
        ret: -14,
        errcode: -14,
        errmsg: "session expired",
        msgs: [],
      },
    });

    expect(result).toEqual({ status: "session_paused" });
    expect(handled).toEqual([]);
    expect(diagnostics).toEqual(["session_expired"]);
  });

  test("does not reuse a legacy codex thread id as an exec runner thread when the conversation has no backend marker", async () => {
    const handled: Array<{ prompt: string; threadId?: string | undefined }> = [];
    const daemon = createWechatBridgeDaemon({
      stateStore: {
        recordInboundMessage() { return true; },
        saveContextToken() {},
        resolveConversation() {
          return {
            conversationKey: "acct-1:user-a@im.wechat",
            codexThreadId: "legacy-thread-1",
            runnerBackend: undefined,
            runnerThreadId: undefined,
          };
        },
        updateConversationThread() {},
      },
      replyOrchestrator: {
        async handleInboundMessage(input: { prompt: string; threadId?: string | undefined }) {
          handled.push({ prompt: input.prompt, threadId: input.threadId });
          return { threadId: "thread-app-1", finalMessage: "done", outboundMessageId: "msg-1" };
        },
      },
      diagnostics: {
        record() {},
      },
    });

    await daemon.handlePollResult({
      accountId: "acct-1",
      response: {
        ret: 0,
        msgs: [
          { message_id: 2, from_user_id: "user-a@im.wechat", item_list: [{ type: 1, text_item: { text: "hello again" } }], context_token: "ctx-2" },
        ],
      },
    });

    expect(handled).toEqual([{ prompt: "hello again", threadId: undefined }]);
  });
});
