import { describe, expect, it, vi } from "vitest";

import { createBridgeToolRegistry } from "../../src/mcp/bridge-tool-registry.js";

describe("createBridgeToolRegistry", () => {
  it("dispatches login and normalizes the response", async () => {
    const service = {
      login: vi.fn().mockResolvedValue({
        sessionKey: "session-1",
        qrcodeUrl: "https://example.com/qr.png",
        message: "scan",
      }),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn(),
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      setTypingState: vi.fn(),
      retryDelivery: vi.fn(),
      getDiagnostics: vi.fn(),
      getAccountState: vi.fn(),
    };

    const registry = createBridgeToolRegistry(service);
    const result = await registry.login!.execute({ account_id: "wx-1" });

    expect(service.login).toHaveBeenCalledWith("wx-1");
    expect(Boolean(result.isError)).toBe(false);
    expect(result.structuredContent).toEqual({
      session_key: "session-1",
      qrcode_url: "https://example.com/qr.png",
      message: "scan",
    });
  });

  it("returns pending messages from fetch_updates", async () => {
    const service = {
      login: vi.fn(),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn().mockReturnValue([
        { id: 11, conversationKey: "acct:user", prompt: "hello", status: "pending" },
      ]),
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      setTypingState: vi.fn(),
      retryDelivery: vi.fn(),
      getDiagnostics: vi.fn(),
      getAccountState: vi.fn(),
    };

    const registry = createBridgeToolRegistry(service);
    const result = await registry.fetch_updates!.execute({ status: ["pending"] });

    expect(service.peekPendingMessages).toHaveBeenCalledWith(["pending"]);
    expect(result.structuredContent).toEqual({
      updates: [{ id: 11, conversationKey: "acct:user", prompt: "hello", status: "pending" }],
    });
  });

  it("dispatches send_image_message to the bridge service", async () => {
    const service = {
      login: vi.fn(),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn(),
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(async () => ({ messageId: "media-1", kind: "image" as const })),
      setTypingState: vi.fn(),
      retryDelivery: vi.fn(),
      getDiagnostics: vi.fn(),
      getAccountState: vi.fn(),
    };

    const registry = createBridgeToolRegistry(service);
    const result = await registry.send_image_message!.execute({
      account_id: "wx-1",
      peer_user_id: "user-1",
      image_path: "D:\\tmp\\a.png",
    });

    expect(service.sendFileMessage).toHaveBeenCalledWith({
      accountId: "wx-1",
      peerUserId: "user-1",
      filePath: "D:\\tmp\\a.png",
      contextToken: undefined,
      captionText: undefined,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      message_id: "media-1",
      status: "sent",
      kind: "image",
    });
  });

  it("dispatches send_file_message to the bridge service", async () => {
    const service = {
      login: vi.fn(),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn(),
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(async () => ({ messageId: "media-2", kind: "file" as const })),
      setTypingState: vi.fn(),
      retryDelivery: vi.fn(),
      getDiagnostics: vi.fn(),
      getAccountState: vi.fn(),
    };

    const registry = createBridgeToolRegistry(service);
    const result = await registry.send_file_message!.execute({
      account_id: "wx-1",
      peer_user_id: "user-1",
      file_path: "D:\\tmp\\report.pdf",
      caption_text: "Here is the report",
    });

    expect(service.sendFileMessage).toHaveBeenCalledWith({
      accountId: "wx-1",
      peerUserId: "user-1",
      filePath: "D:\\tmp\\report.pdf",
      contextToken: undefined,
      captionText: "Here is the report",
    });
    expect(result.structuredContent).toEqual({
      message_id: "media-2",
      status: "sent",
      kind: "file",
    });
  });

  it("includes runtime diagnostics when account state is empty", async () => {
    const service = {
      login: vi.fn(),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn(),
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      setTypingState: vi.fn(),
      retryDelivery: vi.fn(),
      getDiagnostics: vi.fn(),
      getAccountState: vi.fn(() => []),
      getRuntimeInfo: vi.fn(() => ({
        workspaceDir: "C:\\Users\\Y\\.codex\\plugins\\cache\\local-personal-plugins\\codex-wechat-bridge\\0.1.6",
        stateDir: "C:\\Users\\Y\\.codex\\plugins\\cache\\local-personal-plugins\\codex-wechat-bridge\\0.1.6\\state",
        databasePath: "C:\\Users\\Y\\.codex\\plugins\\cache\\local-personal-plugins\\codex-wechat-bridge\\0.1.6\\state\\bridge.sqlite",
        installedPluginRoot: "C:\\Users\\Y\\.codex\\plugins\\codex-wechat-bridge",
        readingInstalledRuntime: false,
      })),
    };

    const registry = createBridgeToolRegistry(service);
    const result = await registry.get_account_state!.execute({});

    expect(result.structuredContent).toEqual({
      accounts: [],
      runtime: {
        workspaceDir: "C:\\Users\\Y\\.codex\\plugins\\cache\\local-personal-plugins\\codex-wechat-bridge\\0.1.6",
        stateDir: "C:\\Users\\Y\\.codex\\plugins\\cache\\local-personal-plugins\\codex-wechat-bridge\\0.1.6\\state",
        databasePath: "C:\\Users\\Y\\.codex\\plugins\\cache\\local-personal-plugins\\codex-wechat-bridge\\0.1.6\\state\\bridge.sqlite",
        installedPluginRoot: "C:\\Users\\Y\\.codex\\plugins\\codex-wechat-bridge",
        readingInstalledRuntime: false,
      },
      warnings: [
        "No account records were found, and this MCP server is not reading the installed WeChat Bridge runtime database.",
      ],
    });
  });

  it("redacts account tokens from get_account_state results", async () => {
    const service = {
      login: vi.fn(),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn(),
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      setTypingState: vi.fn(),
      retryDelivery: vi.fn(),
      getDiagnostics: vi.fn(),
      getAccountState: vi.fn(() => [{
        accountId: "acct-1",
        token: "secret-token",
        loginState: "active",
      }]),
    };

    const registry = createBridgeToolRegistry(service);
    const result = await registry.get_account_state!.execute({});

    expect(result.structuredContent).toEqual({
      accounts: [{
        accountId: "acct-1",
        loginState: "active",
        tokenPresent: true,
      }],
    });
  });
});
