import { spawn } from "node:child_process";
import readline from "node:readline";
import { CodexTurnInterruptedError, type CodexRunner, type CodexTurnResult, type ReasoningEffort } from "./codex-runner.js";

export type ExecInvocation = {
  command: string;
  args: string[];
};

export type ExecTurnResult = CodexTurnResult;

export type BuildExecInvocationInput = {
  cwd: string;
  prompt: string;
  threadId?: string | undefined;
  skipGitRepoCheck?: boolean | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
};

export function buildExecInvocation(input: BuildExecInvocationInput): ExecInvocation {
  const modelArgs = input.model ? ["-m", input.model] : [];

  if (input.threadId) {
    return {
      command: "codex",
      args: [
        "exec",
        "resume",
        "--json",
        ...modelArgs,
        ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
        input.threadId,
        input.prompt,
      ],
    };
  }

  return {
    command: "codex",
    args: [
      "exec",
      "--json",
      ...modelArgs,
      ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      "-C",
      input.cwd,
      input.prompt,
    ],
  };
}

export function buildSpawnInvocation(
  invocation: ExecInvocation,
  platform = process.platform,
  commandShell = process.env.ComSpec ?? "cmd.exe",
): ExecInvocation {
  if (platform !== "win32") {
    return invocation;
  }

  return {
    command: commandShell,
    args: ["/d", "/c", invocation.command, ...invocation.args],
  };
}

type JsonEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
};

export function collectExecResultFromOutput(lines: string[]): ExecTurnResult {
  let threadId: string | undefined;
  let finalMessage: string | undefined;

  for (const line of lines) {
    let parsed: JsonEvent;
    try {
      parsed = JSON.parse(line) as JsonEvent;
    } catch {
      continue;
    }

    if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
      threadId = parsed.thread_id;
    }

    if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
      finalMessage = parsed.item.text;
    }
  }

  if (!threadId) {
    throw new Error("Codex exec output did not include a thread id.");
  }
  if (!finalMessage) {
    throw new Error("Codex exec output did not include a final agent message.");
  }

  return { runnerBackend: "exec", threadId, finalMessage, cwd: "" };
}

export class ExecCodexRunner implements CodexRunner {
  public constructor(
    private readonly options: {
      command?: string | undefined;
      model?: string | undefined;
      skipGitRepoCheck?: boolean | undefined;
    } = {},
  ) {}

  async runTurn(input: {
    cwd: string;
    prompt: string;
    threadId?: string | undefined;
    model?: string | undefined;
    signal?: AbortSignal | undefined;
    onReasoningProgress?: ((chunk: string) => Promise<void>) | undefined;
    onTurnStarted?: ((control: {
      runnerBackend: "exec";
      threadId?: string | undefined;
      turnId?: string | undefined;
      supportsAppend: false;
      interrupt: () => Promise<void>;
    }) => void) | undefined;
  }): Promise<ExecTurnResult> {
    const logicalInvocation = buildExecInvocation({
      cwd: input.cwd,
      prompt: input.prompt,
      threadId: input.threadId,
      skipGitRepoCheck: this.options.skipGitRepoCheck,
      model: input.model ?? this.options.model,
    });
    logicalInvocation.command = this.options.command ?? logicalInvocation.command;
    const invocation = buildSpawnInvocation(logicalInvocation);

    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines: string[] = [];
    const stderrLines: string[] = [];

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      lines.push(line);
    });

    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line) => {
      lines.push(line);
      stderrLines.push(line);
    });

    let interrupted = false;
    let settled = false;
    const interrupt = async (): Promise<void> => {
      if (settled || interrupted) {
        return;
      }
      interrupted = true;
      child.kill();
    };
    input.onTurnStarted?.({
      runnerBackend: "exec",
      supportsAppend: false,
      interrupt,
    });
    const abortListener = () => {
      void interrupt();
    };
    input.signal?.addEventListener("abort", abortListener, { once: true });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
    });
    settled = true;
    input.signal?.removeEventListener("abort", abortListener);

    stdoutReader.close();
    stderrReader.close();

    if (interrupted || input.signal?.aborted) {
      throw new CodexTurnInterruptedError("Codex exec turn interrupted.");
    }

    if (exitCode !== 0) {
      throw new Error(`codex exec exited with code ${exitCode}: ${stderrLines.join("\n")}`.trim());
    }

    const result = collectExecResultFromOutput(lines);
    return {
      ...result,
      cwd: input.cwd,
    };
  }
}
