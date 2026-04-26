import { describe, expect, test } from "vitest";

import { AppServerCodexRunner } from "../../src/codex/app-server-codex-runner.js";
const TEST_CWD = "C:/repo/codex-wechat-plugin";
const TEST_ATTACHMENT_PATH = String.raw`C:\repo\codex-wechat-plugin\.cache\wechat-bridge\inbound-attachments\x\test.txt`;


class FakeProcessManager {
  public ensureRunningCalls = 0;

  async ensureRunning(): Promise<void> {
    this.ensureRunningCalls += 1;
  }
}

class FakeAppServerClient {
  public initializeCalls = 0;
  public startThreadCalls = 0;
  public resumeThreadCalls = 0;
  public startTurnCalls = 0;
  public closeCalls = 0;
  public interruptTurnCalls: Array<{ threadId: string; turnId: string }> = [];
  public steerTurnCalls: Array<{ threadId: string; turnId: string; prompt: string }> = [];
  public setThreadNameCalls: Array<{ threadId: string; name: string }> = [];
  public startTurnImplementation?: (input: { threadId: string; cwd: string; prompt: string; model?: string | undefined; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined; onUpdate?: ((text: string) => void) | undefined; onStarted?: ((turnId: string) => void) | undefined }) => Promise<{ threadId: string; turnId: string; finalMessage: string }>;

  async initialize(): Promise<{ userAgent: string; platformFamily: string; platformOs: string }> {
    this.initializeCalls += 1;
    return { userAgent: "Codex Test", platformFamily: "windows", platformOs: "windows" };
  }

  async startThread(input: { cwd: string }): Promise<{ id: string }> {
    this.startThreadCalls += 1;
    expect(input).toEqual({ cwd: TEST_CWD });
    return { id: "thread-new" };
  }

  async resumeThread(input: { threadId: string }): Promise<{ id: string }> {
    this.resumeThreadCalls += 1;
    expect(input).toEqual({ threadId: "thread-existing" });
    return { id: input.threadId };
  }

  async startTurn(input: { threadId: string; cwd: string; prompt: string; model?: string | undefined; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined; onUpdate?: ((text: string) => void) | undefined; onStarted?: ((turnId: string) => void) | undefined }): Promise<{ threadId: string; turnId: string; finalMessage: string }> {
    this.startTurnCalls += 1;
    if (this.startTurnImplementation) {
      return await this.startTurnImplementation(input);
    }
    input.onStarted?.("turn-1");
    input.onUpdate?.("first sentence. ");
    input.onUpdate?.("first sentence. second sentence.");
    return {
      threadId: input.threadId,
      turnId: "turn-1",
      finalMessage: "first sentence. second sentence.",
    };
  }

  async setThreadName(input: { threadId: string; name: string }): Promise<void> {
    this.setThreadNameCalls.push(input);
  }

  async listThreads(): Promise<Array<{ id: string }>> {
    return [];
  }

  async listModels(): Promise<Array<{ id: string; supportedReasoningEfforts: Array<"minimal" | "low" | "medium" | "high" | "xhigh">; defaultReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined; isDefault: boolean }>> {
    return [];
  }

  async readRateLimits(): Promise<Record<string, unknown>> {
    return {
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1776334444 },
    };
  }

  async interruptTurn(input: { threadId: string; turnId: string }): Promise<void> {
    this.interruptTurnCalls.push(input);
  }

  async steerTurn(input: { threadId: string; turnId: string; prompt: string }): Promise<{ turnId: string }> {
    this.steerTurnCalls.push(input);
    return { turnId: input.turnId };
  }

  close(): void {
    this.closeCalls += 1;
  }
}

