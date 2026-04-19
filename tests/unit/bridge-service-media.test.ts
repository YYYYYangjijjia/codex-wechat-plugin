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

describe("BridgeService media delivery", () => {
  test("sends a local file through the account client and records manual delivery status", async () => {
    const recordDeliveryAttempt = vi.fn();
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
      recordDiagnostic: vi.fn(),
      getRuntimeState() {
        return undefined;
      },
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      getUploadUrl: vi.fn(async () => ({ uploadFullUrl: "https://cdn.example/upload" })),
      sendFileMessage: vi.fn(async () => ({ messageId: "media-1" })),
      sendImageMessage: vi.fn(async () => ({ messageId: "media-image-1" })),
    }));
    (service as any).sendLocalMediaFile = vi.fn(async () => ({ messageId: "media-1", kind: "file" }));

    const result = await service.sendFileMessage({
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      filePath: "D:\\tmp\\report.pdf",
    });

    expect(result).toEqual({ messageId: "media-1", kind: "file" });
    expect(recordDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "manual_media_sent",
      prompt: "D:\\tmp\\report.pdf",
    }));
  });

  test("queues a local file delivery when the reply context expired", async () => {
    const enqueueOutboundDelivery = vi.fn(() => 23);
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
      enqueueOutboundDelivery,
      recordDeliveryAttempt,
      recordDiagnostic,
      getRuntimeState() {
        return undefined;
      },
    } as any);

    (service as any).createAccountClient = vi.fn(() => ({
      getUploadUrl: vi.fn(async () => ({ uploadFullUrl: "https://cdn.example/upload" })),
      sendFileMessage: vi.fn(async () => ({ messageId: "media-1" })),
      sendImageMessage: vi.fn(async () => ({ messageId: "media-image-1" })),
    }));
    (service as any).sendLocalMediaFile = vi.fn(async () => {
      throw new Error(
        "sendmessage failed: ret=-2 (the current reply context is no longer valid; wait for a fresh inbound message to refresh context_token before sending again)",
      );
    });

    await expect(service.sendFileMessage({
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      filePath: "D:\\tmp\\report.pdf",
    })).resolves.toEqual({
      messageId: "queued:23",
      kind: "file",
      status: "queued",
    });

    expect(enqueueOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      kind: "file",
      status: "waiting_for_fresh_context",
      payload: {
        filePath: "D:\\tmp\\report.pdf",
      },
    }));
    expect(recordDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "manual_media_queued",
      errorMessage: expect.stringContaining("context is no longer valid"),
    }));
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "manual_media_send_queued",
    }));
  });

  test("stores delivery intent and injects deliver-file guidance for a newly enqueued pending message", async () => {
    const saveRuntimeState = vi.fn();
    const enqueuePendingMessage = vi.fn(() => 41);
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
        id: 41,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "ignored",
        status: "pending",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
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
      fetchUpdates: vi.fn(async () => ({
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
                text_item: { text: "请整理结果，然后把生成的 PDF 发给我" },
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

    expect(enqueuePendingMessage).toHaveBeenCalledTimes(1);
    expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("deliver-file"),
    }));
    expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("[[WECHAT_DELIVERED:<absolute-path>]]"),
    }));
    expect(saveRuntimeState).toHaveBeenCalledWith("pending_delivery_intent:41", {
      enabled: true,
      requestedKinds: ["pdf"],
      evidenceText: expect.arrayContaining(["PDF", "发给我"]),
    });
  });
});
