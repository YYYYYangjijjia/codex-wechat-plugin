import type { CodexRunner, CodexTurnResult, RunnerBackend } from "./codex-runner.js";

export async function runTurnWithFallback(input: {
  cwd: string;
  prompt: string;
  threadName?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((chunk: string) => Promise<void>) | undefined;
  onReasoningProgress?: ((chunk: string) => Promise<void>) | undefined;
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
      onTurnStarted: input.onTurnStarted,
    });
  } catch (error) {
    if (!input.fallbackBackend) {
      throw error;
    }
    const fallbackRunner = input.runners[input.fallbackBackend];
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    input.onFallback?.({ from: input.primaryBackend, to: input.fallbackBackend, error: normalizedError });
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
