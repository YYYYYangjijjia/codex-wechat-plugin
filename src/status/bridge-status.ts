import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BridgeConfig } from "../config/app-config.js";
import type { StateStore } from "../state/sqlite-state-store.js";

type DaemonRuntimeState = {
  pid?: number | undefined;
  workspaceDir?: string | undefined;
  backend?: string | undefined;
  startedAt?: string | undefined;
  heartbeatAt?: string | undefined;
  activeAccounts?: number | undefined;
};

type DaemonLockRecord = {
  pid?: number | undefined;
  acquiredAt?: string | undefined;
  purpose?: string | undefined;
};

export type BridgeStatusSnapshot = {
  generatedAt: string;
  workspaceDir: string;
  databasePath: string;
  codexBackend: BridgeConfig["codexBackend"];
  accounts: {
    total: number;
    active: number;
    expired: number;
    pending: number;
  };
  conversations: {
    total: number;
  };
  pendingMessages: {
    pending: number;
    failed: number;
  };
  outboundDeliveries: {
    waitingForFreshContext: number;
    failed: number;
  };
  daemon: {
    running: boolean;
    healthy: boolean;
    pid?: number | undefined;
    startedAt?: string | undefined;
    heartbeatAt?: string | undefined;
    activeAccounts?: number | undefined;
  };
  codex: {
    appServerUrl: string;
    appServerConnected: boolean;
    quotaCached: boolean;
  };
  latestReplyTiming?: {
    runnerBackend?: string | undefined;
    typingStartMs?: number | undefined;
    runnerMs?: number | undefined;
    typingStopMs?: number | undefined;
    sendMs?: number | undefined;
    totalMs?: number | undefined;
  };
  recentDiagnostics: Array<{
    code: string;
    createdAt: string;
    detail?: string | undefined;
  }>;
};

