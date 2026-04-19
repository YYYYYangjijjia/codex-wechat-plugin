import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createReplyOrchestrator } from "../../src/daemon/reply-orchestrator.js";

class FakeStore {
  public deliveries: Array<{ conversationKey: string; status: string; errorMessage?: string; finalMessage?: string }> = [];
  public queued: Array<Record<string, unknown>> = [];

  recordDeliveryAttempt(entry: { conversationKey: string; status: string; errorMessage?: string; finalMessage?: string }): void {
    this.deliveries.push(entry);
  }

  enqueueOutboundDelivery(entry: Record<string, unknown>): number {
    this.queued.push(entry);
    return this.queued.length;
  }
}

describe("reply orchestrator media delivery", () => {
  const tempDirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sends a generated file after the final text when delivery intent is explicitly enabled", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-reply-media-"));
    tempDirs.push(workspaceDir);
    const pdfPath = path.join(workspaceDir, "artifacts", "report.pdf");
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, "pdf-content");

    const events: string[] = [];
    const store = new FakeStore();
    globalThis.fetch = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param-1" },
    })) as typeof globalThis.fetch;

    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn() {
          events.push("runner");
          return {
            runnerBackend: "exec" as const,
            threadId: "thread-1",
            finalMessage: `Done. Output: ${pdfPath}`,
            cwd: workspaceDir,
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: "msg-final" };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
        async getUploadUrl() {
          events.push("upload:url");
          return { uploadFullUrl: "https://cdn.example/upload" };
        },
        async sendFileMessage(input) {
          events.push(`send:file:${input.fileName}`);
          return { messageId: "msg-file" };
        },
        async sendImageMessage() {
          throw new Error("image send not expected");
        },
      },
    });

    const result = await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
      deliveryIntent: {
        enabled: true,
        requestedKinds: ["pdf"],
        evidenceText: ["PDF", "send it back"],
      },
    });

    expect(result.outboundMessageId).toBe("msg-file");
    expect(events).toEqual([
      "typing:start",
      "runner",
      "typing:stop",
      `send:<FINAL>:\nDone. Output: ${pdfPath}`,
      "upload:url",
      "send:file:report.pdf",
    ]);
    expect(store.deliveries).toContainEqual({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "media_sent",
      finalMessage: pdfPath,
    });
  });

  test("does not attempt media delivery when delivery intent is not enabled", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-reply-media-"));
    tempDirs.push(workspaceDir);
    const pdfPath = path.join(workspaceDir, "artifacts", "report.pdf");
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, "pdf-content");

    const events: string[] = [];
    const store = new FakeStore();
    const getUploadUrl = vi.fn(async () => ({ uploadFullUrl: "https://cdn.example/upload" }));
    const sendFileMessage = vi.fn(async () => ({ messageId: "msg-file" }));

    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn() {
          events.push("runner");
          return {
            runnerBackend: "exec" as const,
            threadId: "thread-1",
            finalMessage: `Done. Output: ${pdfPath}`,
            cwd: workspaceDir,
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: "msg-final" };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
        getUploadUrl,
        sendFileMessage,
        async sendImageMessage() {
          return { messageId: "msg-image" };
        },
      },
    });

    const result = await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      typingTicket: "ticket-1",
      deliveryIntent: {
        enabled: false,
        requestedKinds: [],
        evidenceText: [],
      },
    });

    expect(result.outboundMessageId).toBe("msg-final");
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(sendFileMessage).not.toHaveBeenCalled();
  });

  test("binds media client methods so automatic delivery works with instance-backed clients", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-reply-media-"));
    tempDirs.push(workspaceDir);
    const pdfPath = path.join(workspaceDir, "artifacts", "report.pdf");
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, "pdf-content");

    globalThis.fetch = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param-2" },
    })) as typeof globalThis.fetch;

    class InstanceBackedClient {
      public readonly calls: string[] = [];
      public readonly uploadFullUrl = "https://cdn.example/upload";

      async setTyping(): Promise<void> {}
      async stopTyping(): Promise<void> {}

      async sendTextMessage(input: { text: string }): Promise<{ messageId: string }> {
        this.calls.push(`text:${input.text}`);
        return { messageId: "msg-final" };
      }

      async getUploadUrl(): Promise<{ uploadFullUrl: string }> {
        this.calls.push("upload:url");
        return { uploadFullUrl: this.uploadFullUrl };
      }

      async sendFileMessage(input: { fileName: string }): Promise<{ messageId: string }> {
        this.calls.push(`file:${input.fileName}`);
        return { messageId: "msg-file" };
      }

      async sendImageMessage(): Promise<{ messageId: string }> {
        throw new Error("image send not expected");
      }
    }

    const client = new InstanceBackedClient();
    const orchestrator = createReplyOrchestrator({
      stateStore: new FakeStore(),
      codexRunner: {
        async runTurn() {
          return {
            runnerBackend: "exec" as const,
            threadId: "thread-2",
            finalMessage: `Done. Output: ${pdfPath}`,
            cwd: workspaceDir,
          };
        },
      },
      weixinClient: client,
    });

    const result = await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      deliveryIntent: {
        enabled: true,
        requestedKinds: ["pdf"],
        evidenceText: ["PDF", "send it back"],
      },
    });

    expect(result.outboundMessageId).toBe("msg-file");
    expect(client.calls).toContain("upload:url");
    expect(client.calls).toContain("file:report.pdf");
  });

  test("does not re-send files when Codex already delivered them via skill markers", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-reply-media-"));
    tempDirs.push(workspaceDir);
    const pdfPath = path.join(workspaceDir, "artifacts", "report.pdf");
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, "pdf-content");

    const events: string[] = [];
    const store = new FakeStore();
    const getUploadUrl = vi.fn(async () => ({ uploadFullUrl: "https://cdn.example/upload" }));
    const sendFileMessage = vi.fn(async () => ({ messageId: "msg-file" }));

    const orchestrator = createReplyOrchestrator({
      stateStore: store,
      codexRunner: {
        async runTurn() {
          return {
            runnerBackend: "exec" as const,
            threadId: "thread-3",
            finalMessage: [
              `Done. Output: ${pdfPath}`,
              `[[WECHAT_DELIVERED:${pdfPath}]]`,
            ].join("\n"),
            cwd: workspaceDir,
          };
        },
      },
      weixinClient: {
        async setTyping() {
          events.push("typing:start");
        },
        async sendTextMessage(input) {
          events.push(`send:${input.text}`);
          return { messageId: "msg-final" };
        },
        async stopTyping() {
          events.push("typing:stop");
        },
        getUploadUrl,
        sendFileMessage,
        async sendImageMessage() {
          return { messageId: "msg-image" };
        },
      },
    });

    const result = await orchestrator.handleInboundMessage({
      conversationKey: "acct-1:user-a@im.wechat",
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      prompt: "hello",
      deliveryIntent: {
        enabled: true,
        requestedKinds: ["pdf"],
        evidenceText: ["PDF", "发给我"],
      },
    });

    expect(result.outboundMessageId).toBe("msg-final");
    expect(events).toContain(`send:<FINAL>:\nDone. Output: ${pdfPath}`);
    expect(events).not.toContain(`send:<FINAL>:\nDone. Output: ${pdfPath}\n[[WECHAT_DELIVERED:${pdfPath}]]`);
    expect(getUploadUrl).not.toHaveBeenCalled();
    expect(sendFileMessage).not.toHaveBeenCalled();
    expect(store.deliveries).toContainEqual({
      conversationKey: "acct-1:user-a@im.wechat",
      status: "media_sent_via_skill",
      finalMessage: pdfPath,
    });
  });
});
