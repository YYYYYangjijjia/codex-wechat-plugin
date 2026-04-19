import fs from "node:fs";
import path from "node:path";
import type { ReasoningEffort, RunnerBackend } from "../codex/codex-runner.js";

export type BridgeConfig = {
  workspaceDir: string;
  stateDir: string;
  attachmentCacheDir?: string;
  databasePath: string;
  weixinBaseUrl: string;
  ilinkAppId: string;
  ilinkBotType: string;
  packageVersion: string;
  clientVersion: number;
  codexCommand: string;
  codexModel?: string | undefined;
  codexReasoningEffort?: ReasoningEffort | undefined;
  codexBackend: RunnerBackend;
  skipGitRepoCheck: boolean;
  appServerListenUrl: string;
  appServerStartupTimeoutMs: number;
  appServerTurnTimeoutMs: number;
  longPollTimeoutMs: number;
  loopIdleDelayMs: number;
};

function readPackageVersion(workspaceDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((value) => Number.parseInt(value, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function loadBridgeConfig(workspaceDir = process.cwd()): BridgeConfig {
  const stateDir = process.env.WECHAT_BRIDGE_STATE_DIR?.trim() || path.join(workspaceDir, "state");
  const attachmentCacheDir = process.env.WECHAT_BRIDGE_ATTACHMENT_CACHE_DIR?.trim()
    || path.join(workspaceDir, ".cache", "wechat-bridge", "inbound-attachments");
  const packageVersion = readPackageVersion(workspaceDir);
  return {
    workspaceDir,
    stateDir,
    attachmentCacheDir,
    databasePath: path.join(stateDir, "bridge.sqlite"),
    weixinBaseUrl: process.env.WEIXIN_API_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com",
    ilinkAppId: process.env.WEIXIN_ILINK_APP_ID?.trim() || "bot",
    ilinkBotType: process.env.WEIXIN_ILINK_BOT_TYPE?.trim() || "3",
    packageVersion,
    clientVersion: buildClientVersion(packageVersion),
    codexCommand: process.env.CODEX_COMMAND?.trim() || "codex",
    codexModel: process.env.CODEX_MODEL?.trim() || undefined,
    codexReasoningEffort: parseReasoningEffort(process.env.CODEX_REASONING_EFFORT),
    codexBackend: process.env.CODEX_BACKEND?.trim() === "exec" ? "exec" : "app_server",
    skipGitRepoCheck: process.env.CODEX_SKIP_GIT_REPO_CHECK !== "false",
    appServerListenUrl: process.env.CODEX_APP_SERVER_URL?.trim() || "ws://127.0.0.1:4500",
    appServerStartupTimeoutMs: Number.parseInt(process.env.CODEX_APP_SERVER_STARTUP_TIMEOUT_MS ?? "10000", 10),
    appServerTurnTimeoutMs: Number.parseInt(process.env.CODEX_APP_SERVER_TURN_TIMEOUT_MS ?? "300000", 10),
    longPollTimeoutMs: Number.parseInt(process.env.WECHAT_LONG_POLL_TIMEOUT_MS ?? "35000", 10),
    loopIdleDelayMs: Number.parseInt(process.env.WECHAT_LOOP_IDLE_DELAY_MS ?? "1000", 10),
  };
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  const normalized = value?.trim();
  switch (normalized) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    default:
      return undefined;
  }
}
