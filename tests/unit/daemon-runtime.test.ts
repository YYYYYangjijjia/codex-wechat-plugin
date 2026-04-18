import { describe, expect, test, vi } from "vitest";

import { runBridgeDaemonRuntime } from "../../src/daemon/daemon-runtime.js";

describe("runBridgeDaemonRuntime", () => {
  test("restarts after an unexpected daemon-loop crash", async () => {
    const lifecycle: string[] = [];
    const diagnostics: string[] = [];
    let attempts = 0;

    await runBridgeDaemonRuntime({
      restartDelayMs: 0,
      createStateStore: () => ({
        getRuntimeState() {
          return attempts === 0 ? undefined : { pid: 1 };
        },
        recordDiagnostic(entry) {
          diagnostics.push(entry.code);
        },
        close() {},
      }),
      createService: () => ({
        async notifyLifecycle(input) {
          lifecycle.push(`${input.phase}:${input.detail ?? ""}`);
        },
        async runDaemonLoop() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("boom");
          }
        },
      }),
      error: vi.fn(),
    });

    expect(attempts).toBe(2);
    expect(diagnostics).toEqual(["daemon_runtime_restart"]);
    expect(lifecycle).toEqual([
      "online:daemon started",
      "offline:daemon loop crashed; restarting",
      "online:daemon recovered after unexpected stop",
    ]);
  });

  test("stops cleanly when the abort signal is raised", async () => {
    const abortController = new AbortController();
    let runs = 0;

    await runBridgeDaemonRuntime({
      abortSignal: abortController.signal,
      restartDelayMs: 0,
      createStateStore: () => ({
        getRuntimeState() {
          return undefined;
        },
        recordDiagnostic() {},
        close() {},
      }),
      createService: () => ({
        async notifyLifecycle() {},
        async runDaemonLoop(signal) {
          runs += 1;
          abortController.abort();
          if (signal?.aborted) {
            return;
          }
        },
      }),
    });

    expect(runs).toBe(1);
  });
});
