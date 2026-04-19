import { CodexTurnInterruptedError, type CodexRunner, type RunnerBackend } from "../codex/codex-runner.js";
import { sendLocalMediaFile } from "../weixin/outbound-media.js";
import type { WeixinClient } from "../weixin/weixin-api-client.js";
import { extractDeliveredFileMarkers, stripDeliveredFileMarkers } from "./delivery-guidance.js";
import type { DeliveryIntent } from "./delivery-intent.js";
import { resolveDeliveryCandidates } from "./outbound-delivery.js";

export type DeliveryRecorder = {
  recordDeliveryAttempt(input: { conversationKey: string; status: string; errorMessage?: string | undefined; finalMessage?: string | undefined }): void;
  enqueueOutboundDelivery(input: {
    conversationKey: string;
    accountId: string;
    peerUserId: string;
    contextToken?: string | undefined;
    kind: "text" | "file";
    payload: { text: string } | { filePath: string };
    status?: "pending" | "waiting_for_fresh_context" | "sent" | "failed";
    errorMessage?: string | undefined;
  }): number;
};

const MAX_FINAL_MESSAGE_CHARS = 1200;
const MAX_PROGRESS_MESSAGE_CHARS = 400;
const SEND_TEXT_RETRY_LIMIT = 3;
const MAX_INTERIM_MESSAGES = 5;

export type ReplyOrchestrator = {
  handleInboundMessage(input: {
    conversationKey: string;
    threadId?: string | undefined;
    accountId: string;
    peerUserId: string;
    contextToken: string;
    prompt: string;
    threadName?: string | undefined;
    typingTicket?: string | undefined;
    model?: string | undefined;
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
    showFinalSummary?: boolean | undefined;
    deliveryIntent?: DeliveryIntent | undefined;
    signal?: AbortSignal | undefined;
    onIdleTimeout?: Parameters<CodexRunner["runTurn"]>[0]["onIdleTimeout"];
    onTurnStarted?: Parameters<CodexRunner["runTurn"]>[0]["onTurnStarted"];
  }): Promise<{
    runnerBackend: RunnerBackend;
    threadId: string;
    cwd: string;
    finalMessage: string;
    outboundMessageId: string;
    timings: {
      typingStartMs: number;
      runnerMs: number;
      typingStopMs: number;
      sendMs: number;
      totalMs: number;
    };
  }>;
};

