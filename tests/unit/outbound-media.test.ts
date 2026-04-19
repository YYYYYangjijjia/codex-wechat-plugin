import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { aesEcbPaddedSize, encryptAesEcb, sendLocalMediaFile } from "../../src/weixin/outbound-media.js";

describe("outbound media helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("computes AES-ECB padded ciphertext size", () => {
    expect(aesEcbPaddedSize(1)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(17)).toBe(32);
  });

  test("encrypts plaintext with AES-128-ECB and PKCS7 padding", () => {
    const key = crypto.randomBytes(16);
    const plaintext = Buffer.from("hello world", "utf8");
    const ciphertext = encryptAesEcb(plaintext, key);

    expect(ciphertext.equals(plaintext)).toBe(false);
    expect(ciphertext.length).toBe(aesEcbPaddedSize(plaintext.length));
  });

  test("uploads a local pdf and sends it as a file attachment", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-outbound-media-"));
    tempDirs.push(workspaceDir);
    const pdfPath = path.join(workspaceDir, "report.pdf");
    fs.writeFileSync(pdfPath, "pdf-content");

    const client = {
      getUploadUrl: vi.fn(async () => ({ uploadFullUrl: "https://cdn.example/upload" })),
      sendFileMessage: vi.fn(async () => ({ messageId: "file-msg-1" })),
      sendImageMessage: vi.fn(async () => ({ messageId: "image-msg-1" })),
    };

    const fetchMock = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param-1" },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await sendLocalMediaFile({
      client,
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      filePath: pdfPath,
    });

    expect(result).toEqual({ messageId: "file-msg-1", kind: "file" });
    expect(client.getUploadUrl).toHaveBeenCalledTimes(1);
    expect(client.sendFileMessage).toHaveBeenCalledTimes(1);
    expect(client.sendImageMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uploads a local png and sends it as an image message", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-outbound-media-"));
    tempDirs.push(workspaceDir);
    const pngPath = path.join(workspaceDir, "preview.png");
    fs.writeFileSync(pngPath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]));

    const client = {
      getUploadUrl: vi.fn(async () => ({ uploadFullUrl: "https://cdn.example/upload" })),
      sendFileMessage: vi.fn(async () => ({ messageId: "file-msg-1" })),
      sendImageMessage: vi.fn(async () => ({ messageId: "image-msg-1" })),
    };

    const fetchMock = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param-2" },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await sendLocalMediaFile({
      client,
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      filePath: pngPath,
    });

    expect(result).toEqual({ messageId: "image-msg-1", kind: "image" });
    expect(client.sendImageMessage).toHaveBeenCalledTimes(1);
    expect(client.sendFileMessage).not.toHaveBeenCalled();
  });

  test("uploads through upload_param when getUploadUrl does not return uploadFullUrl", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-outbound-media-"));
    tempDirs.push(workspaceDir);
    const pdfPath = path.join(workspaceDir, "fallback.pdf");
    fs.writeFileSync(pdfPath, "pdf-content");

    const client = {
      getUploadUrl: vi.fn(async () => ({ uploadParam: "enc-upload-param-1" })),
      sendFileMessage: vi.fn(async () => ({ messageId: "file-msg-2" })),
      sendImageMessage: vi.fn(async () => ({ messageId: "image-msg-2" })),
    };

    const fetchMock = vi.fn(async () => new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param-3" },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await sendLocalMediaFile({
      client,
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      filePath: pdfPath,
    });

    expect(result).toEqual({ messageId: "file-msg-2", kind: "file" });
    const uploadCalls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const uploadUrl = String(uploadCalls[0]?.[0]);
    expect(uploadUrl).toContain("https://novac2c.cdn.weixin.qq.com/c2c/upload");
    expect(uploadUrl).toContain("encrypted_query_param=enc-upload-param-1");
    expect(uploadUrl).toContain("filekey=");
  });
});
