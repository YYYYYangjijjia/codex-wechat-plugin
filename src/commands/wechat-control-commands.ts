import fs from "node:fs";
import path from "node:path";
import type { AppServerModelSummary, AppServerThreadSummary } from "../codex/app-server-client.js";
import type { ReasoningEffort, RunnerBackend } from "../codex/codex-runner.js";
import type { InstalledSkillsCatalog } from "./installed-skills.js";
import type { AccountRecord, ConversationRecord, DiagnosticEvent, PendingMessageRecord } from "../state/sqlite-state-store.js";

type ControlCommandStore = {
  clearConversationThread(conversationKey: string): void;
  updateConversationThread(conversationKey: string, thread: { runnerBackend: RunnerBackend; runnerThreadId: string; runnerCwd?: string | undefined }): void;
  saveRuntimeState(key: string, value: unknown): void;
  getRuntimeState(key: string): unknown;
  listConversations(): ConversationRecord[];
  listAccounts(): AccountRecord[];
  listPendingMessages(statuses?: Array<PendingMessageRecord["status"]>): PendingMessageRecord[];
  listDiagnostics(limit?: number): DiagnosticEvent[];
};

type RuntimePreferences = {
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  showFinalSummary?: boolean | undefined;
};

type ActiveTaskSummary = {
  prompt: string;
  runnerBackend?: RunnerBackend | undefined;
  supportsAppend?: boolean | undefined;
};

type PendingReviewSummary = {
  count: number;
  items: string[];
};

type TestSessionBinding = {
  threadId: string;
};

type SessionRecordEntry = {
  name: string;
  threadId: string;
};

type PendingConfirmation =
  | { kind: "clear_session_records"; createdAt: string };

type CommandAction =
  | { type: "stop" }
  | { type: "restart_bridge" }
  | { type: "fallback_continue" }
  | { type: "append"; guidance: string }
  | { type: "use_session"; threadId: string; afterSwitch?: "remember_non_test" | "clear_test_return" }
  | { type: "quota_read" }
  | { type: "pending_continue" }
  | { type: "pending_clear" };

type ParsedCommand = {
  name: string;
  args: string[];
};

type SystemMessageCategory = "control" | "status" | "config" | "success" | "warning";

export const TEST_SESSION_BINDING_KEY = "test_session_binding";
export const NEXT_NEW_SESSION_NAME_PREFIX = "next_new_session_name:";
export const TEST_SESSION_RETURN_PREFIX = "test_session_return:";
export const SESSION_RECORDS_KEY = "session_records";
export const PENDING_CONFIRMATION_PREFIX = "pending_confirmation:";
const PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

export function parseWechatControlCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const body = trimmed.slice(1).trim();
  if (!body) {
    return undefined;
  }
  const [name, ...args] = body.split(/\s+/).filter(Boolean);
  if (!name) {
    return undefined;
  }
  return {
    name: name.toLowerCase(),
    args,
  };
}

