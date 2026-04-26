import { describe, expect, test } from "vitest";

import { collectBridgeStatus, formatBridgeStatus } from "../../src/status/bridge-status.js";
import type { BridgeConfig } from "../../src/config/app-config.js";

function makeConfig(): BridgeConfig {
  return {
    workspaceDir: "C:/repo/codex-wechat-plugin",
    stateDir: "C:/repo/codex-wechat-plugin/state",
    databasePath: "C:/repo/codex-wechat-plugin/state/bridge.sqlite",
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
    longPollTimeoutMs: 35000,
    loopIdleDelayMs: 1000,
  };
}

describe("bridge status", () => {
  test("collects a snapshot with daemon heartbeat and reply timing", async () => {
    const snapshot = await collectBridgeStatus({
      config: makeConfig(),
      appServerConnected: true,
      stateStore: {
        listAccounts() {
          return [
            { accountId: "acct-1", baseUrl: "https://ilinkai.weixin.qq.com", loginState: "active" as const, createdAt: "", updatedAt: "" },
            { accountId: "acct-2", baseUrl: "https://ilinkai.weixin.qq.com", loginState: "expired" as const, createdAt: "", updatedAt: "" },
          ];
        },
        listConversations() {
          return [{ conversationKey: "acct-1:user-a", accountId: "acct-1", peerUserId: "user-a", createdAt: "", updatedAt: "" }];
        },
        listPendingMessages(statuses) {
          if (statuses?.[0] === "pending") {
            return [{ id: 1, conversationKey: "acct-1:user-a", accountId: "acct-1", peerUserId: "user-a", prompt: "hello", status: "pending" as const, createdAt: "", updatedAt: "" }];
          }
          if (statuses?.[0] === "failed") {
            return [{ id: 2, conversationKey: "acct-1:user-a", accountId: "acct-1", peerUserId: "user-a", prompt: "oops", status: "failed" as const, createdAt: "", updatedAt: "" }];
          }
          return [];
        },
        listOutboundDeliveries(statuses) {
          if (statuses?.[0] === "waiting_for_fresh_context") {
            return [{ id: 3, conversationKey: "acct-1:user-a", accountId: "acct-1", peerUserId: "user-a", kind: "file" as const, payload: { filePath: "C:/tmp/report.pdf" }, status: "waiting_for_fresh_context" as const, createdAt: "", updatedAt: "" }];
          }
          if (statuses?.[0] === "failed") {
            return [{ id: 4, conversationKey: "acct-1:user-a", accountId: "acct-1", peerUserId: "user-a", kind: "text" as const, payload: { text: "done" }, status: "failed" as const, createdAt: "", updatedAt: "" }];
          }
          return [];
        },
        listDiagnostics() {
          return [
            {
              id: 10,
              code: "reply_timing",
              createdAt: "2026-04-16T00:00:00.000Z",
              detail: JSON.stringify({ runnerBackend: "app_server", totalMs: 1800 }),
            },
          ];
        },
        getRuntimeState(key: string) {
          if (key === "daemon_status") {
            return {
              pid: 99999999,
              heartbeatAt: new Date().toISOString(),
              startedAt: "2026-04-16T00:00:00.000Z",
              activeAccounts: 1,
            };
          }
          if (key === "codex_rate_limits") {
            return { primary: { usedPercent: 10 } };
          }
          return undefined;
        },
      },
    });

    expect(snapshot.accounts).toEqual({
      total: 2,
      active: 1,
      expired: 1,
      pending: 0,
    });
    expect(snapshot.pendingMessages).toEqual({
      pending: 1,
      failed: 1,
    });
    expect(snapshot.outboundDeliveries).toEqual({
      waitingForFreshContext: 1,
      failed: 1,
    });
    expect(snapshot.daemon).toEqual(expect.objectContaining({
      running: false,
      healthy: false,
      pid: 99999999,
      activeAccounts: 1,
    }));
    expect(snapshot.latestReplyTiming).toEqual({
      runnerBackend: "app_server",
      totalMs: 1800,
    });
    expect(formatBridgeStatus(snapshot)).toContain("daemon: stopped / stale (pid 99999999)");
    expect(formatBridgeStatus(snapshot)).toContain("app-server: connected");
    expect(formatBridgeStatus(snapshot)).toContain("pending messages: 1 active pending / 1 historical failed");
    expect(formatBridgeStatus(snapshot)).toContain("outbound deliveries: 1 waiting for fresh WeChat context / 1 failed");
  });

  test("prefers the live daemon lock over stale runtime daemon status", async () => {
    const snapshot = await collectBridgeStatus({
      config: makeConfig(),
      appServerConnected: true,
      readDaemonLock() {
        return {
          pid: process.pid,
          acquiredAt: "2026-04-25T07:08:40.271Z",
        };
      },
      stateStore: {
        listAccounts() {
          return [];
        },
        listConversations() {
          return [];
        },
        listPendingMessages() {
          return [];
        },
        listOutboundDeliveries() {
          return [];
        },
        listDiagnostics() {
          return [];
        },
        getRuntimeState(key: string) {
          if (key === "daemon_status") {
            return {
              pid: 58928,
              heartbeatAt: new Date().toISOString(),
              startedAt: "2026-04-21T09:08:08.884Z",
              activeAccounts: 1,
            };
          }
          return undefined;
        },
      },
    });

    expect(snapshot.daemon).toEqual(expect.objectContaining({
      running: true,
      healthy: true,
      pid: process.pid,
      startedAt: "2026-04-25T07:08:40.271Z",
      activeAccounts: 1,
    }));
  });
});