export async function collectBridgeStatus(input: {
  config: BridgeConfig;
  stateStore: Pick<StateStore, "listAccounts" | "listConversations" | "listPendingMessages" | "listDiagnostics" | "getRuntimeState"> & Partial<Pick<StateStore, "listOutboundDeliveries">>;
  appServerConnected?: boolean | undefined;
  probeAppServer?: (() => Promise<boolean>) | undefined;
  readDaemonLock?: ((workspaceDir: string) => DaemonLockRecord | undefined) | undefined;
  isDaemonProcessAlive?: ((pid: number) => boolean) | undefined;
}): Promise<BridgeStatusSnapshot> {
  const accounts = input.stateStore.listAccounts();
  const active = accounts.filter((account) => account.loginState === "active").length;
  const expired = accounts.filter((account) => account.loginState === "expired").length;
  const pendingAccounts = accounts.filter((account) => account.loginState === "pending").length;
  const pendingMessages = input.stateStore.listPendingMessages(["pending"]);
  const failedMessages = input.stateStore.listPendingMessages(["failed"]);
  const waitingOutboundDeliveries = input.stateStore.listOutboundDeliveries?.(["waiting_for_fresh_context"]) ?? [];
  const failedOutboundDeliveries = input.stateStore.listOutboundDeliveries?.(["failed"]) ?? [];
  const diagnostics = input.stateStore.listDiagnostics(10);
  const daemonState = parseDaemonRuntimeState(input.stateStore.getRuntimeState("daemon_status"));
  const daemonLock = input.readDaemonLock?.(input.config.workspaceDir) ?? readDaemonLock(input.config.workspaceDir);
  const heartbeatAt = daemonState?.heartbeatAt ? Date.parse(daemonState.heartbeatAt) : Number.NaN;
  const staleThresholdMs = Math.max(30_000, input.config.longPollTimeoutMs * 2 + 10_000);
  const heartbeatFresh = Number.isFinite(heartbeatAt) && (Date.now() - heartbeatAt) <= staleThresholdMs;
  const liveDaemon = resolveLiveDaemon(daemonLock, daemonState, {
    heartbeatFresh,
    isDaemonProcessAlive: input.isDaemonProcessAlive ?? isBridgeDaemonProcessAlive,
  });
  const daemonRunning = typeof liveDaemon?.pid === "number"
    && (input.isDaemonProcessAlive ?? isBridgeDaemonProcessAlive)(liveDaemon.pid);
  const appServerConnected = input.appServerConnected ?? await input.probeAppServer?.() ?? false;
  const latestReplyTiming = parseLatestReplyTiming(diagnostics);

  return {
    generatedAt: new Date().toISOString(),
    workspaceDir: input.config.workspaceDir,
    databasePath: input.config.databasePath,
    codexBackend: input.config.codexBackend,
    accounts: {
      total: accounts.length,
      active,
      expired,
      pending: pendingAccounts,
    },
    conversations: {
      total: input.stateStore.listConversations().length,
    },
    pendingMessages: {
      pending: pendingMessages.length,
      failed: failedMessages.length,
    },
    outboundDeliveries: {
      waitingForFreshContext: waitingOutboundDeliveries.length,
      failed: failedOutboundDeliveries.length,
    },
    daemon: {
      running: daemonRunning,
      healthy: daemonRunning && heartbeatFresh,
      ...(typeof liveDaemon?.pid === "number" ? { pid: liveDaemon.pid } : {}),
      ...(liveDaemon?.startedAt ? { startedAt: liveDaemon.startedAt } : {}),
      ...(daemonState?.heartbeatAt ? { heartbeatAt: daemonState.heartbeatAt } : {}),
      ...(typeof daemonState?.activeAccounts === "number" ? { activeAccounts: daemonState.activeAccounts } : {}),
    },
    codex: {
      appServerUrl: input.config.appServerListenUrl,
      appServerConnected,
      quotaCached: input.stateStore.getRuntimeState("codex_rate_limits") !== undefined,
    },
    ...(latestReplyTiming ? { latestReplyTiming } : {}),
    recentDiagnostics: diagnostics.map((event) => ({
      code: event.code,
      createdAt: event.createdAt,
      ...(event.detail ? { detail: event.detail } : {}),
    })),
  };
}

export function formatBridgeStatus(snapshot: BridgeStatusSnapshot): string {
  return [
    `workspace: ${snapshot.workspaceDir}`,
    `database: ${snapshot.databasePath}`,
    `accounts: ${snapshot.accounts.total} total / ${snapshot.accounts.active} active / ${snapshot.accounts.expired} expired / ${snapshot.accounts.pending} pending`,
    `conversations: ${snapshot.conversations.total}`,
    `pending messages: ${snapshot.pendingMessages.pending} active pending / ${snapshot.pendingMessages.failed} historical failed`,
    `outbound deliveries: ${snapshot.outboundDeliveries.waitingForFreshContext} waiting for fresh WeChat context / ${snapshot.outboundDeliveries.failed} failed`,
    `daemon: ${snapshot.daemon.running ? "running" : "stopped"} / ${snapshot.daemon.healthy ? "healthy" : "stale"}${snapshot.daemon.pid ? ` (pid ${snapshot.daemon.pid})` : ""}`,
    `codex backend: ${snapshot.codexBackend}`,
    `app-server: ${snapshot.codex.appServerConnected ? "connected" : "disconnected"} @ ${snapshot.codex.appServerUrl}`,
    `quota cached: ${snapshot.codex.quotaCached ? "yes" : "no"}`,
    `latest reply timing: ${formatReplyTiming(snapshot.latestReplyTiming)}`,
    "recent diagnostics:",
    ...(snapshot.recentDiagnostics.length > 0
      ? snapshot.recentDiagnostics.map((event) => `- [${event.createdAt}] ${event.code}${event.detail ? ` :: ${shorten(event.detail, 120)}` : ""}`)
      : ["- none"]),
  ].join("\n");
}

