import { CodexTurnInterruptedError, type ReasoningEffort } from "./codex-runner.js";

type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type JsonRpcNotification = {
  method?: string;
  params?: Record<string, unknown>;
};

export type AppServerTransport = {
  open(): Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  send(message: unknown): void;
  close(): void;
};

export type AppServerClientInfo = {
  name: string;
  version: string;
};

export type InitializeResponse = {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
};

export type ThreadRecord = {
  id: string;
  cwd?: string | undefined;
};

export type AppServerThreadSummary = {
  id: string;
  name?: string | undefined;
  preview?: string | undefined;
  cwd?: string | undefined;
  updatedAt?: number | undefined;
  sourceKind?: string | undefined;
  statusType?: string | undefined;
};

export type AppServerModelSummary = {
  id: string;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort | undefined;
  isDefault: boolean;
};

export type AppServerRateLimitsSnapshot = Record<string, unknown>;

export type AppServerTurnResult = {
  threadId: string;
  turnId: string;
  finalMessage: string;
};

type PendingTurn = {
  threadId: string;
  turnId: string;
  finalMessage?: string;
  deltaBuffer: string;
  reasoningBuffer: string;
  reasoningSummaryBuffer: string;
  reasoningMode?: "summary" | "raw" | undefined;
  onUpdate?: ((text: string) => void) | undefined;
  onReasoningUpdate?: ((text: string) => void) | undefined;
  resolve: (result: AppServerTurnResult) => void;
  reject: (error: Error) => void;
};

export class AppServerClient {
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
  private readonly pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly bufferedNotifications = new Map<string, JsonRpcNotification[]>();
  private nextRequestId = 1;
  private isOpened = false;

