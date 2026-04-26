import path from "node:path";

import { createReplyOrchestrator } from "./reply-orchestrator.js";
import { BridgeRestartRequestedError } from "./bridge-restart-requested-error.js";
import { appendDeliverySkillPrompt } from "./delivery-guidance.js";
import { parseDeliveryIntent, type DeliveryIntent } from "./delivery-intent.js";
import type { BridgeConfig } from "../config/app-config.js";
import { ExecCodexRunner } from "../codex/exec-codex-runner.js";
import { AppServerClient, type AppServerThreadSummary } from "../codex/app-server-client.js";
import { AppServerCodexRunner } from "../codex/app-server-codex-runner.js";
import { AppServerProcessManager } from "../codex/app-server-process-manager.js";
import { WebSocketAppServerTransport } from "../codex/app-server-websocket-transport.js";
import { CodexTurnFallbackRequestedError, CodexTurnInterruptedError, type ActiveTurnControl, type CodexRunner, type ReasoningEffort, type RunnerBackend } from "../codex/codex-runner.js";
import { getInstalledPluginRoot } from "../config/runtime-root.js";
import { listInstalledSkills } from "../commands/installed-skills.js";
import { runTurnWithFallback } from "../codex/fallback-codex-runner.js";
import {
  handleWechatControlCommand,
  NEXT_NEW_SESSION_NAME_PREFIX,
  TEST_SESSION_RETURN_PREFIX,
  parseWechatControlCommand,
} from "../commands/wechat-control-commands.js";
import type { ConversationRecord, OutboundDeliveryRecord, PendingMessageRecord, StateStore } from "../state/sqlite-state-store.js";
import { HttpWeixinClient, type GetUpdatesResponse, MessageItemType } from "../weixin/weixin-api-client.js";
import { downloadInboundAttachments, type InboundAttachmentDownload } from "../weixin/media-download.js";
import { sendLocalMediaFile } from "../weixin/outbound-media.js";
import { LoginManager } from "../weixin/login-manager.js";

const SESSION_EXPIRED_ERROR = -14;
const RUNTIME_PREFERENCES_KEY = "codex_runtime_preferences";
const LIFECYCLE_NOTIFICATION_LIMIT = 5;
const PENDING_REVIEW_PREFIX = "pending_review:";
const RECOVERY_MESSAGE_PREVIEW_LENGTH = 120;
const PENDING_LIFECYCLE_NOTIFICATION_KEY = "pending_lifecycle_notification";
const PENDING_PROCESSING_STARTED_AT_PREFIX = "pending_processing_started_at:";
const ACTIVE_TASK_REAP_AFTER_IDLE_MS = 5 * 60_000;
const ACTIVE_TASK_REAP_AFTER_EXTENDED_IDLE_MS = 30 * 60_000;
const STALE_TASK_INTERRUPTED_PREFIX = "Stale Codex task interrupted";

type RuntimePreferences = {
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  showFinalSummary?: boolean | undefined;
};

type PendingLifecycleNotification = {
  phase: "online" | "offline";
  detail?: string | undefined;
  createdAt: string;
};

type ActiveTaskState = {
  pendingMessageId: number;
  conversationKey: string;
  prompt: string;
  abortController: AbortController;
  runnerBackend?: RunnerBackend | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  supportsAppend: boolean;
  fallbackEligible?: boolean | undefined;
  fallbackRequestedBackend?: RunnerBackend | undefined;
  control?: ActiveTurnControl | undefined;
  startedAtMs?: number | undefined;
  lastActivityAtMs?: number | undefined;
  idleNotifiedAtMs?: number | undefined;
};

function extractTextPrompt(message: NonNullable<GetUpdatesResponse["msgs"]>[number]): string {
  for (const item of message.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      return item.text_item.text;
    }
  }
  return "";
}

function extractQuotedTexts(message: NonNullable<GetUpdatesResponse["msgs"]>[number]): string[] {
  const quotedTexts: string[] = [];
  for (const item of message.item_list ?? []) {
    const text = item.ref_msg?.message_item?.text_item?.text?.trim();
    if (!text) {
      continue;
    }
    if (!quotedTexts.includes(text)) {
      quotedTexts.push(text);
    }
  }
  return quotedTexts;
}

function buildInboundPrompt(message: NonNullable<GetUpdatesResponse["msgs"]>[number]): string {
  const prompt = extractTextPrompt(message);
  const quotedTexts = extractQuotedTexts(message);
  if (quotedTexts.length === 0) {
    return prompt;
  }
  if (quotedTexts.length === 1) {
    return [
      "User is replying to a quoted WeChat message.",
      "Treat the quoted message as primary context for the reply unless the new user message clearly changes topic.",
      "",
      "Quoted message (primary context):",
      quotedTexts[0]!,
      "",
      "New user message:",
      prompt,
    ].join("\n");
  }
  return [
    "User is replying to multiple quoted WeChat messages.",
    "Treat the quoted messages as primary context for the reply unless the new user message clearly changes topic.",
    "",
    "Quoted messages (primary context):",
    ...quotedTexts.map((text, index) => `${index + 1}. ${text}`),
    "",
    "New user message:",
    prompt,
  ].join("\n");
}

function buildInboundPromptWithAttachments(basePrompt: string, attachments: InboundAttachmentDownload[]): string {
  if (attachments.length === 0) {
    return basePrompt;
  }
  const sections = [
    "User sent attachments in WeChat.",
    "",
    "Attachments:",
    ...attachments.map((attachment, index) => {
      const suffix = attachment.fileName ? ` (original name: ${attachment.fileName})` : "";
      return `${index + 1}. [${attachment.kind}] ${attachment.localPath}${suffix}`;
    }),
  ];
  if (basePrompt.trim().length > 0) {
    sections.push("", "Accompanying message:", basePrompt);
  }
  return sections.join("\n");
}

function buildMessageKey(message: NonNullable<GetUpdatesResponse["msgs"]>[number]): string {
  return `dup-${String(message.message_id ?? "unknown")}`;
}

function isReplyContextExpiredError(error: unknown): boolean {
  return error instanceof Error && /ret=-2|reply context is no longer valid|refresh context_token/i.test(error.message);
}

function formatReplyContextQueuedReason(): string {
  return "Delivery was queued because WeChat rejected the stored reply context (ret=-2). It will retry automatically after this same chat sends any fresh inbound WeChat message or command, which refreshes the context_token.";
}

function isUnsupportedQuotaResponseError(error: unknown): boolean {
  return error instanceof Error
    && /unknown .*plan|plan_?type|plan variant|unsupported .*quota|rate.?limits?.*(decode|parse|variant)|prolite/i.test(error.message);
}

function isAutoReapedStaleTaskInterruption(error: unknown): boolean {
  return error instanceof CodexTurnInterruptedError && error.message.startsWith(STALE_TASK_INTERRUPTED_PREFIX);
}

export class BridgeService {
  private readonly loginManager: LoginManager;
  private readonly execCodexRunner: ExecCodexRunner;
  private readonly appServerCodexRunner: AppServerCodexRunner;
  private readonly startedAt = new Date().toISOString();
  private readonly activeTasks = new Map<string, ActiveTaskState>();
  private readonly processingPendingIds = new Set<number>();
  private readonly processingConversationKeys = new Set<string>();
  private readonly recoveryReviewPendingAccounts = new Set<string>();

  public constructor(private readonly config: BridgeConfig, private readonly stateStore: StateStore) {
    this.loginManager = new LoginManager(config);
    this.execCodexRunner = new ExecCodexRunner({
      command: config.codexCommand,
      model: config.codexModel,
      skipGitRepoCheck: config.skipGitRepoCheck,
    });
    const appServerTransport = new WebSocketAppServerTransport({
      url: config.appServerListenUrl,
    });
    const appServerClient = new AppServerClient({
      transport: appServerTransport,
      clientInfo: { name: "codex-wechat-plugin", version: config.packageVersion },
      onNotification: (message) => {
        if (message.method === "account/rateLimits/updated" && message.params?.rateLimits) {
          this.stateStore.saveRuntimeState("codex_rate_limits", message.params.rateLimits);
        }
      },
    });
    const appServerProcessManager = new AppServerProcessManager({
      command: config.codexCommand,
      listenUrl: config.appServerListenUrl,
      cwd: config.workspaceDir,
      startupTimeoutMs: config.appServerStartupTimeoutMs,
    });
    this.appServerCodexRunner = new AppServerCodexRunner({
      processManager: appServerProcessManager,
      client: appServerClient,
      turnTimeoutMs: config.appServerTurnTimeoutMs,
    });
    const shouldReviewRecoveryBacklog = this.shouldReviewRecoveryBacklog();
    const existingAccounts = typeof (this.stateStore as Partial<StateStore>).listAccounts === "function"
      ? this.stateStore.listAccounts()
      : [];
    for (const account of existingAccounts) {
      if (shouldReviewRecoveryBacklog && account.loginState === "active" && account.token) {
        this.recoveryReviewPendingAccounts.add(account.accountId);
      }
    }
  }

  async login(accountId?: string): Promise<{ sessionKey: string; qrcodeUrl: string; message: string }> {
    return this.loginManager.startLogin(accountId);
  }

  async getLoginStatus(sessionKey: string): Promise<Record<string, unknown>> {
    const result = await this.loginManager.getLoginStatus(sessionKey);
    if (result.connected) {
      this.stateStore.upsertAccount({
        accountId: result.accountId,
        token: result.botToken,
        baseUrl: result.baseUrl,
        linkedUserId: result.linkedUserId,
        loginState: "active",
      });
      this.stateStore.recordDiagnostic({
        code: "login_confirmed",
        accountId: result.accountId,
        detail: `Linked user: ${result.linkedUserId ?? "unknown"}`,
      });
    }
    return result;
  }

  getAccountState(): ReturnType<StateStore["listAccounts"]> {
    return this.stateStore.listAccounts();
  }