describe("AppServerCodexRunner", () => {
  test("starts a new thread when the conversation has no app-server thread", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
    });

    expect(result).toEqual({
      runnerBackend: "app_server",
      threadId: "thread-new",
      finalMessage: "first sentence. second sentence.",
      cwd: TEST_CWD,
    });
    expect(processManager.ensureRunningCalls).toBe(1);
    expect(client.initializeCalls).toBe(1);
    expect(client.startThreadCalls).toBe(1);
    expect(client.resumeThreadCalls).toBe(0);
    expect(client.startTurnCalls).toBe(1);
  });

  test("resumes an existing app-server thread and initializes only once", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });

    await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "first",
    });

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "second",
      threadId: "thread-existing",
    });

    expect(result).toEqual({
      runnerBackend: "app_server",
      threadId: "thread-existing",
      finalMessage: "first sentence. second sentence.",
      cwd: TEST_CWD,
    });
    expect(processManager.ensureRunningCalls).toBe(2);
    expect(client.initializeCalls).toBe(1);
    expect(client.startThreadCalls).toBe(1);
    expect(client.resumeThreadCalls).toBe(1);
    expect(client.startTurnCalls).toBe(2);
  });

  test("reinitializes and retries resumeThread once when app-server reports Not initialized", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    let firstResume = true;
    client.resumeThread = async (input: { threadId: string }) => {
      client.resumeThreadCalls += 1;
      expect(input).toEqual({ threadId: "thread-existing" });
      if (firstResume) {
        firstResume = false;
        throw new Error("Not initialized");
      }
      return { id: input.threadId };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });

    const thread = await runner.resumeThread("thread-existing");

    expect(thread).toEqual({ id: "thread-existing" });
    expect(client.initializeCalls).toBe(2);
    expect(client.closeCalls).toBe(1);
    expect(client.resumeThreadCalls).toBe(2);
  });

  test("labels new threads and forwards progress chunks", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    const chunks: string[] = [];

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      threadName: "WeChat user-a",
      onProgress: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(result.finalMessage).toBe("first sentence. second sentence.");
    expect(client.setThreadNameCalls).toEqual([{ threadId: "thread-new", name: "WeChat user-a" }]);
    expect(chunks).toEqual(["first sentence. ", "second sentence."]);
  });

  test("reuses the most recent named thread when no explicit thread id is stored", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.listThreads = async () => [
      { id: "thread-existing", name: "WeChat user-a" },
      { id: "thread-other", name: "WeChat user-b" },
    ];
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      threadName: "WeChat user-a",
    });

    expect(result.threadId).toBe("thread-existing");
    expect(client.startThreadCalls).toBe(0);
    expect(client.resumeThreadCalls).toBe(1);
    expect(client.setThreadNameCalls).toEqual([]);
  });

  test("forwards model and effort overrides and exposes active-turn controls", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      expect(input.model).toBe("gpt-5.4-mini");
      expect(input.effort).toBe("high");
      input.onStarted?.("turn-1");
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: "first sentence. second sentence.",
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    let control: {
      runnerBackend: "app_server";
      threadId?: string | undefined;
      turnId?: string | undefined;
      supportsAppend: boolean;
      interrupt: () => Promise<void>;
      append?: ((guidance: string) => Promise<void>) | undefined;
    } | undefined;

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      onTurnStarted: (value) => {
        control = value as typeof control;
      },
    });

    expect(result.finalMessage).toBe("first sentence. second sentence.");
    expect(control?.threadId).toBe("thread-new");
    expect(control?.turnId).toBe("turn-1");
    expect(control?.supportsAppend).toBe(true);
    await control?.append?.("focus on failing tests");
    await control?.interrupt();
    expect(client.steerTurnCalls).toEqual([{ threadId: "thread-new", turnId: "turn-1", prompt: "focus on failing tests" }]);
    expect(client.interruptTurnCalls).toEqual([{ threadId: "thread-new", turnId: "turn-1" }]);
  });

  test("reinitializes and retries turn interrupts once when app-server reports the client is closed", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    let firstInterrupt = true;
    client.interruptTurn = async (input: { threadId: string; turnId: string }) => {
      if (firstInterrupt) {
        firstInterrupt = false;
        throw new Error("Codex app-server client closed.");
      }
      client.interruptTurnCalls.push(input);
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    let control: {
      runnerBackend: "app_server";
      threadId?: string | undefined;
      turnId?: string | undefined;
      supportsAppend: boolean;
      interrupt: () => Promise<void>;
    } | undefined;

    await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onTurnStarted: (value) => {
        control = value as typeof control;
      },
    });

    await control?.interrupt();

    expect(client.initializeCalls).toBe(2);
    expect(client.closeCalls).toBe(1);
    expect(client.interruptTurnCalls).toEqual([{ threadId: "thread-new", turnId: "turn-1" }]);
  });

  test("does not split progress chunks inside urls or file paths", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      input.onUpdate?.("Open https://example.com/docs/file.txt now. ");
      input.onUpdate?.("Open https://example.com/docs/file.txt now. Next sentence.");
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: "Open https://example.com/docs/file.txt now. Next sentence.",
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    const chunks: string[] = [];

    await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onProgress: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      "Open https://example.com/docs/file.txt now. ",
      "Next sentence.",
    ]);
  });

  test("does not commit a chunk in the middle of an inline-code path when the current aggregate ends with a dot", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      input.onUpdate?.("Received 1 file attachment:\n\n`C:\\repo\\codex-wechat-plugin\\.");
      input.onUpdate?.(`Received 1 file attachment:\n\n\`${TEST_ATTACHMENT_PATH}\``);
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: `Received 1 file attachment:\n\n\`${TEST_ATTACHMENT_PATH}\``,
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    const chunks: string[] = [];

    await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onProgress: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      "Received 1 file attachment:\n\n",
      `\`${TEST_ATTACHMENT_PATH}\``,
    ]);
  });

  test("does not split ordered-list markers from the following item content", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      input.onUpdate?.("1.\nCurrent task category: workspace path confirmation.\n2.\n");
      input.onUpdate?.("1.\nCurrent task category: workspace path confirmation.\n2.\nPrimary skill needed: none.");
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: "1.\nCurrent task category: workspace path confirmation.\n2.\nPrimary skill needed: none.",
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    const chunks: string[] = [];

    await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onProgress: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      "1.\nCurrent task category: workspace path confirmation.\n",
      "2.\nPrimary skill needed: none.",
    ]);
  });

  test("flushes a trailing ordered-list item instead of leaving only the numeric marker", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      input.onUpdate?.("1.\nFirst item content.\n2.");
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: "1.\nFirst item content.\n2.\nSecond item content is still here.",
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    const chunks: string[] = [];

    await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onProgress: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([
      "1.\nFirst item content.\n",
      "2.\nSecond item content is still here.",
    ]);
  });
  test("aborts an active turn via AbortSignal", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      return await new Promise(() => undefined);
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
    });
    const abortController = new AbortController();
    const runPromise = runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      signal: abortController.signal,
    });

    abortController.abort("Interrupted from test.");

    await expect(runPromise).rejects.toThrow("Interrupted from test.");
    expect(client.interruptTurnCalls).toEqual([{ threadId: "thread-new", turnId: "turn-1" }]);
    expect(client.closeCalls).toBeGreaterThanOrEqual(1);
  });

  test("does not wait forever when interrupt cleanup hangs during abort", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      return await new Promise(() => undefined);
    };
    client.interruptTurn = async (input: { threadId: string; turnId: string }) => {
      client.interruptTurnCalls.push(input);
      return await new Promise(() => undefined);
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 30_000,
      interruptTimeoutMs: 20,
    });
    const abortController = new AbortController();
    const runPromise = runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      signal: abortController.signal,
    });

    abortController.abort("Interrupted while cleanup hangs.");

    await expect(runPromise).rejects.toThrow("Interrupted while cleanup hangs.");
    expect(client.interruptTurnCalls).toEqual([{ threadId: "thread-new", turnId: "turn-1" }]);
    expect(client.closeCalls).toBeGreaterThanOrEqual(1);
  });

  test("emits a single idle-timeout notice and keeps waiting for the turn result", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      await sleep(30);
      input.onUpdate?.("finished.");
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: "finished.",
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 20,
    });
    const notices: Array<{ threadId?: string; turnId?: string; timeoutMs: number }> = [];

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      threadId: "thread-existing",
      onIdleTimeout: async (input) => {
        notices.push({
          timeoutMs: input.timeoutMs,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      },
    });

    expect(result.finalMessage).toBe("finished.");
    expect(notices).toEqual([{ threadId: "thread-existing", turnId: "turn-1", timeoutMs: 20 }]);
    expect(client.closeCalls).toBe(0);
  });

  test("starts the idle-timeout window before app-server emits onStarted", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async () => await new Promise(() => undefined);
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 20,
    });
    const notices: Array<{ threadId?: string; turnId?: string; timeoutMs: number }> = [];
    const abortController = new AbortController();

    const runPromise = runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onIdleTimeout: async (input) => {
        notices.push({
          timeoutMs: input.timeoutMs,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      },
      signal: abortController.signal,
    });

    await sleep(35);
    abortController.abort("Interrupted from startup-stall test.");

    await expect(runPromise).rejects.toThrow("Interrupted from startup-stall test.");
    expect(notices).toEqual([{ threadId: "thread-new", timeoutMs: 20 }]);
  });

  test("does not time out while the turn keeps emitting updates within the idle timeout window", async () => {
    const processManager = new FakeProcessManager();
    const client = new FakeAppServerClient();
    client.startTurnImplementation = async (input) => {
      input.onStarted?.("turn-1");
      await sleep(10);
      input.onUpdate?.("first sentence. ");
      await sleep(10);
      input.onUpdate?.("first sentence. second sentence. ");
      await sleep(10);
      return {
        threadId: input.threadId,
        turnId: "turn-1",
        finalMessage: "first sentence. second sentence.",
      };
    };
    const runner = new AppServerCodexRunner({
      processManager,
      client,
      turnTimeoutMs: 20,
    });
    const chunks: string[] = [];

    const result = await runner.runTurn({
      cwd: TEST_CWD,
      prompt: "hello",
      onProgress: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(result.finalMessage).toBe("first sentence. second sentence.");
    expect(chunks).toEqual(["first sentence. ", "second sentence. "]);
    expect(client.closeCalls).toBe(0);
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
