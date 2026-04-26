import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { getInstalledPluginRoot, resolveRuntimeRoot } from "../../src/config/runtime-root.js";

describe("resolveRuntimeRoot", () => {
  test("uses the global installed plugin root when MCP starts from the versioned cache bundle", () => {
    const homeDir = "C:\\Users\\Y";
    const installedRoot = getInstalledPluginRoot(homeDir);
    const modulePath = path.join(
      homeDir,
      ".codex",
      "plugins",
      "cache",
      "local-personal-plugins",
      "codex-wechat-bridge",
      "0.1.6",
      "dist",
      "src",
      "cli",
      "mcp-server.js",
    );

    expect(resolveRuntimeRoot({
      moduleUrl: pathToFileURL(modulePath).href,
      cwd: "D:\\GitHub\\codex-wechat-plugin",
      homeDir,
      env: {},
      existsSync(filePath) {
        return path.normalize(filePath) === path.normalize(path.join(installedRoot, "package.json"));
      },
    })).toBe(installedRoot);
  });

  test("honors an explicit runtime root override", () => {
    expect(resolveRuntimeRoot({
      cwd: "D:\\GitHub\\codex-wechat-plugin",
      env: {
        WECHAT_BRIDGE_RUNTIME_ROOT: "D:\\tmp\\wechat-runtime",
      },
    })).toBe("D:\\tmp\\wechat-runtime");
  });

  test("uses the inferred package root for normal development commands", () => {
    const repoRoot = "D:\\GitHub\\codex-wechat-plugin";
    const modulePath = path.join(repoRoot, "dist", "src", "cli", "status.js");

    expect(resolveRuntimeRoot({
      moduleUrl: pathToFileURL(modulePath).href,
      cwd: "D:\\other",
      homeDir: "C:\\Users\\Y",
      env: {},
      existsSync(filePath) {
        return path.normalize(filePath) === path.normalize(path.join(repoRoot, "package.json"));
      },
    })).toBe(repoRoot);
  });
});