export function createReplyOrchestrator(input: {
  stateStore: DeliveryRecorder;
  codexRunner: CodexRunner;
  weixinClient: Pick<WeixinClient, "setTyping" | "stopTyping" | "sendTextMessage"> & Partial<Pick<WeixinClient, "getUploadUrl" | "sendImageMessage" | "sendFileMessage">>;
}): ReplyOrchestrator {
  return {
    async handleInboundMessage(message) {
      const startedAt = Date.now();
      let typingStartMs = 0;
      let runnerMs = 0;
      let typingStopMs = 0;
      let sendMs = 0;
      let sawStructuredBlock = false;
      let fencedStructuredBlockBuffer = "";
      let plainStructuredBlockBuffer = "";
      const emittedAnswerProseParts: string[] = [];
      let interimMessagesSent = 0;
      let suppressInterimMessages = false;

      const sendAnswerProgress = async (text: string, includeInVisibleFinalPrefix: boolean): Promise<void> => {
        if (includeInVisibleFinalPrefix) {
          emittedAnswerProseParts.push(text);
        }
        if (suppressInterimMessages || interimMessagesSent >= MAX_INTERIM_MESSAGES) {
          return;
        }
        const outbound = await sendTextMessageWithRetry({
          weixinClient: input.weixinClient,
          peerUserId: message.peerUserId,
          contextToken: message.contextToken,
          text,
          fatal: false,
        });
        if (!outbound) {
          suppressInterimMessages = true;
          input.stateStore.recordDeliveryAttempt({
            conversationKey: message.conversationKey,
            status: "progress_failed",
            errorMessage: "Progress delivery failed after retries.",
            finalMessage: text,
          });
          return;
        }
        interimMessagesSent += 1;
        input.stateStore.recordDeliveryAttempt({
          conversationKey: message.conversationKey,
          status: "progress_sent",
          finalMessage: text,
        });
      };

      const emitOutsideFenceProgress = async (chunk: string): Promise<void> => {
        const parts = splitProgressChunk(chunk);
        for (const text of parts) {
          await sendAnswerProgress(text, true);
        }
      };

      const flushStructuredBlockBuffer = async (): Promise<void> => {
        if (fencedStructuredBlockBuffer) {
          const normalized = normalizeStructuredBlock(fencedStructuredBlockBuffer);
          fencedStructuredBlockBuffer = "";
          if (normalized) {
            await sendAnswerProgress(normalized, false);
          }
        }
        if (!plainStructuredBlockBuffer) {
          return;
        }
        const normalized = normalizePlainStructuredBlock(plainStructuredBlockBuffer);
        plainStructuredBlockBuffer = "";
        if (!normalized) {
          return;
        }
        await sendAnswerProgress(normalized, false);
      };

      const bufferPlainStructuredChunk = (chunk: string): void => {
        const normalized = normalizePlainStructuredBlock(chunk);
        if (!normalized) {
          return;
        }
        if (!plainStructuredBlockBuffer) {
          plainStructuredBlockBuffer = normalized;
          return;
        }
        plainStructuredBlockBuffer = `${plainStructuredBlockBuffer}\n${normalized}`;
      };

      const handleProgressChunk = async (chunk: string): Promise<void> => {
        let remaining = chunk;
        while (remaining.length > 0) {
          if (fencedStructuredBlockBuffer) {
            fencedStructuredBlockBuffer = appendStructuredChunk(fencedStructuredBlockBuffer, remaining);
            remaining = "";
            const extracted = extractClosedStructuredBlock(fencedStructuredBlockBuffer);
            if (!extracted) {
              return;
            }
            fencedStructuredBlockBuffer = "";
            if (extracted.content) {
              await sendAnswerProgress(extracted.content, false);
            }
            remaining = extracted.remaining;
            continue;
          }

          if (plainStructuredBlockBuffer) {
            const fenceStart = remaining.indexOf("```");
            if (fenceStart >= 0) {
              const beforeFence = remaining.slice(0, fenceStart);
              if (looksLikeStructuredPlainText(beforeFence)) {
                bufferPlainStructuredChunk(beforeFence);
                await flushStructuredBlockBuffer();
                fencedStructuredBlockBuffer = remaining.slice(fenceStart);
                sawStructuredBlock = true;
                remaining = "";
                continue;
              }
              await flushStructuredBlockBuffer();
              continue;
            }
            if (looksLikeStructuredPlainText(remaining)) {
              bufferPlainStructuredChunk(remaining);
              return;
            }
            await flushStructuredBlockBuffer();
            continue;
          }

          if (!fencedStructuredBlockBuffer) {
            const fenceStart = remaining.indexOf("```");
            if (fenceStart < 0) {
              if (looksLikeStructuredPlainText(remaining)) {
                sawStructuredBlock = true;
                bufferPlainStructuredChunk(remaining);
                return;
              }
              await emitOutsideFenceProgress(remaining);
              return;
            }
            const beforeFence = remaining.slice(0, fenceStart);
            if (looksLikeStructuredPlainText(beforeFence)) {
              sawStructuredBlock = true;
              bufferPlainStructuredChunk(beforeFence);
            } else {
              await emitOutsideFenceProgress(beforeFence);
            }
            fencedStructuredBlockBuffer = remaining.slice(fenceStart);
            sawStructuredBlock = true;
            remaining = "";
            const extracted = extractClosedStructuredBlock(fencedStructuredBlockBuffer);
            if (!extracted) {
              return;
            }
            fencedStructuredBlockBuffer = "";
            if (extracted.content) {
              await sendAnswerProgress(extracted.content, false);
            }
            remaining = extracted.remaining;
            continue;
          }
        }
      };

      if (message.typingTicket) {
        const typingStartedAt = Date.now();
        await input.weixinClient.setTyping({
          peerUserId: message.peerUserId,
          typingTicket: message.typingTicket,
        });
        typingStartMs = Date.now() - typingStartedAt;
      }

      try {
        const runnerStartedAt = Date.now();
        const result = await input.codexRunner.runTurn({
          cwd: process.cwd(),
          prompt: message.prompt,
          threadId: message.threadId,
          threadName: message.threadName ?? `WeChat ${message.peerUserId}`,
          model: message.model,
          reasoningEffort: message.reasoningEffort,
          signal: message.signal,
          onProgress: handleProgressChunk,
          onReasoningProgress: async (chunk) => {
            const text = formatThinkingChunk(chunk);
            if (!text) {
              return;
            }
            if (suppressInterimMessages || interimMessagesSent >= MAX_INTERIM_MESSAGES) {
              return;
            }
            const outbound = await sendTextMessageWithRetry({
              weixinClient: input.weixinClient,
              peerUserId: message.peerUserId,
              contextToken: message.contextToken,
              text,
              fatal: false,
            });
            if (!outbound) {
              suppressInterimMessages = true;
              input.stateStore.recordDeliveryAttempt({
                conversationKey: message.conversationKey,
                status: "thinking_failed",
                errorMessage: "Thinking delivery failed after retries.",
                finalMessage: text,
              });
              return;
            }
            interimMessagesSent += 1;
            input.stateStore.recordDeliveryAttempt({
              conversationKey: message.conversationKey,
              status: "thinking_sent",
              finalMessage: text,
            });
          },
          onIdleTimeout: message.onIdleTimeout,
          onTurnStarted: message.onTurnStarted,
        });
        runnerMs = Date.now() - runnerStartedAt;
        await flushStructuredBlockBuffer();

        if (message.typingTicket) {
          const typingStoppedAt = Date.now();
          await input.weixinClient.stopTyping({
            peerUserId: message.peerUserId,
            typingTicket: message.typingTicket,
          });
          typingStopMs = Date.now() - typingStoppedAt;
        }

        const sendStartedAt = Date.now();
        const finalText = message.showFinalSummary !== false && result.finalMessage.trim().length > 0
          ? buildVisibleFinalSummary(result.finalMessage, emittedAnswerProseParts, sawStructuredBlock)
          : "";
        const outbound = finalText
          ? await sendFinalSummary({
              stateStore: input.stateStore,
              conversationKey: message.conversationKey,
              accountId: message.accountId,
              weixinClient: input.weixinClient,
              peerUserId: message.peerUserId,
              contextToken: message.contextToken,
              finalText,
            })
          : { messageId: "progress-only" };
        const mediaOutbound = await deliverRequestedMediaIfAny({
          weixinClient: input.weixinClient,
          conversationKey: message.conversationKey,
          accountId: message.accountId,
          peerUserId: message.peerUserId,
          contextToken: message.contextToken,
          finalMessage: result.finalMessage,
          workspaceDir: result.cwd,
          deliveryIntent: message.deliveryIntent,
          taskStartedAtMs: startedAt,
          stateStore: input.stateStore,
        });
        sendMs = Date.now() - sendStartedAt;

        input.stateStore.recordDeliveryAttempt({
          conversationKey: message.conversationKey,
          status: outbound.messageId.startsWith("queued:") ? "sent_deferred" : "sent",
          finalMessage: finalText || undefined,
        });

        return {
          runnerBackend: result.runnerBackend,
          threadId: result.threadId,
          cwd: result.cwd,
          finalMessage: result.finalMessage,
          outboundMessageId: mediaOutbound?.messageId ?? outbound.messageId,
          timings: {
            typingStartMs,
            runnerMs,
            typingStopMs,
            sendMs,
            totalMs: Date.now() - startedAt,
          },
        };
      } catch (error) {
        if (message.typingTicket) {
          const typingStoppedAt = Date.now();
          await input.weixinClient.stopTyping({
            peerUserId: message.peerUserId,
            typingTicket: message.typingTicket,
          });
          typingStopMs = Date.now() - typingStoppedAt;
        }

        input.stateStore.recordDeliveryAttempt({
          conversationKey: message.conversationKey,
          status: error instanceof CodexTurnInterruptedError ? "interrupted" : "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    },
  };
}

function formatProgressChunk(chunk: string): string {
  return stripStandaloneCodeFenceLines(chunk).trim();
}

function splitProgressChunk(chunk: string): string[] {
  const normalized = formatProgressChunk(chunk);
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines.length <= 1 && normalized.length <= MAX_PROGRESS_MESSAGE_CHARS) {
    return [normalized];
  }
  const nonEmptyLines = mergeOrderedListMarkerLines(lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0));
  if (nonEmptyLines.length > 1) {
    return nonEmptyLines.flatMap((line) => splitLongProgressLine(line));
  }
  const parts: string[] = [];
  let current = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!current) {
      current = line;
      continue;
    }
    const candidate = `${current}\n${line}`;
    if (candidate.length > MAX_PROGRESS_MESSAGE_CHARS) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts.length > 0 ? parts : [normalized];
}

function splitLongProgressLine(line: string): string[] {
  if (line.length <= MAX_PROGRESS_MESSAGE_CHARS) {
    return [line];
  }
  const parts: string[] = [];
  let remaining = line;
  while (remaining.length > MAX_PROGRESS_MESSAGE_CHARS) {
    const splitAt = findProgressSplit(remaining, MAX_PROGRESS_MESSAGE_CHARS);
    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function mergeOrderedListMarkerLines(lines: string[]): string[] {
  const merged: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isOrderedListMarkerOnly(line) && index + 1 < lines.length) {
      merged.push(`${line}\n${lines[index + 1]!}`);
      index += 1;
      continue;
    }
    merged.push(line);
  }
  return merged;
}

function isOrderedListMarkerOnly(line: string): boolean {
  return /^\d+[.)、]$/.test(line);
}