export function handleWechatControlCommand(input: {
  text: string;
  stateStore: ControlCommandStore;
  conversation: ConversationRecord;
  workspaceDir: string;
  primaryBackend: RunnerBackend;
  defaultModel?: string | undefined;
  defaultReasoningEffort?: ReasoningEffort | undefined;
  activeTask?: ActiveTaskSummary | undefined;
  installedSkills?: InstalledSkillsCatalog;
  availableSessions?: AppServerThreadSummary[];
  currentSession?: AppServerThreadSummary | undefined;
  availableModels?: AppServerModelSummary[];
  pendingReview?: PendingReviewSummary | undefined;
  pendingMessages?: PendingMessageRecord[] | undefined;
}): { handled: boolean; responseText?: string | undefined; action?: CommandAction | undefined } {
  const parsed = parseWechatControlCommand(input.text);
  if (!parsed) {
    return { handled: false };
  }
  const existingConfirmation = readPendingConfirmation(input.stateStore, input.conversation.conversationKey);
  if (parsed.name !== "yes" && parsed.name !== "no" && existingConfirmation) {
    clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
  }
  const runtimePreferences = readRuntimePreferences(input.stateStore.getRuntimeState("codex_runtime_preferences"));
  const effectiveWorkspaceDir = input.currentSession?.cwd ?? input.conversation.runnerCwd ?? input.workspaceDir;

  switch (parsed.name) {
    case "help":
      return {
        handled: true,
        responseText: formatSystemReply("control", [
          "Available commands:",
          "- /help - show this command list",
          "- /pwd - show the current workspace directory",
          "- /session - show the current Codex session mapping for this WeChat chat",
          "- /new-session [name] - clear the mapped Codex session; optionally name the next new session",
          "- /newsession - legacy alias for /new-session",
          "- /use-session <id> - bind this WeChat chat to a specific Codex session id",
          "- /test-session - switch this chat to the configured shared test session",
          "- /test-session bind <id> - bind the shared test session id",
          "- /test-session quit - leave the shared test session and return to the latest non-test session",
          "- /test-session unbind - clear the shared test session id",
          "- /record-session - list saved session records",
          "- /record-session add <record-name> <session-id> - save a persistent alias for a session id",
          "- /record-session delete <record-name> - delete a saved session record",
          "- /record-session clear - request confirmation before clearing all saved session records",
          "- /use-record <record-name> - switch this chat to a saved session record",
          "- /yes - confirm the pending destructive action for this chat",
          "- /no - cancel the pending destructive action for this chat",
          "- /quota - show the current Codex rate-limit snapshot",
          "- /skills - show the currently installed local and plugin skills",
          "- /stop - interrupt the current Codex task for this chat",
          "- /fallback continue - switch the current timed-out app_server task to exec fallback",
          "- /restart - restart the current bridge daemon for this chat",
          "- /append <text> - steer the current in-flight Codex task with more guidance",
          "- /pending - show the current backlog review summary for this chat",
          "- /pending continue - release pending backlog messages to Codex",
          "- /pending clear - discard pending backlog messages for this chat",
          "- /model [id|default] - show or override the bridge model for new turns",
          "- /effort [minimal|low|medium|high|xhigh|default] - show or override the bridge reasoning effort",
          "- /final [on|off|default] - show or override whether the final full summary is sent",
          "- /status - show the current bridge status for this chat",
          "- /diagnostics [n] - show the most recent diagnostic events",
          "- /threads - show this chat mapping and recent conversation mappings",
          "- /sessions [n] - list recent Codex app-server sessions you can bind with /use-session",
          "- /ls [path] - list files in the current workspace or a relative subdirectory",
        ].join("\n")),
      };
    case "pwd":
    case "cwd":
      return {
        handled: true,
        responseText: formatSystemReply("control", `workspace: ${effectiveWorkspaceDir}`),
      };
    case "session":
      return {
        handled: true,
        responseText: formatSystemReply("config", formatSession({
          conversation: input.conversation,
          currentSession: input.currentSession,
        })),
      };
    case "newsession":
    case "new-session":
    case "newthread":
    case "new-thread": {
      const requestedName = parsed.args.join(" ").trim();
      input.stateStore.clearConversationThread(input.conversation.conversationKey);
      saveNextNewSessionName(input.stateStore, input.conversation.conversationKey, requestedName || undefined);
      return {
        handled: true,
        responseText: formatSystemReply("config", requestedName
          ? `Cleared the current session mapping. The next normal message will start a new Codex session named ${requestedName}.`
          : "Cleared the current session mapping. The next normal message will start a new Codex session."),
      };
    }
    case "use-session": {
      const threadId = parsed.args[0];
      if (!threadId) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "Usage: /use-session <session-id>"),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("config", `Switching this chat to session ${threadId}. Verifying the target workspace first.`),
        action: { type: "use_session", threadId },
      };
    }
    case "use-record": {
      const recordName = parsed.args[0]?.trim();
      if (!recordName) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "Usage: /use-record <record-name>"),
        };
      }
      const records = readSessionRecords(input.stateStore.getRuntimeState(SESSION_RECORDS_KEY));
      const record = findSessionRecord(records, recordName);
      if (!record) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", `No saved session record named ${recordName} exists.`),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("config", `Switching this chat to saved record ${record.name} (${record.threadId}).`),
        action: { type: "use_session", threadId: record.threadId },
      };
    }
    case "test-session": {
      const subcommand = parsed.args[0]?.toLowerCase();
      const binding = readTestSessionBinding(input.stateStore.getRuntimeState(TEST_SESSION_BINDING_KEY));
      if (!subcommand) {
        if (!binding?.threadId) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "No shared /test-session is configured yet. Use /test-session bind <session-id> first."),
          };
        }
        const currentThreadId = input.conversation.runnerThreadId ?? input.conversation.codexThreadId ?? undefined;
        if (currentThreadId && currentThreadId !== binding.threadId) {
          saveTestSessionReturnThread(input.stateStore, input.conversation.conversationKey, currentThreadId);
        }
        return {
          handled: true,
          responseText: formatSystemReply("config", `Switching this chat to the configured test session ${binding.threadId}.`),
          action: { type: "use_session", threadId: binding.threadId, afterSwitch: "remember_non_test" },
        };
      }
      if (subcommand === "bind") {
        const threadId = parsed.args.slice(1).join(" ").trim();
        if (!threadId) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "Usage: /test-session bind <session-id>"),
          };
        }
        input.stateStore.saveRuntimeState(TEST_SESSION_BINDING_KEY, { threadId });
        return {
          handled: true,
          responseText: formatSystemReply("config", `Bound /test-session to ${threadId}.`),
        };
      }
      if (subcommand === "quit") {
        if (!binding?.threadId) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "No shared /test-session is configured yet. Use /test-session bind <session-id> first."),
          };
        }
        const currentThreadId = input.conversation.runnerThreadId ?? input.conversation.codexThreadId ?? undefined;
        if (!currentThreadId || currentThreadId !== binding.threadId) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "This chat is not currently on the shared test session. Switch with /test-session first."),
          };
        }
        const returnThreadId = readTestSessionReturnThread(input.stateStore, input.conversation.conversationKey);
        if (!returnThreadId) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "No previous non-test session is recorded for this chat yet."),
          };
        }
        return {
          handled: true,
          responseText: formatSystemReply("config", `Leaving the shared test session and returning this chat to ${returnThreadId}.`),
          action: { type: "use_session", threadId: returnThreadId, afterSwitch: "clear_test_return" },
        };
      }
      if (subcommand === "unbind") {
        input.stateStore.saveRuntimeState(TEST_SESSION_BINDING_KEY, null);
        return {
          handled: true,
          responseText: formatSystemReply("config", "Cleared the configured /test-session binding."),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("warning", "Usage: /test-session [bind <session-id>|quit|unbind]"),
      };
    }
    case "record-session": {
      const subcommand = parsed.args[0]?.toLowerCase();
      const records = readSessionRecords(input.stateStore.getRuntimeState(SESSION_RECORDS_KEY));
      if (!subcommand) {
        return {
          handled: true,
          responseText: formatSystemReply("config", formatSessionRecords(records)),
        };
      }
      if (subcommand === "add") {
        const recordName = parsed.args[1]?.trim();
        const threadId = parsed.args[2]?.trim();
        if (!recordName || !threadId) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "Usage: /record-session add <record-name> <session-id>"),
          };
        }
        if (findSessionRecord(records, recordName)) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", `A session record named ${recordName} already exists. Choose a different record name.`),
          };
        }
        const next = [...records, { name: recordName, threadId }];
        saveSessionRecords(input.stateStore, next);
        clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
        return {
          handled: true,
          responseText: formatSystemReply("config", `Saved session record ${recordName} -> ${threadId}.`),
        };
      }
      if (subcommand === "delete") {
        const recordName = parsed.args[1]?.trim();
        if (!recordName) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "Usage: /record-session delete <record-name>"),
          };
        }
        const target = findSessionRecord(records, recordName);
        if (!target) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", `No saved session record named ${recordName} exists.`),
          };
        }
        saveSessionRecords(input.stateStore, records.filter((entry) => normalizeRecordName(entry.name) !== normalizeRecordName(target.name)));
        clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
        return {
          handled: true,
          responseText: formatSystemReply("config", `Deleted session record ${target.name}.`),
        };
      }
      if (subcommand === "clear") {
        if (records.length === 0) {
          return {
            handled: true,
            responseText: formatSystemReply("warning", "There are no saved session records to clear."),
          };
        }
        savePendingConfirmation(input.stateStore, input.conversation.conversationKey, { kind: "clear_session_records", createdAt: new Date().toISOString() });
        return {
          handled: true,
          responseText: formatSystemReply("warning", "This will clear all saved session records. Reply with /yes to confirm or /no to cancel within 5 minutes. Any other command will cancel it."),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("warning", "Usage: /record-session [add <record-name> <session-id>|delete <record-name>|clear]"),
      };
    }
    case "yes": {
      const confirmation = readPendingConfirmation(input.stateStore, input.conversation.conversationKey);
      if (!confirmation) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "There is no pending action waiting for confirmation."),
        };
      }
      if (isPendingConfirmationExpired(confirmation)) {
        clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
        return {
          handled: true,
          responseText: formatSystemReply("warning", "The pending confirmation has expired. Run the original command again if you still want to do it."),
        };
      }
      clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
      if (confirmation.kind === "clear_session_records") {
        saveSessionRecords(input.stateStore, []);
        return {
          handled: true,
          responseText: formatSystemReply("success", "Cleared all saved session records."),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("warning", "The pending confirmation could not be resolved."),
      };
    }
    case "no": {
      const confirmation = readPendingConfirmation(input.stateStore, input.conversation.conversationKey);
      if (!confirmation) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "There is no pending action waiting for confirmation."),
        };
      }
      if (isPendingConfirmationExpired(confirmation)) {
        clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
        return {
          handled: true,
          responseText: formatSystemReply("warning", "The pending confirmation has already expired."),
        };
      }
      clearPendingConfirmation(input.stateStore, input.conversation.conversationKey);
      return {
        handled: true,
        responseText: formatSystemReply("config", "Canceled the pending action."),
      };
    }
    case "quota":
      return {
        handled: true,
        responseText: formatSystemReply("status", "Reading the current Codex quota snapshot."),
        action: { type: "quota_read" },
      };
    case "stop":
      return {
        handled: true,
        responseText: formatSystemReply("control", "Checking for an active task to stop for this chat."),
        action: { type: "stop" },
      };
    case "fallback": {
      const subcommand = parsed.args[0]?.trim().toLowerCase();
      if (subcommand === "continue") {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "Checking whether the current app_server task can switch to exec fallback."),
          action: { type: "fallback_continue" },
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("warning", "Usage: /fallback continue"),
      };
    }
    case "append": {
      const guidance = parsed.args.join(" ").trim();
      if (!guidance) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "Usage: /append <additional guidance>"),
        };
      }
      if (input.activeTask && !input.activeTask.supportsAppend) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", `The current task is running on ${input.activeTask.runnerBackend ?? "an unsupported backend"}, so /append may be unavailable. If this keeps failing, use /stop and send a new message instead.`),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("control", "Trying to append your guidance to the current task."),
        action: { type: "append", guidance },
      };
    }
    case "restart":
      return {
        handled: true,
        responseText: formatSystemReply("warning", "Restarting the current bridge daemon after this reply is sent."),
        action: { type: "restart_bridge" },
      };
    case "pending": {
      const subcommand = parsed.args[0]?.toLowerCase();
      const pendingMessages = input.pendingMessages
        ?? input.stateStore
          .listPendingMessages(["pending"])
          .filter((row) => row.conversationKey === input.conversation.conversationKey);
      if (!subcommand) {
        return {
          handled: true,
          responseText: formatSystemReply("status", formatPendingState({
            pendingMessages,
            ...(input.pendingReview ? { pendingReview: input.pendingReview } : {}),
            ...(input.activeTask ? { activeTask: input.activeTask } : {}),
          })),
        };
      }
      if (subcommand === "continue") {
        return {
          handled: true,
          responseText: formatSystemReply("control", "Confirmed. Releasing the pending backlog for this chat."),
          action: { type: "pending_continue" },
        };
      }
      if (subcommand === "clear") {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "Confirmed. Clearing the pending backlog for this chat."),
          action: { type: "pending_clear" },
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("warning", "Usage: /pending [continue|clear]"),
      };
    }
    case "model": {
      const value = parsed.args.join(" ").trim();
      if (!value) {
        const effectiveModel = resolveEffectiveModel({
          runtimePreferences,
          defaultModel: input.defaultModel,
          availableModels: input.availableModels,
        });
        return {
          handled: true,
          responseText: formatSystemReply("config", formatModelStatus({
            effectiveModel,
            availableModels: input.availableModels,
          })),
        };
      }
      if (value.toLowerCase() === "default") {
        const next = { ...runtimePreferences };
        delete next.model;
        saveRuntimePreferences(input.stateStore, next);
        return {
          handled: true,
          responseText: formatSystemReply("config", `Cleared the model override. New turns will use ${input.defaultModel ?? "the default model"}.`),
        };
      }
      saveRuntimePreferences(input.stateStore, {
        ...runtimePreferences,
        model: value,
      });
      return {
        handled: true,
        responseText: formatSystemReply("config", `Set the bridge model to ${value}. New turns will use it.`),
      };
    }
    case "effort": {
      const value = parsed.args[0]?.trim().toLowerCase();
      if (!value) {
        const effectiveModel = resolveEffectiveModel({
          runtimePreferences,
          defaultModel: input.defaultModel,
          availableModels: input.availableModels,
        });
        const effectiveEffort = resolveEffectiveReasoningEffort({
          runtimePreferences,
          defaultReasoningEffort: input.defaultReasoningEffort,
          availableModels: input.availableModels,
          effectiveModel,
        });
        return {
          handled: true,
          responseText: formatSystemReply("config", formatEffortStatus({
            effectiveModel,
            effectiveEffort,
            availableModels: input.availableModels,
          })),
        };
      }
      if (value === "default") {
        const next = { ...runtimePreferences };
        delete next.reasoningEffort;
        saveRuntimePreferences(input.stateStore, next);
        return {
          handled: true,
          responseText: formatSystemReply("config", `Cleared the reasoning effort override. New turns will use ${input.defaultReasoningEffort ?? "the default effort"}.`),
        };
      }
      if (!isReasoningEffort(value)) {
        return {
          handled: true,
          responseText: formatSystemReply("warning", "Usage: /effort [minimal|low|medium|high|xhigh|default]"),
        };
      }
      saveRuntimePreferences(input.stateStore, {
        ...runtimePreferences,
        reasoningEffort: value,
      });
      return {
        handled: true,
        responseText: formatSystemReply("config", `Set the bridge reasoning effort to ${value}. New turns will use it.`),
      };
    }
    case "final": {
      const value = parsed.args[0]?.trim().toLowerCase();
      if (!value) {
        return {
          handled: true,
          responseText: formatSystemReply("config", formatFinalSummaryStatus(runtimePreferences)),
        };
      }
      if (value === "default") {
        const next = { ...runtimePreferences };
        delete next.showFinalSummary;
        saveRuntimePreferences(input.stateStore, next);
        return {
          handled: true,
          responseText: formatSystemReply("config", "Cleared the final summary override. New turns will use the default final summary behavior."),
        };
      }
      if (value === "on" || value === "off") {
        saveRuntimePreferences(input.stateStore, {
          ...runtimePreferences,
          showFinalSummary: value === "on",
        });
        return {
          handled: true,
          responseText: formatSystemReply("config", `${value === "on" ? "Enabled" : "Disabled"} the final full summary for new turns.`),
        };
      }
      return {
        handled: true,
        responseText: formatSystemReply("warning", "Usage: /final [on|off|default]"),
      };
    }
    case "skills":
      return {
        handled: true,
        responseText: formatSystemReply("control", formatInstalledSkills(input.installedSkills)),
      };
    case "status":
      return {
        handled: true,
        responseText: formatSystemReply("status", formatStatus({
          workspaceDir: effectiveWorkspaceDir,
          conversation: input.conversation,
          currentSession: input.currentSession,
          accounts: input.stateStore.listAccounts(),
          pendingMessages: input.stateStore.listPendingMessages(["pending"]),
          diagnostics: input.stateStore.listDiagnostics(20),
        })),
      };
    case "diagnostics":
      return {
        handled: true,
        responseText: formatSystemReply("status", formatDiagnostics(input.stateStore.listDiagnostics(parseLimitArg(parsed.args[0], 5, 20)))),
      };
    case "threads":
      return {
        handled: true,
        responseText: formatSystemReply("control", formatThreads({
          currentConversation: input.conversation,
          conversations: input.stateStore.listConversations(),
        })),
      };
    case "sessions":
      return {
        handled: true,
        responseText: formatSystemReply("control", formatAvailableSessions(input.availableSessions, parseLimitArg(parsed.args[0], 5, 20))),
      };
    case "ls":
      return {
        handled: true,
        responseText: formatSystemReply("control", formatWorkspaceListing({
          workspaceDir: effectiveWorkspaceDir,
          relativePath: parsed.args[0],
        })),
      };
    default:
      return {
        handled: true,
        responseText: formatSystemReply("warning", `Unknown command: /${parsed.name}\nUse /help to see available commands.`),
      };
  }
}

