import { CodexTurnInterruptedError, type CodexRunner, type RunnerBackend } from "../codex/codex-runner.js";
import type { WeixinClient } from "../weixin/weixin-api-client.js";

export type DeliveryRecorder = {
  recordDeliveryAttempt(input: { conversationKey: string; status: string; errorMessage?: string | undefined; finalMessage?: string | undefined }): void;
};

const MAX_FINAL_MESSAGE_CHARS = 1200;
const MAX_PROGRESS_MESSAGE_CHARS = 400;

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
    signal?: AbortSignal | undefined;
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
  weixinClient: WeixinClient;
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

      const sendAnswerProgress = async (text: string, includeInVisibleFinalPrefix: boolean): Promise<void> => {
        await input.weixinClient.sendTextMessage({
          peerUserId: message.peerUserId,
          contextToken: message.contextToken,
          text,
        });
        if (includeInVisibleFinalPrefix) {
          emittedAnswerProseParts.push(text);
        }
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
            await input.weixinClient.sendTextMessage({
              peerUserId: message.peerUserId,
              contextToken: message.contextToken,
              text,
            });
            input.stateStore.recordDeliveryAttempt({
              conversationKey: message.conversationKey,
              status: "thinking_sent",
              finalMessage: text,
            });
          },
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
              weixinClient: input.weixinClient,
              peerUserId: message.peerUserId,
              contextToken: message.contextToken,
              finalText,
            })
          : { messageId: "progress-only" };
        sendMs = Date.now() - sendStartedAt;

        input.stateStore.recordDeliveryAttempt({
          conversationKey: message.conversationKey,
          status: "sent",
          finalMessage: finalText || undefined,
        });

        return {
          runnerBackend: result.runnerBackend,
          threadId: result.threadId,
          cwd: result.cwd,
          finalMessage: result.finalMessage,
          outboundMessageId: outbound.messageId,
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
  const nonEmptyLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
  weixinClient: WeixinClient;
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
    const outbound = await input.weixinClient.sendTextMessage({
      peerUserId: input.peerUserId,
      contextToken: input.contextToken,
      text,
    });
    lastMessageId = outbound.messageId;
  }
  return { messageId: lastMessageId };
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
  const trimmed = text.trim();
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
