import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleWechatControlCommand, parseWechatControlCommand } from "../../src/commands/wechat-control-commands.js";
import type { AccountRecord, ConversationRecord, DiagnosticEvent, PendingMessageRecord } from "../../src/state/sqlite-state-store.js";
import type { AppServerModelSummary, AppServerThreadSummary } from "../../src/codex/app-server-client.js";

class FakeStore {
  public cleared: string[] = [];
  public updated: Array<{ conversationKey: string; runnerBackend: string; runnerThreadId: string; runnerCwd?: string | undefined }> = [];
  public runtime = new Map<string, unknown>();
  public conversations: ConversationRecord[] = [];
  public accounts: AccountRecord[] = [];
  public pending: PendingMessageRecord[] = [];
  public diagnostics: DiagnosticEvent[] = [];

  clearConversationThread(conversationKey: string): void {
    this.cleared.push(conversationKey);
  }

  updateConversationThread(conversationKey: string, thread: { runnerBackend: "exec" | "app_server"; runnerThreadId: string; runnerCwd?: string | undefined }): void {
    this.updated.push({ conversationKey, runnerBackend: thread.runnerBackend, runnerThreadId: thread.runnerThreadId, runnerCwd: thread.runnerCwd });
  }

  getRuntimeState(key: string): unknown {
    return this.runtime.get(key);
  }

  saveRuntimeState(key: string, value: unknown): void {
    this.runtime.set(key, value);
  }

  listConversations(): ConversationRecord[] {
    return this.conversations;
  }

  listAccounts(): AccountRecord[] {
    return this.accounts;
  }

  listPendingMessages(statuses?: Array<PendingMessageRecord["status"]>): PendingMessageRecord[] {
    if (!statuses || statuses.length === 0) {
      return this.pending;
    }
    const allowed = new Set(statuses);
    return this.pending.filter((row) => allowed.has(row.status));
  }

  listDiagnostics(limit?: number): DiagnosticEvent[] {
    return this.diagnostics.slice(0, limit ?? this.diagnostics.length);
  }
}

function makeSession(overrides: Partial<AppServerThreadSummary>): AppServerThreadSummary {
  return {
    id: "thr-a",
    name: "WeChat user-a",
    preview: "hello",
    updatedAt: 1,
    sourceKind: "appServer",
    statusType: "notLoaded",
    cwd: "C:/repo/codex-wechat-plugin",
    ...overrides,
  };
}

