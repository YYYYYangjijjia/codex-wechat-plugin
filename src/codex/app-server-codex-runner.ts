import { CodexTurnInterruptedError, type ReasoningEffort } from "./codex-runner.js";
import type { AppServerClient, AppServerModelSummary, AppServerRateLimitsSnapshot, AppServerThreadSummary, ThreadRecord } from "./app-server-client.js";
import type { CodexRunner, CodexTurnResult } from "./codex-runner.js";
import type { AppServerProcessManager } from "./app-server-process-manager.js";

export class AppServerCodexRunner implements CodexRunner {
  private initializePromise: Promise<void> | undefined;

  public constructor(
    private readonly options: {
      processManager: Pick<AppServerProcessManager, "ensureRunning">;
      client: Pick<AppServerClient, "initialize" | "startThread" | "resumeThread" | "startTurn" | "interruptTurn" | "steerTurn" | "setThreadName" | "listThreads" | "listModels" | "readRateLimits" | "close">;
      turnTimeoutMs?: number | undefined;
    },
  ) {}

  async listThreads(input?: { limit?: number; sourceKinds?: string[] }): Promise<AppServerThreadSummary[]> {
    return await this.runWithRecoveredInitialization(() => this.options.client.listThreads(input));
  }

  async listModels(): Promise<AppServerModelSummary[]> {
    return await this.runWithRecoveredInitialization(() => this.options.client.listModels());
  }

  async readRateLimits(): Promise<AppServerRateLimitsSnapshot> {
    return await this.runWithRecoveredInitialization(() => this.options.client.readRateLimits());
  }

  async resumeThread(threadId: string): Promise<ThreadRecord> {
    return await this.runWithRecoveredInitialization(() => this.options.client.resumeThread({ threadId }));
  }

  async runTurn(input: {
    cwd: string;
    prompt: string;
    threadId?: string | undefined;
    threadName?: string | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((chunk: string) => Promise<void>) | undefined;
    onReasoningProgress?: ((chunk: string) => Promise<void>) | undefined;
    onIdleTimeout?: ((input: {
      runnerBackend: "app_server";
      threadId?: string | undefined;
      turnId?: string | undefined;
      timeoutMs: number;
    }) => Promise<void>) | undefined;
    onTurnStarted?: ((control: {
      runnerBackend: "app_server";
      threadId?: string | undefined;
      turnId?: string | undefined;
      supportsAppend: true;
      interrupt: () => Promise<void>;
      append?: ((guidance: string) => Promise<void>) | undefined;
    }) => void) | undefined;
  }): Promise<CodexTurnResult> {
    await this.ensureInitialized();

    const answerChunker = new ProgressChunker();
    const reasoningChunker = new ProgressChunker();
    let progressChain = Promise.resolve();
    let reasoningChain = Promise.resolve();
    let latestReasoningText = "";
    const reusableThreadId = !input.threadId && input.threadName
      ? await this.findReusableThreadId(input.threadName)
      : undefined;
    const thread = input.threadId
      ? await this.options.client.resumeThread({ threadId: input.threadId })
      : reusableThreadId
        ? await this.options.client.resumeThread({ threadId: reusableThreadId })
        : await this.options.client.startThread({ cwd: input.cwd });
    if (!input.threadId && !reusableThreadId && input.threadName) {
      await this.options.client.setThreadName({
        threadId: thread.id,
        name: input.threadName,
      });
    }

    try {
      let activeTurnId: string | undefined;
      const idleTimeout = createIdleTimeoutNotice({
        timeoutMs: this.options.turnTimeoutMs ?? 60_000,
        onIdle: async () => {
          await input.onIdleTimeout?.({
            runnerBackend: "app_server",
            threadId: thread.id,
            turnId: activeTurnId,
            timeoutMs: this.options.turnTimeoutMs ?? 60_000,
          });
        },
      });
      const turnPromise = this.options.client.startTurn({
        threadId: thread.id,
        cwd: input.cwd,
        prompt: input.prompt,
        model: input.model,
        effort: input.reasoningEffort,
        onStarted: (turnId) => {
          activeTurnId = turnId;
          idleTimeout.touch();
          input.onTurnStarted?.({
            runnerBackend: "app_server",
            threadId: thread.id,
            turnId,
            supportsAppend: true,
            interrupt: async () => {
              await this.options.client.interruptTurn({ threadId: thread.id, turnId });
            },
            append: async (guidance: string) => {
              await this.options.client.steerTurn({ threadId: thread.id, turnId, prompt: guidance });
            },
          });
        },
        onUpdate: (text) => {
          idleTimeout.touch();
          if (input.signal?.aborted || !input.onProgress) {
            return;
          }
          for (const chunk of answerChunker.extractCommitted(text)) {
            progressChain = progressChain.then(() => input.onProgress!(chunk));
          }
        },
        onReasoningUpdate: (text) => {
          latestReasoningText = text;
          idleTimeout.touch();
          if (input.signal?.aborted || !input.onReasoningProgress) {
            return;
          }
          for (const chunk of reasoningChunker.extractCommitted(text)) {
            reasoningChain = reasoningChain.then(() => input.onReasoningProgress!(chunk));
          }
        },
      });
      const result = await raceWithAbort(turnPromise, input.signal, async () => {
        idleTimeout.stop();
        if (activeTurnId) {
          await this.options.client.interruptTurn({ threadId: thread.id, turnId: activeTurnId }).catch(() => undefined);
        }
        this.resetClient();
      });
      idleTimeout.stop();
      await progressChain;
      await reasoningChain;
      if (input.onReasoningProgress && !input.signal?.aborted) {
        const trailingReasoning = reasoningChunker.flushTrailing(latestReasoningText);
        if (trailingReasoning) {
          await input.onReasoningProgress(trailingReasoning);
        }
      }
      if (input.onProgress && !input.signal?.aborted) {
        const trailing = answerChunker.flushTrailing(result.finalMessage);
        if (trailing) {
          await input.onProgress(trailing);
        }
      }

      return {
        runnerBackend: "app_server",
        threadId: result.threadId,
        finalMessage: result.finalMessage,
        cwd: input.cwd,
      };
    } catch (error) {
      this.resetClient();
      throw error;
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.options.processManager.ensureRunning();
    if (!this.initializePromise) {
      this.initializePromise = this.options.client.initialize().then(() => undefined);
    }
    await this.initializePromise;
  }

  private resetClient(): void {
    this.options.client.close();
    this.initializePromise = undefined;
  }

  private async runWithRecoveredInitialization<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    try {
      return await operation();
    } catch (error) {
      if (!isNotInitializedError(error)) {
        throw error;
      }
      this.resetClient();
      await this.ensureInitialized();
      return await operation();
    }
  }

