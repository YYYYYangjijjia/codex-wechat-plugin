export type RunnerBackend = "exec" | "app_server";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export class CodexTurnInterruptedError extends Error {
  public constructor(message = "Codex turn interrupted.") {
    super(message);
    this.name = "CodexTurnInterruptedError";
  }
}

export type ActiveTurnControl = {
  runnerBackend: RunnerBackend;
  threadId?: string | undefined;
  turnId?: string | undefined;
  supportsAppend: boolean;
  interrupt: () => Promise<void>;
  append?: ((guidance: string) => Promise<void>) | undefined;
};

export type CodexTurnResult = {
  runnerBackend: RunnerBackend;
  threadId: string;
  finalMessage: string;
  cwd: string;
};

export type CodexRunner = {
  runTurn(input: {
    cwd: string;
    prompt: string;
    threadId?: string | undefined;
    threadName?: string | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((chunk: string) => Promise<void>) | undefined;
    onReasoningProgress?: ((chunk: string) => Promise<void>) | undefined;
    onTurnStarted?: ((control: ActiveTurnControl) => void) | undefined;
  }): Promise<CodexTurnResult>;
};
