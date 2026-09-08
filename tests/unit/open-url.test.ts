import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { openUrl } from "../../src/cli/open-url.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

describe("login URL opener", () => {
  let child: EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test.runIf(process.platform === "win32").each([
    "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=test-token&bot_type=3",
    "https://example.com/login?qrcode=abc%2Bdef%3D&bot_type=3&label=O'Reilly%20%PATH%!&literal=$(noop)&name=微信",
  ])("passes the complete URL through Windows to Start-Process: %s", (url) => {
    openUrl(url);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], SpawnOptions];

    // Preserve ALL production spawn options, including stdio and console mode.
    // Only replace browser activation with a capture of the actual argument.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-login-url-"));
    const capturePath = path.join(tempDir, "url.txt");
    const capture = "function Start-Process { param([string]$FilePath) [IO.File]::WriteAllText($env:WECHAT_BRIDGE_TEST_CAPTURE_PATH, $FilePath) }; ";
    try {
      const result = spawnSync(command, [...args.slice(0, -1), capture + args.at(-1)], {
        ...options,
        env: { ...options.env, WECHAT_BRIDGE_TEST_CAPTURE_PATH: capturePath },
        timeout: 10000,
        encoding: "utf8",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(fs.existsSync(capturePath), "PowerShell must execute the launcher command").toBe(true);
      expect(fs.readFileSync(capturePath, "utf8")).toBe(url);
    } finally {
      if (fs.existsSync(capturePath)) {
        fs.unlinkSync(capturePath);
      }
      fs.rmdirSync(tempDir);
    }
  }, 15000);

  test.runIf(process.platform === "win32")("offers the printed link if the launcher cannot start", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    openUrl("https://example.com/login?qrcode=test&bot_type=3");

    expect(() => child.emit("error", new Error("spawn powershell.exe ENOENT"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Open the printed qrcode_url manually"));
  });

  test("keeps automatic browser opening disabled on other platforms", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });

    openUrl("https://example.com/login?qrcode=test&bot_type=3");

    expect(spawn).not.toHaveBeenCalled();
  });
});