  private async findReusableThreadId(threadName: string): Promise<string | undefined> {
    const threads = await this.options.client.listThreads({ limit: 50 });
    return threads.find((thread) => thread.name === threadName)?.id;
  }
}

function isNotInitializedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /not initialized/i.test(error.message);
}

class ProgressChunker {
  private emittedLength = 0;

  extractCommitted(aggregateText: string): string[] {
    const boundary = findCommitBoundary(aggregateText);
    if (boundary <= this.emittedLength) {
      return [];
    }
    const chunk = aggregateText.slice(this.emittedLength, boundary);
    this.emittedLength = boundary;
    return chunk ? [chunk] : [];
  }

  flushTrailing(finalText: string): string | undefined {
    if (finalText.length <= this.emittedLength) {
      return undefined;
    }
    const trailing = finalText.slice(this.emittedLength);
    this.emittedLength = finalText.length;
    return trailing || undefined;
  }
}

function findCommitBoundary(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index] ?? "";
    if (isInsideUnclosedInlineCode(text, index + 1)) {
      continue;
    }
    if (char === "\n") {
      if (isOrderedListMarkerLine(text, index)) {
        continue;
      }
      return index + 1;
    }
    if (isSentenceBoundary(char)) {
      const next = text[index + 1];
      if (char === "." && next && !/\s/.test(next)) {
        continue;
      }
      if (isOrderedListMarkerAt(text, index)) {
        continue;
      }
      let boundary = index + 1;
      while (boundary < text.length && /\s/.test(text[boundary]!)) {
        boundary += 1;
      }
      return boundary;
    }
  }
  return 0;
}

function isSentenceBoundary(char: string): boolean {
  return char === "." || char === "!" || char === "?" || char === "。" || char === "！" || char === "？";
}

function isOrderedListMarkerAt(text: string, markerIndex: number): boolean {
  const lineStart = text.lastIndexOf("\n", markerIndex - 1) + 1;
  const candidate = text.slice(lineStart, markerIndex + 1).trim();
  return /^\d+[.)、]$/.test(candidate);
}

function isOrderedListMarkerLine(text: string, newlineIndex: number): boolean {
  const lineStart = text.lastIndexOf("\n", newlineIndex - 1) + 1;
  const candidate = text.slice(lineStart, newlineIndex).trim();
  return /^\d+[.)、]$/.test(candidate);
}

function isInsideUnclosedInlineCode(text: string, endExclusive: number): boolean {
  let inlineTickCount = 0;
  for (let index = 0; index < endExclusive; index += 1) {
    if (text[index] !== "`") {
      continue;
    }
    let runLength = 1;
    while (index + runLength < endExclusive && text[index + runLength] === "`") {
      runLength += 1;
    }
    if (runLength === 1) {
      inlineTickCount += 1;
    }
    index += runLength - 1;
  }
  return inlineTickCount % 2 === 1;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createIdleTimeoutNotice(input: {
  timeoutMs: number;
  onIdle: () => Promise<void>;
}): {
  touch: () => void;
  stop: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let notified = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const touch = () => {
    if (settled || notified) {
      return;
    }
    clear();
    timer = setTimeout(async () => {
      if (settled || notified) {
        return;
      }
      notified = true;
      await input.onIdle();
    }, input.timeoutMs);
  };

  return {
    touch,
    stop() {
      settled = true;
      clear();
    },
  };
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Promise<void>): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    await onAbort();
    throw interruptedFromSignal(signal);
  }
  return await new Promise<T>((resolve, reject) => {
    const abortHandler = async () => {
      try {
        await onAbort();
      } finally {
        reject(interruptedFromSignal(signal));
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abortHandler);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abortHandler);
        reject(error);
      },
    );
  });
}

function interruptedFromSignal(signal: AbortSignal): CodexTurnInterruptedError {
  if (signal.reason instanceof CodexTurnInterruptedError) {
    return signal.reason;
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    return new CodexTurnInterruptedError(signal.reason);
  }
  return new CodexTurnInterruptedError("Codex turn interrupted.");
}
