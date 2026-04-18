import { describe, expect, test } from "vitest";

import { runTurnWithFallback } from "../../src/codex/fallback-codex-runner.js";

function makeRunner(
  name: "exec" | "app_server",
  events: string[],
  implementation?: (input: {
    threadId?: string | undefined;
    threadName?: string | undefined;
    onProgress?: ((chunk: string) => Promise<void>) | undefined;
    cwd: string;
    prompt: string;
  }) => Promise<{ runnerBackend: "exec" | "app_server"; threadId: string; finalMessage: string; cwd: string }>,
) {
  return {
    async runTurn(input: { cwd: string; threadId?: string | undefined; threadName?: string | undefined; onProgress?: ((chunk: string) => Promise<void>) | undefined; prompt: string }) {
      events.push(`${name}:${input.threadId ?? "new"}:${input.prompt}`);
      if (implementation) {
        return await implementation(input);
      }
      return {
        runnerBackend: name,
        threadId: input.threadId ?? `${name}-thread-new`,
        finalMessage: `${name}:${input.prompt}`,
        cwd: input.cwd,
      };
    },
  };
}

describe("runTurnWithFallback", () => {
  test("uses the primary backend thread when the stored backend matches", async () => {
    const events: string[] = [];
    const result = await runTurnWithFallback({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello",
      primaryBackend: "app_server",
      fallbackBackend: "exec",
      conversationThread: {
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
      },
      runners: {
        app_server: makeRunner("app_server", events),
        exec: makeRunner("exec", events),
      },
    });

    expect(result).toEqual({
      runnerBackend: "app_server",
      threadId: "thread-app-1",
      finalMessage: "app_server:hello",
      cwd: "C:/repo/codex-wechat-plugin",
    });
    expect(events).toEqual(["app_server:thread-app-1:hello"]);
  });

  test("falls back to exec without leaking an app-server thread id", async () => {
    const events: string[] = [];
    const result = await runTurnWithFallback({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello",
      primaryBackend: "app_server",
      fallbackBackend: "exec",
      conversationThread: {
        runnerBackend: "app_server",
        runnerThreadId: "thread-app-1",
      },
      runners: {
        app_server: makeRunner("app_server", events, async () => {
          throw new Error("app-server unavailable");
        }),
        exec: makeRunner("exec", events),
      },
    });

    expect(result).toEqual({
      runnerBackend: "exec",
      threadId: "exec-thread-new",
      finalMessage: "exec:hello",
      cwd: "C:/repo/codex-wechat-plugin",
    });
    expect(events).toEqual([
      "app_server:thread-app-1:hello",
      "exec:new:hello",
    ]);
  });

  test("forwards thread naming and progress callbacks to the selected backend", async () => {
    const events: string[] = [];
    const progress: string[] = [];
    await runTurnWithFallback({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "hello",
      threadName: "WeChat user-a",
      onProgress: async (chunk) => {
        progress.push(chunk);
      },
      primaryBackend: "app_server",
      runners: {
        app_server: makeRunner("app_server", events, async (input) => {
          await input.onProgress?.("partial");
          events.push(`thread-name:${input.threadName ?? "missing"}`);
          return {
            runnerBackend: "app_server",
            threadId: "thread-app-1",
            finalMessage: "done",
            cwd: input.cwd,
          };
        }),
        exec: makeRunner("exec", events),
      },
    });

    expect(events).toEqual([
      "app_server:new:hello",
      "thread-name:WeChat user-a",
    ]);
    expect(progress).toEqual(["partial"]);
  });
});

