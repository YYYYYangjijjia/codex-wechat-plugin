import { AppServerClient } from "../codex/app-server-client.js";
import { WebSocketAppServerTransport } from "../codex/app-server-websocket-transport.js";

export async function probeCodexAppServer(input: {
  url: string;
  timeoutMs?: number | undefined;
}): Promise<boolean> {
  const transport = new WebSocketAppServerTransport({ url: input.url });
  const client = new AppServerClient({
    transport,
    clientInfo: {
      name: "codex-wechat-plugin-status",
      version: "0.1.0",
    },
  });

  try {
    await withTimeout(client.initialize(), input.timeoutMs ?? 2000);
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
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
