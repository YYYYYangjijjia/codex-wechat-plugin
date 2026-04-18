import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBridgeConfig } from "../config/app-config.js";
import { BridgeService } from "../daemon/bridge-service.js";
import { createWechatBridgeMcpServer } from "../mcp/wechat-bridge-mcp-server.js";
import { createStateStore } from "../state/sqlite-state-store.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const stateStore = createStateStore({ databasePath: config.databasePath });
  const service = new BridgeService(config, stateStore);
  const server = createWechatBridgeMcpServer({
    service,
    version: config.packageVersion,
  });
  const transport = new StdioServerTransport();

  const close = async () => {
    await server.close().catch(() => undefined);
    stateStore.close();
  };

  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