function findProgressSplit(text: string, maxChars: number): number {
  const whitespace = text.lastIndexOf(" ", maxChars);
  if (whitespace >= Math.floor(maxChars * 0.6)) {
    return whitespace;
  }
  return maxChars;
}

function formatThinkingChunk(chunk: string): string {
  const normalized = chunk.trim();
  return normalized.length > 0 ? `<T>:\n${normalized}` : "";
}

function formatFinalAnswerChunk(chunk: string): string {
  return `<FINAL>:\n${chunk}`;
}

function buildVisibleFinalSummary(finalMessage: string, emittedAnswerProseParts: string[], sawStructuredBlock: boolean): string {
  const normalizedFinal = normalizeFinalSummary(finalMessage);
  if (!sawStructuredBlock) {
    return normalizedFinal;
  }
  const normalizedProse = emittedAnswerProseParts
    .map((part) => stripStandaloneCodeFenceLines(part).trim())
    .filter((part) => part.length > 0)
    .join("\n");

  if (!normalizedProse) {
    return normalizedFinal;
  }

  if (!normalizedFinal) {
    return normalizedProse;
  }

  if (normalizedFinal.includes(normalizedProse)) {
    return normalizedFinal;
  }

  return `${normalizedProse}\n${normalizedFinal}`.trim();
}

