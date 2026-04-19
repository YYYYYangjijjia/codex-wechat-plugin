import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { UploadMediaType, type WeixinClient } from "./weixin-api-client.js";

const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function aesEcbPaddedSize(plainSize: number): number {
  const blockSize = 16;
  return Math.ceil((plainSize + 1) / blockSize) * blockSize;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export async function sendLocalMediaFile(input: {
  client: Pick<WeixinClient, "getUploadUrl" | "sendFileMessage" | "sendImageMessage">;
  peerUserId: string;
  contextToken: string;
  filePath: string;
}): Promise<{ messageId: string; kind: "image" | "file" }> {
  const plaintext = fs.readFileSync(input.filePath);
  const rawSize = plaintext.length;
  const rawFileMd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const cipherSize = aesEcbPaddedSize(rawSize);
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const fileKey = crypto.randomBytes(16).toString("hex");
  const extension = path.extname(input.filePath).toLowerCase();
  const mediaType = isImageExtension(extension) ? UploadMediaType.IMAGE : UploadMediaType.FILE;

  const uploadUrl = await input.client.getUploadUrl({
    fileKey,
    mediaType,
    toUserId: input.peerUserId,
    rawSize,
    rawFileMd5,
    cipherSize,
    noNeedThumb: true,
    aesKeyHex,
  });

  const downloadParam = await uploadBufferToCdn({
    plaintext,
    aesKey,
    fileKey,
    uploadFullUrl: uploadUrl.uploadFullUrl,
    uploadParam: uploadUrl.uploadParam,
  });

  const aesKeyBase64 = Buffer.from(aesKeyHex, "utf8").toString("base64");
  if (mediaType === UploadMediaType.IMAGE) {
    const result = await input.client.sendImageMessage({
      peerUserId: input.peerUserId,
      contextToken: input.contextToken,
      encryptQueryParam: downloadParam,
      aesKeyBase64,
      cipherSize,
    });
    return { messageId: result.messageId, kind: "image" };
  }

  const result = await input.client.sendFileMessage({
    peerUserId: input.peerUserId,
    contextToken: input.contextToken,
    fileName: path.basename(input.filePath),
    encryptQueryParam: downloadParam,
    aesKeyBase64,
    plainSize: rawSize,
  });
  return { messageId: result.messageId, kind: "file" };
}

async function uploadBufferToCdn(input: {
  plaintext: Buffer;
  aesKey: Buffer;
  fileKey: string;
  uploadFullUrl?: string | undefined;
  uploadParam?: string | undefined;
}): Promise<string> {
  const uploadUrl = resolveUploadUrl(input);
  const ciphertext = encryptAesEcb(input.plaintext, input.aesKey);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!response.ok) {
    throw new Error(`CDN upload failed: ${response.status} ${response.statusText}`);
  }
  const encryptedParam = response.headers.get("x-encrypted-param");
  if (!encryptedParam) {
    throw new Error("CDN upload response missing x-encrypted-param header.");
  }
  return encryptedParam;
}

function resolveUploadUrl(input: {
  fileKey: string;
  uploadFullUrl?: string | undefined;
  uploadParam?: string | undefined;
}): string {
  const fullUrl = input.uploadFullUrl?.trim();
  if (fullUrl) {
    return fullUrl;
  }
  const uploadParam = input.uploadParam?.trim();
  if (!uploadParam) {
    throw new Error("Outbound media upload URL is missing.");
  }
  return `${DEFAULT_WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(input.fileKey)}`;
}

function isImageExtension(extension: string): boolean {
  return extension === ".png"
    || extension === ".jpg"
    || extension === ".jpeg"
    || extension === ".gif"
    || extension === ".webp"
    || extension === ".bmp";
}
