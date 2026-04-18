export type NotificationConversation = {
  runner_thread_id?: string | null;
};

export type NotificationOptions = {
  sessionId?: string;
  useBridgeSession?: boolean;
};

export function resolveSourceSessionId(
  options: NotificationOptions,
  conversation: NotificationConversation,
  env?: Record<string, string | undefined>,
): string;
