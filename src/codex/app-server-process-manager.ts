import { spawn, type ChildProcess } from "node:child_process";

export type CommandInvocation = {
  command: string;
  args: string[];
};

export function buildAppServerInvocation(input: { command?: string | undefined; listenUrl: string }): CommandInvocation {
  return {
    command: input.command ?? "codex",
    args: ["app-server", "--listen", input.listenUrl],
  };
}

export function buildAppServerSpawnInvocation(
  invocation: CommandInvocation,
  platform = process.platform,
  commandShell = process.env.ComSpec ?? "cmd.exe",
): CommandInvocation {
  if (platform !== "win32") {
    return invocation;
  }

  return {
    command: commandShell,
    args: ["/d", "/c", invocation.command, ...invocation.args],
  };
}

export async function checkWebSocketEndpoint(input: { url: string; timeoutMs?: number | undefined }): Promise<boolean> {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("Global WebSocket is not available in this Node runtime.");
  }

  const timeoutMs = input.timeoutMs ?? 1000;
  return await new Promise<boolean>((resolve) => {
    const socket = new WebSocketCtor(input.url);
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    }, { once: true });
  });
}

export class AppServerProcessManager {
  private child: ChildProcess | undefined;

  public constructor(
    private readonly options: {
      command?: string | undefined;
      listenUrl: string;
      cwd: string;
      startupTimeoutMs?: number | undefined;
      healthCheck?: (() => Promise<boolean>) | undefined;
      spawnProcess?: ((invocation: CommandInvocation, cwd: string) => ChildProcess) | undefined;
      platform?: NodeJS.Platform | undefined;
      commandShell?: string | undefined;
    },
  ) {}

  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      return;
    }

    this.startProcess();
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 10000);
    while (Date.now() < deadline) {
      if (await this.isHealthy()) {
        return;
      }
      await sleep(200);
    }

    throw new Error(`Codex app-server did not become healthy at ${this.options.listenUrl}.`);
  }

  private async isHealthy(): Promise<boolean> {
    const healthCheck = this.options.healthCheck ?? (() => checkWebSocketEndpoint({ url: this.options.listenUrl }));
    try {
      return await healthCheck();
    } catch {
      return false;
    }
  }

  private startProcess(): void {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return;
    }

    const logicalInvocation = buildAppServerInvocation({
      command: this.options.command,
      listenUrl: this.options.listenUrl,
    });
    const invocation = buildAppServerSpawnInvocation(
      logicalInvocation,
      this.options.platform,
      this.options.commandShell,
    );
    const spawnProcess = this.options.spawnProcess ?? defaultSpawnProcess;
    this.child = spawnProcess(invocation, this.options.cwd);
    this.child.once("exit", () => {
      this.child = undefined;
    });
  }
}

function defaultSpawnProcess(invocation: CommandInvocation, cwd: string): ChildProcess {
  return spawn(invocation.command, invocation.args, {
    cwd,
    stdio: "ignore",
    windowsHide: true,
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