async function sendFinalSummary(input: {
  stateStore: DeliveryRecorder;
  conversationKey: string;
  accountId: string;
  weixinClient: Pick<WeixinClient, "sendTextMessage">;
  peerUserId: string;
  contextToken: string;
  finalText: string;
}): Promise<{ messageId: string }> {
  const parts = splitFinalSummary(input.finalText, MAX_FINAL_MESSAGE_CHARS);
  let lastMessageId = "progress-only";
  for (let index = 0; index < parts.length; index += 1) {
    const text = parts.length === 1
      ? formatFinalAnswerChunk(parts[index]!)
      : formatFinalAnswerChunkPart(parts[index]!, index + 1, parts.length);
    try {
      const outbound = await sendTextMessageWithRetry({
        weixinClient: input.weixinClient,
        peerUserId: input.peerUserId,
        contextToken: input.contextToken,
        text,
        fatal: true,
      });
      if (!outbound) {
        throw new Error("Final summary delivery unexpectedly returned no outbound message id.");
      }
      lastMessageId = outbound.messageId;
    } catch (error) {
      if (!isReplyContextExpiredError(error)) {
        throw error;
      }
      const deliveryId = input.stateStore.enqueueOutboundDelivery({
        conversationKey: input.conversationKey,
        accountId: input.accountId,
        peerUserId: input.peerUserId,
        contextToken: input.contextToken,
        kind: "text",
        payload: { text },
        status: "waiting_for_fresh_context",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { messageId: `queued:${deliveryId}` };
    }
  }
  return { messageId: lastMessageId };
}

async function sendTextMessageWithRetry(input: {
  weixinClient: Pick<WeixinClient, "sendTextMessage">;
  peerUserId: string;
  contextToken: string;
  text: string;
  fatal: boolean;
}): Promise<{ messageId: string } | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SEND_TEXT_RETRY_LIMIT; attempt += 1) {
    try {
      return await input.weixinClient.sendTextMessage({
        peerUserId: input.peerUserId,
        contextToken: input.contextToken,
        text: input.text,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableSendError(error) || attempt >= SEND_TEXT_RETRY_LIMIT) {
        break;
      }
    }
  }
  if (input.fatal) {
    throw lastError;
  }
  return undefined;
}

async function deliverRequestedMediaIfAny(input: {
  weixinClient: Pick<WeixinClient, "sendTextMessage"> & Partial<Pick<WeixinClient, "getUploadUrl" | "sendImageMessage" | "sendFileMessage">>;
  conversationKey: string;
  peerUserId: string;
  contextToken: string;
  finalMessage: string;
  workspaceDir: string;
  deliveryIntent?: DeliveryIntent | undefined;
  accountId: string;
  taskStartedAtMs: number;
  stateStore: DeliveryRecorder;
}): Promise<{ messageId: string } | undefined> {
  if (!input.deliveryIntent?.enabled) {
    return undefined;
  }

  const skillDeliveredPaths = extractDeliveredFileMarkers(input.finalMessage);
  if (skillDeliveredPaths.length > 0) {
    for (const filePath of skillDeliveredPaths) {
      input.stateStore.recordDeliveryAttempt({
        conversationKey: input.conversationKey,
        status: "media_sent_via_skill",
        finalMessage: filePath,
      });
    }
    return undefined;
  }

  if (!input.weixinClient.getUploadUrl || !input.weixinClient.sendImageMessage || !input.weixinClient.sendFileMessage) {
    await sendMediaFallbackText({
      weixinClient: input.weixinClient,
      peerUserId: input.peerUserId,
      contextToken: input.contextToken,
      text: "已识别到本轮需要回传文件，但当前 bridge 未启用媒体发送能力。本轮先返回文本结果。",
    });
    input.stateStore.recordDeliveryAttempt({
      conversationKey: input.conversationKey,
      status: "media_delivery_degraded",
      errorMessage: "Media delivery capability is unavailable.",
    });
    return undefined;
  }

  const resolution = resolveDeliveryCandidates({
    workspaceDir: input.workspaceDir,
    finalMessage: input.finalMessage,
    requestedKinds: input.deliveryIntent.requestedKinds,
    taskStartedAtMs: input.taskStartedAtMs,
  });

  if (resolution.status !== "ready") {
    await sendMediaFallbackText({
      weixinClient: input.weixinClient,
      peerUserId: input.peerUserId,
      contextToken: input.contextToken,
      text: resolution.notice,
    });
    input.stateStore.recordDeliveryAttempt({
      conversationKey: input.conversationKey,
      status: "media_delivery_degraded",
      errorMessage: resolution.notice,
      finalMessage: resolution.status === "ambiguous" ? resolution.candidates.join("\n") : undefined,
    });
    return undefined;
  }

  let lastMessageId: string | undefined;
  try {
    for (const filePath of resolution.files) {
      const outbound = await sendLocalMediaFile({
        client: {
          getUploadUrl: input.weixinClient.getUploadUrl.bind(input.weixinClient),
          sendImageMessage: input.weixinClient.sendImageMessage.bind(input.weixinClient),
          sendFileMessage: input.weixinClient.sendFileMessage.bind(input.weixinClient),
        },
        peerUserId: input.peerUserId,
        contextToken: input.contextToken,
        filePath,
      });
      lastMessageId = outbound.messageId;
      input.stateStore.recordDeliveryAttempt({
        conversationKey: input.conversationKey,
        status: "media_sent",
        finalMessage: filePath,
      });
    }
    return lastMessageId ? { messageId: lastMessageId } : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isReplyContextExpiredError(error) && resolution.status === "ready") {
      let lastQueuedId: number | undefined;
      for (const filePath of resolution.files) {
        lastQueuedId = input.stateStore.enqueueOutboundDelivery({
          conversationKey: input.conversationKey,
          accountId: input.accountId,
          peerUserId: input.peerUserId,
          contextToken: input.contextToken,
          kind: "file",
          payload: { filePath },
          status: "waiting_for_fresh_context",
          errorMessage: message,
        });
        input.stateStore.recordDeliveryAttempt({
          conversationKey: input.conversationKey,
          status: "media_queued",
          errorMessage: message,
          finalMessage: filePath,
        });
      }
      return lastQueuedId ? { messageId: `queued:${lastQueuedId}` } : undefined;
    }
    await sendMediaFallbackText({
      weixinClient: input.weixinClient,
      peerUserId: input.peerUserId,
      contextToken: input.contextToken,
      text: `文件回传失败，已保留文本结果。原因: ${message}`,
    });
    input.stateStore.recordDeliveryAttempt({
      conversationKey: input.conversationKey,
      status: "media_delivery_degraded",
      errorMessage: message,
    });
    return undefined;
  }
}

