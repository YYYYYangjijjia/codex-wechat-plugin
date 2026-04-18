import { describe, expect, test } from "vitest";

// @ts-expect-error JS skill script is imported directly for behavior verification.
import { resolveSourceSessionId } from "../../skills/task-finished-notifier/scripts/send_task_finished_notification.mjs";

describe("resolveSourceSessionId", () => {
  const conversation = { runner_thread_id: "bridge-thread-123" };

  test("prefers an explicit session id", () => {
    expect(
      resolveSourceSessionId(
        { sessionId: "explicit-thread-456", useBridgeSession: false },
        conversation,
        { CODEX_THREAD_ID: "current-codex-thread-789" },
      ),
    ).toBe("explicit-thread-456");
  });

  test("uses the current Codex thread id before falling back to unknown", () => {
    expect(
      resolveSourceSessionId(
        { useBridgeSession: false },
        conversation,
        { CODEX_THREAD_ID: "current-codex-thread-789" },
      ),
    ).toBe("current-codex-thread-789");
  });

  test("uses the bridge session only when explicitly requested", () => {
    expect(
      resolveSourceSessionId(
        { useBridgeSession: true },
        conversation,
        { CODEX_THREAD_ID: "current-codex-thread-789" },
      ),
    ).toBe("bridge-thread-123");
  });

  test("returns unknown when no source session metadata is available", () => {
    expect(resolveSourceSessionId({ useBridgeSession: false }, { runner_thread_id: null }, {})).toBe("unknown");
  });
});
