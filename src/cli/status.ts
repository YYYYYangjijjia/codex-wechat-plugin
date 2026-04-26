import { loadBridgeConfig } from "../config/app-config.js";
import { resolveRuntimeRoot } from "../config/runtime-root.js";
import { createStateStore } from "../state/sqlite-state-store.js";
import { collectBridgeStatus, formatBridgeStatus } from "../status/bridge-status.js";
import { probeCodexAppServer } from "../status/probe-codex-app-server.js";

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const runtimeRoot = resolveRuntimeRoot({ moduleUrl: import.meta.url });
  const config = loadBridgeConfig(runtimeRoot);
  const stateStore = createStateStore({ databasePath: config.databasePath });

  try {
    const snapshot = await collectBridgeStatus({
      config,
      stateStore,
      probeAppServer: async () => await probeCodexAppServer({
        url: config.appServerListenUrl,
        timeoutMs: Math.min(2000, config.appServerStartupTimeoutMs),
      }),
    });
    if (json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    console.log(formatBridgeStatus(snapshot));
  } finally {
    stateStore.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