async function sendMediaFallbackText(input: {
  weixinClient: Pick<WeixinClient, "sendTextMessage">;
  peerUserId: string;
  contextToken: string;
  text: string;
}): Promise<void> {
  await sendTextMessageWithRetry({
    weixinClient: input.weixinClient,
    peerUserId: input.peerUserId,
    contextToken: input.contextToken,
    text: input.text,
    fatal: false,
  });
}

function isRetryableSendError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /fetch failed/i.test(error.message);
}

function isReplyContextExpiredError(error: unknown): boolean {
  return error instanceof Error && /ret=-2|reply context is no longer valid|refresh context_token/i.test(error.message);
}

function splitFinalSummary(text: string, maxChars: number): string[] {
  const trimmed = normalizeFinalSummary(text);
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxChars) {
    const splitAt = findSummarySplit(remaining, maxChars);
    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function findSummarySplit(text: string, maxChars: number): number {
  const newline = text.lastIndexOf("\n", maxChars);
  if (newline >= Math.floor(maxChars * 0.5)) {
    return newline;
  }
  const whitespace = text.lastIndexOf(" ", maxChars);
  if (whitespace >= Math.floor(maxChars * 0.7)) {
    return whitespace;
  }
  return maxChars;
}

function formatFinalAnswerChunkPart(chunk: string, index: number, total: number): string {
  return `<FINAL ${index}/${total}>:\n${chunk}`;
}

function stripStandaloneCodeFenceLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isStandaloneCodeFence(line))
    .join("\n");
}