function formatSystemReply(category: SystemMessageCategory, text: string): string {
  const emoji = systemMessageEmoji(category);
  const trimmed = text.trim();
  if (!trimmed) {
    return `${emoji}`;
  }
  const [firstLine, ...rest] = trimmed.split("\n");
  return [`${emoji} ${firstLine}`, ...rest].join("\n");
}

function systemMessageEmoji(category: SystemMessageCategory): string {
  switch (category) {
    case "control":
      return "🛠️";
    case "status":
      return "📡";
    case "config":
      return "⚙️";
    case "success":
      return "✅";
    case "warning":
      return "⚠️";
  }
}

function formatInstalledSkills(value?: InstalledSkillsCatalog): string {
  const local = value?.local ?? [];
  const plugin = value?.plugin ?? [];
  return [
    "local skills:",
    ...formatSkillLines(local),
    "",
    "plugin skills:",
    ...formatSkillLines(plugin),
  ].join("\n");
}

function formatSkillLines(names: string[]): string[] {
  if (names.length === 0) {
    return ["- none"];
  }
  return names.map((name) => `- ${name}`);
}

function formatStatus(input: {
  workspaceDir: string;
  conversation: ConversationRecord;
  currentSession?: AppServerThreadSummary | undefined;
  accounts: AccountRecord[];
  pendingMessages: PendingMessageRecord[];
  diagnostics: DiagnosticEvent[];
}): string {
  const activeAccounts = input.accounts.filter((account) => account.loginState === "active");
  const lastReplyTiming = input.diagnostics.find((event) => event.code === "reply_timing");
  const lastReplyFailure = input.diagnostics.find((event) => event.code === "reply_failed");
  const sessionName = input.currentSession?.name?.trim();
  return [
    `workspace: ${input.workspaceDir}`,
    `accounts: ${input.accounts.length} total / ${activeAccounts.length} active`,
    `pending messages: ${input.pendingMessages.length}`,
    `current backend: ${input.conversation.runnerBackend ?? "none"}`,
    `current session: ${input.conversation.runnerThreadId ?? input.conversation.codexThreadId ?? "none"}`,
    `current session name: ${sessionName && sessionName.length > 0 ? sessionName : "unknown"}`,
    `last reply_timing: ${formatReplyTiming(lastReplyTiming)}`,
    `last reply_failed: ${lastReplyFailure ? shorten(lastReplyFailure.detail, 80) : "none"}`,
  ].join("\n");
}

