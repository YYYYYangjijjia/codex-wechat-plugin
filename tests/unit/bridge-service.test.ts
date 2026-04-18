import { describe, expect, test, vi } from "vitest";

import { BridgeService } from "../../src/daemon/bridge-service.js";
import type { BridgeConfig } from "../../src/config/app-config.js";
import { MessageItemType } from "../../src/weixin/weixin-api-client.js";

function makeConfig(): BridgeConfig {
  return {
    workspaceDir: "C:/repo/codex-wechat-plugin",
    stateDir: "C:/repo/codex-wechat-plugin/state",
    attachmentCacheDir: "C:/repo/codex-wechat-plugin/.cache/wechat-bridge/inbound-attachments",
    databasePath: "C:/repo/codex-wechat-plugin/state/test.sqlite",
    weixinBaseUrl: "https://ilinkai.weixin.qq.com",
    ilinkAppId: "bot",
    ilinkBotType: "3",
    packageVersion: "0.1.0",
    clientVersion: 1,
    codexCommand: "codex",
    codexReasoningEffort: "medium",
    codexBackend: "app_server",
    skipGitRepoCheck: true,
    appServerListenUrl: "ws://127.0.0.1:4500",
    appServerStartupTimeoutMs: 1000,
    appServerTurnTimeoutMs: 60_000,
    longPollTimeoutMs: 1000,
    loopIdleDelayMs: 100,
  };
}

