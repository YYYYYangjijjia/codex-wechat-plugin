import crypto from "node:crypto";

export const MessageType = {
  USER: 1,
  BOT: 2,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export const TypingState = {
  Start: "start",
  Stop: "stop",
} as const;

export type TypingState = (typeof TypingState)[keyof typeof TypingState];

export type SendMessageRequest = {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    context_token?: string | undefined;
    item_list: Array<{
      type: number;
      text_item?: { text: string } | undefined;
      image_item?: {
        media: {
          encrypt_query_param: string;
          aes_key: string;
          encrypt_type: number;
        };
        mid_size: number;
      } | undefined;
      file_item?: {
        media: {
          encrypt_query_param: string;
          aes_key: string;
          encrypt_type: number;
        };
        file_name: string;
        len: string;
      } | undefined;
    }>;
  };
};

export type GetUploadUrlRequest = {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb?: boolean | undefined;
  aeskey?: string | undefined;
};

export type GetUploadUrlResponse = {
  upload_param?: string | undefined;
  upload_full_url?: string | undefined;
  thumb_upload_param?: string | undefined;
};

export type WeixinMessage = {
  message_id?: number | undefined;
  from_user_id?: string | undefined;
  to_user_id?: string | undefined;
  message_type?: number | undefined;
  message_state?: number | undefined;
  group_id?: string | undefined;
  context_token?: string | undefined;
  item_list?: Array<{
    type?: number | undefined;
    file_item?: {
      media?: {
        encrypt_query_param?: string | undefined;
        aes_key?: string | undefined;
        full_url?: string | undefined;
      } | undefined;
      file_name?: string | undefined;
      md5?: string | undefined;
      len?: string | undefined;
    } | undefined;
    image_item?: {
      aeskey?: string | undefined;
      media?: {
        encrypt_query_param?: string | undefined;
        aes_key?: string | undefined;
        full_url?: string | undefined;
      } | undefined;
      mid_size?: number | undefined;
      thumb_size?: number | undefined;
      thumb_height?: number | undefined;
      thumb_width?: number | undefined;
      hd_size?: number | undefined;
    } | undefined;
    ref_msg?: {
      message_item?: {
        type?: number | undefined;
        text_item?: { text?: string | undefined } | undefined;
      } | undefined;
    } | undefined;
    text_item?: { text?: string | undefined } | undefined;
  }> | undefined;
};

export type GetUpdatesResponse = {
  ret?: number | undefined;
  errcode?: number | undefined;
  errmsg?: string | undefined;
  msgs?: WeixinMessage[] | undefined;
  get_updates_buf?: string | undefined;
  longpolling_timeout_ms?: number | undefined;
};

export type LoginStartResult = {
  qrcode: string;
  qrcodeUrl: string;
};

export type LoginStatusResult = {
  status: string;
  botToken?: string | undefined;
  accountId?: string | undefined;
  baseUrl?: string | undefined;
  linkedUserId?: string | undefined;
  redirectHost?: string | undefined;
};

export function buildAuthenticatedHeaders(input: {
  token?: string | undefined;
  appId: string;
  clientVersion: number;
  randomWechatUin: string;
  contentLength?: number | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    AuthorizationType: "ilink_bot_token",
    "iLink-App-Id": input.appId,
    "iLink-App-ClientVersion": String(input.clientVersion),
    "X-WECHAT-UIN": input.randomWechatUin,
  };
  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }
  if (input.contentLength !== undefined) {
    headers["Content-Length"] = String(input.contentLength);
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

export function buildSendMessageRequest(input: {
  toUserId: string;
  text: string;
  clientId: string;
  contextToken?: string | undefined;
}): SendMessageRequest {
  return {
    msg: {
      from_user_id: "",
      to_user_id: input.toUserId,
      client_id: input.clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: input.contextToken,
      item_list: [
        {
          type: MessageItemType.TEXT,
          text_item: { text: input.text },
        },
      ],
    },
  };
}

export function buildGetUploadUrlRequest(input: {
  fileKey: string;
  mediaType: number;
  toUserId: string;
  rawSize: number;
  rawFileMd5: string;
  cipherSize: number;
  noNeedThumb?: boolean | undefined;
  aesKeyHex?: string | undefined;
}): GetUploadUrlRequest {
  return {
    filekey: input.fileKey,
    media_type: input.mediaType,
    to_user_id: input.toUserId,
    rawsize: input.rawSize,
    rawfilemd5: input.rawFileMd5,
    filesize: input.cipherSize,
    ...(typeof input.noNeedThumb === "boolean" ? { no_need_thumb: input.noNeedThumb } : {}),
    ...(input.aesKeyHex ? { aeskey: input.aesKeyHex } : {}),
  };
}

export function buildImageMessageRequest(input: {
  toUserId: string;
  clientId: string;
  contextToken?: string | undefined;
  encryptQueryParam: string;
  aesKeyBase64: string;
  cipherSize: number;
}): SendMessageRequest {
  return {
    msg: {
      from_user_id: "",
      to_user_id: input.toUserId,
      client_id: input.clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: input.contextToken,
      item_list: [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: input.cipherSize,
          },
        },
      ],
    },
  };
}