function formatDiagnostics(diagnostics: DiagnosticEvent[]): string {
  if (diagnostics.length === 0) {
    return "recent diagnostics:\n- none";
  }
  return [
    "recent diagnostics:",
    ...diagnostics.map((event) => `- [${event.createdAt}] ${event.code}${event.detail ? ` :: ${shorten(event.detail, 120)}` : ""}`),
  ].join("\n");
}

function formatThreads(input: {
  currentConversation: ConversationRecord;
  conversations: ConversationRecord[];
}): string {
  const recent = input.conversations
    .filter((conversation) => conversation.conversationKey !== input.currentConversation.conversationKey)
    .slice(0, 5);
  return [
    "current conversation:",
    `- ${formatConversationSummary(input.currentConversation)}`,
    "",
    "recent conversations:",
    ...(recent.length > 0 ? recent.map((conversation) => `- ${formatConversationSummary(conversation)}`) : ["- none"]),
  ].join("\n");
}

function formatConversationSummary(conversation: ConversationRecord): string {
  return `${conversation.conversationKey} | ${conversation.runnerBackend ?? "none"} | ${conversation.runnerThreadId ?? conversation.codexThreadId ?? "none"} | ${conversation.runnerCwd ?? "workspace: unknown"}`;
}

function formatAvailableSessions(sessions: AppServerThreadSummary[] | undefined, limit: number): string {
  const visible = (sessions ?? []).slice(0, limit);
  return [
    "available sessions:",
    ...(visible.length > 0
      ? visible.map((session) => {
          const parts = [
            session.id,
            session.name ?? "unnamed",
            session.sourceKind ?? "unknown",
            `workspace: ${shortenMiddle(session.cwd ?? "unknown", 48)}`,
          ];
          if (session.preview?.trim()) {
            parts.push(shortenMiddle(session.preview.trim(), 64));
          }
          return `- ${parts.join(" | ")}`.trimEnd();
        })
      : ["- none"]),
  ].join("\n");
}

