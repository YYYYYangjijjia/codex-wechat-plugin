import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createBridgeToolRegistry, type BridgeToolService } from "./bridge-tool-registry.js";

export function createWechatBridgeMcpServer(input: {
  service: BridgeToolService;
  version: string;
}): McpServer {
  const server = new McpServer({
    name: "codex-wechat-bridge",
    version: input.version,
  });

  const registry = createBridgeToolRegistry(input.service);
  for (const [name, definition] of Object.entries(registry)) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (args) => definition.execute((args ?? {}) as Record<string, unknown>),
    );
  }

  return server;
}
