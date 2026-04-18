import { buildExecInvocation, buildSpawnInvocation, collectExecResultFromOutput } from "../../src/codex/exec-codex-runner.js";

describe("ExecCodexRunner helpers", () => {
  test("builds a fresh codex exec invocation for a new conversation", () => {
    const invocation = buildExecInvocation({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Reply politely",
      skipGitRepoCheck: true,
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "C:/repo/codex-wechat-plugin",
      "Reply politely",
    ]);
  });

  test("builds a resume invocation when a thread id already exists", () => {
    const invocation = buildExecInvocation({
      cwd: "C:/repo/codex-wechat-plugin",
      prompt: "Continue",
      threadId: "019d918c-9b3e-7f13-9edf-41db1ffb454e",
      skipGitRepoCheck: true,
    });

    expect(invocation.args).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "019d918c-9b3e-7f13-9edf-41db1ffb454e",
      "Continue",
    ]);
  });

  test("parses jsonl output and ignores non-json warning lines", () => {
    const result = collectExecResultFromOutput([
      '{"type":"thread.started","thread_id":"thread-123"}',
      '{"type":"turn.started"}',
      '2026-04-15T14:30:04.347433Z WARN something noisy',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"final answer"}}',
      '{"type":"turn.completed"}',
    ]);

    expect(result).toEqual({
      runnerBackend: "exec",
      threadId: "thread-123",
      finalMessage: "final answer",
      cwd: "",
    });
  });

  test("wraps codex execution with cmd.exe on Windows", () => {
    const invocation = buildSpawnInvocation(
      {
        command: "codex",
        args: ["exec", "--json", "-C", "C:/repo/codex-wechat-plugin", "Reply politely"],
      },
      "win32",
      "C:/Windows/System32/cmd.exe",
    );

    expect(invocation.command).toBe("C:/Windows/System32/cmd.exe");
    expect(invocation.args).toEqual([
      "/d",
      "/c",
      "codex",
      "exec",
      "--json",
      "-C",
      "C:/repo/codex-wechat-plugin",
      "Reply politely",
    ]);
  });
});

