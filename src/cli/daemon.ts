import path from "node:path";

import { loadBridgeConfig } from "../config/app-config.js";
import { BridgeService } from "../daemon/bridge-service.js";
import { runBridgeDaemonRuntime } from "../daemon/daemon-runtime.js";
import { acquireProcessLock, ProcessLockAlreadyHeldError } from "../runtime/process-lock.js";
import { createStateStore } from "../state/sqlite-state-store.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const lock = await acquireProcessLock({
    lockPath: path.join(config.stateDir, "daemon.lock"),
    purpose: "wechat-bridge-daemon",
  });
  const abortController = new AbortController();
  let shutdownSignal: "SIGINT" | "SIGTERM" | undefined;

  process.on("SIGINT", () => {
    shutdownSignal = "SIGINT";
    abortController.abort();
  });
  process.on("SIGTERM", () => {
    shutdownSignal = "SIGTERM";
    abortController.abort();
  });
  process.on("uncaughtException", (error) => {
    console.error("uncaughtException in daemon", error);
    shutdownSignal = shutdownSignal ?? "SIGTERM";
    abortController.abort(error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection in daemon", reason);
    shutdownSignal = shutdownSignal ?? "SIGTERM";
    abortController.abort(reason);
  });

  console.log(`WeChat bridge daemon starting with state db: ${config.databasePath}`);
  console.log(`Workspace: ${config.workspaceDir}`);

  try {
    await runBridgeDaemonRuntime({
      abortSignal: abortController.signal,
      createStateStore: () => createStateStore({ databasePath: config.databasePath }),
      createService: (runtimeStateStore) => new BridgeService(config, runtimeStateStore),
      error: (message, error) => {
        console.error(message, error);
      },
    });
  } finally {
    const stateStore = createStateStore({ databasePath: config.databasePath });
    const service = new BridgeService(config, stateStore);
    await service.notifyLifecycle({
      phase: "offline",
      detail: shutdownSignal ? `daemon stopping after ${shutdownSignal}` : "daemon exiting",
    }).catch(() => undefined);
    stateStore.close();
    await lock.release().catch(() => undefined);
  }
}

main().catch((error) => {
  if (error instanceof ProcessLockAlreadyHeldError) {
    console.log(`WeChat bridge daemon is already running${typeof error.pid === "number" ? ` (pid ${error.pid})` : ""}.`);
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});
