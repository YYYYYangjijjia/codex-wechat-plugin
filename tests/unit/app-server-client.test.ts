import { describe, expect, test } from "vitest";

import { AppServerClient } from "../../src/codex/app-server-client.js";
import { afterEach, vi } from "vitest";

type MessageHandler = (message: unknown) => void;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

class FakeTransport {
  public sent: unknown[] = [];
  public openCalls = 0;
  public closeCalls = 0;
  public connected = false;
  private handler?: MessageHandler;

  async open(): Promise<void> {
    this.openCalls += 1;
    this.connected = true;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  send(message: unknown): void {
    if (!this.connected) {
      throw new Error("Codex app-server transport is not connected.");
    }
    this.sent.push(message);
  }

  push(message: unknown): void {
    if (!this.handler) {
      throw new Error("handler not registered");
    }
    this.handler(message);
  }

  close(): void {
    this.closeCalls += 1;
    this.connected = false;
  }
}

describe("AppServerClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("initializes the app-server connection", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({
      transport,
      clientInfo: { name: "wechat-bridge-test", version: "0.1.0" },
    });

    const initPromise = client.initialize();
    await flushMicrotasks();
    expect(transport.sent).toEqual([
      {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "wechat-bridge-test", version: "0.1.0" },
        },
      },
    ]);

    transport.push({ id: 1, result: { userAgent: "Codex Test", platformFamily: "windows", platformOs: "windows" } });

    await expect(initPromise).resolves.toEqual({
      userAgent: "Codex Test",
      platformFamily: "windows",
      platformOs: "windows",
    });
  });

  test("sends thread/start with the provided cwd", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const startPromise = client.startThread({ cwd: "C:/repo/codex-wechat-plugin" });
    await flushMicrotasks();

    expect(transport.sent).toEqual([
      {
        id: 1,
        method: "thread/start",
        params: { cwd: "C:/repo/codex-wechat-plugin" },
      },
    ]);

    transport.push({
      id: 1,
      result: {
        thread: { id: "thread-1" },
      },
    });

    await expect(startPromise).resolves.toEqual({ id: "thread-1" });
  });

  test("sends thread/resume with the provided thread id", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const resumePromise = client.resumeThread({ threadId: "thread-1" });
    await flushMicrotasks();

    expect(transport.sent).toEqual([
      {
        id: 1,
        method: "thread/resume",
        params: { threadId: "thread-1" },
      },
    ]);

    transport.push({
      id: 1,
      result: {
        thread: { id: "thread-1", cwd: "D:/OtherProject" },
      },
    });

    await expect(resumePromise).resolves.toEqual({ id: "thread-1", cwd: "D:/OtherProject" });
  });

  test("collects the final agent message from turn notifications", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply with exactly ok",
    });
    await flushMicrotasks();

    expect(transport.sent).toEqual([
      {
        id: 1,
        method: "turn/start",
        params: {
          threadId: "thread-1",
          cwd: "C:/repo/codex-wechat-plugin",
          input: [{ type: "text", text: "Reply with exactly ok" }],
        },
      },
    ]);

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    transport.push({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "", phase: "final_answer" } } });
    transport.push({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "ok" } });
    transport.push({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "ok", phase: "final_answer" } } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });

    await expect(turnPromise).resolves.toEqual({
      turnId: "turn-1",
      finalMessage: "ok",
      threadId: "thread-1",
    });
  });

  test("fails a turn when the stream completes without a final answer", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply with exactly ok",
    });
    await flushMicrotasks();

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });

    await expect(turnPromise).rejects.toThrow("did not include a final agent message");
  });

  test("accepts a buffered final agent message even when turn/completed arrives before item/completed is flushed", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply with exactly ok",
    });
    await flushMicrotasks();

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    transport.push({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "", phase: "final_answer" } } });
    transport.push({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "ok" } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    transport.push({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "ok", phase: "final_answer" } } });

    await expect(turnPromise).resolves.toEqual({
      turnId: "turn-1",
      finalMessage: "ok",
      threadId: "thread-1",
    });
  });

  test("emits aggregate text updates while a turn is streaming", async () => {
    const transport = new FakeTransport();
    const updates: string[] = [];
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply with exactly ok",
      onUpdate: (text) => updates.push(text),
    });
    await flushMicrotasks();

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    transport.push({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" } });
    transport.push({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: " world." } });
    transport.push({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello world.", phase: "final_answer" } } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });

    await expect(turnPromise).resolves.toEqual({
      turnId: "turn-1",
      finalMessage: "hello world.",
      threadId: "thread-1",
    });
    expect(updates).toEqual(["hello", "hello world.", "hello world."]);
  });

  test("collects reasoning deltas separately from answer deltas", async () => {
    const transport = new FakeTransport();
    const answerUpdates: string[] = [];
    const reasoningUpdates: string[] = [];
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Explain the fix",
      onUpdate: (text) => answerUpdates.push(text),
      onReasoningUpdate: (text) => reasoningUpdates.push(text),
    });
    await flushMicrotasks();

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    transport.push({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", delta: "First thought. " } });
    transport.push({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", delta: "Second thought." } });
    transport.push({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Final answer." } });
    transport.push({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "Final answer.", phase: "final_answer" } } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });

    await expect(turnPromise).resolves.toEqual({
      turnId: "turn-1",
      finalMessage: "Final answer.",
      threadId: "thread-1",
    });
    expect(reasoningUpdates).toEqual(["First thought. ", "First thought. Second thought."]);
    expect(answerUpdates).toEqual(["Final answer.", "Final answer."]);
  });

  test("sends model and effort overrides and exposes the started turn id", async () => {
    const transport = new FakeTransport();
    let startedTurnId: string | undefined;
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply with exactly ok",
      model: "gpt-5.4-mini",
      effort: "high",
      onStarted: (turnId) => {
        startedTurnId = turnId;
      },
    });
    await flushMicrotasks();

    expect(transport.sent).toEqual([
      {
        id: 1,
        method: "turn/start",
        params: {
          threadId: "thread-1",
          cwd: "C:/repo/codex-wechat-plugin",
          input: [{ type: "text", text: "Reply with exactly ok" }],
          model: "gpt-5.4-mini",
          effort: "high",
        },
      },
    ]);

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    await flushMicrotasks();
    expect(startedTurnId).toBe("turn-1");
    transport.push({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "ok", phase: "final_answer" } } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });

    await expect(turnPromise).resolves.toEqual({
      turnId: "turn-1",
      finalMessage: "ok",
      threadId: "thread-1",
    });
  });

  test("can interrupt and steer an active turn", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });

    const interruptPromise = client.interruptTurn({ threadId: "thread-1", turnId: "turn-1" });
    await flushMicrotasks();
    expect(transport.sent[0]).toEqual({
      id: 1,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    transport.push({ id: 1, result: {} });
    await expect(interruptPromise).resolves.toBeUndefined();

    const steerPromise = client.steerTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      prompt: "Actually focus on failing tests first.",
    });
    await flushMicrotasks();
    expect(transport.sent[1]).toEqual({
      id: 2,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Actually focus on failing tests first." }],
      },
    });
    transport.push({ id: 2, result: { turnId: "turn-1" } });
    await expect(steerPromise).resolves.toEqual({ turnId: "turn-1" });
  });

  test("treats interrupted turns as an interrupt, not a missing-final-message failure", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });
    const turnPromise = client.startTurn({
      threadId: "thread-1",
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply with exactly ok",
    });
    await flushMicrotasks();

    transport.push({ id: 1, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    transport.push({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } } });

    await expect(turnPromise).rejects.toThrow("interrupted");
  });

  test("lists stored threads and sets thread names", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });

    const listPromise = client.listThreads({ limit: 2, sourceKinds: ["appServer", "cli"] });
    await flushMicrotasks();
    expect(transport.sent[0]).toEqual({
      id: 1,
      method: "thread/list",
      params: { cursor: null, limit: 2, sortKey: "updated_at", sourceKinds: ["appServer", "cli"] },
    });
    transport.push({
      id: 1,
      result: {
        data: [
          { id: "thr-a", name: "WeChat user-a", preview: "hi", updatedAt: 10, sourceKind: "appServer", status: { type: "notLoaded" } },
          { id: "thr-b", name: "Desktop task", preview: "fix", updatedAt: 9, sourceKind: "cli", status: { type: "notLoaded" }, cwd: "D:/OtherProject" },
        ],
        nextCursor: null,
      },
    });
    await expect(listPromise).resolves.toEqual([
      { id: "thr-a", name: "WeChat user-a", preview: "hi", updatedAt: 10, sourceKind: "appServer", statusType: "notLoaded" },
      { id: "thr-b", name: "Desktop task", preview: "fix", updatedAt: 9, sourceKind: "cli", statusType: "notLoaded", cwd: "D:/OtherProject" },
    ]);

    const setNamePromise = client.setThreadName({ threadId: "thr-a", name: "WeChat user-a" });
    await flushMicrotasks();
    expect(transport.sent[1]).toEqual({
      id: 2,
      method: "thread/name/set",
      params: { threadId: "thr-a", name: "WeChat user-a" },
    });
    transport.push({ id: 2, result: {} });
    await expect(setNamePromise).resolves.toBeUndefined();
  });

  test("lists available models with default and effort metadata", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });

    const listPromise = client.listModels();
    await flushMicrotasks();
    expect(transport.sent[0]).toEqual({
      id: 1,
      method: "model/list",
      params: { includeHidden: false },
    });

    transport.push({
      id: 1,
      result: {
        data: [
          { id: "gpt-5.4", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
          { id: "gpt-5.4-mini", isDefault: false, supportedReasoningEfforts: ["minimal", "low", "medium"], defaultReasoningEffort: "low" },
        ],
      },
    });

    await expect(listPromise).resolves.toEqual([
      { id: "gpt-5.4", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
      { id: "gpt-5.4-mini", isDefault: false, supportedReasoningEfforts: ["minimal", "low", "medium"], defaultReasoningEffort: "low" },
    ]);
  });

  test("reads live account rate limits", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });

    const readPromise = client.readRateLimits();
    await flushMicrotasks();
    expect(transport.sent[0]).toEqual({
      id: 1,
      method: "account/rateLimits/read",
    });

    transport.push({
      id: 1,
      result: {
        rateLimits: {
          primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1776334444 },
          secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1776686215 },
        },
      },
    });

    await expect(readPromise).resolves.toEqual({
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1776334444 },
      secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1776686215 },
    });
  });

  test("times out app-server requests that never receive a response", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new AppServerClient({
      transport,
      clientInfo: { name: "test", version: "0.1.0" },
      requestTimeoutMs: 25,
    });

    const initPromise = client.initialize();
    await flushMicrotasks();
    expect(transport.sent[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    const rejection = expect(initPromise).rejects.toThrow("app-server request initialize timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    transport.push({ id: 1, result: { userAgent: "late", platformFamily: "windows", platformOs: "windows" } });
  });

  test("reopens the transport after client.close()", async () => {
    const transport = new FakeTransport();
    const client = new AppServerClient({ transport, clientInfo: { name: "test", version: "0.1.0" } });

    const firstInit = client.initialize();
    await flushMicrotasks();
    transport.push({ id: 1, result: { userAgent: "Codex Test", platformFamily: "windows", platformOs: "windows" } });
    await expect(firstInit).resolves.toEqual({
      userAgent: "Codex Test",
      platformFamily: "windows",
      platformOs: "windows",
    });

    client.close();

    const secondInit = client.initialize();
    await flushMicrotasks();
    expect(transport.openCalls).toBe(2);
    expect(transport.closeCalls).toBe(1);
    expect(transport.sent[1]).toEqual({
      id: 2,
      method: "initialize",
      params: {
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });
    transport.push({ id: 2, result: { userAgent: "Codex Test", platformFamily: "windows", platformOs: "windows" } });
    await expect(secondInit).resolves.toEqual({
      userAgent: "Codex Test",
      platformFamily: "windows",
      platformOs: "windows",
    });
  });
});