describe("BridgeService", () => {
  test("records diagnostics when manual send fails because the reply context expired", async () => {
    const recordDeliveryAttempt = vi.fn();
    const recordDiagnostic = vi.fn();
    const service = new BridgeService(makeConfig(), {
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getContextToken() {
        return "ctx-1";
      },
      recordDeliveryAttempt,
      recordDiagnostic,
      getRuntimeState() {
        return undefined;
      },
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      sendTextMessage: vi.fn(async () => {
        throw new Error(
          "sendmessage failed: ret=-2 (the current reply context is no longer valid; wait for a fresh inbound message to refresh context_token before sending again)",
        );
      }),
    }));

    await expect(
      service.sendTextMessage({
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        text: "manual probe",
      }),
    ).rejects.toThrow(/context is no longer valid/i);

    expect(recordDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "manual_failed",
      errorMessage: expect.stringMatching(/context is no longer valid/i),
      prompt: "manual probe",
    }));
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "manual_send_failed",
      accountId: "acct-1",
      detail: expect.stringContaining("context is no longer valid"),
    }));
  });

  test("stores the latest raw inbound message shape for protocol debugging", async () => {
    const saveRuntimeState = vi.fn();
    const fetchUpdates = vi.fn(async () => ({
      ret: 0,
      get_updates_buf: "cursor-2",
      msgs: [
        {
          message_id: 1001,
          from_user_id: "user-a@im.wechat",
          context_token: "ctx-1",
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: "quoted reply test" },
            },
          ],
          quoted_message_id: 88,
          quote_preview: "older message",
        },
      ],
    }));

    const service = new BridgeService(makeConfig(), {
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return { accountId: "acct-1", cursor: "cursor-1" };
      },
      savePollState: vi.fn(),
      recordInboundMessage: vi.fn(() => true),
      saveContextToken: vi.fn(),
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
        };
      },
      enqueuePendingMessage: vi.fn(() => 1),
      getPendingMessage: vi.fn(() => ({
        id: 1,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "quoted reply test",
        status: "pending",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      })),
      getRuntimeState() {
        return undefined;
      },
      saveRuntimeState,
      listPendingMessages: vi.fn(() => []),
      listAccounts: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
      recordDiagnostic: vi.fn(),
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates,
      sendTextMessage: vi.fn(),
    }));
    (service as any).maybeStartPendingMessage = vi.fn();
    (service as any).deliverPendingReviewSummaries = vi.fn(async () => undefined);
    (service as any).deliverPendingLifecycleNotification = vi.fn(async () => undefined);

    await service.pollAccount("acct-1");

    expect(saveRuntimeState).toHaveBeenCalledWith(
      "last_raw_inbound_message",
      expect.objectContaining({
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        messageId: 1001,
        prompt: "quoted reply test",
        rawMessage: expect.objectContaining({
          quoted_message_id: 88,
          quote_preview: "older message",
        }),
      }),
    );
  });

  test("injects quoted message text into the Codex prompt while leaving command parsing on the new text only", async () => {
    const enqueuePendingMessage = vi.fn(() => 1);
    const service = new BridgeService(makeConfig(), {
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return { accountId: "acct-1", cursor: "cursor-1" };
      },
      savePollState: vi.fn(),
      recordInboundMessage: vi.fn(() => true),
      saveContextToken: vi.fn(),
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
        };
      },
      enqueuePendingMessage,
      getPendingMessage: vi.fn(() => ({
        id: 1,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "ignored",
        status: "pending",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      })),
      getRuntimeState() {
        return undefined;
      },
      saveRuntimeState: vi.fn(),
      listPendingMessages: vi.fn(() => []),
      listAccounts: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
      recordDiagnostic: vi.fn(),
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates: vi.fn(async () => ({
        ret: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_id: 1002,
            from_user_id: "user-a@im.wechat",
            context_token: "ctx-2",
            item_list: [
              {
                type: MessageItemType.TEXT,
                ref_msg: {
                  message_item: {
                    type: MessageItemType.TEXT,
                    text_item: { text: "refresh token test" },
                  },
                },
                text_item: { text: "quote test 001" },
              },
            ],
          },
        ],
      })),
      sendTextMessage: vi.fn(),
    }));
    (service as any).maybeStartPendingMessage = vi.fn();
    (service as any).deliverPendingReviewSummaries = vi.fn(async () => undefined);
    (service as any).deliverPendingLifecycleNotification = vi.fn(async () => undefined);

    await service.pollAccount("acct-1");

    expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [
        "User is replying to a quoted WeChat message.",
        "",
        "Quoted message:",
        "refresh token test",
        "",
        "New user message:",
        "quote test 001",
      ].join("\n"),
    }));
  });

  test("injects multiple quoted messages into the Codex prompt when several refs are present", async () => {
    const enqueuePendingMessage = vi.fn(() => 1);
    const service = new BridgeService(makeConfig(), {
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return { accountId: "acct-1", cursor: "cursor-1" };
      },
      savePollState: vi.fn(),
      recordInboundMessage: vi.fn(() => true),
      saveContextToken: vi.fn(),
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
        };
      },
      enqueuePendingMessage,
      getPendingMessage: vi.fn(() => ({
        id: 1,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "ignored",
        status: "pending",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      })),
      getRuntimeState() {
        return undefined;
      },
      saveRuntimeState: vi.fn(),
      listPendingMessages: vi.fn(() => []),
      listAccounts: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
      recordDiagnostic: vi.fn(),
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates: vi.fn(async () => ({
        ret: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_id: 1003,
            from_user_id: "user-a@im.wechat",
            context_token: "ctx-3",
            item_list: [
              {
                type: MessageItemType.TEXT,
                ref_msg: {
                  message_item: {
                    type: MessageItemType.TEXT,
                    text_item: { text: "first quoted message" },
                  },
                },
                text_item: { text: "quote batch 001" },
              },
              {
                type: MessageItemType.TEXT,
                ref_msg: {
                  message_item: {
                    type: MessageItemType.TEXT,
                    text_item: { text: "second quoted message" },
                  },
                },
                text_item: { text: "quote batch 001" },
              },
            ],
          },
        ],
      })),
      sendTextMessage: vi.fn(),
    }));
    (service as any).maybeStartPendingMessage = vi.fn();
    (service as any).deliverPendingReviewSummaries = vi.fn(async () => undefined);
    (service as any).deliverPendingLifecycleNotification = vi.fn(async () => undefined);

    await service.pollAccount("acct-1");

    expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [
        "User is replying to multiple quoted WeChat messages.",
        "",
        "Quoted messages:",
        "1. first quoted message",
        "2. second quoted message",
        "",
        "New user message:",
        "quote batch 001",
      ].join("\n"),
    }));
  });

  test("injects downloaded attachment metadata into the Codex prompt for inbound media messages", async () => {
    const enqueuePendingMessage = vi.fn(() => 1);
    const service = new BridgeService(makeConfig(), {
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return { accountId: "acct-1", cursor: "cursor-1" };
      },
      savePollState: vi.fn(),
      recordInboundMessage: vi.fn(() => true),
      saveContextToken: vi.fn(),
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
        };
      },
      enqueuePendingMessage,
      getPendingMessage: vi.fn(() => ({
        id: 1,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "ignored",
        status: "pending",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      })),
      getRuntimeState() {
        return undefined;
      },
      saveRuntimeState: vi.fn(),
      listPendingMessages: vi.fn(() => []),
      listAccounts: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
      recordDiagnostic: vi.fn(),
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates: vi.fn(async () => ({
        ret: 0,
        get_updates_buf: "cursor-2",
        msgs: [
          {
            message_id: 1004,
            from_user_id: "user-a@im.wechat",
            context_token: "ctx-4",
            item_list: [
              {
                type: MessageItemType.IMAGE,
                image_item: {
                  aeskey: "00112233445566778899aabbccddeeff",
                  media: {
                    full_url: "https://example.test/download?id=img-1",
                  },
                },
              },
              {
                type: MessageItemType.FILE,
                file_item: {
                  file_name: "notes.txt",
                  media: {
                    aes_key: "YWJjZGVmZ2hpamtsbW5vcA==",
                    full_url: "https://example.test/download?id=file-1",
                  },
                },
              },
            ],
          },
        ],
      })),
      sendTextMessage: vi.fn(),
    }));
    (service as any).downloadInboundAttachmentsIfPresent = vi.fn(async () => ([
      {
        kind: "image",
        localPath: "C:/repo/codex-wechat-plugin/.cache/wechat-bridge/inbound-attachments/acct-1/user-a/msg-1004.png",
      },
      {
        kind: "file",
        fileName: "notes.txt",
        localPath: "C:/repo/codex-wechat-plugin/.cache/wechat-bridge/inbound-attachments/acct-1/user-a/msg-1004-notes.txt",
      },
    ]));
    (service as any).maybeStartPendingMessage = vi.fn();
    (service as any).deliverPendingReviewSummaries = vi.fn(async () => undefined);
    (service as any).deliverPendingLifecycleNotification = vi.fn(async () => undefined);

    await service.pollAccount("acct-1");

    expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [
        "User sent attachments in WeChat.",
        "",
        "Attachments:",
        "1. [image] C:/repo/codex-wechat-plugin/.cache/wechat-bridge/inbound-attachments/acct-1/user-a/msg-1004.png",
        "2. [file] C:/repo/codex-wechat-plugin/.cache/wechat-bridge/inbound-attachments/acct-1/user-a/msg-1004-notes.txt (original name: notes.txt)",
      ].join("\n"),
    }));
  });

  test("forwards thread naming and progress callbacks through the pending-message runner wrapper", async () => {
    const onProgress = vi.fn(async () => undefined);
    const onReasoningProgress = vi.fn(async () => undefined);
    const appServerRunTurn = vi.fn(async (input: { cwd: string; threadId?: string; threadName?: string; onProgress?: (chunk: string) => Promise<void>; onReasoningProgress?: (chunk: string) => Promise<void>; prompt: string }) => {
      await input.onReasoningProgress?.("thinking chunk");
      await input.onProgress?.("partial chunk");
      return {
        runnerBackend: "app_server" as const,
        threadId: input.threadId ?? "thread-new",
        finalMessage: "final answer",
        cwd: input.cwd,
      };
    });
    const stateStore = {
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          runnerBackend: "app_server" as const,
          runnerThreadId: "thread-app-1",
          runnerCwd: "D:/OtherProject",
        };
      },
      getRuntimeState() {
        return undefined;
      },
      recordDiagnostic() {},
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).appServerCodexRunner = {
      runTurn: appServerRunTurn,
    };
    (service as any).execCodexRunner = {
      runTurn: vi.fn(),
    };

    const runner = (service as any).createCodexRunnerForPending({
      id: 1,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "hello",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    });

    const result = await runner.runTurn({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello",
      threadName: "WeChat user-a",
      onProgress,
      onReasoningProgress,
    });

    expect(appServerRunTurn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "D:/OtherProject",
      prompt: "hello",
      threadId: "thread-app-1",
      threadName: "WeChat user-a",
      onProgress: expect.any(Function),
      onReasoningProgress: expect.any(Function),
    }));
    expect(onReasoningProgress).toHaveBeenCalledWith("thinking chunk");
    expect(onProgress).toHaveBeenCalledWith("partial chunk");
    expect(result).toEqual({
      runnerBackend: "app_server",
      threadId: "thread-app-1",
      finalMessage: "final answer",
      cwd: "D:/OtherProject",
    });
  });

  test("reuses the most recent same-contact app-server thread when no explicit mapping exists", async () => {
    const appServerRunTurn = vi.fn(async (input: { threadId?: string; prompt: string }) => ({
      runnerBackend: "app_server" as const,
      threadId: input.threadId ?? "thread-new",
      finalMessage: "final answer",
    }));
    const stateStore = {
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
        };
      },
      getRuntimeState() {
        return undefined;
      },
      recordDiagnostic() {},
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).appServerCodexRunner = {
      runTurn: appServerRunTurn,
      listThreads: vi.fn(async () => [
        {
          id: "thread-other",
          name: "WeChat user-b@im.wechat",
        },
        {
          id: "thread-recent",
          name: "WeChat user-a@im.wechat",
        },
      ]),
    };
    (service as any).execCodexRunner = {
      runTurn: vi.fn(),
    };

    const runner = (service as any).createCodexRunnerForPending({
      id: 2,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "hello again",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    });

    const result = await runner.runTurn({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello again",
      threadName: "WeChat user-a@im.wechat",
    });

    expect(appServerRunTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-recent",
    }));
    expect(result.threadId).toBe("thread-recent");
  });

  test("does not infer a same-contact thread after a chat intentionally cleared its mapping", async () => {
    const appServerRunTurn = vi.fn(async (input: { threadId?: string; prompt: string }) => ({
      runnerBackend: "app_server" as const,
      threadId: input.threadId ?? "thread-new",
      finalMessage: "final answer",
    }));
    const stateStore = {
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        };
      },
      getRuntimeState() {
        return undefined;
      },
      recordDiagnostic() {},
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).appServerCodexRunner = {
      runTurn: appServerRunTurn,
      listThreads: vi.fn(async () => [
        {
          id: "thread-recent",
          name: "WeChat user-a@im.wechat",
        },
      ]),
    };
    (service as any).execCodexRunner = {
      runTurn: vi.fn(),
    };

    const runner = (service as any).createCodexRunnerForPending({
      id: 3,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "hello fresh",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    });

    const result = await runner.runTurn({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello fresh",
      threadName: "WeChat user-a@im.wechat",
    });

    expect(appServerRunTurn).toHaveBeenCalledWith(expect.not.objectContaining({
      threadId: "thread-recent",
    }));
    expect(result.threadId).toBe("thread-new");
  });

  test("uses the pending /new-session name and skips implicit same-contact reuse for the next turn", async () => {
    const appServerRunTurn = vi.fn(async (input: { threadId?: string; threadName?: string; prompt: string }) => ({
      runnerBackend: "app_server" as const,
      threadId: input.threadId ?? "thread-new",
      finalMessage: "final answer",
      cwd: "C:/repo/codex-wechat-plugin",
    }));
    const stateStore = {
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        };
      },
      getRuntimeState(key: string) {
        if (key === "next_new_session_name:acct-1:user-a@im.wechat") {
          return "VideoFM test";
        }
        return undefined;
      },
      recordDiagnostic() {},
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).appServerCodexRunner = {
      runTurn: appServerRunTurn,
      listThreads: vi.fn(async () => [
        {
          id: "thread-recent",
          name: "WeChat user-a@im.wechat",
        },
      ]),
    };
    (service as any).execCodexRunner = {
      runTurn: vi.fn(),
    };

    const runner = (service as any).createCodexRunnerForPending({
      id: 4,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "hello named session",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    });

    const result = await runner.runTurn({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello named session",
      threadName: "WeChat user-a@im.wechat",
    });

    expect(appServerRunTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: undefined,
      threadName: "VideoFM test",
    }));
    expect(result.threadId).toBe("thread-new");
  });

  test("sends lifecycle notifications to recent conversations with context tokens", async () => {
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-1" }));
    const service = new BridgeService(makeConfig(), {
      listConversations() {
        return [
          {
            conversationKey: "acct-1:user-a@im.wechat",
            accountId: "acct-1",
            peerUserId: "user-a@im.wechat",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-16T00:00:00.000Z",
          },
          {
            conversationKey: "acct-1:user-b@im.wechat",
            accountId: "acct-1",
            peerUserId: "user-b@im.wechat",
            createdAt: "2026-04-16T00:00:00.000Z",
            updatedAt: "2026-04-15T00:00:00.000Z",
          },
        ];
      },
      getContextToken(accountId: string, peerUserId: string) {
        return peerUserId === "user-a@im.wechat" ? "ctx-a" : undefined;
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      recordDiagnostic: vi.fn(),
      saveRuntimeState: vi.fn(),
      getRuntimeState: vi.fn(),
    } as any);
    (service as any).createAccountClient = vi.fn(() => ({
      sendTextMessage,
    }));

    await service.notifyLifecycle({
      phase: "online",
      detail: "daemon restarted",
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-a",
      text: expect.stringContaining("📡 Bridge online and ready."),
    }));
  });

  test("stores a pending online lifecycle notification when startup delivery fails", async () => {
    const saveRuntimeState = vi.fn();
    const service = new BridgeService(makeConfig(), {
      listConversations() {
        return [{
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }];
      },
      getContextToken() {
        return "ctx-a";
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      recordDiagnostic: vi.fn(),
      saveRuntimeState,
      getRuntimeState: vi.fn(),
    } as any);
    (service as any).createAccountClient = vi.fn(() => ({
      sendTextMessage: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    }));

    await service.notifyLifecycle({
      phase: "online",
      detail: "daemon restarted",
    });

    expect(saveRuntimeState).toHaveBeenCalledWith("pending_lifecycle_notification", expect.objectContaining({
      phase: "online",
      detail: "daemon restarted",
      createdAt: expect.any(String),
    }));
  });

  test("gates recovery backlog and sends a pending review summary instead of auto-processing", async () => {
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-1" }));
    const fetchUpdates = vi.fn(async () => ({
      get_updates_buf: "cursor-2",
      msgs: [
        {
          from_user_id: "user-a@im.wechat",
          context_token: "ctx-a",
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: "message while offline" },
            },
          ],
        },
      ],
    }));
    const runtime = new Map<string, unknown>();
    const stateStore = {
      listAccounts() {
        return [{
          accountId: "acct-1",
          token: "token-1",
          loginState: "active",
        }];
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return undefined;
      },
      savePollState: vi.fn(),
      recordInboundMessage() {
        return true;
      },
      saveContextToken: vi.fn(),
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        };
      },
      enqueuePendingMessage: vi.fn(() => 1),
      getPendingMessage: vi.fn(() => ({
        id: 1,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "message while offline",
        status: "pending",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z",
      })),
      saveRuntimeState: vi.fn((key: string, value: unknown) => {
        runtime.set(key, value);
      }),
      getRuntimeState: vi.fn((key: string) => {
        if (key === "daemon_status") {
          return { startedAt: "2026-04-15T23:59:59.000Z" };
        }
        return runtime.get(key);
      }),
      listConversations() {
        return [{
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }];
      },
      getContextToken() {
        return "ctx-a";
      },
      recordDiagnostic: vi.fn(),
      listPendingMessages() {
        return [];
      },
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates,
      sendTextMessage,
    }));
    (service as any).maybeStartPendingMessage = vi.fn();

    const result = await service.pollAccount("acct-1");

    expect(result).toEqual({ status: "ok", processed: 1 });
    expect((service as any).maybeStartPendingMessage).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      text: expect.stringContaining("pending messages: 1"),
    }));
    expect(runtime.get("pending_review:acct-1:user-a@im.wechat")).toEqual({
      count: 1,
      items: ["message while offline"],
      lastNotifiedCount: 1,
    });
  });

  test("auto-processes new messages when no recovery restart state is present", async () => {
    const fetchUpdates = vi.fn(async () => ({
      get_updates_buf: "cursor-2",
      msgs: [
        {
          from_user_id: "user-a@im.wechat",
          context_token: "ctx-a",
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: "message while online" },
            },
          ],
        },
      ],
    }));
    const runtime = new Map<string, unknown>();
    const stateStore = {
      listAccounts() {
        return [{
          accountId: "acct-1",
          token: "token-1",
          loginState: "active",
        }];
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return undefined;
      },
      savePollState: vi.fn(),
      recordInboundMessage() {
        return true;
      },
      saveContextToken: vi.fn(),
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        };
      },
      enqueuePendingMessage: vi.fn(() => 1),
      getPendingMessage: vi.fn(() => ({
        id: 1,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "message while online",
        status: "pending",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:00.000Z",
      })),
      saveRuntimeState: vi.fn((key: string, value: unknown) => {
        runtime.set(key, value);
      }),
      getRuntimeState: vi.fn((key: string) => runtime.get(key)),
      listConversations() {
        return [{
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }];
      },
      getContextToken() {
        return "ctx-a";
      },
      recordDiagnostic: vi.fn(),
      listPendingMessages() {
        return [];
      },
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates,
      sendTextMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    }));
    (service as any).maybeStartPendingMessage = vi.fn();

    const result = await service.pollAccount("acct-1");

    expect(result).toEqual({ status: "ok", processed: 1 });
    expect((service as any).maybeStartPendingMessage).toHaveBeenCalledTimes(1);
    expect(runtime.get("pending_review:acct-1:user-a@im.wechat")).toBeUndefined();
  });

  test("re-sends a pending review summary for legacy review state that was never marked notified", async () => {
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-1" }));
    const runtime = new Map<string, unknown>([
      ["pending_review:acct-1:user-a@im.wechat", { count: 2, items: ["hi", "hi"] }],
    ]);
    const stateStore = {
      listAccounts() {
        return [{
          accountId: "acct-1",
          token: "token-1",
          loginState: "active",
        }];
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return undefined;
      },
      savePollState: vi.fn(),
      recordInboundMessage() {
        return false;
      },
      saveContextToken: vi.fn(),
      resolveConversation: vi.fn(),
      enqueuePendingMessage: vi.fn(),
      getPendingMessage: vi.fn(),
      saveRuntimeState: vi.fn((key: string, value: unknown) => {
        runtime.set(key, value);
      }),
      getRuntimeState: vi.fn((key: string) => runtime.get(key)),
      listConversations() {
        return [{
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }];
      },
      getContextToken() {
        return "ctx-a";
      },
      recordDiagnostic: vi.fn(),
      listPendingMessages() {
        return [];
      },
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates: vi.fn(async () => ({
        get_updates_buf: "cursor-3",
        msgs: [],
      })),
      sendTextMessage,
    }));

    const result = await service.pollAccount("acct-1");

    expect(result).toEqual({ status: "ok", processed: 0 });
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      text: expect.stringContaining("pending messages: 2"),
    }));
    expect(runtime.get("pending_review:acct-1:user-a@im.wechat")).toEqual({
      count: 2,
      items: ["hi", "hi"],
      lastNotifiedCount: 2,
    });
  });

  test("delivers a deferred lifecycle notification after polling recovers", async () => {
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-1" }));
    const runtime = new Map<string, unknown>([
      ["pending_lifecycle_notification", {
        phase: "online",
        detail: "daemon restarted",
        createdAt: "2026-04-17T00:00:00.000Z",
      }],
    ]);
    const saveRuntimeState = vi.fn((key: string, value: unknown) => {
      runtime.set(key, value);
    });
    const stateStore = {
      listAccounts() {
        return [{
          accountId: "acct-1",
          token: "token-1",
          loginState: "active",
        }];
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      getPollState() {
        return undefined;
      },
      savePollState: vi.fn(),
      recordInboundMessage() {
        return false;
      },
      saveContextToken: vi.fn(),
      resolveConversation: vi.fn(),
      enqueuePendingMessage: vi.fn(),
      getPendingMessage: vi.fn(),
      saveRuntimeState,
      getRuntimeState: vi.fn((key: string) => runtime.get(key)),
      listConversations() {
        return [{
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }];
      },
      getContextToken() {
        return "ctx-a";
      },
      recordDiagnostic: vi.fn(),
      listPendingMessages() {
        return [];
      },
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).createAccountClient = vi.fn(() => ({
      fetchUpdates: vi.fn(async () => ({
        get_updates_buf: "cursor-3",
        msgs: [],
      })),
      sendTextMessage,
    }));

    const result = await service.pollAccount("acct-1");

    expect(result).toEqual({ status: "ok", processed: 0 });
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      text: expect.stringContaining("Bridge online and ready."),
    }));
    expect(runtime.get("pending_lifecycle_notification")).toBeNull();
    expect(stateStore.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "lifecycle_notification_delivered_late",
    }));
  });

  test("marks a pending message failed when typing ticket acquisition throws", async () => {
    const stateStore = {
      listAccounts() {
        return [];
      },
      getAccount() {
        return {
          accountId: "acct-1",
          token: "token-1",
          baseUrl: "https://ilinkai.weixin.qq.com",
          loginState: "active",
        };
      },
      markPendingMessageStatus: vi.fn(),
      recordDiagnostic: vi.fn(),
      recordDeliveryAttempt: vi.fn(),
      getRuntimeState() {
        return undefined;
      },
      resolveConversation() {
        return {
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
        };
      },
    };
    const service = new BridgeService(makeConfig(), stateStore as any);
    (service as any).createAccountClient = vi.fn(() => ({
      getTypingTicket: vi.fn(async () => {
        throw new Error("typing ticket unavailable");
      }),
    }));

    await expect((service as any).processPendingMessage({
      id: 99,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "hello",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(stateStore.markPendingMessageStatus).toHaveBeenCalledWith(99, expect.objectContaining({
      status: "failed",
      errorMessage: "typing ticket unavailable",
    }));
    expect(stateStore.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "reply_failed",
    }));
  });
});