function formatWorkspaceListing(input: {
  workspaceDir: string;
  relativePath: string | undefined;
}): string {
  const targetDir = resolveWorkspacePath(input.workspaceDir, input.relativePath);
  if (!targetDir) {
    return "Usage: /ls [relative-path-inside-workspace]";
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch (error) {
    return `Unable to list ${targetDir}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const lines = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 20)
    .map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`);
  return [
    `path: ${targetDir}`,
    ...(lines.length > 0 ? lines : ["- empty"]),
    ...(entries.length > 20 ? [`- ... ${entries.length - 20} more`] : []),
  ].join("\n");
}

function resolveWorkspacePath(workspaceDir: string, relativePath?: string): string | undefined {
  if (!relativePath) {
    return workspaceDir;
  }
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  const resolved = path.resolve(workspaceDir, relativePath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

function formatSession(input: {
  conversation: ConversationRecord;
  currentSession?: AppServerThreadSummary | undefined;
}): string {
  const conversation = input.conversation;
  const backend = conversation.runnerBackend ?? "none";
  const threadId = conversation.runnerThreadId ?? conversation.codexThreadId ?? "none";
  const sessionName = input.currentSession?.name?.trim();
  const workspace = input.currentSession?.cwd ?? conversation.runnerCwd ?? "unknown";
  const sessionNameText = sessionName && sessionName.length > 0
    ? sessionName
    : backend === "exec"
      ? "unavailable on exec backend"
      : "unknown";
  return [
    `conversation: ${conversation.conversationKey}`,
    `backend: ${backend}`,
    `session: ${threadId}`,
    `session name: ${sessionNameText}`,
    `workspace: ${workspace}`,
  ].join("\n");
}

function formatReplyTiming(event?: DiagnosticEvent): string {
  if (!event?.detail) {
    return "none";
  }
  try {
    const parsed = JSON.parse(event.detail) as { runnerBackend?: string; totalMs?: number };
    if (parsed.totalMs) {
      return `${parsed.runnerBackend ?? "unknown"} / ${parsed.totalMs} ms`;
    }
  } catch {
    // fall through
  }
  return shorten(event.detail, 80);
}

function formatModelStatus(input: {
  effectiveModel?: string | undefined;
  availableModels?: AppServerModelSummary[] | undefined;
}): string {
  const lines = [
    `current model: ${input.effectiveModel ?? "unknown"}`,
  ];
  if (input.availableModels?.length) {
    lines.push("available models:");
    lines.push(...input.availableModels.map((model) => {
      const tags: string[] = [];
      if (model.isDefault) {
        tags.push("default");
      }
      if (model.defaultReasoningEffort) {
        tags.push(`default effort ${model.defaultReasoningEffort}`);
      }
      if (model.supportedReasoningEfforts.length > 0) {
        tags.push(`efforts: ${model.supportedReasoningEfforts.join(", ")}`);
      }
      return `- ${model.id}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}`;
    }));
  }
  return lines.join("\n");
}

function formatEffortStatus(input: {
  effectiveModel?: string | undefined;
  effectiveEffort?: ReasoningEffort | undefined;
  availableModels?: AppServerModelSummary[] | undefined;
}): string {
  const lines = [
    `current reasoning effort: ${input.effectiveEffort ?? "unknown"}`,
  ];
  const selectedModel = input.availableModels?.find((model) => model.id === input.effectiveModel)
    ?? input.availableModels?.find((model) => model.isDefault);
  if (selectedModel?.supportedReasoningEfforts.length) {
    lines.push(`available efforts for ${selectedModel.id}: ${selectedModel.supportedReasoningEfforts.join(", ")}`);
  }
  return lines.join("\n");
}

function resolveEffectiveModel(input: {
  runtimePreferences: RuntimePreferences;
  defaultModel?: string | undefined;
  availableModels?: AppServerModelSummary[] | undefined;
}): string | undefined {
  return input.runtimePreferences.model
    ?? input.defaultModel
    ?? input.availableModels?.find((model) => model.isDefault)?.id
    ?? input.availableModels?.[0]?.id;
}

function resolveEffectiveReasoningEffort(input: {
  runtimePreferences: RuntimePreferences;
  defaultReasoningEffort?: ReasoningEffort | undefined;
  availableModels?: AppServerModelSummary[] | undefined;
  effectiveModel?: string | undefined;
}): ReasoningEffort | undefined {
  if (input.runtimePreferences.reasoningEffort) {
    return input.runtimePreferences.reasoningEffort;
  }
  if (input.defaultReasoningEffort) {
    return input.defaultReasoningEffort;
  }
  const selectedModel = input.availableModels?.find((model) => model.id === input.effectiveModel)
    ?? input.availableModels?.find((model) => model.isDefault);
  return selectedModel?.defaultReasoningEffort ?? selectedModel?.supportedReasoningEfforts[0];
}

function parseLimitArg(value: string | undefined, defaultValue: number, maxValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.min(Math.trunc(parsed), maxValue);
}

function shorten(value: string | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function shortenMiddle(value: string | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.max(1, Math.floor((maxLength - 6) / 2));
  const tail = Math.max(1, maxLength - 6 - head);
  return `${value.slice(0, head)} ... ... ${value.slice(value.length - tail)}`;
}

function formatQuota(value: unknown): string {
  if (!isObject(value)) {
    return "No Codex quota snapshot is available yet.";
  }

  const primary = isObject(value.primary) ? value.primary : undefined;
  const secondary = isObject(value.secondary) ? value.secondary : undefined;
  const credits = isObject(value.credits) ? value.credits : undefined;
  const lines = ["current quota:"];

  if (primary) {
    lines.push(`primary: ${primary.usedPercent ?? "?"}% used / ${primary.windowDurationMins ?? "?"} min window / resets ${formatReset(primary.resetsAt)}`);
  }
  if (secondary) {
    lines.push(`secondary: ${secondary.usedPercent ?? "?"}% used / ${secondary.windowDurationMins ?? "?"} min window / resets ${formatReset(secondary.resetsAt)}`);
  }
  if (credits) {
    lines.push(`credits: hasCredits=${String(credits.hasCredits)} unlimited=${String(credits.unlimited)} balance=${credits.balance ?? "n/a"}`);
  }

  return lines.join("\n");
}

function formatPendingState(input: {
  pendingReview?: PendingReviewSummary;
  pendingMessages?: PendingMessageRecord[];
  activeTask?: ActiveTaskSummary;
}): string {
  const pendingMessages = input.pendingMessages ?? [];
  const backlogCount = input.pendingReview?.count ?? 0;
  if (backlogCount === 0 && pendingMessages.length === 0) {
    return input.activeTask
      ? "No pending queued messages are waiting for this chat. The current task is still running."
      : "No pending queued messages or backlog review are waiting for this chat.";
  }
  const lines = [
    `queued pending messages: ${pendingMessages.length}`,
  ];
  if (pendingMessages.length > 0) {
    lines.push(
      ...pendingMessages
        .slice()
        .sort((left, right) => left.id - right.id)
        .slice(0, 5)
        .map((row, index) => `- queued ${index + 1}. ${shorten(row.prompt, 80)}`),
    );
  }
  lines.push(`pending backlog review: ${backlogCount}`);
  if (backlogCount > 0 && input.pendingReview) {
    lines.push(...input.pendingReview.items.map((item, index) => `- backlog ${index + 1}. ${item}`));
  }
  lines.push("");
  lines.push("Use /pending continue to release queued/backlog work, or /pending clear to discard pending queued/backlog work for this chat.");
  return lines.join("\n");
}

function formatSessionRecords(records: SessionRecordEntry[]): string {
  if (records.length === 0) {
    return "saved session records:\n- none";
  }
  return [
    "saved session records:",
    ...records
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((record) => `- ${record.name} -> ${record.threadId}`),
  ].join("\n");
}

function formatReset(value: unknown): string {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : "unknown";
}

function formatFinalSummaryStatus(runtimePreferences: RuntimePreferences): string {
  return `final summary: ${runtimePreferences.showFinalSummary === false ? "off" : "on"}`;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function readRuntimePreferences(value: unknown): RuntimePreferences {
  if (!isObject(value)) {
    return {};
  }
  const preferences: RuntimePreferences = {};
  if (typeof value.model === "string" && value.model.trim()) {
    preferences.model = value.model.trim();
  }
  if (isReasoningEffort(value.reasoningEffort)) {
    preferences.reasoningEffort = value.reasoningEffort;
  }
  if (typeof value.showFinalSummary === "boolean") {
    preferences.showFinalSummary = value.showFinalSummary;
  }
  return preferences;
}

function saveRuntimePreferences(stateStore: ControlCommandStore, value: RuntimePreferences): void {
  stateStore.saveRuntimeState("codex_runtime_preferences", sanitizeRuntimePreferences(value));
}

function readTestSessionBinding(value: unknown): TestSessionBinding | undefined {
  if (!isObject(value) || typeof value.threadId !== "string" || !value.threadId.trim()) {
    return undefined;
  }
  return {
    threadId: value.threadId.trim(),
  };
}

function readSessionRecords(value: unknown): SessionRecordEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is { name: unknown; threadId: unknown } => isObject(entry))
    .map((entry) => ({
      name: typeof entry.name === "string" ? entry.name.trim() : "",
      threadId: typeof entry.threadId === "string" ? entry.threadId.trim() : "",
    }))
    .filter((entry) => entry.name.length > 0 && entry.threadId.length > 0);
}

function saveSessionRecords(stateStore: ControlCommandStore, records: SessionRecordEntry[]): void {
  stateStore.saveRuntimeState(SESSION_RECORDS_KEY, records.map((record) => ({ name: record.name, threadId: record.threadId })));
}

function findSessionRecord(records: SessionRecordEntry[], recordName: string): SessionRecordEntry | undefined {
  const normalized = normalizeRecordName(recordName);
  return records.find((entry) => normalizeRecordName(entry.name) === normalized);
}

function normalizeRecordName(value: string): string {
  return value.trim().toLowerCase();
}

function readTestSessionReturnThread(stateStore: ControlCommandStore, conversationKey: string): string | undefined {
  const value = stateStore.getRuntimeState(`${TEST_SESSION_RETURN_PREFIX}${conversationKey}`);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPendingConfirmation(stateStore: ControlCommandStore, conversationKey: string): PendingConfirmation | undefined {
  const value = stateStore.getRuntimeState(`${PENDING_CONFIRMATION_PREFIX}${conversationKey}`);
  if (!isObject(value)) {
    return undefined;
  }
  if (value.kind === "clear_session_records" && typeof value.createdAt === "string" && value.createdAt.trim()) {
    return { kind: "clear_session_records", createdAt: value.createdAt };
  }
  return undefined;
}

function savePendingConfirmation(stateStore: ControlCommandStore, conversationKey: string, value: PendingConfirmation): void {
  stateStore.saveRuntimeState(`${PENDING_CONFIRMATION_PREFIX}${conversationKey}`, value);
}

function clearPendingConfirmation(stateStore: ControlCommandStore, conversationKey: string): void {
  stateStore.saveRuntimeState(`${PENDING_CONFIRMATION_PREFIX}${conversationKey}`, null);
}

function isPendingConfirmationExpired(value: PendingConfirmation): boolean {
  const createdAt = Date.parse(value.createdAt);
  if (!Number.isFinite(createdAt)) {
    return true;
  }
  return Date.now() - createdAt > PENDING_CONFIRMATION_TTL_MS;
}

function saveTestSessionReturnThread(stateStore: ControlCommandStore, conversationKey: string, threadId: string | undefined): void {
  stateStore.saveRuntimeState(`${TEST_SESSION_RETURN_PREFIX}${conversationKey}`, threadId?.trim() ? threadId.trim() : null);
}

function saveNextNewSessionName(stateStore: ControlCommandStore, conversationKey: string, value: string | undefined): void {
  stateStore.saveRuntimeState(`${NEXT_NEW_SESSION_NAME_PREFIX}${conversationKey}`, value?.trim() ? value.trim() : null);
}

function sanitizeRuntimePreferences(value: RuntimePreferences): RuntimePreferences {
  const sanitized: RuntimePreferences = {};
  if (value.model?.trim()) {
    sanitized.model = value.model.trim();
  }
  if (value.reasoningEffort) {
    sanitized.reasoningEffort = value.reasoningEffort;
  }
  if (typeof value.showFinalSummary === "boolean") {
    sanitized.showFinalSummary = value.showFinalSummary;
  }
  return sanitized;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
