import { describe, expect, test, vi } from "vitest";

import { BridgeService } from "../../src/daemon/bridge-service.js";
import { BridgeRestartRequestedError } from "../../src/daemon/bridge-restart-requested-error.js";
import type { BridgeConfig } from "../../src/config/app-config.js";
import { CodexTurnFallbackRequestedError, CodexTurnInterruptedError } from "../../src/codex/codex-runner.js";
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
  test("rethrows bridge restart requests so the runtime supervisor can restart the daemon", async () => {
    const service = new BridgeService({
      ...makeConfig(),
      loopIdleDelayMs: 0,
    }, {
      listAccounts() {
        return [
          {
            accountId: "acct-1",
            token: "token-1",
            baseUrl: "https://ilinkai.weixin.qq.com",
            loginState: "active",
          },
        ];
      },
      listPendingMessages() {
        return [];
      },
      saveRuntimeState: vi.fn(),
      recordDiagnostic: vi.fn(),
      close: vi.fn(),
      getRuntimeState: vi.fn(),
    } as any);

    (service as any).pollAccount = vi.fn(async () => {
      throw new BridgeRestartRequestedError("restart requested from test");
    });

    await expect(service.runDaemonLoop()).rejects.toThrow(BridgeRestartRequestedError);
  });

  test("records diagnostics when manual send fails because the reply context expired", async () => {
    const recordDeliveryAttempt = vi.fn();
    const recordDiagnostic = vi.fn();
    const enqueueOutboundDelivery = vi.fn(() => 17);
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
      sendTextMessage: vi.fn(async () => {
        throw new Error(
          "sendmessage failed: ret=-2 (the current reply context is no longer valid; wait for a fresh inbound message to refresh context_token before sending again)",
        );
      }),
    }));

    await expect(service.sendTextMessage({
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      text: "manual probe",
    })).resolves.toEqual(expect.objectContaining({
      messageId: "queued:17",
      status: "queued",
      queuedReason: expect.stringContaining("fresh inbound WeChat message"),
    }));

    expect(recordDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "manual_queued",
      errorMessage: expect.stringMatching(/context is no longer valid/i),
      prompt: "manual probe",
    }));
    expect(enqueueOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      kind: "text",
      status: "waiting_for_fresh_context",
      payload: {
        text: "manual probe",
      },
    }));
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "manual_send_queued",
      accountId: "acct-1",
      detail: expect.stringContaining("context is no longer valid"),
    }));
  });

  test("degrades quota reads when Codex returns an unknown plan variant", async () => {
    const recordDiagnostic = vi.fn();
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(() => undefined),
      saveRuntimeState: vi.fn(),
      recordDiagnostic,
      listAccounts: vi.fn(() => []),
      listPendingMessages: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
    } as any);
    (service as any).appServerCodexRunner = {
      readRateLimits: vi.fn(async () => {
        throw new Error("unknown plan_type variant: prolite");
      }),
    };

    const result = await (service as any).readQuotaForChat("acct-1");

    expect(result).toContain("Unable to read the current Codex quota because Codex returned an unsupported quota response");
    expect(result).toContain("This does not affect WeChat message delivery");
    expect(result).toContain("prolite");
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "quota_read_failed",
      accountId: "acct-1",
    }));
  });

  test("best-effort parses live quota from an unsupported Codex quota response body", async () => {
    const recordDiagnostic = vi.fn();
    const saveRuntimeState = vi.fn();
    const quotaBody = {
      user_id: "user-test-123",
      account_id: "acct-test-456",
      email: "tester@example.com",
      plan_type: "prolite",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 66,
          limit_window_seconds: 18000,
          reset_at: 1777219594,
        },
        secondary_window: {
          used_percent: 68,
          limit_window_seconds: 604800,
          reset_at: 1777400839,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 18000,
              reset_at: 1777235582,
            },
            secondary_window: {
              used_percent: 0,
              limit_window_seconds: 604800,
              reset_at: 1777822382,
            },
          },
        },
      ],
      credits: {
        has_credits: false,
        unlimited: false,
        balance: "0",
      },
    };
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(() => ({ primary: { usedPercent: 32 } })),
      saveRuntimeState,
      recordDiagnostic,
      listAccounts: vi.fn(() => []),
      listPendingMessages: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
    } as any);
    (service as any).appServerCodexRunner = {
      readRateLimits: vi.fn(async () => {
        throw new Error(`failed to fetch codex rate limits: Decode error: unknown variant \`prolite\`; body=${JSON.stringify(quotaBody, null, 2)}`);
      }),
    };

    const result = await (service as any).readQuotaForChat("acct-1");

    expect(result).toContain("Bridge parsed the live quota response body directly");
    expect(result).toContain("email: tester@example.com");
    expect(result).toContain("user_id: user-test-123");
    expect(result).toContain("account_id: acct-test-456");
    expect(result).toContain("plan_type: prolite");
    expect(result).toContain("- email: tester@example.com");
    expect(result).toContain("- user_id: user-test-123");
    expect(result).toContain("- account_id: acct-test-456");
    expect(result).toContain("- plan_type: prolite");
    expect(result).toContain("- primary: 66% used / 300 min window / resets(Beijing): 2026-04-27 00:06:34");
    expect(result).toContain("- secondary: 68% used / 10080 min window / resets(Beijing): 2026-04-29 02:27:19");
    expect(result).toContain("- additional GPT-5.3-Codex-Spark: primary 0% / 300 min / resets(Beijing): 2026-04-27 04:33:02; secondary 0% / 10080 min / resets(Beijing): 2026-05-03 23:33:02");
    expect(result).toContain("GPT-5.3-Codex-Spark");
    expect(result).not.toContain("32% used");
    expect(saveRuntimeState).toHaveBeenCalledWith("codex_rate_limits", expect.objectContaining({
      account: expect.objectContaining({
        email: "tester@example.com",
        userId: "user-test-123",
        accountId: "acct-test-456",
        planType: "prolite",
      }),
      primary: expect.objectContaining({
        usedPercent: 66,
        windowDurationMins: 300,
        resetsAt: 1777219594,
      }),
    }));
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "quota_read_failed",
      accountId: "acct-1",
      detail: expect.stringContaining("prolite"),
    }));
  });

  test("replays queued outbound text deliveries when a fresh inbound command arrives", async () => {
    const markOutboundDeliveryStatus = vi.fn();
    const recordDeliveryAttempt = vi.fn();
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-1" }));
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
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        };
      },
      listOutboundDeliveries(statuses?: string[], conversationKey?: string) {
        if (!statuses?.includes("waiting_for_fresh_context") || conversationKey !== "acct-1:user-a@im.wechat") {
          return [];
        }
        return [{
          id: 31,
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          contextToken: "ctx-old",
          kind: "text" as const,
          payload: { text: "<FINAL>:\nqueued summary" },
          status: "waiting_for_fresh_context" as const,
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        }];
      },
      markOutboundDeliveryStatus,
      recordDeliveryAttempt,
      saveRuntimeState: vi.fn(),
      getRuntimeState() {
        return undefined;
      },
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
            context_token: "ctx-fresh",
            item_list: [
              {
                type: MessageItemType.TEXT,
                text_item: { text: "/help" },
              },
            ],
          },
        ],
      })),
      sendTextMessage,
    }));
    (service as any).maybeStartPendingMessage = vi.fn();
    (service as any).deliverPendingReviewSummaries = vi.fn(async () => undefined);
    (service as any).deliverPendingLifecycleNotification = vi.fn(async () => undefined);

    await service.pollAccount("acct-1");

    expect(sendTextMessage).toHaveBeenNthCalledWith(1, {
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-fresh",
      text: "<FINAL>:\nqueued summary",
    });
    expect(sendTextMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-fresh",
      text: expect.stringContaining("Available commands:"),
    }));
    expect(markOutboundDeliveryStatus).toHaveBeenCalledWith(31, {
      status: "sent",
      errorMessage: undefined,
    });
    expect(recordDeliveryAttempt).toHaveBeenCalledWith(expect.objectContaining({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "queued_delivery_sent",
      finalMessage: "<FINAL>:\nqueued summary",
    }));
  });

  test("switches an idle-timed-out app_server task to exec fallback only after an explicit command", async () => {
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(),
      saveRuntimeState: vi.fn(),
      recordDiagnostic: vi.fn(),
      listAccounts: vi.fn(() => []),
      listPendingMessages: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
    } as any);
    const interrupt = vi.fn(async () => undefined);
    const abortController = new AbortController();
    (service as any).activeTasks.set("acct-1:user-a@im.wechat", {
      pendingMessageId: 9,
      conversationKey: "acct-1:user-a@im.wechat",
      prompt: "check gpu usage",
      abortController,
      runnerBackend: "app_server",
      threadId: "thread-app-1",
      turnId: "turn-1",
      supportsAppend: true,
      fallbackEligible: true,
      control: {
        runnerBackend: "app_server",
        threadId: "thread-app-1",
        turnId: "turn-1",
        supportsAppend: true,
        interrupt,
        append: vi.fn(),
      },
    });

    const result = await (service as any).executeCommandAction({
      conversation: {
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
      },
      result: {
        action: { type: "fallback_continue" },
        responseText: "unused",
      },
      accountId: "acct-1",
    });

    expect(result).toContain("Switching the current task to exec fallback");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBeInstanceOf(CodexTurnFallbackRequestedError);
  });

  test("does not start multiple pending messages concurrently for the same conversation before active task state is set", async () => {
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(),
      saveRuntimeState: vi.fn(),
      recordDiagnostic: vi.fn(),
      listAccounts: vi.fn(() => []),
      listPendingMessages: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
    } as any);
    const started: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPendingDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    (service as any).processPendingMessage = vi.fn((pending: { id: number }) => {
      started.push(pending.id);
      if (pending.id === 96) {
        return firstPendingDone;
      }
      return Promise.resolve();
    });

    (service as any).maybeStartPendingMessage({
      id: 96,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "test 1",
      status: "pending",
      createdAt: "2026-04-21T07:19:24.086Z",
      updatedAt: "2026-04-21T07:19:24.086Z",
    });
    (service as any).maybeStartPendingMessage({
      id: 97,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "test 2",
      status: "pending",
      createdAt: "2026-04-21T07:21:15.074Z",
      updatedAt: "2026-04-21T07:21:15.074Z",
    });

    expect(started).toEqual([96]);

    let pendingRows = [{
      id: 97,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "test 2",
      status: "pending",
      createdAt: "2026-04-21T07:21:15.074Z",
      updatedAt: "2026-04-21T07:21:15.074Z",
    }];
    (service as any).stateStore.listPendingMessages = vi.fn((statuses?: string[]) => {
      if (!statuses?.includes("pending")) {
        return [];
      }
      const rows = pendingRows;
      pendingRows = [];
      return rows;
    });

    releaseFirst?.();
    await vi.waitFor(() => {
      expect(started).toEqual([96, 97]);
    });
  });

  test("marks a pending message failed when background processing rejects before handling status", async () => {
    const markPendingMessageStatus = vi.fn();
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(),
      saveRuntimeState: vi.fn(),
      recordDiagnostic: vi.fn(),
      markPendingMessageStatus,
      listAccounts: vi.fn(() => []),
      listPendingMessages: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
    } as any);

    (service as any).processPendingMessage = vi.fn(async () => {
      throw new Error("preflight failed");
    });

    (service as any).maybeStartPendingMessage({
      id: 109,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      prompt: "hello",
      status: "pending",
      createdAt: "2026-04-26T05:12:44.875Z",
      updatedAt: "2026-04-26T05:12:44.875Z",
    });

    await vi.waitFor(() => {
      expect(markPendingMessageStatus).toHaveBeenCalledWith(109, expect.objectContaining({
        status: "failed",
        errorMessage: "preflight failed",
      }));
    });
  });

  test("interrupts a previously-started stale pending message instead of restarting it after daemon restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T11:00:00.000Z"));
    try {
      const markPendingMessageStatus = vi.fn();
      const recordDiagnostic = vi.fn();
      const runtime = new Map<string, unknown>([
        ["pending_processing_started_at:109", "2026-04-26T10:17:47.991Z"],
      ]);
      const service = new BridgeService(makeConfig(), {
        getRuntimeState: vi.fn((key: string) => runtime.get(key)),
        saveRuntimeState: vi.fn((key: string, value: unknown) => {
          runtime.set(key, value);
        }),
        recordDiagnostic,
        markPendingMessageStatus,
        listAccounts: vi.fn(() => []),
        listPendingMessages: vi.fn(() => []),
        listConversations: vi.fn(() => []),
        listDiagnostics: vi.fn(() => []),
      } as any);
      (service as any).processPendingMessage = vi.fn(async () => undefined);

      (service as any).maybeStartPendingMessage({
        id: 109,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        prompt: "hello",
        status: "pending",
        createdAt: "2026-04-26T10:17:47.991Z",
        updatedAt: "2026-04-26T10:17:47.991Z",
      });

      expect((service as any).processPendingMessage).not.toHaveBeenCalled();
      expect(markPendingMessageStatus).toHaveBeenCalledWith(109, expect.objectContaining({
        status: "interrupted",
        errorMessage: expect.stringContaining("extended idle timeout"),
      }));
      expect(runtime.get("pending_processing_started_at:109")).toBeNull();
      expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        code: "pending_message_reaped",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts stale idle active task when queued work is blocked behind it", () => {
    const abortController = new AbortController();
    const recordDiagnostic = vi.fn();
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(),
      saveRuntimeState: vi.fn(),
      recordDiagnostic,
      listAccounts: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
      listPendingMessages: vi.fn((statuses?: string[]) => {
        if (!statuses?.includes("pending")) {
          return [];
        }
        return [{
          id: 2,
          conversationKey: "acct-1:user-a@im.wechat",
          accountId: "acct-1",
          peerUserId: "user-a@im.wechat",
          prompt: "next queued work",
          status: "pending" as const,
          createdAt: "2026-04-25T11:06:21.108Z",
          updatedAt: "2026-04-25T11:06:21.108Z",
        }];
      }),
    } as any);

    (service as any).activeTasks.set("acct-1:user-a@im.wechat", {
      pendingMessageId: 1,
      conversationKey: "acct-1:user-a@im.wechat",
      prompt: "stalled work",
      abortController,
      supportsAppend: true,
      runnerBackend: "app_server",
      startedAtMs: 1000,
      lastActivityAtMs: 1000,
      idleNotifiedAtMs: 1000,
    });

    (service as any).reapStaleActiveTasks(1_000 + 301_000);

    expect(abortController.signal.aborted).toBe(true);
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "active_task_reaped",
    }));
  });

  test("aborts an extended-idle active task even when no newer messages are queued", () => {
    const abortController = new AbortController();
    const recordDiagnostic = vi.fn();
    const service = new BridgeService(makeConfig(), {
      getRuntimeState: vi.fn(),
      saveRuntimeState: vi.fn(),
      recordDiagnostic,
      listAccounts: vi.fn(() => []),
      listConversations: vi.fn(() => []),
      listDiagnostics: vi.fn(() => []),
      listPendingMessages: vi.fn(() => []),
    } as any);

    (service as any).activeTasks.set("acct-1:user-a@im.wechat", {
      pendingMessageId: 109,
      conversationKey: "acct-1:user-a@im.wechat",
      prompt: "stalled work",
      abortController,
      supportsAppend: true,
      runnerBackend: "app_server",
      startedAtMs: 1000,
      lastActivityAtMs: 1000,
      idleNotifiedAtMs: 1000,
    });

    (service as any).reapStaleActiveTasks(1_000 + 1_801_000);

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBeInstanceOf(CodexTurnInterruptedError);
    expect(String((abortController.signal.reason as Error).message)).toContain("extended idle timeout");
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "active_task_reaped",
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
        "Treat the quoted message as primary context for the reply unless the new user message clearly changes topic.",
        "",
        "Quoted message (primary context):",
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
        "Treat the quoted messages as primary context for the reply unless the new user message clearly changes topic.",
        "",
        "Quoted messages (primary context):",
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
      saveRuntimeState: vi.fn(),
      getRuntimeState() {
        return undefined;
      },
      getContextToken() {
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

  test("notifies the chat when a pending message fails after execution starts", async () => {
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-failure-notice" }));
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
      saveRuntimeState: vi.fn(),
      getRuntimeState() {
        return undefined;
      },
      getContextToken() {
        return "ctx-a";
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
      getTypingTicket: vi.fn(async () => "typing-ticket-1"),
      setTyping: vi.fn(async () => ({ ok: true })),
      stopTyping: vi.fn(async () => ({ ok: true })),
      sendTextMessage,
    }));
    (service as any).createCodexRunnerForPending = vi.fn(() => ({
      runTurn: vi.fn(async () => {
        throw new Error("turn turn-1 did not include a final agent message.");
      }),
    }));

    await expect((service as any).processPendingMessage({
      id: 100,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-old",
      prompt: "hello",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(stateStore.markPendingMessageStatus).toHaveBeenCalledWith(100, expect.objectContaining({
      status: "failed",
      errorMessage: "turn turn-1 did not include a final agent message.",
    }));
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-a",
      text: expect.stringContaining("Codex 任务未能在发送回复前完成。"),
    }));
    expect(stateStore.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: "reply_failure_notified",
    }));
  });

  test("notifies the chat when an auto-reaped stale task is interrupted", async () => {
    const sendTextMessage = vi.fn(async () => ({ messageId: "msg-stale-notice" }));
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
      saveRuntimeState: vi.fn(),
      getRuntimeState() {
        return undefined;
      },
      getContextToken() {
        return "ctx-a";
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
      getTypingTicket: vi.fn(async () => "typing-ticket-1"),
      setTyping: vi.fn(async () => ({ ok: true })),
      stopTyping: vi.fn(async () => ({ ok: true })),
      sendTextMessage,
    }));
    (service as any).createCodexRunnerForPending = vi.fn(() => ({
      runTurn: vi.fn(async () => {
        throw new CodexTurnInterruptedError("Stale Codex task interrupted after extended idle timeout.");
      }),
    }));

    await expect((service as any).processPendingMessage({
      id: 109,
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-old",
      prompt: "hello",
      status: "pending",
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
    })).resolves.toBeUndefined();

    expect(stateStore.markPendingMessageStatus).toHaveBeenCalledWith(109, expect.objectContaining({
      status: "interrupted",
      errorMessage: "Stale Codex task interrupted after extended idle timeout.",
    }));
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-a",
      text: expect.stringContaining("Codex 任务未能在发送回复前完成。"),
    }));
  });
});