export function buildFileMessageRequest(input: {
  toUserId: string;
  clientId: string;
  contextToken?: string | undefined;
  fileName: string;
  encryptQueryParam: string;
  aesKeyBase64: string;
  plainSize: number;
}): SendMessageRequest {
  return {
    msg: {
      from_user_id: "",
      to_user_id: input.toUserId,
      client_id: input.clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: input.contextToken,
      item_list: [
        {
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: input.encryptQueryParam,
              aes_key: input.aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: input.fileName,
            len: String(input.plainSize),
          },
        },
      ],
    },
  };
}

export function buildSendTypingRequest(input: {
  ilinkUserId: string;
  typingTicket: string;
  state: TypingState;
}): { ilink_user_id: string; typing_ticket: string; status: number } {
  return {
    ilink_user_id: input.ilinkUserId,
    typing_ticket: input.typingTicket,
    status: input.state === TypingState.Start ? 1 : 2,
  };
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

async function fetchJson<T>(input: {
  method: "GET" | "POST";
  baseUrl: string;
  endpoint: string;
  body?: unknown;
  token?: string | undefined;
  appId: string;
  clientVersion: number;
  timeoutMs?: number | undefined;
  retryLimit?: number | undefined;
  retryDelayMs?: number | undefined;
}): Promise<T> {
  const url = new URL(input.endpoint, input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`);
  const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
  const retryLimit = input.retryLimit ?? 0;
  const retryDelayMs = input.retryDelayMs ?? 250;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15000);
    try {
      const response = await fetch(url, {
        method: input.method,
        headers: buildAuthenticatedHeaders({
          token: input.token,
          appId: input.appId,
          clientVersion: input.clientVersion,
          randomWechatUin: randomWechatUin(),
          contentLength: bodyText ? Buffer.byteLength(bodyText, "utf8") : undefined,
        }),
        ...(bodyText === undefined ? {} : { body: bodyText }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`${input.method} ${url.pathname} failed: ${response.status} ${raw}`);
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      if (attempt >= retryLimit || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("unreachable");
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /fetch failed/i.test(error.message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function assertBusinessSuccess(
  response: { ret?: number | undefined; errcode?: number | undefined; errmsg?: string | undefined },
  context: string,
): void {
  const code = response.ret ?? response.errcode;
  if (code !== undefined && code !== 0) {
    if (context === "sendmessage" && code === -2) {
      throw new Error(
        "sendmessage failed: ret=-2 (the current reply context is no longer valid; wait for a fresh inbound message to refresh context_token before sending again)",
      );
    }
    const message = response.errmsg ? ` ${response.errmsg}` : "";
    throw new Error(`${context} failed: ret=${code}${message}`);
  }
}

export type WeixinClient = {
  setTyping(input: { peerUserId: string; typingTicket: string }): Promise<void>;
  stopTyping(input: { peerUserId: string; typingTicket: string }): Promise<void>;
  sendTextMessage(input: { peerUserId: string; contextToken: string; text: string }): Promise<{ messageId: string }>;
  getUploadUrl(input: {
    fileKey: string;
    mediaType: number;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    cipherSize: number;
    noNeedThumb?: boolean | undefined;
    aesKeyHex?: string | undefined;
  }): Promise<{ uploadParam?: string | undefined; uploadFullUrl?: string | undefined; thumbUploadParam?: string | undefined }>;
  sendImageMessage(input: {
    peerUserId: string;
    contextToken: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    cipherSize: number;
  }): Promise<{ messageId: string }>;
  sendFileMessage(input: {
    peerUserId: string;
    contextToken: string;
    fileName: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    plainSize: number;
  }): Promise<{ messageId: string }>;
};

export class HttpWeixinClient implements WeixinClient {
  public constructor(
    private readonly options: {
      baseUrl: string;
      token?: string | undefined;
      appId: string;
      clientVersion: number;
      packageVersion: string;
    },
  ) {}

  async startQrLogin(botType: string): Promise<LoginStartResult> {
    const response = await fetchJson<{ qrcode: string; qrcode_img_content: string }>({
      method: "GET",
      baseUrl: this.options.baseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: 15000,
    });
    return {
      qrcode: response.qrcode,
      qrcodeUrl: response.qrcode_img_content,
    };
  }

  async pollQrLoginStatus(qrcode: string, timeoutMs = 35000): Promise<LoginStatusResult> {
    const response = await fetchJson<{
      status: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
      redirect_host?: string;
    }>({
      method: "GET",
      baseUrl: this.options.baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs,
    });
    return {
      status: response.status,
      botToken: response.bot_token,
      accountId: response.ilink_bot_id,
      baseUrl: response.baseurl,
      linkedUserId: response.ilink_user_id,
      redirectHost: response.redirect_host,
    };
  }

  async fetchUpdates(input: { cursor?: string | undefined; timeoutMs?: number | undefined }): Promise<GetUpdatesResponse> {
    return fetchJson<GetUpdatesResponse>({
      method: "POST",
      baseUrl: this.options.baseUrl,
      endpoint: "ilink/bot/getupdates",
      token: this.options.token,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: input.timeoutMs ?? 35000,
      retryLimit: 1,
      retryDelayMs: 500,
      body: {
        get_updates_buf: input.cursor ?? "",
        base_info: { channel_version: this.options.packageVersion },
      },
    });
  }

  async getTypingTicket(input: { peerUserId: string; contextToken?: string | undefined }): Promise<string | undefined> {
    const response = await fetchJson<{ typing_ticket?: string }>({
      method: "POST",
      baseUrl: this.options.baseUrl,
      endpoint: "ilink/bot/getconfig",
      token: this.options.token,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: 10000,
      retryLimit: 1,
      retryDelayMs: 300,
      body: {
        ilink_user_id: input.peerUserId,
        context_token: input.contextToken,
        base_info: { channel_version: this.options.packageVersion },
      },
    });
    return response.typing_ticket;
  }

  async sendTextMessage(input: { peerUserId: string; contextToken: string; text: string }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    const response = await this.sendMessageRequest({
      request: buildSendMessageRequest({
        toUserId: input.peerUserId,
        text: input.text,
        clientId,
        contextToken: input.contextToken,
      }),
    });
    return { messageId: clientId };
  }

  async getUploadUrl(input: {
    fileKey: string;
    mediaType: number;
    toUserId: string;
    rawSize: number;
    rawFileMd5: string;
    cipherSize: number;
    noNeedThumb?: boolean | undefined;
    aesKeyHex?: string | undefined;
  }): Promise<{ uploadParam?: string | undefined; uploadFullUrl?: string | undefined; thumbUploadParam?: string | undefined }> {
    const response = await fetchJson<GetUploadUrlResponse>({
      method: "POST",
      baseUrl: this.options.baseUrl,
      endpoint: "ilink/bot/getuploadurl",
      token: this.options.token,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: 15000,
      body: {
        ...buildGetUploadUrlRequest(input),
        base_info: { channel_version: this.options.packageVersion },
      },
    });
    return {
      uploadParam: response.upload_param,
      uploadFullUrl: response.upload_full_url,
      thumbUploadParam: response.thumb_upload_param,
    };
  }

  async sendImageMessage(input: {
    peerUserId: string;
    contextToken: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    cipherSize: number;
  }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    await this.sendMessageRequest({
      request: buildImageMessageRequest({
        toUserId: input.peerUserId,
        clientId,
        contextToken: input.contextToken,
        encryptQueryParam: input.encryptQueryParam,
        aesKeyBase64: input.aesKeyBase64,
        cipherSize: input.cipherSize,
      }),
    });
    return { messageId: clientId };
  }

  async sendFileMessage(input: {
    peerUserId: string;
    contextToken: string;
    fileName: string;
    encryptQueryParam: string;
    aesKeyBase64: string;
    plainSize: number;
  }): Promise<{ messageId: string }> {
    const clientId = crypto.randomUUID();
    await this.sendMessageRequest({
      request: buildFileMessageRequest({
        toUserId: input.peerUserId,
        clientId,
        contextToken: input.contextToken,
        fileName: input.fileName,
        encryptQueryParam: input.encryptQueryParam,
        aesKeyBase64: input.aesKeyBase64,
        plainSize: input.plainSize,
      }),
    });
    return { messageId: clientId };
  }

  private async sendMessageRequest(input: { request: SendMessageRequest }): Promise<{ ret?: number; errcode?: number; errmsg?: string }> {
    const response = await fetchJson<{ ret?: number; errcode?: number; errmsg?: string }>({
      method: "POST",
      baseUrl: this.options.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      token: this.options.token,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: 15000,
      retryLimit: 2,
      retryDelayMs: 400,
      body: {
        ...input.request,
        base_info: { channel_version: this.options.packageVersion },
      },
    });
    assertBusinessSuccess(response, "sendmessage");
    return response;
  }

  async setTyping(input: { peerUserId: string; typingTicket: string }): Promise<void> {
    const response = await fetchJson<{ ret?: number; errcode?: number; errmsg?: string }>({
      method: "POST",
      baseUrl: this.options.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      token: this.options.token,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: 10000,
      body: {
        ...buildSendTypingRequest({
          ilinkUserId: input.peerUserId,
          typingTicket: input.typingTicket,
          state: TypingState.Start,
        }),
        base_info: { channel_version: this.options.packageVersion },
      },
    });
    assertBusinessSuccess(response, "sendtyping");
  }

  async stopTyping(input: { peerUserId: string; typingTicket: string }): Promise<void> {
    const response = await fetchJson<{ ret?: number; errcode?: number; errmsg?: string }>({
      method: "POST",
      baseUrl: this.options.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      token: this.options.token,
      appId: this.options.appId,
      clientVersion: this.options.clientVersion,
      timeoutMs: 10000,
      body: {
        ...buildSendTypingRequest({
          ilinkUserId: input.peerUserId,
          typingTicket: input.typingTicket,
          state: TypingState.Stop,
        }),
        base_info: { channel_version: this.options.packageVersion },
      },
    });
    assertBusinessSuccess(response, "sendtyping");
  }
}