function normalizeFinalSummary(text: string): string {
  const trimmed = stripDeliveredFileMarkers(text).trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) {
    return fenced[1]!.trim();
  }
  return stripStandaloneCodeFenceLines(trimmed).trim();
}

function isStandaloneCodeFence(line: string): boolean {
  return /^```(?:\S+)?\s*$/.test(line.trim());
}

function normalizeStructuredBlock(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) {
    return fenced[1]!.trim();
  }
  return stripStandaloneCodeFenceLines(trimmed).trim();
}

function normalizePlainStructuredBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function extractClosedStructuredBlock(text: string): { content: string; remaining: string } | undefined {
  const match = text.match(/^```[^\n]*\n([\s\S]*?)\n```/);
  if (!match || match.index !== 0) {
    return undefined;
  }
  const whole = match[0];
  return {
    content: match[1]!.trim(),
    remaining: text.slice(whole.length),
  };
}

function appendStructuredChunk(buffer: string, chunk: string): string {
  if (/^```[^\n]*$/.test(buffer) && chunk.length > 0 && !chunk.startsWith("\n")) {
    return `${buffer}\n${chunk}`;
  }
  return `${buffer}${chunk}`;
}

function looksLikeStructuredPlainText(text: string): boolean {
  const lines = normalizePlainStructuredBlock(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return false;
  }
  let structuredLines = 0;
  for (const line of lines) {
    if (looksLikeStructuredLine(line)) {
      structuredLines += 1;
    }
  }
  return structuredLines >= Math.max(2, Math.ceil(lines.length * 0.7));
}

function looksLikeStructuredLine(line: string): boolean {
  return looksLikeListItem(line)
    || looksLikeTableRow(line)
    || looksLikeTreeRow(line)
    || looksLikePathishLine(line)
    || looksLikeCodeLine(line);
}

function looksLikeListItem(line: string): boolean {
  return /^(\d+[.)]\s+|[-*+]\s+|\[[ xX]\]\s+)/.test(line);
}

function looksLikeTableRow(line: string): boolean {
  return /^\|.+\|$/.test(line) || /^[\s:|-]+$/.test(line);
}

function looksLikeTreeRow(line: string): boolean {
  return /^[├└│─┬┼].+/.test(line);
}

function looksLikePathishLine(line: string): boolean {
  return /^[.~A-Za-z0-9_/-\\]+(?:\.[A-Za-z0-9_-]+)?$/.test(line) && !/\s/.test(line);
}

function looksLikeCodeLine(line: string): boolean {
  if (/^(const|let|var|if|for|while|return|function|class|def|import|from|export)\b/.test(line)) {
    return true;
  }
  return /[{}();=<>]/.test(line) && !/[。！？]$/.test(line);
}
