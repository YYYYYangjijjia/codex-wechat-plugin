import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

type CheckResult = {
  item: string;
  status: "pass" | "fail" | "manual";
  detail: string;
};

function exists(workspaceDir: string, relativePath: string): boolean {
  return fs.existsSync(path.join(workspaceDir, relativePath));
}

function runCheck(command: string, cwd: string): string {
  const executable = process.platform === "win32" ? `cmd /d /s /c "${command}"` : command;
  return execSync(executable, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
}

async function smokeStartMcpServer(workspaceDir: string): Promise<{ status: "pass" | "fail"; detail: string }> {
  const entryPath = path.join(workspaceDir, "dist/src/cli/mcp-server.js");
  if (!fs.existsSync(entryPath)) {
    return { status: "fail", detail: "Missing dist/src/cli/mcp-server.js build artifact." };
  }

  const child = spawn(process.execPath, [entryPath], {
    cwd: workspaceDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const alive = child.exitCode === null && !child.killed;

  if (alive) {
    child.kill();
    return { status: "pass", detail: "MCP stdio server stayed alive for a startup smoke window." };
  }

  return {
    status: "fail",
    detail: stderr.trim() || `MCP server exited early with code ${child.exitCode ?? "unknown"}.`,
  };
}

async function main(): Promise<void> {
  const workspaceDir = process.cwd();
  const checks: CheckResult[] = [];

  checks.push({
    item: "仓库是否已初始化",
    status: exists(workspaceDir, ".git") ? "pass" : "fail",
    detail: exists(workspaceDir, ".git") ? "Found .git directory." : "Missing .git directory.",
  });
  checks.push({
    item: "参考项目是否已复制到本地参考目录",
    status: exists(workspaceDir, "_reference/openclaw-weixin/package.json") ? "pass" : "fail",
    detail: "_reference/openclaw-weixin",
  });
  checks.push({
    item: "是否完成参考源码分析文档",
    status: exists(workspaceDir, "docs/reference-analysis.md") ? "pass" : "fail",
    detail: "docs/reference-analysis.md",
  });
  checks.push({
    item: "是否生成了 Codex plugin 所需的关键文件",
    status:
      exists(workspaceDir, ".codex-plugin/plugin.json") && exists(workspaceDir, ".mcp.json") && exists(workspaceDir, "skills/wechat-bridge-ops/SKILL.md")
        ? "pass"
        : "fail",
    detail: ".codex-plugin/plugin.json, .mcp.json, skills/wechat-bridge-ops/SKILL.md",
  });

  try {
    runCheck("npm run typecheck", workspaceDir);
    runCheck("npm run test", workspaceDir);
    const mcpSmoke = await smokeStartMcpServer(workspaceDir);
    checks.push({
      item: "MCP server 是否可启动",
      status: mcpSmoke.status,
      detail: mcpSmoke.detail,
    });
  } catch (error) {
    checks.push({
      item: "MCP server 是否可启动",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  checks.push({
    item: "是否能完成扫码登录",
    status: "manual",
    detail: "Implemented in code path; requires a real WeChat QR scan on this machine.",
  });
  checks.push({
    item: "是否能收到微信消息",
    status: "manual",
    detail: "Daemon poll loop is implemented; requires live WeChat verification.",
  });
  checks.push({
    item: "是否能从 Codex 触发回复微信消息",
    status: "manual",
    detail: "send_text_message MCP tool and daemon reply path are implemented; requires live verification.",
  });
  checks.push({
    item: "typing / generating 状态做到什么程度",
    status: "pass",
    detail: "Implemented typing start/stop only. No streaming generating chunks.",
  });
  checks.push({
    item: "图片或媒体支持做到什么程度",
    status: "manual",
    detail: "send_image_message is a documented phase-2 placeholder. Text path is implemented.",
  });
  checks.push({
    item: "仍未完成的缺口有哪些",
    status: "pass",
    detail: "Group chats, image/media send, richer login recovery, and live end-to-end validation are still pending.",
  });
  checks.push({
    item: "下一步最小增量开发建议是什么",
    status: "pass",
    detail: "Do a real QR login and private-chat message roundtrip, then implement image upload/send on top of verified context-token handling.",
  });

  console.log("# Acceptance Report");
  for (const check of checks) {
    console.log(`- [${check.status}] ${check.item}: ${check.detail}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
