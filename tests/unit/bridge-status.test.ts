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
              pid: 1234,
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
    expect(snapshot.daemon).toEqual(expect.objectContaining({
      running: false,
      healthy: false,
      pid: 1234,
      activeAccounts: 1,
    }));
    expect(snapshot.latestReplyTiming).toEqual({
      runnerBackend: "app_server",
      totalMs: 1800,
    });
    expect(formatBridgeStatus(snapshot)).toContain("daemon: stopped / stale (pid 1234)");
    expect(formatBridgeStatus(snapshot)).toContain("app-server: connected");
  });
});