  getRuntimeInfo(): {
    workspaceDir: string;
    stateDir: string;
    databasePath: string;
    installedPluginRoot: string;
    readingInstalledRuntime: boolean;
  } {
    const installedPluginRoot = getInstalledPluginRoot();
    return {
      workspaceDir: this.config.workspaceDir,
      stateDir: this.config.stateDir,
      databasePath: this.config.databasePath,
      installedPluginRoot,
      readingInstalledRuntime: isSamePath(this.config.workspaceDir, installedPluginRoot)
        || isSamePath(this.config.stateDir, path.join(installedPluginRoot, "state")),
    };
  }

  listConversations(): ReturnType<StateStore["listConversations"]> {
    return this.stateStore.listConversations();
  }

  peekPendingMessages(statuses?: PendingMessageRecord["status"][]): PendingMessageRecord[] {
    return this.stateStore.listPendingMessages(statuses);
  }

  getDiagnostics(limit?: number) {
    return this.stateStore.listDiagnostics(limit);
  }

  async sendTextMessage(input: { accountId: string; peerUserId: string; text: string; contextToken?: string }): Promise<{ messageId: string; status?: "queued" | "sent"; queuedReason?: string | undefined }> {
    const account = this.requireAccount(input.accountId);
    const client = this.createAccountClient(account.accountId);
    const contextToken = input.contextToken ?? this.stateStore.getContextToken(account.accountId, input.peerUserId);
    if (!contextToken) {
      throw new Error(`No context token found for ${account.accountId} -> ${input.peerUserId}`);
    }
    try {
      const result = await client.sendTextMessage({
        peerUserId: input.peerUserId,
        contextToken,
        text: input.text,
      });
      this.stateStore.recordDeliveryAttempt({
        conversationKey: `${input.accountId}:${input.peerUserId}`,
        status: "manual_sent",
        peerUserId: input.peerUserId,
        contextToken,
        prompt: input.text,
        finalMessage: input.text,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isReplyContextExpiredError(error)) {
        const queuedId = this.stateStore.enqueueOutboundDelivery({
          conversationKey: `${input.accountId}:${input.peerUserId}`,
          accountId: input.accountId,
          peerUserId: input.peerUserId,
          contextToken,
          kind: "text",
          payload: {
            text: input.text,
          },
          status: "waiting_for_fresh_context",
          errorMessage: message,
        });
        this.stateStore.recordDeliveryAttempt({
          conversationKey: `${input.accountId}:${input.peerUserId}`,
          status: "manual_queued",
          errorMessage: message,
          peerUserId: input.peerUserId,
          contextToken,
          prompt: input.text,
          finalMessage: input.text,
        });
        this.stateStore.recordDiagnostic({
          code: "manual_send_queued",
          accountId: input.accountId,
          detail: JSON.stringify({
            peerUserId: input.peerUserId,
            deliveryId: queuedId,
            error: message,
          }),
        });
        return { messageId: `queued:${queuedId}`, status: "queued", queuedReason: formatReplyContextQueuedReason() };
      }
      this.stateStore.recordDeliveryAttempt({
        conversationKey: `${input.accountId}:${input.peerUserId}`,
        status: "manual_failed",
        errorMessage: message,
        peerUserId: input.peerUserId,
        contextToken,
        prompt: input.text,
        finalMessage: input.text,
      });
      this.stateStore.recordDiagnostic({
        code: "manual_send_failed",
        accountId: input.accountId,
        detail: JSON.stringify({
          peerUserId: input.peerUserId,
          error: message,
        }),
      });
      throw error;
    }
  }

  async sendFileMessage(input: {
    accountId: string;
    peerUserId: string;
    filePath: string;
    contextToken?: string;
    captionText?: string;
  }): Promise<{ messageId: string; kind: "image" | "file"; status?: "queued" | "sent"; queuedReason?: string | undefined }> {
    const account = this.requireAccount(input.accountId);
    const client = this.createAccountClient(account.accountId);
    const contextToken = input.contextToken ?? this.stateStore.getContextToken(account.accountId, input.peerUserId);
    if (!contextToken) {
      throw new Error(`No context token found for ${account.accountId} -> ${input.peerUserId}`);
    }
    try {
      const result = await this.sendLocalMediaFile({
        client,
        peerUserId: input.peerUserId,
        contextToken,
        filePath: input.filePath,
      });
      this.stateStore.recordDeliveryAttempt({
        conversationKey: `${input.accountId}:${input.peerUserId}`,
        status: "manual_media_sent",
        peerUserId: input.peerUserId,
        contextToken,
        prompt: input.filePath,
        finalMessage: input.filePath,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isReplyContextExpiredError(error)) {
        const queuedId = this.stateStore.enqueueOutboundDelivery({
          conversationKey: `${input.accountId}:${input.peerUserId}`,
          accountId: input.accountId,
          peerUserId: input.peerUserId,
          contextToken,
          kind: "file",
          payload: {
            filePath: input.filePath,
          },
          status: "waiting_for_fresh_context",
          errorMessage: message,
        });
        this.stateStore.recordDeliveryAttempt({
          conversationKey: `${input.accountId}:${input.peerUserId}`,
          status: "manual_media_queued",
          errorMessage: message,
          peerUserId: input.peerUserId,
          contextToken,
          prompt: input.filePath,
          finalMessage: input.filePath,
        });
        this.stateStore.recordDiagnostic({
          code: "manual_media_send_queued",
          accountId: input.accountId,
          detail: JSON.stringify({
            peerUserId: input.peerUserId,
            filePath: input.filePath,
            deliveryId: queuedId,
            error: message,
          }),
        });
        return { messageId: `queued:${queuedId}`, kind: "file", status: "queued", queuedReason: formatReplyContextQueuedReason() };
      }
      this.stateStore.recordDeliveryAttempt({
        conversationKey: `${input.accountId}:${input.peerUserId}`,
        status: "manual_media_failed",
        errorMessage: message,
        peerUserId: input.peerUserId,
        contextToken,
        prompt: input.filePath,
        finalMessage: input.filePath,
      });
      this.stateStore.recordDiagnostic({
        code: "manual_media_send_failed",
        accountId: input.accountId,
        detail: JSON.stringify({
          peerUserId: input.peerUserId,
          filePath: input.filePath,
          error: message,
        }),
      });
      throw error;
    }
  }

  async setTypingState(input: { accountId: string; peerUserId: string; state: "start" | "stop"; typingTicket?: string }): Promise<{ status: string }> {
    const account = this.requireAccount(input.accountId);
    const client = this.createAccountClient(account.accountId);
    const typingTicket = input.typingTicket ?? await client.getTypingTicket({
      peerUserId: input.peerUserId,
      contextToken: this.stateStore.getContextToken(account.accountId, input.peerUserId),
    });
    if (!typingTicket) {
      throw new Error(`No typing ticket available for ${input.peerUserId}`);
    }
    if (input.state === "start") {
      await client.setTyping({ peerUserId: input.peerUserId, typingTicket });
    } else {
      await client.stopTyping({ peerUserId: input.peerUserId, typingTicket });
    }
    return { status: input.state };
  }

  async retryDelivery(pendingMessageId: number): Promise<{ pendingMessageId: number; status: string }> {
    const pending = this.stateStore.getPendingMessage(pendingMessageId);
    if (!pending) {
      throw new Error(`Pending message ${pendingMessageId} not found.`);
    }
    await this.processPendingMessage(pending);
    const refreshed = this.stateStore.getPendingMessage(pendingMessageId);
    return {
      pendingMessageId,
      status: refreshed?.status ?? "missing",
    };
  }

  async pollAccount(accountId: string, abortSignal?: AbortSignal): Promise<{ status: string; processed: number }> {
    const account = this.requireAccount(accountId);
    const client = this.createAccountClient(account.accountId);
    const pollState = this.stateStore.getPollState(account.accountId);
    const response = await client.fetchUpdates({
      cursor: pollState?.cursor,
      timeoutMs: this.config.longPollTimeoutMs,
      signal: abortSignal,
    });

    if (response.errcode === SESSION_EXPIRED_ERROR || response.ret === SESSION_EXPIRED_ERROR) {
      this.stateStore.upsertAccount({
        accountId: account.accountId,
        token: account.token,
        baseUrl: account.baseUrl,
        linkedUserId: account.linkedUserId,
        loginState: "expired",
      });
      this.stateStore.recordDiagnostic({
        code: "session_expired",
        accountId: account.accountId,
        detail: response.errmsg,
      });
      return { status: "session_expired", processed: 0 };
    }

    if (response.get_updates_buf) {
      this.stateStore.savePollState({
        accountId: account.accountId,
        cursor: response.get_updates_buf,
        nextTimeoutMs: response.longpolling_timeout_ms,
      });
    }

    let processed = 0;
    for (const message of response.msgs ?? []) {
      if (message.group_id) {
        continue;
      }
      const peerUserId = message.from_user_id;
      if (!peerUserId) {
        continue;
      }
      this.stateStore.saveRuntimeState("last_raw_inbound_message", {
        accountId: account.accountId,
        peerUserId,
        messageId: message.message_id ?? null,
        prompt: extractTextPrompt(message),
        receivedAt: new Date().toISOString(),
        rawMessage: message,
      });
      const isNew = this.stateStore.recordInboundMessage({
        accountId: account.accountId,
        peerUserId,
        messageKey: buildMessageKey(message),
      });
      if (!isNew) {
        continue;
      }
      if (message.context_token) {
        this.stateStore.saveContextToken({
          accountId: account.accountId,
          peerUserId,
          contextToken: message.context_token,
        });
      }
      const conversation = this.stateStore.resolveConversation({
        accountId: account.accountId,
        peerUserId,
      });
      await this.replayDeferredOutboundDeliveries({
        accountId: account.accountId,
        conversation,
        contextToken: message.context_token ?? this.stateStore.getContextToken(account.accountId, peerUserId),
      });
      const attachments = await this.downloadInboundAttachmentsIfPresent({
        accountId: account.accountId,
        peerUserId,
        message,
      });
      const prompt = buildInboundPromptWithAttachments(buildInboundPrompt(message), attachments);
      const commandText = extractTextPrompt(message);
      const parsedCommand = parseWechatControlCommand(commandText);
      const needsLiveSessionView = parsedCommand !== undefined && ["pwd", "cwd", "session", "status", "ls", "sessions"].includes(parsedCommand.name);
      const availableSessions = parsedCommand?.name === "sessions" || needsLiveSessionView
        ? await this.appServerCodexRunner.listThreads({ limit: 50 })
        : undefined;
      const currentSession = needsLiveSessionView
        ? await this.resolveCurrentSessionSummary(conversation, availableSessions)
        : undefined;
      const availableModels = parsedCommand?.name === "model" || parsedCommand?.name === "effort"
        ? await this.safeListModels(account.accountId)
        : undefined;
      const commandResult = handleWechatControlCommand({
        text: prompt,
        stateStore: this.stateStore,
        conversation,
        workspaceDir: this.config.workspaceDir,
        primaryBackend: this.config.codexBackend,
        defaultModel: this.config.codexModel,
        defaultReasoningEffort: this.config.codexReasoningEffort,
        activeTask: this.getActiveTaskSummary(conversation.conversationKey),
        pendingReview: this.getPendingReviewSummary(conversation.conversationKey),
        installedSkills: listInstalledSkills(),
        ...(currentSession ? { currentSession } : {}),
        ...(availableSessions ? { availableSessions } : {}),
        ...(availableModels ? { availableModels } : {}),
      });
      if (commandResult.handled) {
        const actionResponse = await this.executeCommandAction({
          conversation,
          result: commandResult,
          accountId: account.accountId,
        });
        const contextToken = message.context_token ?? this.stateStore.getContextToken(account.accountId, peerUserId);
        if (!contextToken) {
          this.stateStore.recordDiagnostic({
            code: "command_reply_missing_context_token",
            accountId: account.accountId,
            detail: JSON.stringify({ conversationKey: conversation.conversationKey, prompt: commandText }),
          });
          continue;
        }
        await client.sendTextMessage({
          peerUserId,
          contextToken,
          text: actionResponse ?? commandResult.responseText ?? "Command handled.",
        });
        this.stateStore.recordDeliveryAttempt({
          conversationKey: conversation.conversationKey,
          status: "command_sent",
          peerUserId,
          contextToken,
          prompt: commandText,
          finalMessage: actionResponse ?? commandResult.responseText,
        });
        if (commandResult.action?.type === "restart_bridge") {
          throw new BridgeRestartRequestedError("Bridge restart requested from WeChat control command.");
        }
        processed += 1;
        continue;
      }
      const deliveryIntent = parseDeliveryIntent(commandText);
      const promptWithDeliveryGuidance = deliveryIntent.enabled
        ? appendDeliverySkillPrompt(prompt, deliveryIntent)
        : prompt;
      const pendingMessageId = this.stateStore.enqueuePendingMessage({
        conversationKey: conversation.conversationKey,
        accountId: account.accountId,
        peerUserId,
        contextToken: message.context_token,
        prompt: promptWithDeliveryGuidance,
        thread: conversation.runnerBackend && conversation.runnerThreadId
          ? {
              runnerBackend: conversation.runnerBackend,
              runnerThreadId: conversation.runnerThreadId,
              runnerCwd: conversation.runnerCwd,
            }
          : undefined,
      });
      if (deliveryIntent.enabled) {
        this.stateStore.saveRuntimeState(this.pendingDeliveryIntentKey(pendingMessageId), deliveryIntent);
      }
      const pendingRow = this.stateStore.getPendingMessage(pendingMessageId)!;
      if (this.recoveryReviewPendingAccounts.has(account.accountId) || this.getPendingReviewState(conversation.conversationKey)?.count) {
        this.addPendingReviewItem(conversation.conversationKey, pendingRow.prompt);
      } else {
        this.maybeStartPendingMessage(pendingRow);
      }
      processed += 1;
    }

    this.recoveryReviewPendingAccounts.delete(account.accountId);
    await this.deliverPendingReviewSummaries(account.accountId, client);
    await this.deliverPendingLifecycleNotification(account.accountId, client);

    return { status: "ok", processed };
  }

  protected async downloadInboundAttachmentsIfPresent(input: {
    accountId: string;
    peerUserId: string;
    message: NonNullable<GetUpdatesResponse["msgs"]>[number];
  }): Promise<InboundAttachmentDownload[]> {
    if (!input.message.message_id) {
      return [];
    }
    return await downloadInboundAttachments({
      rootDir: this.config.attachmentCacheDir ?? path.join(this.config.workspaceDir, ".cache", "wechat-bridge", "inbound-attachments"),
      accountId: input.accountId,
      peerUserId: input.peerUserId,
      messageId: String(input.message.message_id),
      itemList: input.message.item_list,
    });
  }

  protected async sendLocalMediaFile(input: {
    client: Pick<HttpWeixinClient, "getUploadUrl" | "sendFileMessage" | "sendImageMessage">;
    peerUserId: string;
    contextToken: string;
    filePath: string;
  }): Promise<{ messageId: string; kind: "image" | "file" }> {
    return await sendLocalMediaFile(input);
  }

  async runDaemonLoop(abortSignal?: AbortSignal): Promise<void> {
    while (!abortSignal?.aborted) {
      const accounts = this.stateStore.listAccounts().filter((account) => account.loginState === "active" && account.token);
      this.stateStore.saveRuntimeState("daemon_status", {
        pid: process.pid,
        workspaceDir: this.config.workspaceDir,
        backend: this.config.codexBackend,
        startedAt: this.startedAt,
        heartbeatAt: new Date().toISOString(),
        activeAccounts: accounts.length,
      });

      this.reapStaleActiveTasks();

      for (const pending of this.stateStore.listPendingMessages(["pending"]).sort((left, right) => left.id - right.id)) {
        this.maybeStartPendingMessage(pending);
      }

      if (accounts.length === 0) {
        await sleep(this.config.loopIdleDelayMs, abortSignal);
        continue;
      }

      for (const account of accounts) {
        try {
          const pollAbortController = new AbortController();
          await withTimeout(
            this.pollAccount(account.accountId, pollAbortController.signal),
            Math.max(60_000, this.config.longPollTimeoutMs + 15_000),
            () => {
              pollAbortController.abort();
            },
          );
        } catch (error) {
          if (error instanceof BridgeRestartRequestedError) {
            throw error;
          }
          this.stateStore.recordDiagnostic({
            code: "poll_error",
            accountId: account.accountId,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await sleep(10, abortSignal);
    }
  }

  async notifyLifecycle(input: { phase: "online" | "offline"; detail?: string | undefined }): Promise<void> {
    const conversations = this.stateStore
      .listConversations()
      .slice(0, LIFECYCLE_NOTIFICATION_LIMIT);
    let sent = 0;
    let failed = 0;

    for (const conversation of conversations) {
      const contextToken = this.stateStore.getContextToken(conversation.accountId, conversation.peerUserId);
      if (!contextToken) {
        continue;
      }
      const account = this.stateStore.getAccount(conversation.accountId);
      if (!account?.token || account.loginState !== "active") {
        continue;
      }
      try {
        const client = this.createAccountClient(conversation.accountId);
        await client.sendTextMessage({
          peerUserId: conversation.peerUserId,
          contextToken,
          text: this.formatLifecycleMessage(input),
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        this.stateStore.recordDiagnostic({
          code: "lifecycle_notification_failed",
          accountId: conversation.accountId,
          detail: JSON.stringify({
            conversationKey: conversation.conversationKey,
            phase: input.phase,
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    }

    if (input.phase === "online") {
      if (sent > 0) {
        this.clearPendingLifecycleNotification();
      } else if (failed > 0) {
        this.savePendingLifecycleNotification(input);
      }
    }
  }

  private maybeStartPendingMessage(pending: PendingMessageRecord): void {
    if (pending.status !== "pending") {
      return;
    }
    const existingStartedAtMs = this.getPendingProcessingStartedAtMs(pending.id);
    if (existingStartedAtMs !== undefined && Date.now() - existingStartedAtMs >= ACTIVE_TASK_REAP_AFTER_EXTENDED_IDLE_MS) {
      const errorMessage = `${STALE_TASK_INTERRUPTED_PREFIX} after extended idle timeout.`;
      this.clearPendingDeliveryIntent(pending.id);
      this.clearPendingProcessingStartedAt(pending.id);
      this.stateStore.markPendingMessageStatus(pending.id, {
        status: "interrupted" as PendingMessageRecord["status"],
        thread: pending.runnerBackend && pending.runnerThreadId
          ? {
              runnerBackend: pending.runnerBackend,
              runnerThreadId: pending.runnerThreadId,
              runnerCwd: pending.runnerCwd,
            }
          : pending.threadId,
        errorMessage,
      });
      this.stateStore.recordDiagnostic({
        code: "pending_message_reaped",
        accountId: pending.accountId,
        detail: JSON.stringify({
          conversationKey: pending.conversationKey,
          pendingMessageId: pending.id,
          startedAtMs: existingStartedAtMs,
          reason: "extended_idle_timeout_after_restart",
        }),
      });
      void this.notifyReapedPendingMessage(pending, errorMessage);
      return;
    }
    if ((this.getPendingReviewState(pending.conversationKey)?.count ?? 0) > 0) {
      return;
    }
    if (
      this.processingPendingIds.has(pending.id)
      || this.processingConversationKeys.has(pending.conversationKey)
      || this.activeTasks.has(pending.conversationKey)
    ) {
      return;
    }
    if (existingStartedAtMs === undefined) {
      this.savePendingProcessingStartedAt(pending.id);
    }
    this.processingPendingIds.add(pending.id);
    this.processingConversationKeys.add(pending.conversationKey);
    this.stateStore.recordDiagnostic({
      code: "pending_message_started",
      accountId: pending.accountId,
      detail: JSON.stringify({
        conversationKey: pending.conversationKey,
        pendingMessageId: pending.id,
      }),
    });
    void this.processPendingMessage(pending)
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.stateStore.recordDiagnostic({
          code: "background_task_error",
          accountId: pending.accountId,
          detail: errorMessage,
        });
        this.clearPendingDeliveryIntent(pending.id);
        this.stateStore.markPendingMessageStatus(pending.id, {
          status: "failed",
          thread: pending.runnerBackend && pending.runnerThreadId
            ? {
                runnerBackend: pending.runnerBackend,
                runnerThreadId: pending.runnerThreadId,
                runnerCwd: pending.runnerCwd,
              }
            : pending.threadId,
          errorMessage,
        });
      })
      .finally(() => {
        this.clearPendingProcessingStartedAt(pending.id);
        this.processingPendingIds.delete(pending.id);
        this.processingConversationKeys.delete(pending.conversationKey);
        this.activeTasks.delete(pending.conversationKey);
        this.startNextPendingMessageForConversation(pending.conversationKey);
      });
  }

  private startNextPendingMessageForConversation(conversationKey: string): void {
    if (this.activeTasks.has(conversationKey)) {
      return;
    }
    const next = this.stateStore
      .listPendingMessages(["pending"])
      .filter((row) => row.conversationKey === conversationKey)
      .sort((left, right) => left.id - right.id)[0];
    if (next) {
      this.maybeStartPendingMessage(next);
    }
  }

  private reapStaleActiveTasks(nowMs = Date.now()): void {
    const pending = this.stateStore.listPendingMessages(["pending"]);
    for (const [conversationKey, activeTask] of this.activeTasks) {
      if (!activeTask.idleNotifiedAtMs || activeTask.abortController.signal.aborted) {
        continue;
      }
      const queuedBehindActiveTask = pending.some((row) => row.conversationKey === conversationKey && row.id !== activeTask.pendingMessageId);
      const idleAfterNoticeMs = nowMs - activeTask.idleNotifiedAtMs;
      const shouldReapForQueuedWork = queuedBehindActiveTask && idleAfterNoticeMs >= ACTIVE_TASK_REAP_AFTER_IDLE_MS;
      const shouldReapForExtendedIdle = idleAfterNoticeMs >= ACTIVE_TASK_REAP_AFTER_EXTENDED_IDLE_MS;
      if (!shouldReapForQueuedWork && !shouldReapForExtendedIdle) {
        continue;
      }
      const reason = shouldReapForExtendedIdle
        ? `${STALE_TASK_INTERRUPTED_PREFIX} after extended idle timeout.`
        : `${STALE_TASK_INTERRUPTED_PREFIX} after idle timeout because newer WeChat messages are waiting.`;
      activeTask.abortController.abort(new CodexTurnInterruptedError(reason));
      this.stateStore.recordDiagnostic({
        code: "active_task_reaped",
        detail: JSON.stringify({
          conversationKey,
          pendingMessageId: activeTask.pendingMessageId,
          idleNotifiedAtMs: activeTask.idleNotifiedAtMs,
          reason: shouldReapForExtendedIdle ? "extended_idle_timeout" : "queued_work_after_idle_timeout",
          queuedPendingMessages: pending.filter((row) => row.conversationKey === conversationKey && row.id !== activeTask.pendingMessageId).length,
        }),
      });
    }
  }

  private async processPendingMessage(pending: PendingMessageRecord): Promise<void> {
    const client = this.createAccountClient(pending.accountId);
    const runtimePreferences = this.getRuntimePreferences();
    const deliveryIntent = this.getPendingDeliveryIntent(pending.id);
    const effectiveContextToken = this.stateStore.getContextToken(pending.accountId, pending.peerUserId) ?? pending.contextToken;
    let currentAbortController = new AbortController();
    let typingTicket: string | undefined;

    const setActiveTask = (overrides?: Partial<ActiveTaskState>): void => {
      const current = this.activeTasks.get(pending.conversationKey);
      const nowMs = Date.now();
      this.activeTasks.set(pending.conversationKey, {
        pendingMessageId: pending.id,
        conversationKey: pending.conversationKey,
        prompt: pending.prompt,
        abortController: overrides?.abortController ?? current?.abortController ?? currentAbortController,
        supportsAppend: overrides?.supportsAppend ?? current?.supportsAppend ?? false,
        ...(overrides?.runnerBackend ? { runnerBackend: overrides.runnerBackend } : current?.runnerBackend ? { runnerBackend: current.runnerBackend } : {}),
        ...(overrides?.threadId ? { threadId: overrides.threadId } : current?.threadId ? { threadId: current.threadId } : {}),
        ...(overrides?.turnId ? { turnId: overrides.turnId } : current?.turnId ? { turnId: current.turnId } : {}),
        ...(overrides?.fallbackEligible !== undefined ? { fallbackEligible: overrides.fallbackEligible } : current?.fallbackEligible !== undefined ? { fallbackEligible: current.fallbackEligible } : {}),
        ...(overrides?.fallbackRequestedBackend ? { fallbackRequestedBackend: overrides.fallbackRequestedBackend } : current?.fallbackRequestedBackend ? { fallbackRequestedBackend: current.fallbackRequestedBackend } : {}),
        ...(overrides?.control ? { control: overrides.control } : current?.control ? { control: current.control } : {}),
        startedAtMs: overrides?.startedAtMs ?? current?.startedAtMs ?? nowMs,
        lastActivityAtMs: overrides?.lastActivityAtMs ?? current?.lastActivityAtMs ?? nowMs,
        ...(overrides?.idleNotifiedAtMs !== undefined ? { idleNotifiedAtMs: overrides.idleNotifiedAtMs } : current?.idleNotifiedAtMs !== undefined ? { idleNotifiedAtMs: current.idleNotifiedAtMs } : {}),
      });
    };

    const finalizeSuccess = (result: {
      runnerBackend: RunnerBackend;
      threadId: string;
      cwd: string;
      timings: Record<string, unknown>;
    }): void => {
      this.stateStore.updateConversationThread(pending.conversationKey, {
        runnerBackend: result.runnerBackend,
        runnerThreadId: result.threadId,
        runnerCwd: result.cwd,
      });
      this.clearPendingNewSessionName(pending.conversationKey);
      this.stateStore.markPendingMessageStatus(pending.id, {
        status: "sent",
        thread: {
          runnerBackend: result.runnerBackend,
          runnerThreadId: result.threadId,
          runnerCwd: result.cwd,
        },
      });
      this.stateStore.recordDiagnostic({
        code: "reply_timing",
        accountId: pending.accountId,
        detail: JSON.stringify({
          conversationKey: pending.conversationKey,
          runnerBackend: result.runnerBackend,
          ...result.timings,
        }),
      });
    };

    const sendIdleTimeoutNotice = async (timeoutMs: number): Promise<void> => {
      const current = this.activeTasks.get(pending.conversationKey);
      if (!current || current.fallbackEligible) {
        return;
      }
      setActiveTask({
        fallbackEligible: true,
        idleNotifiedAtMs: Date.now(),
      });
      this.stateStore.recordDiagnostic({
        code: "reply_idle_timeout",
        accountId: pending.accountId,
        detail: JSON.stringify({
          conversationKey: pending.conversationKey,
          timeoutMs,
          runnerBackend: "app_server",
        }),
      });
      try {
        await client.sendTextMessage({
          peerUserId: pending.peerUserId,
          contextToken: effectiveContextToken ?? "",
          text: this.formatIdleTimeoutMessage(timeoutMs),
        });
        this.stateStore.recordDeliveryAttempt({
          conversationKey: pending.conversationKey,
          status: "timeout_notice_sent",
          finalMessage: this.formatIdleTimeoutMessage(timeoutMs),
        });
      } catch (error) {
        this.stateStore.recordDiagnostic({
          code: "reply_idle_timeout_notice_failed",
          accountId: pending.accountId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const runWithRunner = async (codexRunner: CodexRunner, typingTicket?: string) => {
      const orchestrator = createReplyOrchestrator({
        stateStore: this.stateStore,
        codexRunner,
        weixinClient: client,
      });
      return await orchestrator.handleInboundMessage({
        conversationKey: pending.conversationKey,
        threadId: pending.threadId,
        accountId: pending.accountId,
        peerUserId: pending.peerUserId,
        contextToken: effectiveContextToken ?? "",
        prompt: pending.prompt,
        threadName: this.getPendingNewSessionName(pending.conversationKey) ?? undefined,
        typingTicket,
        model: runtimePreferences.model,
        reasoningEffort: runtimePreferences.reasoningEffort,
        showFinalSummary: runtimePreferences.showFinalSummary,
        deliveryIntent,
        signal: currentAbortController.signal,
        onIdleTimeout: async ({ timeoutMs }) => {
          await sendIdleTimeoutNotice(timeoutMs);
        },
        onTurnStarted: (control) => {
          setActiveTask({
            runnerBackend: control.runnerBackend,
            threadId: control.threadId,
            turnId: control.turnId,
            supportsAppend: control.supportsAppend,
            control,
            lastActivityAtMs: Date.now(),
          });
        },
      });
    };

    try {
      typingTicket = await client.getTypingTicket({
        peerUserId: pending.peerUserId,
        contextToken: effectiveContextToken,
      });
      setActiveTask({
        abortController: currentAbortController,
        supportsAppend: false,
        fallbackEligible: false,
      });
      const result = await runWithRunner(this.createCodexRunnerForPending(pending), typingTicket);
      finalizeSuccess(result);
      this.clearPendingDeliveryIntent(pending.id);
    } catch (error) {
      let resolvedError = error;
      if (resolvedError instanceof CodexTurnFallbackRequestedError && resolvedError.targetBackend === "exec") {
        try {
          typingTicket = await client.getTypingTicket({
            peerUserId: pending.peerUserId,
            contextToken: effectiveContextToken,
          });
        } catch {
          typingTicket = undefined;
        }
        currentAbortController = new AbortController();
        setActiveTask({
          abortController: currentAbortController,
          supportsAppend: false,
          fallbackEligible: false,
        });
        this.stateStore.recordDiagnostic({
          code: "reply_exec_fallback_requested",
          accountId: pending.accountId,
          detail: JSON.stringify({
            conversationKey: pending.conversationKey,
            threadId: pending.threadId ?? null,
          }),
        });
        try {
          const result = await runWithRunner(this.execCodexRunner, typingTicket);
          finalizeSuccess(result);
          this.clearPendingDeliveryIntent(pending.id);
          return;
        } catch (fallbackError) {
          resolvedError = fallbackError;
        }
      }
      if (resolvedError instanceof CodexTurnInterruptedError) {
        this.clearPendingDeliveryIntent(pending.id);
        this.stateStore.markPendingMessageStatus(pending.id, {
          status: "interrupted" as PendingMessageRecord["status"],
          thread: pending.runnerBackend && pending.runnerThreadId
            ? {
                runnerBackend: pending.runnerBackend,
                runnerThreadId: pending.runnerThreadId,
                runnerCwd: pending.runnerCwd,
              }
            : pending.threadId,
          errorMessage: resolvedError.message,
        });
        this.stateStore.recordDiagnostic({
          code: "reply_interrupted",
          accountId: pending.accountId,
          detail: JSON.stringify({
            conversationKey: pending.conversationKey,
            error: resolvedError.message,
          }),
        });
        this.stateStore.recordDeliveryAttempt({
          conversationKey: pending.conversationKey,
          status: "interrupted",
          errorMessage: resolvedError.message,
        });
        if (isAutoReapedStaleTaskInterruption(resolvedError)) {
          await this.notifyPendingFailure({
            client,
            pending,
            contextToken: effectiveContextToken,
            errorMessage: resolvedError.message,
          });
        }
        return;
      }
      this.clearPendingDeliveryIntent(pending.id);
      this.stateStore.markPendingMessageStatus(pending.id, {
        status: "failed",
        thread: pending.runnerBackend && pending.runnerThreadId
          ? {
              runnerBackend: pending.runnerBackend,
              runnerThreadId: pending.runnerThreadId,
              runnerCwd: pending.runnerCwd,
            }
          : pending.threadId,
        errorMessage: resolvedError instanceof Error ? resolvedError.message : String(resolvedError),
      });
      this.stateStore.recordDiagnostic({
        code: "reply_failed",
        accountId: pending.accountId,
        detail: resolvedError instanceof Error ? resolvedError.message : String(resolvedError),
      });
      await this.notifyPendingFailure({
        client,
        pending,
        contextToken: effectiveContextToken,
        errorMessage: resolvedError instanceof Error ? resolvedError.message : String(resolvedError),
      });
    }
  }

  private async notifyPendingFailure(input: {
    client: HttpWeixinClient;
    pending: PendingMessageRecord;
    contextToken?: string | undefined;
    errorMessage: string;
  }): Promise<void> {
    if (!input.contextToken) {
      this.stateStore.recordDiagnostic({
        code: "reply_failure_notice_missing_context",
        accountId: input.pending.accountId,
        detail: JSON.stringify({
          conversationKey: input.pending.conversationKey,
          pendingMessageId: input.pending.id,
          error: input.errorMessage,
        }),
      });
      return;
    }
    const text = this.formatPendingFailureMessage(input.pending, input.errorMessage);
    try {
      await input.client.sendTextMessage({
        peerUserId: input.pending.peerUserId,
        contextToken: input.contextToken,
        text,
      });
      this.stateStore.recordDeliveryAttempt({
        conversationKey: input.pending.conversationKey,
        status: "failure_notice_sent",
        peerUserId: input.pending.peerUserId,
        contextToken: input.contextToken,
        prompt: input.pending.prompt,
        finalMessage: text,
      });
      this.stateStore.recordDiagnostic({
        code: "reply_failure_notified",
        accountId: input.pending.accountId,
        detail: JSON.stringify({
          conversationKey: input.pending.conversationKey,
          pendingMessageId: input.pending.id,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isReplyContextExpiredError(error)) {
        const queuedId = this.stateStore.enqueueOutboundDelivery({
          conversationKey: input.pending.conversationKey,
          accountId: input.pending.accountId,
          peerUserId: input.pending.peerUserId,
          contextToken: input.contextToken,
          kind: "text",
          payload: {
            text,
          },
          status: "waiting_for_fresh_context",
          errorMessage: message,
        });
        this.stateStore.recordDeliveryAttempt({
          conversationKey: input.pending.conversationKey,
          status: "failure_notice_queued",
          errorMessage: message,
          peerUserId: input.pending.peerUserId,
          contextToken: input.contextToken,
          prompt: input.pending.prompt,
          finalMessage: text,
        });
        this.stateStore.recordDiagnostic({
          code: "reply_failure_notice_queued",
          accountId: input.pending.accountId,
          detail: JSON.stringify({
            conversationKey: input.pending.conversationKey,
            pendingMessageId: input.pending.id,
            deliveryId: queuedId,
            error: message,
          }),
        });
        return;
      }
      this.stateStore.recordDiagnostic({
        code: "reply_failure_notice_failed",
        accountId: input.pending.accountId,
        detail: JSON.stringify({
          conversationKey: input.pending.conversationKey,
          pendingMessageId: input.pending.id,
          error: message,
        }),
      });
    }
  }

  private async notifyReapedPendingMessage(pending: PendingMessageRecord, errorMessage: string): Promise<void> {
    try {
      const client = this.createAccountClient(pending.accountId);
      const contextToken = this.stateStore.getContextToken(pending.accountId, pending.peerUserId) ?? pending.contextToken;
      await this.notifyPendingFailure({
        client,
        pending,
        contextToken,
        errorMessage,
      });
    } catch (error) {
      this.stateStore.recordDiagnostic({
        code: "pending_reap_notice_failed",
        accountId: pending.accountId,
        detail: JSON.stringify({
          conversationKey: pending.conversationKey,
          pendingMessageId: pending.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }

  private getActiveTaskSummary(conversationKey: string): {
    prompt: string;
    runnerBackend?: RunnerBackend | undefined;
    supportsAppend?: boolean | undefined;
  } | undefined {
    const task = this.activeTasks.get(conversationKey);
    if (!task) {
      return undefined;
    }
    return {
      prompt: task.prompt,
      runnerBackend: task.runnerBackend,
      supportsAppend: task.supportsAppend,
    };
  }

  private formatPendingFailureMessage(pending: PendingMessageRecord, errorMessage: string): string {
    return [
      "Codex 任务未能在发送回复前完成。",
      `Pending message id: ${pending.id}`,
      `原因: ${shortenMiddle(errorMessage, 240)}`,
      "这条消息已标记为失败或中断。请直接重新发送任务；如果状态仍异常，可先发送 /status 或 /restart。",
    ].join("\n");
  }

  private formatIdleTimeoutMessage(timeoutMs: number): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    return [
      `⚠️ 当前任务已连续 ${timeoutMinutes} 分钟没有新的输出。`,
      "默认策略是不切换 fallback，当前仍在继续等待。",
      "如果你怀疑任务已经卡死，请发送 /stop 终止当前任务。",
    ].join("\n");
  }

  private async executeCommandAction(input: {
    conversation: ConversationRecord;
    result: { action?: { type: "stop" } | { type: "restart_bridge" } | { type: "fallback_continue" } | { type: "append"; guidance: string } | { type: "use_session"; threadId: string; afterSwitch?: "remember_non_test" | "clear_test_return" } | { type: "quota_read" } | { type: "pending_continue" } | { type: "pending_clear" } | undefined; responseText?: string | undefined };
    accountId: string;
  }): Promise<string | undefined> {
    if (!input.result.action) {
      return undefined;
    }
    if (input.result.action.type === "restart_bridge") {
      return input.result.responseText;
    }
    if (input.result.action.type === "quota_read") {
      return await this.readQuotaForChat(input.accountId);
    }
    if (input.result.action.type === "pending_continue") {
      this.clearPendingReview(input.conversation.conversationKey);
      this.startNextPendingMessageForConversation(input.conversation.conversationKey);
      return input.result.responseText;
    }
    if (input.result.action.type === "pending_clear") {
      const pending = this.stateStore
        .listPendingMessages(["pending"])
        .filter((row) => row.conversationKey === input.conversation.conversationKey);
      for (const row of pending) {
        this.stateStore.markPendingMessageStatus(row.id, {
          status: "failed",
          thread: row.runnerBackend && row.runnerThreadId
            ? {
                runnerBackend: row.runnerBackend,
                runnerThreadId: row.runnerThreadId,
                runnerCwd: row.runnerCwd,
              }
            : row.threadId,
          errorMessage: "Cleared by operator before processing.",
        });
      }
      this.clearPendingReview(input.conversation.conversationKey);
      return input.result.responseText;
    }
    if (input.result.action.type === "use_session") {
      if (this.config.codexBackend !== "app_server") {
        return "Session switching is only supported when the bridge primary backend is app_server.";
      }
      try {
        const thread = await this.appServerCodexRunner.resumeThread(input.result.action.threadId);
        const sessions = await this.appServerCodexRunner.listThreads({ limit: 50 });
        const sessionSummary = sessions.find((session) => session.id === thread.id);
        this.clearPendingNewSessionName(input.conversation.conversationKey);
        this.stateStore.updateConversationThread(input.conversation.conversationKey, {
          runnerBackend: "app_server",
          runnerThreadId: thread.id,
          runnerCwd: thread.cwd,
        });
        if (input.result.action.afterSwitch === "remember_non_test") {
          const previousThreadId = input.conversation.runnerThreadId ?? input.conversation.codexThreadId ?? undefined;
          if (previousThreadId && previousThreadId !== thread.id) {
            this.stateStore.saveRuntimeState(`${TEST_SESSION_RETURN_PREFIX}${input.conversation.conversationKey}`, previousThreadId);
          }
        }
        if (input.result.action.afterSwitch === "clear_test_return") {
          this.stateStore.saveRuntimeState(`${TEST_SESSION_RETURN_PREFIX}${input.conversation.conversationKey}`, null);
        }
        return [
          `⚙️ Switched this chat to session ${thread.id}.`,
          `session name: ${sessionSummary?.name?.trim() ? sessionSummary.name.trim() : "unknown"}`,
          `workspace: ${thread.cwd ?? "unknown"}`,
        ].join("\n");
      } catch (error) {
        this.stateStore.recordDiagnostic({
          code: "session_switch_failed",
          accountId: input.accountId,
          detail: JSON.stringify({
            conversationKey: input.conversation.conversationKey,
            threadId: input.result.action.threadId,
            error: error instanceof Error ? error.message : String(error),
          }),
        });
        return `Unable to switch to session ${input.result.action.threadId}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const task = this.activeTasks.get(input.conversation.conversationKey);
    if (!task) {
      return "No active task is currently running for this chat.";
    }
    try {
      if (input.result.action.type === "fallback_continue") {
        if (task.runnerBackend !== "app_server") {
          return "The current task is not running on app_server, so exec fallback is not available.";
        }
        if (!task.fallbackEligible) {
          return "The current task has not hit the idle-timeout fallback prompt yet. Keep waiting, or use /stop if you believe it is stuck.";
        }
        task.fallbackEligible = false;
        task.fallbackRequestedBackend = "exec";
        task.abortController.abort(new CodexTurnFallbackRequestedError("exec", "Switching the current task to exec fallback from WeChat control command."));
        await task.control?.interrupt?.();
        return "Switching the current task to exec fallback. The original app_server turn has been stopped.";
      }
      if (input.result.action.type === "stop") {
        task.abortController.abort(new CodexTurnInterruptedError("Interrupted from WeChat control command."));
        await task.control?.interrupt?.();
        return input.result.responseText;
      }
      if (!task.control) {
        return "The task is running, but control is not available yet. Try again in a moment.";
      }
      if (!task.control.append) {
        return `The current task is running on ${task.control.runnerBackend}, so /append is unavailable. Use /stop and send a new message instead.`;
      }
      await task.control.append(input.result.action.guidance);
      this.stateStore.recordDiagnostic({
        code: "reply_append",
        accountId: input.accountId,
        detail: JSON.stringify({
          conversationKey: input.conversation.conversationKey,
          guidance: input.result.action.guidance,
        }),
      });
      return input.result.responseText;
    } catch (error) {
      this.stateStore.recordDiagnostic({
        code: "command_action_failed",
        accountId: input.accountId,
        detail: JSON.stringify({
          conversationKey: input.conversation.conversationKey,
          action: input.result.action.type,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      return `Command failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private createAccountClient(accountId: string): HttpWeixinClient {
    const account = this.requireAccount(accountId);
    return new HttpWeixinClient({
      baseUrl: account.baseUrl,
      token: account.token,
      appId: this.config.ilinkAppId,
      clientVersion: this.config.clientVersion,
      packageVersion: this.config.packageVersion,
    });
  }

  private requireAccount(accountId: string) {
    const account = this.stateStore.getAccount(accountId);
    if (!account || !account.token) {
      throw new Error(`Account ${accountId} is not configured with a usable token.`);
    }
    return account;
  }

  private getRuntimePreferences(): RuntimePreferences {
    const value = this.stateStore.getRuntimeState(RUNTIME_PREFERENCES_KEY);
    if (!isObject(value)) {
      return {
        ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
        ...(this.config.codexReasoningEffort ? { reasoningEffort: this.config.codexReasoningEffort } : {}),
        showFinalSummary: true,
      };
    }
    return {
      model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : this.config.codexModel,
      reasoningEffort: isReasoningEffort(value.reasoningEffort) ? value.reasoningEffort : this.config.codexReasoningEffort,
      showFinalSummary: typeof value.showFinalSummary === "boolean" ? value.showFinalSummary : true,
    };
  }

  private async safeListModels(accountId: string) {
    try {
      return await this.appServerCodexRunner.listModels();
    } catch (error) {
      this.stateStore.recordDiagnostic({
        code: "model_catalog_unavailable",
        accountId,
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async resolveCurrentSessionSummary(
    conversation: ConversationRecord,
    availableSessions?: AppServerThreadSummary[] | undefined,
  ): Promise<AppServerThreadSummary | undefined> {
    if (conversation.runnerBackend !== "app_server" || !conversation.runnerThreadId) {
      return undefined;
    }

    const listed = availableSessions?.find((session) => session.id === conversation.runnerThreadId);
    if (listed) {
      return listed;
    }

    try {
      const resumed = await this.appServerCodexRunner.resumeThread(conversation.runnerThreadId);
      return {
        id: resumed.id,
        ...(resumed.cwd ? { cwd: resumed.cwd } : {}),
      };
    } catch (error) {
      this.stateStore.recordDiagnostic({
        code: "current_session_lookup_failed",
        accountId: conversation.accountId,
        detail: JSON.stringify({
          conversationKey: conversation.conversationKey,
          threadId: conversation.runnerThreadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      return undefined;
    }
  }

  private async readQuotaForChat(accountId: string): Promise<string> {
    try {
      const rateLimits = await this.appServerCodexRunner.readRateLimits();
      this.stateStore.saveRuntimeState("codex_rate_limits", rateLimits);
      return formatQuotaSnapshot(rateLimits);
    } catch (error) {
      const parsedQuota = parseQuotaSnapshotFromUnsupportedResponseError(error);
      this.stateStore.recordDiagnostic({
        code: "quota_read_failed",
        accountId,
        detail: formatQuotaReadFailureDiagnostic(error, parsedQuota),
      });
      if (parsedQuota) {
        this.stateStore.saveRuntimeState("codex_rate_limits", parsedQuota);
        return [
          "Live quota read failed because Codex returned an unsupported quota response. Bridge parsed the live quota response body directly.",
          "",
          formatQuotaSnapshot(parsedQuota),
        ].join("\n");
      }
      const cached = this.stateStore.getRuntimeState("codex_rate_limits");
      if (isObject(cached)) {
        if (isUnsupportedQuotaResponseError(error)) {
          return [
            "Live quota read failed because Codex returned an unsupported quota response. Showing the latest cached snapshot instead.",
            `detail: ${error instanceof Error ? error.message : String(error)}`,
            "",
            formatQuotaSnapshot(cached),
          ].join("\n");
        }
        return [
          "Live quota read failed. Showing the latest cached snapshot instead.",
          "",
          formatQuotaSnapshot(cached),
        ].join("\n");
      }
      if (isUnsupportedQuotaResponseError(error)) {
        return [
          "Unable to read the current Codex quota because Codex returned an unsupported quota response.",
          "This does not affect WeChat message delivery.",
          `detail: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n");
      }
      return `Unable to read the current Codex quota: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private createCodexRunnerForPending(pending: PendingMessageRecord): CodexRunner {
      const runtimePreferences = this.getRuntimePreferences();
      const pendingNewSessionName = this.getPendingNewSessionName(pending.conversationKey);
      return {
        runTurn: async ({ cwd, prompt, threadName, model, reasoningEffort, signal, onProgress, onReasoningProgress, onIdleTimeout, onTurnStarted }) => {
        const primaryBackend = this.config.codexBackend;
        const fallbackBackend = primaryBackend === "app_server" ? "exec" : undefined;
        const conversation = this.stateStore.resolveConversation({
          accountId: pending.accountId,
          peerUserId: pending.peerUserId,
        });
        const resolvedConversationThreadId = conversation.runnerThreadId ?? conversation.codexThreadId;
        const effectiveConversationThread = conversation.runnerBackend && resolvedConversationThreadId
          ? {
              runnerBackend: conversation.runnerBackend,
              runnerThreadId: resolvedConversationThreadId,
              runnerCwd: conversation.runnerCwd ?? await this.lookupThreadCwd(resolvedConversationThreadId),
            }
          : pending.runnerBackend && pending.runnerThreadId && pending.runnerBackend !== "exec"
            ? {
                runnerBackend: pending.runnerBackend,
                runnerThreadId: pending.runnerThreadId,
                runnerCwd: pending.runnerCwd ?? await this.lookupThreadCwd(pending.runnerThreadId),
              }
            : await this.resolveReusableConversationThread({
                accountId: pending.accountId,
                peerUserId: pending.peerUserId,
                conversation,
                allowImplicitReuse: !pendingNewSessionName,
              });
        if (effectiveConversationThread?.runnerBackend === "app_server" && effectiveConversationThread.runnerThreadId && effectiveConversationThread.runnerCwd && effectiveConversationThread.runnerCwd !== conversation.runnerCwd) {
          this.stateStore.updateConversationThread(conversation.conversationKey, {
            runnerBackend: "app_server",
            runnerThreadId: effectiveConversationThread.runnerThreadId,
            runnerCwd: effectiveConversationThread.runnerCwd,
          });
        }
        const effectiveCwd = effectiveConversationThread?.runnerCwd ?? pending.runnerCwd ?? cwd;
        return await runTurnWithFallback({
          cwd: effectiveCwd,
          prompt,
          threadName: pendingNewSessionName ?? threadName,
          model: model ?? runtimePreferences.model,
          reasoningEffort: reasoningEffort ?? runtimePreferences.reasoningEffort,
          signal,
          onProgress,
          onReasoningProgress,
          onIdleTimeout,
          onTurnStarted,
          primaryBackend,
          fallbackBackend,
          conversationThread: effectiveConversationThread,
          runners: {
            app_server: this.appServerCodexRunner,
            exec: this.execCodexRunner,
          },
          onFallback: ({ from, to, error }) => {
            this.stateStore.recordDiagnostic({
              code: "codex_runner_fallback",
              accountId: pending.accountId,
              detail: JSON.stringify({
                from,
                to,
                conversationKey: pending.conversationKey,
                error: error.message,
              }),
            });
          },
        });
      },
    };
  }

  private async resolveReusableConversationThread(input: {
    accountId: string;
    peerUserId: string;
    conversation: ConversationRecord;
    allowImplicitReuse?: boolean | undefined;
  }): Promise<{ runnerBackend: "app_server"; runnerThreadId: string; runnerCwd?: string | undefined } | undefined> {
    if (this.config.codexBackend !== "app_server") {
      return undefined;
    }
    if (input.allowImplicitReuse === false) {
      return undefined;
    }
    if (!this.shouldAttemptImplicitSessionReuse(input.conversation)) {
      return undefined;
    }
    try {
      const expectedThreadName = `WeChat ${input.peerUserId}`;
      const sessions = await this.appServerCodexRunner.listThreads({ limit: 50 });
      const matchingSession = sessions.find((session) => session.name === expectedThreadName);
      if (!matchingSession?.id) {
        return undefined;
      }
      return {
        runnerBackend: "app_server",
        runnerThreadId: matchingSession.id,
        runnerCwd: matchingSession.cwd,
      };
    } catch (error) {
      this.stateStore.recordDiagnostic({
        code: "reusable_session_lookup_failed",
        accountId: input.accountId,
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private getPendingNewSessionName(conversationKey: string): string | undefined {
    const value = this.stateStore.getRuntimeState(`${NEXT_NEW_SESSION_NAME_PREFIX}${conversationKey}`);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private clearPendingNewSessionName(conversationKey: string): void {
    this.stateStore.saveRuntimeState(`${NEXT_NEW_SESSION_NAME_PREFIX}${conversationKey}`, null);
  }

  private shouldAttemptImplicitSessionReuse(conversation: ConversationRecord): boolean {
    if (conversation.runnerBackend || conversation.runnerThreadId || conversation.codexThreadId) {
      return false;
    }
    return conversation.createdAt === conversation.updatedAt;
  }

  private shouldReviewRecoveryBacklog(): boolean {
    const previousStatus = this.stateStore.getRuntimeState("daemon_status");
    return isObject(previousStatus) && typeof previousStatus.startedAt === "string" && previousStatus.startedAt.trim().length > 0;
  }

  private async lookupThreadCwd(threadId: string): Promise<string | undefined> {
    if (this.config.codexBackend !== "app_server") {
      return undefined;
    }
    try {
      const thread = await this.appServerCodexRunner.resumeThread(threadId);
      return thread.cwd;
    } catch {
      return undefined;
    }
  }

  private formatLifecycleMessage(input: { phase: "online" | "offline"; detail?: string | undefined }): string {
    const lines = [
      input.phase === "online"
        ? "📡 Bridge online and ready."
        : "📡 Bridge going offline.",
    ];
    if (input.detail?.trim()) {
      lines.push(`detail: ${input.detail.trim()}`);
    }
    lines.push(`backend: ${this.config.codexBackend}`);
    lines.push(`bridge cwd: ${this.config.workspaceDir}`);
    return lines.join("\n");
  }

  private getPendingLifecycleNotification(): PendingLifecycleNotification | undefined {
    const value = this.stateStore.getRuntimeState(PENDING_LIFECYCLE_NOTIFICATION_KEY);
    if (!isObject(value)) {
      return undefined;
    }
    if (value.phase !== "online" && value.phase !== "offline") {
      return undefined;
    }
    if (typeof value.createdAt !== "string" || !value.createdAt.trim()) {
      return undefined;
    }
    return {
      phase: value.phase,
      detail: typeof value.detail === "string" ? value.detail : undefined,
      createdAt: value.createdAt,
    };
  }

  private savePendingLifecycleNotification(input: { phase: "online" | "offline"; detail?: string | undefined }): void {
    this.stateStore.saveRuntimeState(PENDING_LIFECYCLE_NOTIFICATION_KEY, {
      phase: input.phase,
      ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  private clearPendingLifecycleNotification(): void {
    this.stateStore.saveRuntimeState(PENDING_LIFECYCLE_NOTIFICATION_KEY, null);
  }

  private async replayDeferredOutboundDeliveries(input: {
    accountId: string;
    conversation: ConversationRecord;
    contextToken?: string | undefined;
  }): Promise<void> {
    if (typeof (this.stateStore as Partial<StateStore>).listOutboundDeliveries !== "function"
      || typeof (this.stateStore as Partial<StateStore>).markOutboundDeliveryStatus !== "function") {
      return;
    }
    const contextToken = input.contextToken?.trim();
    if (!contextToken) {
      return;
    }

    const pending = this.stateStore.listOutboundDeliveries(["waiting_for_fresh_context"], input.conversation.conversationKey);
    if (pending.length === 0) {
      return;
    }

    const client = this.createAccountClient(input.accountId);
    for (const delivery of pending) {
      try {
        await this.replayDeferredOutboundDelivery({
          client,
          delivery,
          contextToken,
        });
        this.stateStore.markOutboundDeliveryStatus(delivery.id, {
          status: "sent",
          errorMessage: undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextStatus = isReplyContextExpiredError(error) ? "waiting_for_fresh_context" : "failed";
        this.stateStore.markOutboundDeliveryStatus(delivery.id, {
          status: nextStatus,
          errorMessage: message,
        });
        this.stateStore.recordDiagnostic({
          code: nextStatus === "waiting_for_fresh_context" ? "queued_delivery_still_waiting" : "queued_delivery_failed",
          accountId: input.accountId,
          detail: JSON.stringify({
            deliveryId: delivery.id,
            conversationKey: delivery.conversationKey,
            error: message,
          }),
        });
        if (nextStatus === "waiting_for_fresh_context") {
          break;
        }
      }
    }
  }

  private async replayDeferredOutboundDelivery(input: {
    client: HttpWeixinClient;
    delivery: OutboundDeliveryRecord;
    contextToken: string;
  }): Promise<void> {
    if (input.delivery.kind === "text" && "text" in input.delivery.payload) {
      await input.client.sendTextMessage({
        peerUserId: input.delivery.peerUserId,
        contextToken: input.contextToken,
        text: input.delivery.payload.text,
      });
      this.stateStore.recordDeliveryAttempt({
        conversationKey: input.delivery.conversationKey,
        status: "queued_delivery_sent",
        peerUserId: input.delivery.peerUserId,
        contextToken: input.contextToken,
        finalMessage: input.delivery.payload.text,
      });
      return;
    }
    if (input.delivery.kind === "file" && "filePath" in input.delivery.payload) {
      await this.sendLocalMediaFile({
        client: input.client,
        peerUserId: input.delivery.peerUserId,
        contextToken: input.contextToken,
        filePath: input.delivery.payload.filePath,
      });
      this.stateStore.recordDeliveryAttempt({
        conversationKey: input.delivery.conversationKey,
        status: "queued_delivery_sent",
        peerUserId: input.delivery.peerUserId,
        contextToken: input.contextToken,
        finalMessage: input.delivery.payload.filePath,
      });
      return;
    }
    throw new Error(`Unsupported queued delivery payload for kind ${input.delivery.kind}`);
  }

  private async deliverPendingLifecycleNotification(accountId: string, client: HttpWeixinClient): Promise<void> {
    const pending = this.getPendingLifecycleNotification();
    if (!pending) {
      return;
    }

    const conversations = this.stateStore
      .listConversations()
      .filter((conversation) => conversation.accountId === accountId)
      .slice(0, LIFECYCLE_NOTIFICATION_LIMIT);

    let sent = 0;
    for (const conversation of conversations) {
      const contextToken = this.stateStore.getContextToken(conversation.accountId, conversation.peerUserId);
      if (!contextToken) {
        continue;
      }
      try {
        await client.sendTextMessage({
          peerUserId: conversation.peerUserId,
          contextToken,
          text: this.formatLifecycleMessage({
            phase: pending.phase,
            detail: pending.detail,
          }),
        });
        sent += 1;
      } catch (error) {
        this.stateStore.recordDiagnostic({
          code: "lifecycle_notification_retry_failed",
          accountId,
          detail: JSON.stringify({
            conversationKey: conversation.conversationKey,
            phase: pending.phase,
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    }

    if (sent > 0) {
      this.clearPendingLifecycleNotification();
      this.stateStore.recordDiagnostic({
        code: "lifecycle_notification_delivered_late",
        accountId,
        detail: JSON.stringify({
          phase: pending.phase,
          createdAt: pending.createdAt,
        }),
      });
    }
  }

  private pendingReviewKey(conversationKey: string): string {
    return `${PENDING_REVIEW_PREFIX}${conversationKey}`;
  }

  private pendingDeliveryIntentKey(pendingMessageId: number): string {
    return `pending_delivery_intent:${pendingMessageId}`;
  }

  private pendingProcessingStartedAtKey(pendingMessageId: number): string {
    return `${PENDING_PROCESSING_STARTED_AT_PREFIX}${pendingMessageId}`;
  }

  private savePendingProcessingStartedAt(pendingMessageId: number): void {
    this.stateStore.saveRuntimeState(this.pendingProcessingStartedAtKey(pendingMessageId), new Date().toISOString());
  }

  private getPendingProcessingStartedAtMs(pendingMessageId: number): number | undefined {
    const value = this.stateStore.getRuntimeState(this.pendingProcessingStartedAtKey(pendingMessageId));
    if (typeof value !== "string") {
      return undefined;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private clearPendingProcessingStartedAt(pendingMessageId: number): void {
    this.stateStore.saveRuntimeState(this.pendingProcessingStartedAtKey(pendingMessageId), null);
  }

  private getPendingDeliveryIntent(pendingMessageId: number): DeliveryIntent | undefined {
    const value = this.stateStore.getRuntimeState(this.pendingDeliveryIntentKey(pendingMessageId));
    if (!isObject(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.requestedKinds) || !Array.isArray(value.evidenceText)) {
      return undefined;
    }
    return {
      enabled: value.enabled,
      requestedKinds: value.requestedKinds.filter((kind): kind is DeliveryIntent["requestedKinds"][number] => typeof kind === "string"),
      evidenceText: value.evidenceText.filter((item): item is string => typeof item === "string"),
    };
  }

  private clearPendingDeliveryIntent(pendingMessageId: number): void {
    this.stateStore.saveRuntimeState(this.pendingDeliveryIntentKey(pendingMessageId), null);
  }

  private getPendingReviewState(conversationKey: string): { count: number; items: string[]; lastNotifiedCount?: number | undefined } | undefined {
    const value = this.stateStore.getRuntimeState(this.pendingReviewKey(conversationKey));
    if (!isObject(value) || !Array.isArray(value.items)) {
      return undefined;
    }
    return {
      count: Number.isFinite(value.count) ? Number(value.count) : value.items.length,
      items: value.items.filter((item): item is string => typeof item === "string"),
      ...(Number.isFinite(value.lastNotifiedCount) ? { lastNotifiedCount: Number(value.lastNotifiedCount) } : {}),
    };
  }

  private getPendingReviewSummary(conversationKey: string): { count: number; items: string[] } | undefined {
    return this.getPendingReviewState(conversationKey);
  }

  private addPendingReviewItem(conversationKey: string, prompt: string): void {
    const current = this.getPendingReviewState(conversationKey) ?? { count: 0, items: [] };
    const next = {
      count: current.count + 1,
      items: [...current.items, shortenMiddle(prompt, RECOVERY_MESSAGE_PREVIEW_LENGTH)],
      ...(current.lastNotifiedCount !== undefined ? { lastNotifiedCount: current.lastNotifiedCount } : {}),
    };
    this.stateStore.saveRuntimeState(this.pendingReviewKey(conversationKey), next);
  }

  private clearPendingReview(conversationKey: string): void {
    this.stateStore.saveRuntimeState(this.pendingReviewKey(conversationKey), { count: 0, items: [], lastNotifiedCount: 0 });
  }

  private async deliverPendingReviewSummaries(accountId: string, client: HttpWeixinClient): Promise<void> {
    const conversations = this.stateStore
      .listConversations()
      .filter((conversation) => conversation.accountId === accountId);
    for (const conversation of conversations) {
      const review = this.getPendingReviewState(conversation.conversationKey);
      if (!review || review.count === 0) {
        continue;
      }
      if (review.lastNotifiedCount === review.count) {
        continue;
      }
      const contextToken = this.stateStore.getContextToken(conversation.accountId, conversation.peerUserId);
      if (!contextToken) {
        continue;
      }
      await client.sendTextMessage({
        peerUserId: conversation.peerUserId,
        contextToken,
        text: [
          "📡 Bridge recovered with pending backlog for this chat.",
          `pending messages: ${review.count}`,
          ...review.items.map((item, index) => `- ${index + 1}. ${item}`),
          "",
          "Use /pending continue to process them or /pending clear to discard them.",
        ].join("\n"),
      });
      this.stateStore.saveRuntimeState(this.pendingReviewKey(conversation.conversationKey), {
        count: review.count,
        items: review.items,
        lastNotifiedCount: review.count,
      });
    }
  }
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== "aborted") {
      throw error;
    }
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: (() => void) | undefined): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Operation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseQuotaSnapshotFromUnsupportedResponseError(error: unknown): Record<string, unknown> | undefined {
  if (!isUnsupportedQuotaResponseError(error)) {
    return undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  const body = extractJsonBodyFromErrorMessage(message);
  if (!body) {
    return undefined;
  }
  return parseWhamUsageQuotaSnapshot(body);
}

function extractJsonBodyFromErrorMessage(message: string): unknown | undefined {
  const markerIndex = message.indexOf("body=");
  if (markerIndex < 0) {
    return undefined;
  }
  const start = message.indexOf("{", markerIndex + "body=".length);
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < message.length; index += 1) {
    const char = message[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(message.slice(start, index + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function parseWhamUsageQuotaSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const rateLimit = isObject(value.rate_limit) ? value.rate_limit : undefined;
  if (!rateLimit) {
    return undefined;
  }
  const primary = parseQuotaWindow(rateLimit.primary_window);
  const secondary = parseQuotaWindow(rateLimit.secondary_window);
  if (!primary && !secondary) {
    return undefined;
  }

  const snapshot: Record<string, unknown> = {};
  const account: Record<string, unknown> = {};
  if (typeof value.email === "string") {
    account.email = value.email;
  }
  if (typeof value.user_id === "string") {
    account.userId = value.user_id;
  }
  if (typeof value.account_id === "string") {
    account.accountId = value.account_id;
  }
  if (typeof value.plan_type === "string") {
    account.planType = value.plan_type;
  }
  if (Object.keys(account).length > 0) {
    snapshot.account = account;
  }
  if (typeof rateLimit.allowed === "boolean") {
    snapshot.allowed = rateLimit.allowed;
  }
  if (typeof rateLimit.limit_reached === "boolean") {
    snapshot.limitReached = rateLimit.limit_reached;
  }
  if (primary) {
    snapshot.primary = primary;
  }
  if (secondary) {
    snapshot.secondary = secondary;
  }
  const additional = parseAdditionalRateLimits(value.additional_rate_limits);
  if (additional.length > 0) {
    snapshot.additional = additional;
  }
  const credits = parseCredits(value.credits);
  if (credits) {
    snapshot.credits = credits;
  }
  return snapshot;
}

function parseAdditionalRateLimits(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!isObject(item)) {
        return undefined;
      }
      const rateLimit = isObject(item.rate_limit) ? item.rate_limit : undefined;
      if (!rateLimit) {
        return undefined;
      }
      const primary = parseQuotaWindow(rateLimit.primary_window);
      const secondary = parseQuotaWindow(rateLimit.secondary_window);
      if (!primary && !secondary) {
        return undefined;
      }
      const parsed: Record<string, unknown> = {};
      if (typeof item.limit_name === "string") {
        parsed.name = item.limit_name;
      }
      if (typeof item.metered_feature === "string") {
        parsed.meteredFeature = item.metered_feature;
      }
      if (primary) {
        parsed.primary = primary;
      }
      if (secondary) {
        parsed.secondary = secondary;
      }
      return parsed;
    })
    .filter((item): item is Record<string, unknown> => item !== undefined);
}

function parseQuotaWindow(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const parsed: Record<string, unknown> = {};
  const usedPercent = readNumber(value.used_percent) ?? readNumber(value.usedPercent);
  const windowSeconds = readNumber(value.limit_window_seconds);
  const windowDurationMins = readNumber(value.windowDurationMins) ?? (windowSeconds !== undefined ? Math.round(windowSeconds / 60) : undefined);
  const resetsAt = readNumber(value.reset_at) ?? readNumber(value.resetsAt);
  if (usedPercent !== undefined) {
    parsed.usedPercent = usedPercent;
  }
  if (windowDurationMins !== undefined) {
    parsed.windowDurationMins = windowDurationMins;
  }
  if (resetsAt !== undefined) {
    parsed.resetsAt = resetsAt;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseCredits(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const parsed: Record<string, unknown> = {};
  if (typeof value.has_credits === "boolean") {
    parsed.hasCredits = value.has_credits;
  } else if (typeof value.hasCredits === "boolean") {
    parsed.hasCredits = value.hasCredits;
  }
  if (typeof value.unlimited === "boolean") {
    parsed.unlimited = value.unlimited;
  }
  if (value.balance !== undefined && value.balance !== null) {
    parsed.balance = value.balance;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatQuotaReadFailureDiagnostic(error: unknown, parsedQuota: Record<string, unknown> | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!parsedQuota) {
    return message;
  }
  const account = isObject(parsedQuota.account) ? parsedQuota.account : undefined;
  return JSON.stringify({
    error: message.replace(/body=\{[\s\S]*$/m, "body=<parsed>"),
    parsedBody: true,
    ...(typeof account?.planType === "string" ? { planType: account.planType } : {}),
    ...(typeof account?.email === "string" ? { email: account.email } : {}),
    ...(typeof account?.userId === "string" ? { userId: account.userId } : {}),
    ...(typeof account?.accountId === "string" ? { accountId: account.accountId } : {}),
  });
}

function formatQuotaSnapshot(value: unknown): string {
  if (!isObject(value)) {
    return "No Codex quota snapshot is available yet.";
  }

  const account = isObject(value.account) ? value.account : undefined;
  const primary = isObject(value.primary) ? value.primary : undefined;
  const secondary = isObject(value.secondary) ? value.secondary : undefined;
  const credits = isObject(value.credits) ? value.credits : undefined;
  const additional = Array.isArray(value.additional)
    ? value.additional.filter(isObject)
    : [];
  const lines = ["current quota:"];

  if (account) {
    if (typeof account.email === "string") {
      lines.push(`- email: ${account.email}`);
    }
    if (typeof account.userId === "string") {
      lines.push(`- user_id: ${account.userId}`);
    }
    if (typeof account.accountId === "string") {
      lines.push(`- account_id: ${account.accountId}`);
    }
    if (typeof account.planType === "string") {
      lines.push(`- plan_type: ${account.planType}`);
    }
  }
  if (typeof value.allowed === "boolean" || typeof value.limitReached === "boolean") {
    lines.push(`- allowed: ${String(value.allowed ?? "unknown")} / limit_reached: ${String(value.limitReached ?? "unknown")}`);
  }
  if (primary) {
    lines.push(`- primary: ${primary.usedPercent ?? "?"}% used / ${primary.windowDurationMins ?? "?"} min window / resets(Beijing): ${formatQuotaReset(primary.resetsAt)}`);
  }
  if (secondary) {
    lines.push(`- secondary: ${secondary.usedPercent ?? "?"}% used / ${secondary.windowDurationMins ?? "?"} min window / resets(Beijing): ${formatQuotaReset(secondary.resetsAt)}`);
  }
  if (additional.length > 0) {
    for (const item of additional) {
      const itemPrimary = isObject(item.primary) ? item.primary : undefined;
      const itemSecondary = isObject(item.secondary) ? item.secondary : undefined;
      lines.push(`- additional ${item.name ?? "rate limit"}: primary ${itemPrimary?.usedPercent ?? "?"}% / ${itemPrimary?.windowDurationMins ?? "?"} min / resets(Beijing): ${formatQuotaReset(itemPrimary?.resetsAt)}; secondary ${itemSecondary?.usedPercent ?? "?"}% / ${itemSecondary?.windowDurationMins ?? "?"} min / resets(Beijing): ${formatQuotaReset(itemSecondary?.resetsAt)}`);
    }
  }
  if (credits) {
    lines.push(`- credits: hasCredits=${String(credits.hasCredits)} / unlimited=${String(credits.unlimited)} / balance=${credits.balance ?? "n/a"}`);
  }

  return lines.join("\n");
}

function formatQuotaReset(value: unknown): string {
  if (typeof value !== "number") {
    return "unknown";
  }
  return formatBeijingTimestamp(value);
}

function formatBeijingTimestamp(epochSeconds: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1000));
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function shortenMiddle(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  const head = Math.max(1, Math.floor((maxLength - 6) / 2));
  const tail = Math.max(1, maxLength - 6 - head);
  return `${trimmed.slice(0, head)} ... ${trimmed.slice(trimmed.length - tail)}`;
}

