import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MessageItemType } from "./weixin-api-client.js";

type DownloadableMedia = {
  encrypt_query_param?: string | undefined;
  aes_key?: string | undefined;
  full_url?: string | undefined;
};

type InboundImageItem = {
  aeskey?: string | undefined;
  media?: DownloadableMedia | undefined;
};

type InboundFileItem = {
  file_name?: string | undefined;
  media?: DownloadableMedia | undefined;
};

type InboundAttachmentItem = {
  type?: number | undefined;
  image_item?: InboundImageItem | undefined;
  file_item?: InboundFileItem | undefined;
};

export type InboundAttachmentDownload = {
  kind: "image" | "file";
  localPath: string;
  fileName?: string | undefined;
};

function parseAesKey(input: { aeskey?: string | undefined; media?: DownloadableMedia | undefined }): Buffer | undefined {
  if (input.aeskey) {
    return Buffer.from(input.aeskey, "hex");
  }
  if (!input.media?.aes_key) {
    return undefined;
  }
  const decoded = Buffer.from(input.media.aes_key, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Unsupported inbound media aes_key length: ${decoded.length}`);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function inferImageExtension(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ".jpg";
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return ".gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  return ".bin";
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function splitFilename(fileName: string): { stem: string; extension: string } {
  const parsed = path.parse(fileName);
  return {
    stem: parsed.name || "attachment",
    extension: parsed.ext || "",
  };
}

function resolveAttachmentTargetPath(input: {
  rootDir: string;
  accountId: string;
  peerUserId: string;
  messageId: string;
  fileName?: string | undefined;
  fallbackExtension: string;
}): string {
  const targetDir = path.join(
    input.rootDir,
    sanitizeSegment(input.accountId),
    sanitizeSegment(input.peerUserId),
  );
  fs.mkdirSync(targetDir, { recursive: true });
  if (input.fileName) {
    const { stem, extension } = splitFilename(input.fileName);
    return path.join(
      targetDir,
      `${sanitizeSegment(input.messageId)}-${sanitizeSegment(stem)}${extension || input.fallbackExtension}`,
    );
  }
  return path.join(targetDir, `${sanitizeSegment(input.messageId)}${input.fallbackExtension}`);
}

async function downloadBuffer(url: string, label: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function downloadInboundAttachment(input: {
  rootDir: string;
  accountId: string;
  peerUserId: string;
  messageId: string;
  item: InboundAttachmentItem;
}): Promise<InboundAttachmentDownload | undefined> {
  if (input.item.type === MessageItemType.IMAGE && input.item.image_item) {
    const result = await downloadInboundImage({
      rootDir: input.rootDir,
      accountId: input.accountId,
      peerUserId: input.peerUserId,
      messageId: input.messageId,
      imageItem: input.item.image_item,
    });
    return result ? { kind: "image", localPath: result.localPath } : undefined;
  }

  if (input.item.type !== MessageItemType.FILE || !input.item.file_item) {
    return undefined;
  }
  const url = input.item.file_item.media?.full_url;
  if (!url) {
    return undefined;
  }
  const encrypted = await downloadBuffer(url, "Inbound file");
  const key = parseAesKey({ media: input.item.file_item.media });
  const plaintext = key ? decryptAesEcb(encrypted, key) : encrypted;
  const targetPath = resolveAttachmentTargetPath({
    rootDir: input.rootDir,
    accountId: input.accountId,
    peerUserId: input.peerUserId,
    messageId: input.messageId,
    fileName: input.item.file_item.file_name,
    fallbackExtension: ".bin",
  });
  fs.writeFileSync(targetPath, plaintext);
  return {
    kind: "file",
    localPath: targetPath,
    fileName: input.item.file_item.file_name,
  };
}

export async function downloadInboundAttachments(input: {
  rootDir: string;
  accountId: string;
  peerUserId: string;
  messageId: string;
  itemList?: InboundAttachmentItem[] | undefined;
}): Promise<InboundAttachmentDownload[]> {
  const attachments: InboundAttachmentDownload[] = [];
  for (const [index, item] of (input.itemList ?? []).entries()) {
    const result = await downloadInboundAttachment({
      rootDir: input.rootDir,
      accountId: input.accountId,
      peerUserId: input.peerUserId,
      messageId: `${input.messageId}-${index + 1}`,
      item,
    });
    if (result) {
      attachments.push(result);
    }
  }
  return attachments;
}

export async function downloadInboundImage(input: {
  rootDir: string;
  accountId: string;
  peerUserId: string;
  messageId: string;
  imageItem: InboundImageItem;
}): Promise<{ localPath: string } | undefined> {
  const url = input.imageItem.media?.full_url;
  if (!url) {
    return undefined;
  }
  const encrypted = await downloadBuffer(url, "Inbound image");
  const key = parseAesKey(input.imageItem);
  const plaintext = key ? decryptAesEcb(encrypted, key) : encrypted;
  const targetPath = resolveAttachmentTargetPath({
    rootDir: input.rootDir,
    accountId: input.accountId,
    peerUserId: input.peerUserId,
    messageId: input.messageId,
    fallbackExtension: inferImageExtension(plaintext),
  });
  fs.writeFileSync(targetPath, plaintext);
  return { localPath: targetPath };
}
