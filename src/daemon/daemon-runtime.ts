type RuntimeStateStore = {
  getRuntimeState(key: string): unknown;
  recordDiagnostic(entry: { code: string; detail?: string | undefined }): void;
  close(): void;
};

type RuntimeService = {
  notifyLifecycle(input: { phase: "online" | "offline"; detail?: string | undefined }): Promise<void>;
  runDaemonLoop(abortSignal?: AbortSignal): Promise<void>;
};

export async function runBridgeDaemonRuntime<TStateStore extends RuntimeStateStore>(input: {
  abortSignal?: AbortSignal | undefined;
  restartDelayMs?: number | undefined;
  createStateStore: () => TStateStore;
  createService: (stateStore: TStateStore) => RuntimeService;
  log?: ((message: string) => void) | undefined;
  error?: ((message: string, error: unknown) => void) | undefined;
}): Promise<void> {
  let lifecycle = "daemon started";

  while (!input.abortSignal?.aborted) {
    const stateStore = input.createStateStore();
    const service = input.createService(stateStore);
    let shouldRestart = false;

    try {
      const previousStatus = stateStore.getRuntimeState("daemon_status");
      const detail = isObject(previousStatus) && lifecycle === "daemon started"
        ? "daemon restarted"
        : lifecycle;
      await service.notifyLifecycle({
        phase: "online",
        detail,
      });
      await service.runDaemonLoop(input.abortSignal);
      return;
    } catch (error) {
      if (input.abortSignal?.aborted) {
        return;
      }
      shouldRestart = true;
      lifecycle = "daemon recovered after unexpected stop";
      stateStore.recordDiagnostic({
        code: "daemon_runtime_restart",
        detail: error instanceof Error ? error.message : String(error),
      });
      input.error?.("daemon runtime crashed; restarting", error);
      await service.notifyLifecycle({
        phase: "offline",
        detail: "daemon loop crashed; restarting",
      }).catch(() => undefined);
    } finally {
      stateStore.close();
    }

    if (!shouldRestart || input.abortSignal?.aborted) {
      return;
    }
    await sleep(input.restartDelayMs ?? 2000, input.abortSignal);
  }
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== "aborted") {
      throw error;
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