  public constructor(
    private readonly options: {
      transport: AppServerTransport;
      clientInfo: AppServerClientInfo;
      onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void) | undefined;
      requestTimeoutMs?: number | undefined;
    },
  ) {
    this.options.transport.onMessage((message) => {
      this.handleMessage(message);
    });
  }

  async initialize(): Promise<InitializeResponse> {
    return this.sendRequest<InitializeResponse>("initialize", {
      clientInfo: this.options.clientInfo,
    });
  }

  async startThread(input: { cwd: string }): Promise<ThreadRecord> {
    const response = await this.sendRequest<{ thread?: { id?: string; cwd?: string } }>("thread/start", {
      cwd: input.cwd,
    });
    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("thread/start response did not include a thread id.");
    }
    return {
      id: threadId,
      ...(typeof response.thread?.cwd === "string" ? { cwd: response.thread.cwd } : {}),
    };
  }

  async resumeThread(input: { threadId: string }): Promise<ThreadRecord> {
    const response = await this.sendRequest<{ thread?: { id?: string; cwd?: string } }>("thread/resume", {
      threadId: input.threadId,
    });
    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("thread/resume response did not include a thread id.");
    }
    return {
      id: threadId,
      ...(typeof response.thread?.cwd === "string" ? { cwd: response.thread.cwd } : {}),
    };
  }

  async listThreads(input?: {
    limit?: number;
    sourceKinds?: string[];
  }): Promise<AppServerThreadSummary[]> {
    const response = await this.sendRequest<{ data?: Array<Record<string, unknown>> }>("thread/list", {
      cursor: null,
      limit: input?.limit ?? 10,
      sortKey: "updated_at",
      ...(input?.sourceKinds ? { sourceKinds: input.sourceKinds } : {}),
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return data.map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(typeof row.preview === "string" ? { preview: row.preview } : {}),
      ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
      ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
      ...(typeof row.sourceKind === "string" ? { sourceKind: row.sourceKind } : {}),
      ...(this.isObject(row.status) && typeof row.status.type === "string" ? { statusType: row.status.type } : {}),
    })).filter((row) => row.id);
  }

  async listModels(): Promise<AppServerModelSummary[]> {
    const response = await this.sendRequest<{ data?: Array<Record<string, unknown>> }>("model/list", {
      includeHidden: false,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return data
      .map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        supportedReasoningEfforts: Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts.filter(isReasoningEffort)
          : [],
        ...(isReasoningEffort(row.defaultReasoningEffort) ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
        isDefault: row.isDefault === true,
      }))
      .filter((row) => row.id);
  }

  async readRateLimits(): Promise<AppServerRateLimitsSnapshot> {
    const response = await this.sendRequest<{ rateLimits?: Record<string, unknown> }>("account/rateLimits/read", null);
    if (!this.isObject(response.rateLimits)) {
      throw new Error("account/rateLimits/read response did not include rateLimits.");
    }
    return response.rateLimits;
  }

  async setThreadName(input: { threadId: string; name: string }): Promise<void> {
    await this.sendRequest("thread/name/set", {
      threadId: input.threadId,
      name: input.name,
    });
  }

  async interruptTurn(input: { threadId: string; turnId: string }): Promise<void> {
    await this.sendRequest("turn/interrupt", {
      threadId: input.threadId,
      turnId: input.turnId,
    });
  }

  async steerTurn(input: { threadId: string; turnId: string; prompt: string }): Promise<{ turnId: string }> {
    const response = await this.sendRequest<{ turnId?: string }>("turn/steer", {
      threadId: input.threadId,
      expectedTurnId: input.turnId,
      input: [{ type: "text", text: input.prompt }],
    });
    return { turnId: response.turnId ?? input.turnId };
  }

  async startTurn(input: {
    threadId: string;
    cwd: string;
    prompt: string;
    model?: string | undefined;
    effort?: ReasoningEffort | undefined;
    onUpdate?: ((text: string) => void) | undefined;
    onReasoningUpdate?: ((text: string) => void) | undefined;
    onStarted?: ((turnId: string) => void) | undefined;
  }): Promise<AppServerTurnResult> {
    const response = await this.sendRequest<{ turn?: { id?: string } }>("turn/start", {
      threadId: input.threadId,
      cwd: input.cwd,
      input: [{ type: "text", text: input.prompt }],
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
    });
    const turnId = response.turn?.id;
    if (!turnId) {
      throw new Error("turn/start response did not include a turn id.");
    }
    input.onStarted?.(turnId);

    return await new Promise<AppServerTurnResult>((resolve, reject) => {
      const pendingTurn: PendingTurn = {
        threadId: input.threadId,
        turnId,
        deltaBuffer: "",
        reasoningBuffer: "",
        reasoningSummaryBuffer: "",
        onUpdate: input.onUpdate,
        onReasoningUpdate: input.onReasoningUpdate,
        resolve,
        reject,
      };
      this.pendingTurns.set(turnId, pendingTurn);
      const buffered = this.bufferedNotifications.get(turnId) ?? [];
      this.bufferedNotifications.delete(turnId);
      for (const notification of buffered) {
        this.handleTurnNotification(pendingTurn, notification);
      }
    });
  }

  close(): void {
    this.isOpened = false;
    this.rejectPending(new Error("Codex app-server client closed."));
    this.bufferedNotifications.clear();
    this.options.transport.close();
  }

  private async ensureOpen(): Promise<void> {
    if (this.isOpened) {
      return;
    }
    await this.options.transport.open();
    this.isOpened = true;
  }

  private async sendRequest<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureOpen();
    const id = this.nextRequestId++;
    const request: JsonRpcRequest = { id, method, ...(params ? { params } : {}) };
    const requestTimeoutMs = this.options.requestTimeoutMs ?? AppServerClient.DEFAULT_REQUEST_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const clearRequestTimeout = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const responsePromise = new Promise<T>((resolve, reject) => {
      timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        this.isOpened = false;
        reject(new Error(`app-server request ${method} timed out after ${requestTimeoutMs}ms.`));
      }, requestTimeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearRequestTimeout();
          resolve(value as T);
        },
        reject: (error) => {
          clearRequestTimeout();
          reject(error);
        },
      });
    });
    try {
      this.options.transport.send(request);
    } catch (error) {
      this.pendingRequests.delete(id);
      clearRequestTimeout();
      this.isOpened = false;
      throw error;
    }
    return await responsePromise;
  }

  private handleMessage(message: unknown): void {
    if (!this.isObject(message)) {
      return;
    }

    if (typeof message.id === "number") {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if (typeof message.method === "string") {
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const id = message.id;
    if (typeof id !== "number") {
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(id);

    if (message.error?.message) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private handleNotification(message: JsonRpcNotification): void {
    const method = message.method;
    const params = message.params;
    if (!method || !this.isObject(params)) {
      return;
    }
    this.options.onNotification?.({ method, params });

    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turnId = this.extractTurnId(params);
    if (!turnId) {
      return;
    }

    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      const buffered = this.bufferedNotifications.get(turnId) ?? [];
      buffered.push(message);
      this.bufferedNotifications.set(turnId, buffered);
      return;
    }
    this.handleTurnNotification(pending, message);
  }

  private handleTurnNotification(pending: PendingTurn, message: JsonRpcNotification): void {
    const method = message.method;
    const params = message.params;
    if (!method || !this.isObject(params)) {
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId && threadId !== pending.threadId) {
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      pending.deltaBuffer += delta;
      pending.onUpdate?.(pending.deltaBuffer);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) {
        return;
      }
      if (method === "item/reasoning/summaryTextDelta") {
        pending.reasoningMode = "summary";
        pending.reasoningSummaryBuffer += delta;
        pending.onReasoningUpdate?.(pending.reasoningSummaryBuffer);
        return;
      }
      if (pending.reasoningMode === "summary") {
        return;
      }
      pending.reasoningMode = "raw";
      pending.reasoningBuffer += delta;
      pending.onReasoningUpdate?.(pending.reasoningBuffer);
      return;
    }

    if (method === "item/completed") {
      const item = this.isObject(params.item) ? params.item : undefined;
      const itemType = typeof item?.type === "string" ? item.type : undefined;
      const phase = typeof item?.phase === "string" ? item.phase : undefined;
      const text = typeof item?.text === "string" ? item.text : undefined;
      if (itemType === "agentMessage" && phase === "final_answer") {
        pending.finalMessage = text ?? pending.deltaBuffer;
        pending.onUpdate?.(pending.finalMessage);
      }
      return;
    }

    if (method === "turn/completed") {
      this.pendingTurns.delete(pending.turnId);
      const turn = this.isObject(params.turn) ? params.turn : undefined;
      const status = typeof turn?.status === "string" ? turn.status : undefined;
      if (status === "interrupted") {
        pending.reject(new CodexTurnInterruptedError(`turn ${pending.turnId} interrupted.`));
        return;
      }
      const finalMessage = pending.finalMessage ?? pending.deltaBuffer;
      if (!finalMessage) {
        pending.reject(new Error(`turn ${pending.turnId} did not include a final agent message.`));
        return;
      }
      pending.resolve({
        threadId: pending.threadId,
        turnId: pending.turnId,
        finalMessage,
      });
    }
  }

  private extractTurnId(params: Record<string, unknown>): string | undefined {
    if (typeof params.turnId === "string") {
      return params.turnId;
    }
    const turn = this.isObject(params.turn) ? params.turn : undefined;
    return typeof turn?.id === "string" ? turn.id : undefined;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const pending of this.pendingTurns.values()) {
      pending.reject(error);
    }
    this.pendingTurns.clear();
  }
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
