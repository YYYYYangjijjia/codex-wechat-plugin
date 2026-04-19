import { createReplyOrchestrator } from "../../src/daemon/reply-orchestrator.js";

class FakeStore {
  public deliveries: Array<{ conversationKey: string; status: string; errorMessage?: string; finalMessage?: string }> = [];

  recordDeliveryAttempt(entry: { conversationKey: string; status: string; errorMessage?: string; finalMessage?: string }): void {
    this.deliveries.push(entry);
  }
}

describe("reply orchestrator", () => {
  test("sends typing, invokes Codex, and emits one final text reply", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn() {
          events.push("runner");
          return { runnerBackend: "exec", threadId: "thread-1", finalMessage: "final answer", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage() {
          events.push("send:final");
          return { messageId: "msg-1" };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    const result = await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      threadId: undefined,
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(result).toEqual(expect.objectContaining({
      runnerBackend: "exec",
      threadId: "thread-1",
      finalMessage: "final answer",
      outboundMessageId: "msg-1",
      timings: expect.objectContaining({
        typingStartMs: expect.any(Number),
        runnerMs: expect.any(Number),
        typingStopMs: expect.any(Number),
        sendMs: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    }));
    expect(events).toEqual(["typing:start", "runner", "typing:stop", "send:final"]);
    expect(store.deliveries).toEqual([{
      conversationKey: "acct-1:user-a@im.wechat",
      status: "sent",
      finalMessage: "final answer",
    }]);
  });

  test("records failures and still stops typing when Codex fails", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn() {
          events.push("runner");
          throw new Error("runner failed");
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage() {
          events.push("send:final");
          return { messageId: "msg-1" };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await expect(orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      threadId: undefined,
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    })).rejects.toThrow("runner failed");

    expect(events).toEqual(["typing:start", "runner", "typing:stop"]);
    expect(store.deliveries).toEqual([
      {
        conversationKey: "acct-1:user-a@im.wechat",
        status: "failed",
        errorMessage: "runner failed",
      },
    ]);
  });

  test("forwards progress chunks before the final message", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.("partial one. ");
          await input.onProgress?.("partial two.");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: "partial one. partial two. Final wrap-up.", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    const result = await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      threadId: undefined,
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(result.finalMessage).toBe("partial one. partial two. Final wrap-up.");
    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:partial one.",
      "send:partial two.",
      "typing:stop",
      "send:<FINAL>:\npartial one. partial two. Final wrap-up.",
    ]);
  });

  test("forwards thinking chunks with a <T> marker", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onReasoningProgress?.(" \n\t ");
          await input.onReasoningProgress?.("Think step one. ");
          await input.onReasoningProgress?.("Think step two.");
          await input.onProgress?.("Answer chunk.");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: "Answer chunk.", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:<T>:\nThink step one.",
      "send:<T>:\nThink step two.",
      "send:Answer chunk.",
      "typing:stop",
      "send:<FINAL>:\nAnswer chunk.",
    ]);
  });

  test("always sends a full final summary even when progress already emitted the same text", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.("line one. ");
          await input.onProgress?.("line two.");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: "line one. line two.", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:line one.",
      "send:line two.",
      "typing:stop",
      "send:<FINAL>:\nline one. line two.",
    ]);
  });

  test("can suppress the final full summary while keeping progress chunks", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.("line one. ");
          await input.onProgress?.("line two.");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: "line one. line two.", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
      showFinalSummary: false,
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:line one.",
      "send:line two.",
      "typing:stop",
    ]);
  });

  test("skips whitespace-only progress chunks", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.(" \n\t ");
          await input.onProgress?.("visible chunk");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: "visible chunk", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:visible chunk",
      "typing:stop",
      "send:<FINAL>:\nvisible chunk",
    ]);
  });

  test("trims leading and trailing whitespace from progress chunks before sending", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.("first line\n\n");
          await input.onProgress?.("\n\nsecond line");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: "first line\n\nsecond line", cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:first line",
      "send:second line",
      "typing:stop",
      "send:<FINAL>:\nfirst line\n\nsecond line",
    ]);
  });

  test("sends plain structured multiline output as a single block", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.(`.git
.pytest_cache
.remote
configs
docs
inputs
notebooks
outputs
scripts
skill_experience
tests
videofm
.gitignore
environment.yml
README.md`);
          await input.onProgress?.("requirements.txt");
          return {
            runnerBackend: "app_server",
            threadId: "thread-1",
            finalMessage: `.git
.pytest_cache
.remote
configs
docs
inputs
notebooks
outputs
scripts
skill_experience
tests
videofm
.gitignore
environment.yml
README.md
requirements.txt`,
            cwd: "C:/repo/other-workspace",
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "ls",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      `send:.git
.pytest_cache
.remote
configs
docs
inputs
notebooks
outputs
scripts
skill_experience
tests
videofm
.gitignore
environment.yml
README.md`,
      "send:requirements.txt",
      "typing:stop",
      `send:<FINAL>:
.git
.pytest_cache
.remote
configs
docs
inputs
notebooks
outputs
scripts
skill_experience
tests
videofm
.gitignore
environment.yml
README.md
requirements.txt`,
    ]);
    expect(store.deliveries.filter((entry) => entry.status === "progress_sent").length).toBe(2);
  });

  test("sends fenced structured output as a single block and keeps the final summary complete", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.(`我再列一次当前目录。
\`\`\`text`);
          await input.onProgress?.(`.git
.pytest_cache
.remote
`);
          await input.onProgress?.(`docs
inputs
\`\`\``);
          return {
            runnerBackend: "app_server",
            threadId: "thread-1",
            finalMessage: `\`\`\`text
.git
.pytest_cache
.remote
docs
inputs
\`\`\``,
            cwd: "C:/repo/other-workspace",
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "ls",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:我再列一次当前目录。",
      `send:.git
.pytest_cache
.remote
docs
inputs`,
      "typing:stop",
      `send:<FINAL>:
我再列一次当前目录。
.git
.pytest_cache
.remote
docs
inputs`,
    ]);
    expect(store.deliveries.filter((entry) => entry.status === "progress_sent").length).toBe(2);
  });

  test("sends ordered lists as a single structured block", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.(`1. first item
2. second item
3. third item`);
          return {
            runnerBackend: "app_server",
            threadId: "thread-1",
            finalMessage: `1. first item
2. second item
3. third item`,
            cwd: "C:/repo/other-workspace",
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "list",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      `send:1. first item
2. second item
3. third item`,
      "typing:stop",
      `send:<FINAL>:
1. first item
2. second item
3. third item`,
    ]);
  });

  test("does not split an ordered-list marker from the following prose line during progress re-chunking", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.(`当前进度可以分成 4 块看。\n\n1.\n主功能已经打通**\n- WeChat / Weixin 私聊桥接到本地 Codex Desktop`);
          return {
            runnerBackend: "app_server",
            threadId: "thread-1",
            finalMessage: `当前进度可以分成 4 块看。\n\n1.\n主功能已经打通**\n- WeChat / Weixin 私聊桥接到本地 Codex Desktop`,
            cwd: "C:/repo/other-workspace",
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "status",
      typingTicket: "ticket-1",
      showFinalSummary: false,
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "send:当前进度可以分成 4 块看。",
      "send:1.\n主功能已经打通**",
      "send:- WeChat / Weixin 私聊桥接到本地 Codex Desktop",
      "typing:stop",
    ]);
  });

  test("sends non-fenced code-like multiline output as a single structured block", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn(input) {
          events.push("runner");
          await input.onProgress?.(`const files = [];
for (const file of files) {
  console.log(file);
}`);
          return {
            runnerBackend: "app_server",
            threadId: "thread-1",
            finalMessage: `const files = [];
for (const file of files) {
  console.log(file);
}`,
            cwd: "C:/repo/other-workspace",
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "code",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      `send:const files = [];
for (const file of files) {
console.log(file);
}`,
      "typing:stop",
      `send:<FINAL>:
const files = [];
for (const file of files) {
  console.log(file);
}`,
    ]);
  });

  test("splits a long final summary into multiple final messages", async () => {
    const events: string[] = [];
    const store = new FakeStore();
    const longFinal = `${"a".repeat(700)}\n${"b".repeat(700)}`;
    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn() {
          events.push("runner");
          return { runnerBackend: "app_server", threadId: "thread-1", finalMessage: longFinal, cwd: "C:/repo/codex-wechat-plugin" };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: `msg-${events.length}` };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
      },
    });

    await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
    });

    expect(events).toEqual([
      "typing:start",
      "runner",
      "typing:stop",
      `send:<FINAL 1/2>:\n${"a".repeat(700)}`,
      `send:<FINAL 2/2>:\n${"b".repeat(700)}`,
    ]);
    expect(store.deliveries).toEqual([
      {
        conversationKey: "acct-1:user-a@im.wechat",
        status: "sent",
        finalMessage: longFinal,
      },
    ]);
  });
});

