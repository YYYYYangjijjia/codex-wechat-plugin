import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { downloadInboundAttachment, downloadInboundImage } from "../../src/weixin/media-download.js";

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

describe("downloadInboundImage", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloads, decrypts, and saves an inbound image using image_item.aeskey", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-image-"));
    tempDirs.push(rootDir);
    const key = crypto.randomBytes(16);
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ]);
    const encrypted = encryptAesEcb(pngBytes, key);

    globalThis.fetch = vi.fn(async () => new Response(encrypted, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })) as typeof globalThis.fetch;

    const result = await downloadInboundImage({
      rootDir,
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      messageId: "msg-1",
      imageItem: {
        aeskey: key.toString("hex"),
        media: {
          full_url: "https://example.test/download?id=1",
        },
      },
    });

    expect(result).toBeDefined();
    expect(result!.localPath.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(result!.localPath)).toEqual(pngBytes);
  });

  test("returns undefined when the image item has no download URL", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-image-"));
    tempDirs.push(rootDir);

    const result = await downloadInboundImage({
      rootDir,
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      messageId: "msg-2",
      imageItem: {
        aeskey: crypto.randomBytes(16).toString("hex"),
        media: {},
      },
    });

    expect(result).toBeUndefined();
  });

  test("downloads, decrypts, and saves an inbound file using media.aes_key and file_name", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-attachment-"));
    tempDirs.push(rootDir);
    const key = crypto.randomBytes(16);
    const fileBytes = Buffer.from("hello from attachment", "utf8");
    const encrypted = encryptAesEcb(fileBytes, key);

    globalThis.fetch = vi.fn(async () => new Response(encrypted, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    })) as typeof globalThis.fetch;

    const result = await downloadInboundAttachment({
      rootDir,
      accountId: "acct-1",
      peerUserId: "user-a@im.wechat",
      messageId: "msg-3",
      item: {
        type: 4,
        file_item: {
          file_name: "notes.txt",
          media: {
            aes_key: key.toString("base64"),
            full_url: "https://example.test/download?id=file-1",
          },
        },
      },
    });

    expect(result).toBeDefined();
    expect(result).toMatchObject({
      kind: "file",
      fileName: "notes.txt",
    });
    expect(result!.localPath.endsWith(".txt")).toBe(true);
    expect(fs.readFileSync(result!.localPath, "utf8")).toBe("hello from attachment");
  });
});
