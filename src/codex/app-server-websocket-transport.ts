export class WebSocketAppServerTransport {
  private socket: WebSocket | undefined;
  private openPromise: Promise<void> | undefined;
  private messageHandler: ((message: unknown) => void) | undefined;

  public constructor(private readonly options: { url: string }) {}

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  async open(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.openPromise) {
      await this.openPromise;
      return;
    }
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("Global WebSocket is not available in this Node runtime.");
    }

    this.openPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocketCtor(this.options.url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        this.openPromise = undefined;
        reject(new Error(`Failed to connect to Codex app-server at ${this.options.url}.`));
      }, { once: true });
      socket.addEventListener("close", () => {
        this.socket = undefined;
        this.openPromise = undefined;
      });
      socket.addEventListener("message", (event) => {
        const payload = parseWebSocketPayload(event.data);
        if (payload === undefined) {
          return;
        }
        this.messageHandler?.(payload);
      });
    });

    await this.openPromise;
  }

  send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server transport is not connected.");
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.openPromise = undefined;
  }
}

function parseWebSocketPayload(data: unknown): unknown {
  const text = typeof data === "string"
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : undefined;
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
