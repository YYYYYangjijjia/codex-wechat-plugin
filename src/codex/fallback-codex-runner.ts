import {
  CodexTurnFallbackRequestedError,
  CodexTurnInterruptedError,
  type CodexRunner,
  type CodexTurnResult,
  type RunnerBackend,
} from "./codex-runner.js";

export async function runTurnWithFallback(input: {
  cwd: string;
  prompt: string;
  threadName?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((chunk: string) => Promise<void>) | undefined;
  onReasoningProgress?: ((chunk: string) => Promise<void>) | undefined;
  onIdleTimeout?: Parameters<CodexRunner["runTurn"]>[0]["onIdleTimeout"];
  onTurnStarted?: ((control: {
    runnerBackend: RunnerBackend;
    threadId?: string | undefined;
    turnId?: string | undefined;
    supportsAppend: boolean;
    interrupt: () => Promise<void>;
    append?: ((guidance: string) => Promise<void>) | undefined;
  }) => void) | undefined;
  primaryBackend: RunnerBackend;
  fallbackBackend?: RunnerBackend | undefined;
  conversationThread?: {
    runnerBackend?: RunnerBackend | undefined;
    runnerThreadId?: string | undefined;
    runnerCwd?: string | undefined;
  } | undefined;
  runners: Record<RunnerBackend, CodexRunner>;
  onFallback?: ((event: { from: RunnerBackend; to: RunnerBackend; error: Error }) => void) | undefined;
}): Promise<CodexTurnResult> {
  const primaryRunner = input.runners[input.primaryBackend];
  try {
    return await primaryRunner.runTurn({
      cwd: input.cwd,
      prompt: input.prompt,
      threadId: selectThreadId(input.conversationThread, input.primaryBackend),
      threadName: input.threadName,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      signal: input.signal,
      onProgress: input.onProgress,
      onReasoningProgress: input.onReasoningProgress,
      onIdleTimeout: input.onIdleTimeout,
      onTurnStarted: input.onTurnStarted,
    });
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (normalizedError instanceof CodexTurnInterruptedError || normalizedError instanceof CodexTurnFallbackRequestedError) {
      throw normalizedError;
    }
    if (
      input.primaryBackend === "app_server"
      && input.fallbackBackend === "exec"
      && input.conversationThread?.runnerBackend === "app_server"
      && input.conversationThread.runnerThreadId
    ) {
      throw normalizedError;
    }
    if (!input.fallbackBackend) {
      throw normalizedError;
    }
    const fallbackRunner = input.runners[input.fallbackBackend];
    input.onFallback?.({ from: input.primaryBackend, to: input.fallbackBackend, error: normalizedError });
    await input.onProgress?.(buildFallbackNotice({
      from: input.primaryBackend,
      to: input.fallbackBackend,
      error: normalizedError,
    }));
    return await fallbackRunner.runTurn({
      cwd: input.cwd,
      prompt: input.prompt,
      threadId: selectThreadId(input.conversationThread, input.fallbackBackend),
      threadName: input.threadName,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      signal: input.signal,
      onProgress: input.onProgress,
      onReasoningProgress: input.onReasoningProgress,
      onTurnStarted: input.onTurnStarted,
    });
  }
}

function buildFallbackNotice(input: { from: RunnerBackend; to: RunnerBackend; error: Error }): string {
  return [
    `⚠️ Codex backend switched from ${input.from} to ${input.to}.`,
    `原因: ${input.error.message}`,
    "本轮回复可能失去当前 session 的实时控制能力。",
  ].join("\n");
}

function selectThreadId(
  conversationThread: { runnerBackend?: RunnerBackend | undefined; runnerThreadId?: string | undefined } | undefined,
  backend: RunnerBackend,
): string | undefined {
  if (!conversationThread) {
    return undefined;
  }
  if (conversationThread.runnerBackend !== backend) {
    return undefined;
  }
  return conversationThread.runnerThreadId;
}
