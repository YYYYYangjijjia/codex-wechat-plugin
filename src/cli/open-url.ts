import { spawn } from "node:child_process";

export function openUrl(url: string): void {
  if (process.platform !== "win32") {
    return;
  }

  // Keep the URL out of command text so query parameters such as &bot_type=3
  // reach the browser unchanged, without shell parsing or variable expansion.
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Start-Process -FilePath $env:WECHAT_BRIDGE_LOGIN_URL",
  ], {
    env: { ...process.env, WECHAT_BRIDGE_LOGIN_URL: url },
    windowsHide: true,
    stdio: "ignore",
  });
  // Keep this short-lived launcher attached: detached PowerShell can exit on
  // Windows without running its command. Start-Process launches the browser.
  child.once("error", () => {
    console.warn("Could not open the browser automatically. Open the printed qrcode_url manually.");
  });
}
