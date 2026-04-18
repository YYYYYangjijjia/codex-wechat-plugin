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

  it("surfaces send_image_message as a documented phase-2 placeholder", async () => {
    const service = {
      login: vi.fn(),
      getLoginStatus: vi.fn(),
      listConversations: vi.fn(),
      peekPendingMessages: vi.fn(),
      sendTextMessage: vi.fn(),
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

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "not_implemented",
      phase: "phase_2",
    });
  });
});
