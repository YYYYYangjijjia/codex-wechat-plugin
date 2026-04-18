import { spawn } from "node:child_process";

import { loadBridgeConfig } from "../config/app-config.js";
import { BridgeService } from "../daemon/bridge-service.js";
import { createStateStore } from "../state/sqlite-state-store.js";

async function main(): Promise<void> {
  const accountId = readFlagValue("--account");
  const timeoutMs = Number.parseInt(readFlagValue("--timeout") ?? "180000", 10);
  const shouldOpen = !process.argv.includes("--no-open");
  const pollIntervalMs = 2_000;

  const config = loadBridgeConfig();
  const stateStore = createStateStore({ databasePath: config.databasePath });
  const service = new BridgeService(config, stateStore);

  try {
    const session = await service.login(accountId);
    console.log(`session_key: ${session.sessionKey}`);
    console.log(`qrcode_url: ${session.qrcodeUrl}`);
    console.log(session.message);
    if (shouldOpen) {
      openUrl(session.qrcodeUrl);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await service.getLoginStatus(session.sessionKey);
      console.log(`status: ${JSON.stringify(status)}`);
      if (status.connected === true) {
        console.log(`connected account_id: ${String(status.accountId)}`);
        return;
      }
      if (status.status === "expired" || status.status === "missing") {
        throw new Error(`Login flow ended with status ${status.status}.`);
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for QR login confirmation after ${timeoutMs}ms.`);
  } finally {
    stateStore.close();
  }
}

function readFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function openUrl(url: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const comspec = process.env.ComSpec ?? "cmd.exe";
  const child = spawn(comspec, ["/d", "/c", "start", "", url], {
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