function makeModel(overrides: Partial<AppServerModelSummary>): AppServerModelSummary {
  return {
    id: "gpt-5.4",
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    isDefault: true,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationRecord>): ConversationRecord {
  return {
    conversationKey: "acct-1:user-a",
    accountId: "acct-1",
    peerUserId: "user-a",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeAccount(overrides: Partial<AccountRecord>): AccountRecord {
  return {
    accountId: "acct-1",
    baseUrl: "https://example.test",
    loginState: "active",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingMessageRecord>): PendingMessageRecord {
  return {
    id: 1,
    conversationKey: "acct-1:user-a",
    accountId: "acct-1",
    peerUserId: "user-a",
    prompt: "hello",
    status: "pending",
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeDiagnostic(overrides: Partial<DiagnosticEvent>): DiagnosticEvent {
  return {
    id: 1,
    code: "reply_timing",
    createdAt: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("wechat control commands", () => {
  test("parses slash commands and trims arguments", () => {
    expect(parseWechatControlCommand("/help")).toEqual({ name: "help", args: [] });
    expect(parseWechatControlCommand("/use-session   thread-123  ")).toEqual({ name: "use-session", args: ["thread-123"] });
    expect(parseWechatControlCommand("hello")).toBeUndefined();
  });

  test("returns help text", () => {
    const store = new FakeStore();
    const result = handleWechatControlCommand({
      text: "/help",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain("Available commands:");
    expect(result.responseText).toContain("\n- /help");
    expect(result.responseText).toContain("\n- /pwd");
      expect(result.responseText).toContain("\n- /new-session [name]");
      expect(result.responseText).toContain("\n- /test-session");
      expect(result.responseText).toContain("\n- /test-session quit");
      expect(result.responseText).toContain("\n- /record-session");
      expect(result.responseText).toContain("\n- /use-record");
      expect(result.responseText).toContain("\n- /yes");
      expect(result.responseText).toContain("\n- /no");
      expect(result.responseText).toContain("\n- /quota");
    expect(result.responseText).toContain("\n- /skills");
    expect(result.responseText).toContain("\n- /stop");
    expect(result.responseText).toContain("\n- /append");
    expect(result.responseText).toContain("\n- /model");
    expect(result.responseText).toContain("\n- /effort");
    expect(result.responseText).toContain("\n- /final");
  });

  test("returns a stop action when there is an active task", () => {
    const store = new FakeStore();
    const result = handleWechatControlCommand({
      text: "/stop",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      activeTask: {
        prompt: "long running task",
      },
    });

    expect(result).toEqual({
      handled: true,
      responseText: "🛠️ Checking for an active task to stop for this chat.",
      action: { type: "stop" },
    });
  });

  test("returns an append action when there is an active task", () => {
    const store = new FakeStore();
    const result = handleWechatControlCommand({
      text: "/append focus on the error logs",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      activeTask: {
        prompt: "debug the outage",
        runnerBackend: "app_server",
        supportsAppend: true,
      },
    });

    expect(result).toEqual({
      handled: true,
      responseText: "🛠️ Trying to append your guidance to the current task.",
      action: {
        type: "append",
        guidance: "focus on the error logs",
      },
    });
  });

  test("reports and controls pending backlog review", () => {
    const store = new FakeStore();
    const summaryResult = handleWechatControlCommand({
      text: "/pending",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      pendingReview: {
        count: 2,
        items: ["first message", "second message"],
      },
    });
    const continueResult = handleWechatControlCommand({
      text: "/pending continue",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const clearResult = handleWechatControlCommand({
      text: "/pending clear",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(summaryResult.responseText).toContain("📡");
    expect(summaryResult.responseText).toContain("pending backlog: 2");
    expect(continueResult.action).toEqual({ type: "pending_continue" });
    expect(clearResult.action).toEqual({ type: "pending_clear" });
  });

  test("still issues stop and append actions when the active task snapshot is missing", () => {
    const store = new FakeStore();
    const stopResult = handleWechatControlCommand({
      text: "/stop",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const appendResult = handleWechatControlCommand({
      text: "/append more detail",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(stopResult.action).toEqual({ type: "stop" });
    expect(stopResult.responseText).toContain("Checking for an active task");
    expect(appendResult.action).toEqual({
      type: "append",
      guidance: "more detail",
    });
    expect(appendResult.responseText).toContain("Trying to append your guidance");
  });

  test("reports and updates the current model override", () => {
    const store = new FakeStore();
    const conversation = makeConversation({});
    const queryResult = handleWechatControlCommand({
      text: "/model",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      defaultModel: "gpt-5.4",
      availableModels: [
        makeModel({}),
        makeModel({ id: "gpt-5.4-mini", isDefault: false, supportedReasoningEfforts: ["minimal", "low", "medium"] }),
      ],
    });
    const setResult = handleWechatControlCommand({
      text: "/model gpt-5.4-mini",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      defaultModel: "gpt-5.4",
      availableModels: [
        makeModel({}),
        makeModel({ id: "gpt-5.4-mini", isDefault: false, supportedReasoningEfforts: ["minimal", "low", "medium"] }),
      ],
    });
    expect(store.runtime.get("codex_runtime_preferences")).toEqual({
      model: "gpt-5.4-mini",
    });
    const clearResult = handleWechatControlCommand({
      text: "/model default",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      defaultModel: "gpt-5.4",
      availableModels: [
        makeModel({}),
        makeModel({ id: "gpt-5.4-mini", isDefault: false, supportedReasoningEfforts: ["minimal", "low", "medium"] }),
      ],
    });

    expect(queryResult.responseText).toContain("current model: gpt-5.4");
    expect(queryResult.responseText).toContain("available models:");
    expect(queryResult.responseText).toContain("gpt-5.4-mini");
    expect(setResult.responseText).toContain("gpt-5.4-mini");
    expect(store.runtime.get("codex_runtime_preferences")).toEqual({});
    expect(clearResult.responseText).toContain("Cleared the model override");
  });

  test("reports and updates the current reasoning effort override", () => {
    const store = new FakeStore();
    const conversation = makeConversation({});
    const queryResult = handleWechatControlCommand({
      text: "/effort",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      defaultReasoningEffort: "medium",
      availableModels: [
        makeModel({}),
        makeModel({ id: "gpt-5.4-mini", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["minimal", "low", "medium"] }),
      ],
    });
    const setResult = handleWechatControlCommand({
      text: "/effort high",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      defaultReasoningEffort: "medium",
      availableModels: [
        makeModel({}),
        makeModel({ id: "gpt-5.4-mini", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["minimal", "low", "medium"] }),
      ],
    });
    const invalidResult = handleWechatControlCommand({
      text: "/effort turbo",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      defaultReasoningEffort: "medium",
      availableModels: [
        makeModel({}),
        makeModel({ id: "gpt-5.4-mini", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: ["minimal", "low", "medium"] }),
      ],
    });

    expect(queryResult.responseText).toContain("current reasoning effort: medium");
    expect(queryResult.responseText).toContain("available efforts for gpt-5.4: low, medium, high");
    expect(setResult.responseText).toContain("high");
    expect(store.runtime.get("codex_runtime_preferences")).toEqual({
      reasoningEffort: "high",
    });
    expect(invalidResult.responseText).toContain("Usage: /effort");
  });

  test("reports and updates the final summary visibility override", () => {
    const store = new FakeStore();
    const conversation = makeConversation({});
    const queryResult = handleWechatControlCommand({
      text: "/final",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const disableResult = handleWechatControlCommand({
      text: "/final off",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const disabledQuery = handleWechatControlCommand({
      text: "/final",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    expect(queryResult.responseText).toContain("final summary: on");
    expect(disableResult.responseText).toContain("Disabled the final full summary");
    expect(store.runtime.get("codex_runtime_preferences")).toEqual({
      showFinalSummary: false,
    });
    expect(disabledQuery.responseText).toContain("final summary: off");
    const enableResult = handleWechatControlCommand({
      text: "/final on",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    expect(enableResult.responseText).toContain("Enabled the final full summary");
    expect(store.runtime.get("codex_runtime_preferences")).toEqual({
      showFinalSummary: true,
    });
    const clearResult = handleWechatControlCommand({
      text: "/final default",
      stateStore: store,
      conversation,
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    expect(clearResult.responseText).toContain("Cleared the final summary override");
    expect(store.runtime.get("codex_runtime_preferences")).toEqual({});
  });

  test("reports the current workspace and session mapping", () => {
    const store = new FakeStore();
    const pwdResult = handleWechatControlCommand({
      text: "/pwd",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
        runnerCwd: "D:/other-workspace",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      currentSession: makeSession({
        id: "thread-app-1",
        name: "VideoFM session",
        cwd: "D:/live-workspace",
      }),
    });
    const sessionResult = handleWechatControlCommand({
      text: "/session",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
        runnerCwd: "D:/other-workspace",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      currentSession: makeSession({
        id: "thread-app-1",
        name: "VideoFM session",
        cwd: "D:/live-workspace",
      }),
    });

    expect(pwdResult.responseText).toContain("workspace:");
    expect(pwdResult.responseText).toContain("D:/live-workspace");
    expect(sessionResult.responseText).toContain("⚙️");
    expect(sessionResult.responseText).toContain("app_server");
    expect(sessionResult.responseText).toContain("thread-app-1");
    expect(sessionResult.responseText).toContain("VideoFM session");
    expect(sessionResult.responseText).toContain("D:/live-workspace");
  });

  test("reports that session names are unavailable on the exec backend", () => {
    const store = new FakeStore();
    const sessionResult = handleWechatControlCommand({
      text: "/session",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "exec",
        runnerThreadId: "exec-thread-1",
        runnerCwd: "D:/GitHub/codex-wechat-plugin",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(sessionResult.responseText).toContain("backend: exec");
    expect(sessionResult.responseText).toContain("session name: unavailable on exec backend");
  });

  test("prefixes status and warning replies with category emoji", () => {
    const store = new FakeStore();
    store.accounts = [makeAccount({})];
    const statusResult = handleWechatControlCommand({
      text: "/status",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const unknownResult = handleWechatControlCommand({
      text: "/wat",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(statusResult.responseText?.startsWith("📡 ")).toBe(true);
    expect(unknownResult.responseText?.startsWith("⚠️ ")).toBe(true);
  });

  test("clears the current session mapping and can remember the next session name", () => {
    const store = new FakeStore();
    const clearResult = handleWechatControlCommand({
      text: "/new-session VideoFM test",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(clearResult.responseText).toContain("new Codex session");
    expect(clearResult.responseText).toContain("VideoFM test");
    expect(store.cleared).toEqual(["acct-1:user-a"]);
    expect(store.runtime.get("next_new_session_name:acct-1:user-a")).toBe("VideoFM test");
  });

  test("supports the legacy /newsession alias", () => {
    const store = new FakeStore();
    const clearResult = handleWechatControlCommand({
      text: "/newsession",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(clearResult.responseText).toContain("new Codex session");
    expect(store.cleared).toEqual(["acct-1:user-a"]);
    expect(store.runtime.get("next_new_session_name:acct-1:user-a")).toBeNull();
  });

  test("requests an override for the mapped session", () => {
    const store = new FakeStore();
    const setResult = handleWechatControlCommand({
      text: "/use-session thread-app-2",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(setResult.responseText).toContain("Switching this chat");
    expect(setResult.action).toEqual({ type: "use_session", threadId: "thread-app-2" });
    expect(store.updated).toEqual([]);
  });

  test("binds, uses, and unbinds the shared test session", () => {
    const store = new FakeStore();
    const bindResult = handleWechatControlCommand({
      text: "/test-session bind thread-test-1",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const useResult = handleWechatControlCommand({
      text: "/test-session",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const unbindResult = handleWechatControlCommand({
      text: "/test-session unbind",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const missingResult = handleWechatControlCommand({
      text: "/test-session",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(bindResult.responseText).toContain("Bound /test-session");
    expect(useResult.responseText).toContain("Switching this chat to the configured test session");
    expect(useResult.action).toEqual({ type: "use_session", threadId: "thread-test-1", afterSwitch: "remember_non_test" });
    expect(unbindResult.responseText).toContain("Cleared the configured /test-session binding");
    expect(store.runtime.get("test_session_binding")).toBeNull();
    expect(missingResult.responseText).toContain("Use /test-session bind <session-id>");
  });

  test("quits the shared test session back to the latest non-test session", () => {
    const store = new FakeStore();
    store.runtime.set("test_session_binding", { threadId: "thread-test-1" });
    store.runtime.set("test_session_return:acct-1:user-a", "thread-app-2");

    const quitResult = handleWechatControlCommand({
      text: "/test-session quit",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-test-1",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(quitResult.responseText).toContain("Leaving the shared test session");
    expect(quitResult.action).toEqual({
      type: "use_session",
      threadId: "thread-app-2",
      afterSwitch: "clear_test_return",
    });
  });

  test("warns when /test-session quit is used outside the shared test session", () => {
    const store = new FakeStore();
    store.runtime.set("test_session_binding", { threadId: "thread-test-1" });
    store.runtime.set("test_session_return:acct-1:user-a", "thread-app-2");

    const result = handleWechatControlCommand({
      text: "/test-session quit",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-2",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(result.responseText).toContain("not currently on the shared test session");
    expect(result.action).toBeUndefined();
  });

  test("adds, lists, uses, deletes, and clears saved session records with confirmation", () => {
    const store = new FakeStore();

    const addResult = handleWechatControlCommand({
      text: "/record-session add alpha thread-app-9",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const listResult = handleWechatControlCommand({
      text: "/record-session",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const useRecordResult = handleWechatControlCommand({
      text: "/use-record alpha",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const deleteResult = handleWechatControlCommand({
      text: "/record-session delete alpha",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const clearEmptyResult = handleWechatControlCommand({
      text: "/record-session clear",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    handleWechatControlCommand({
      text: "/record-session add beta thread-app-10",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const clearRequest = handleWechatControlCommand({
      text: "/record-session clear",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const noResult = handleWechatControlCommand({
      text: "/no",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const yesWithoutPending = handleWechatControlCommand({
      text: "/yes",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const clearRequestAgain = handleWechatControlCommand({
      text: "/record-session clear",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const yesResult = handleWechatControlCommand({
      text: "/YES",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const finalList = handleWechatControlCommand({
      text: "/record-session",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(addResult.responseText).toContain("Saved session record alpha -> thread-app-9");
    expect(listResult.responseText).toContain("alpha -> thread-app-9");
    expect(useRecordResult.action).toEqual({ type: "use_session", threadId: "thread-app-9" });
    expect(deleteResult.responseText).toContain("Deleted session record alpha");
    expect(clearEmptyResult.responseText).toContain("There are no saved session records to clear");
    expect(clearRequest.responseText).toContain("Reply with /yes to confirm or /no to cancel within 5 minutes");
    expect(noResult.responseText).toContain("Canceled the pending action");
    expect(yesWithoutPending.responseText).toContain("There is no pending action waiting for confirmation");
    expect(clearRequestAgain.responseText).toContain("Reply with /yes to confirm or /no to cancel within 5 minutes");
    expect(yesResult.responseText).toContain("Cleared all saved session records");
    expect(finalList.responseText).toContain("saved session records:\n- none");
  });

  test("rejects duplicate record names case-insensitively and handles missing records", () => {
    const store = new FakeStore();
    store.runtime.set("session_records", [{ name: "Alpha", threadId: "thread-app-1" }]);

    const addDuplicate = handleWechatControlCommand({
      text: "/record-session add alpha thread-app-2",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const useMissing = handleWechatControlCommand({
      text: "/use-record beta",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    const deleteMissing = handleWechatControlCommand({
      text: "/record-session delete beta",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(addDuplicate.responseText).toContain("already exists");
    expect(useMissing.responseText).toContain("No saved session record named beta exists");
    expect(deleteMissing.responseText).toContain("No saved session record named beta exists");
  });

  test("expires or cancels pending confirmations before /yes or /no", () => {
    const store = new FakeStore();
    const expiredAt = new Date(Date.now() - (6 * 60 * 1000)).toISOString();
    store.runtime.set("pending_confirmation:acct-1:user-a", { kind: "clear_session_records", createdAt: expiredAt });

    const expiredYes = handleWechatControlCommand({
      text: "/yes",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    expect(expiredYes.responseText).toContain("pending confirmation has expired");

    store.runtime.set("pending_confirmation:acct-1:user-a", { kind: "clear_session_records", createdAt: new Date().toISOString() });
    const otherCommand = handleWechatControlCommand({
      text: "/status",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    expect(otherCommand.responseText).toContain("workspace:");

    const lateYes = handleWechatControlCommand({
      text: "/yes",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });
    expect(lateYes.responseText).toContain("There is no pending action waiting for confirmation");
  });

  test("returns a live quota action", () => {
    const store = new FakeStore();
    store.runtime.set("codex_rate_limits", {
      limitId: "codex",
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1776334444 },
      secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1776686215 },
      credits: { hasCredits: false, unlimited: false, balance: null },
    });

    const result = handleWechatControlCommand({
      text: "/quota",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(result.responseText).toContain("Reading the current Codex quota snapshot.");
    expect(result.action).toEqual({ type: "quota_read" });
  });

  test("formats installed local and plugin skills", () => {
    const store = new FakeStore();
    const result = handleWechatControlCommand({
      text: "/skills",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      installedSkills: {
        local: ["code-builder", "superpowers"],
        plugin: ["gmail:gmail", "google-calendar:google-calendar"],
      },
    });

    expect(result.responseText).toContain("local skills");
    expect(result.responseText).toContain("code-builder");
    expect(result.responseText).toContain("plugin skills");
    expect(result.responseText).toContain("gmail:gmail");
  });

  test("formats current bridge status from state and diagnostics", () => {
    const store = new FakeStore();
    store.accounts = [
      makeAccount({ accountId: "acct-1", loginState: "active" }),
      makeAccount({ accountId: "acct-2", loginState: "expired" }),
    ];
    store.pending = [
      makePending({ id: 1, status: "pending" }),
      makePending({ id: 2, status: "failed" }),
    ];
    store.diagnostics = [
      makeDiagnostic({ id: 3, code: "reply_timing", detail: "{\"runnerBackend\":\"app_server\",\"totalMs\":24000}" }),
      makeDiagnostic({ id: 2, code: "reply_failed", detail: "boom" }),
    ];

    const result = handleWechatControlCommand({
      text: "/status",
      stateStore: store,
      conversation: makeConversation({
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
      }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      currentSession: makeSession({
        id: "thread-app-1",
        name: "VideoFM session",
        cwd: "D:/live-workspace",
      }),
    });

    expect(result.responseText).toContain("workspace: D:/live-workspace");
    expect(result.responseText).toContain("accounts: 2 total / 1 active");
    expect(result.responseText).toContain("pending messages: 1");
    expect(result.responseText).toContain("current backend: app_server");
    expect(result.responseText).toContain("last reply_timing");
  });

  test("lists files from the live session workspace when available", () => {
    const bridgeWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-bridge-root-"));
    const sessionWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-session-root-"));
    fs.writeFileSync(path.join(bridgeWorkspaceDir, "bridge.txt"), "bridge\n", "utf8");
    fs.writeFileSync(path.join(sessionWorkspaceDir, "session.txt"), "session\n", "utf8");

    try {
      const result = handleWechatControlCommand({
        text: "/ls",
        stateStore: new FakeStore(),
        conversation: makeConversation({
          runnerBackend: "app_server",
          runnerThreadId: "thread-app-1",
          runnerCwd: bridgeWorkspaceDir,
        }),
        workspaceDir: bridgeWorkspaceDir,
        primaryBackend: "app_server",
        currentSession: makeSession({
          id: "thread-app-1",
          name: "VideoFM session",
          cwd: sessionWorkspaceDir,
        }),
      });

      expect(result.responseText).toContain(`path: ${sessionWorkspaceDir}`);
      expect(result.responseText).toContain("session.txt");
      expect(result.responseText).not.toContain("bridge.txt");
    } finally {
      fs.rmSync(bridgeWorkspaceDir, { recursive: true, force: true });
      fs.rmSync(sessionWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("lists recent diagnostics with an optional limit", () => {
    const store = new FakeStore();
    store.diagnostics = [
      makeDiagnostic({ id: 3, code: "reply_timing", detail: "{\"totalMs\":24000}" }),
      makeDiagnostic({ id: 2, code: "reply_failed", detail: "boom" }),
      makeDiagnostic({ id: 1, code: "poll_error", detail: "network" }),
    ];

    const result = handleWechatControlCommand({
      text: "/diagnostics 2",
      stateStore: store,
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(result.responseText).toContain("recent diagnostics");
    expect(result.responseText).toContain("reply_timing");
    expect(result.responseText).toContain("reply_failed");
    expect(result.responseText).not.toContain("poll_error");
  });

  test("lists recent conversation mappings", () => {
    const store = new FakeStore();
    store.conversations = [
      makeConversation({ conversationKey: "acct-1:user-a", runnerBackend: "app_server", runnerThreadId: "thread-a" }),
      makeConversation({ conversationKey: "acct-1:user-b", runnerBackend: "exec", runnerThreadId: "thread-b" }),
    ];

    const result = handleWechatControlCommand({
      text: "/threads",
      stateStore: store,
      conversation: makeConversation({ conversationKey: "acct-1:user-a", runnerBackend: "app_server", runnerThreadId: "thread-a" }),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
    });

    expect(result.responseText).toContain("current conversation");
    expect(result.responseText).toContain("acct-1:user-a");
    expect(result.responseText).toContain("recent conversations");
    expect(result.responseText).toContain("acct-1:user-b");
  });

  test("lists the current workspace directory contents", () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ls-"));
    fs.mkdirSync(path.join(workspaceDir, "src"));
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "# test\n", "utf8");

    try {
      const result = handleWechatControlCommand({
        text: "/ls",
        stateStore: new FakeStore(),
        conversation: makeConversation({}),
        workspaceDir,
        primaryBackend: "app_server",
      });

      expect(result.responseText).toContain(`path: ${workspaceDir}`);
      expect(result.responseText).toContain("README.md");
      expect(result.responseText).toContain("src/");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("lists available app-server sessions for binding", () => {
    const longPreview = "first prompt " + "x".repeat(80) + " final tail";
    const result = handleWechatControlCommand({
      text: "/sessions 2",
      stateStore: new FakeStore(),
      conversation: makeConversation({}),
      workspaceDir: "C:/repo/codex-wechat-plugin",
      primaryBackend: "app_server",
      availableSessions: [
        makeSession({ id: "thr-a", name: "WeChat user-a", sourceKind: "appServer", preview: longPreview, cwd: "D:/Projects/very-long-project-name/subdir/worktree" }),
        makeSession({ id: "thr-b", name: "Desktop task", sourceKind: "cli" }),
      ],
    });

    expect(result.responseText).toContain("available sessions");
    expect(result.responseText).toContain("thr-a");
    expect(result.responseText).toContain("Desktop task");
    expect(result.responseText).toContain("... ...");
    expect(result.responseText).toContain("workspace:");
  });
});