function parseDaemonRuntimeState(value: unknown): DaemonRuntimeState | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return {
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.workspaceDir === "string" ? { workspaceDir: value.workspaceDir } : {}),
    ...(typeof value.backend === "string" ? { backend: value.backend } : {}),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.heartbeatAt === "string" ? { heartbeatAt: value.heartbeatAt } : {}),
    ...(typeof value.activeAccounts === "number" ? { activeAccounts: value.activeAccounts } : {}),
  };
}

function resolveLiveDaemon(
  daemonLock: DaemonLockRecord | undefined,
  daemonState: DaemonRuntimeState | undefined,
  options: {
    heartbeatFresh: boolean;
    isDaemonProcessAlive: (pid: number) => boolean;
  },
): { pid?: number | undefined; startedAt?: string | undefined } | undefined {
  if (typeof daemonLock?.pid === "number" && options.isDaemonProcessAlive(daemonLock.pid)) {
    return {
      pid: daemonLock.pid,
      startedAt: daemonLock.acquiredAt ?? daemonState?.startedAt,
    };
  }
  if (
    typeof daemonState?.pid === "number"
    && options.heartbeatFresh
    && options.isDaemonProcessAlive(daemonState.pid)
  ) {
    return {
      pid: daemonState.pid,
      startedAt: daemonState.startedAt,
    };
  }
  return undefined;
}

function readDaemonLock(workspaceDir: string): DaemonLockRecord | undefined {
  const lockPath = path.join(workspaceDir, "state", "daemon.lock");
  if (!fs.existsSync(lockPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      return undefined;
    }
    return {
      ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
      ...(typeof parsed.acquiredAt === "string" ? { acquiredAt: parsed.acquiredAt } : {}),
      ...(typeof parsed.purpose === "string" ? { purpose: parsed.purpose } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseLatestReplyTiming(diagnostics: ReturnType<Pick<StateStore, "listDiagnostics">["listDiagnostics"]>): BridgeStatusSnapshot["latestReplyTiming"] | undefined {
  const event = diagnostics.find((item) => item.code === "reply_timing" && item.detail);
  if (!event?.detail) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(event.detail) as Record<string, unknown>;
    return {
      ...(typeof parsed.runnerBackend === "string" ? { runnerBackend: parsed.runnerBackend } : {}),
      ...(typeof parsed.typingStartMs === "number" ? { typingStartMs: parsed.typingStartMs } : {}),
      ...(typeof parsed.runnerMs === "number" ? { runnerMs: parsed.runnerMs } : {}),
      ...(typeof parsed.typingStopMs === "number" ? { typingStopMs: parsed.typingStopMs } : {}),
      ...(typeof parsed.sendMs === "number" ? { sendMs: parsed.sendMs } : {}),
      ...(typeof parsed.totalMs === "number" ? { totalMs: parsed.totalMs } : {}),
    };
  } catch {
    return undefined;
  }
}

function formatReplyTiming(value: BridgeStatusSnapshot["latestReplyTiming"]): string {
  if (!value?.totalMs) {
    return "none";
  }
  return `${value.runnerBackend ?? "unknown"} / ${value.totalMs} ms`;
}

function shorten(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBridgeDaemonProcessAlive(pid: number): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  if (process.platform !== "win32") {
    return true;
  }
  const commandLine = readWindowsProcessCommandLine(pid);
  if (!commandLine) {
    return false;
  }
  return /daemon\.(?:js|ts)\b/i.test(commandLine);
}

function readWindowsProcessCommandLine(pid: number): string | undefined {
  try {
    const script = [
      "$p = Get-CimInstance Win32_Process -Filter \"ProcessId = " + pid + "\"",
      "if ($p -and $p.CommandLine) { [Console]::Write($p.CommandLine) }",
    ].join("; ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "EPERM";
  }
}
