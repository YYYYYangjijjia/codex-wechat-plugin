import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStateStore } from "../../src/state/sqlite-state-store.js";

describe("SQLite state store", () => {
  test("persists poll state and context tokens across reopen", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-store-"));
    const databasePath = path.join(tempDir, "bridge.sqlite");

    const first = createStateStore({ databasePath });
    first.savePollState({ accountId: "acct-1", cursor: "cursor-1", nextTimeoutMs: 35000 });
    first.saveContextToken({ accountId: "acct-1", peerUserId: "user-a@im.wechat", contextToken: "token-1" });
    first.close();

    const reopened = createStateStore({ databasePath });
    expect(reopened.getPollState("acct-1")).toEqual({
      accountId: "acct-1",
      cursor: "cursor-1",
      nextTimeoutMs: 35000,
    });
    expect(reopened.getContextToken("acct-1", "user-a@im.wechat")).toBe("token-1");
    reopened.close();
  });

  test("isolates conversations by account and peer", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-store-"));
    const store = createStateStore({ databasePath: path.join(tempDir, "bridge.sqlite") });

    const first = store.resolveConversation({ accountId: "acct-1", peerUserId: "user-a@im.wechat" });
    const repeated = store.resolveConversation({ accountId: "acct-1", peerUserId: "user-a@im.wechat" });
    const differentPeer = store.resolveConversation({ accountId: "acct-1", peerUserId: "user-b@im.wechat" });
    const differentAccount = store.resolveConversation({ accountId: "acct-2", peerUserId: "user-a@im.wechat" });

    expect(repeated.conversationKey).toBe(first.conversationKey);
    expect(differentPeer.conversationKey).not.toBe(first.conversationKey);
    expect(differentAccount.conversationKey).not.toBe(first.conversationKey);

    store.close();
  });

  test("stores backend-aware conversation thread metadata while preserving legacy aliases", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-store-"));
    const store = createStateStore({ databasePath: path.join(tempDir, "bridge.sqlite") });

    const conversation = store.resolveConversation({ accountId: "acct-1", peerUserId: "user-a@im.wechat" });
    store.updateConversationThread(conversation.conversationKey, {
      runnerBackend: "app_server",
      runnerThreadId: "thread-app-1",
      runnerCwd: "D:/OtherProject",
    });

    expect(store.listConversations()).toEqual([
      expect.objectContaining({
        conversationKey: "acct-1:user-a@im.wechat",
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
        runnerCwd: "D:/OtherProject",
        codexThreadId: "thread-app-1",
      }),
    ]);

    store.close();
  });

  test("deduplicates inbound message keys durably", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-store-"));
    const databasePath = path.join(tempDir, "bridge.sqlite");

    const first = createStateStore({ databasePath });
    expect(first.recordInboundMessage({ accountId: "acct-1", messageKey: "msg-1", peerUserId: "user-a@im.wechat" })).toBe(true);
    expect(first.recordInboundMessage({ accountId: "acct-1", messageKey: "msg-1", peerUserId: "user-a@im.wechat" })).toBe(false);
    first.close();

    const reopened = createStateStore({ databasePath });
    expect(reopened.recordInboundMessage({ accountId: "acct-1", messageKey: "msg-1", peerUserId: "user-a@im.wechat" })).toBe(false);
    reopened.close();
  });

  test("stores backend-aware pending message thread metadata", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-store-"));
    const store = createStateStore({ databasePath: path.join(tempDir, "bridge.sqlite") });

    const id = store.enqueuePendingMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      thread: {
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
        runnerCwd: "D:/OtherProject",
      },
    });

    expect(store.getPendingMessage(id)).toEqual(
      expect.objectContaining({
        id,
        threadId: "thread-app-1",
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
        runnerCwd: "D:/OtherProject",
      }),
    );

    store.markPendingMessageStatus(id, {
      status: "failed",
      thread: {
        runnerBackend: "exec",
        runnerThreadId: "thread-exec-1",
        runnerCwd: "D:/ExecWorkspace",
      },
      errorMessage: "fallback failed",
    });

    expect(store.getPendingMessage(id)).toEqual(
      expect.objectContaining({
        id,
        status: "failed",
        threadId: "thread-exec-1",
        runnerBackend: "exec",
        runnerThreadId: "thread-exec-1",
        runnerCwd: "D:/ExecWorkspace",
        errorMessage: "fallback failed",
      }),
    );

    store.close();
  });

  test("persists queued outbound deliveries across reopen", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-store-"));
    const databasePath = path.join(tempDir, "bridge.sqlite");

    const first = createStateStore({ databasePath });
    const deliveryId = first.enqueueOutboundDelivery({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      kind: "text",
      payload: {
        text: "<FINAL>:\nqueued summary",
      },
      status: "waiting_for_fresh_context",
      errorMessage: "sendmessage failed: ret=-2",
    });
    first.close();

    const reopened = createStateStore({ databasePath });
    expect(reopened.listOutboundDeliveries(["waiting_for_fresh_context"])).toEqual([
      expect.objectContaining({
        id: deliveryId,
        conversationKey: "acct-1:user-a@im.wechat",
        accountId: "acct-1",
        peerUserId: "user-a@im.wechat",
        contextToken: "ctx-1",
        kind: "text",
        status: "waiting_for_fresh_context",
        errorMessage: "sendmessage failed: ret=-2",
        payload: {
          text: "<FINAL>:\nqueued summary",
        },
      }),
    ]);

    reopened.markOutboundDeliveryStatus(deliveryId, {
      status: "sent",
      errorMessage: undefined,
    });

    expect(reopened.listOutboundDeliveries(["sent"])).toEqual([
      expect.objectContaining({
        id: deliveryId,
        status: "sent",
      }),
    ]);

    reopened.close();
  });
});
