import { buildAppServerInvocation, buildAppServerSpawnInvocation } from "../../src/codex/app-server-process-manager.js";

describe("AppServerProcessManager helpers", () => {
  test("builds a codex app-server invocation for loopback websocket", () => {
    const invocation = buildAppServerInvocation({
      listenUrl: "ws://127.0.0.1:4500",
    });

    expect(invocation).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "ws://127.0.0.1:4500"],
    });
  });

  test("wraps app-server startup with cmd.exe on Windows", () => {
    const invocation = buildAppServerSpawnInvocation(
      {
        command: "codex",
        args: ["app-server", "--listen", "ws://127.0.0.1:4500"],
      },
      "win32",
      "C:/Windows/System32/cmd.exe",
    );

    expect(invocation).toEqual({
      command: "C:/Windows/System32/cmd.exe",
      args: ["/d", "/c", "codex", "app-server", "--listen", "ws://127.0.0.1:4500"],
    });
  });
});
