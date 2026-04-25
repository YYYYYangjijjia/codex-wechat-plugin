import {
  buildAuthenticatedHeaders,
  buildFileMessageRequest,
  buildGetUploadUrlRequest,
  buildImageMessageRequest,
  buildSendMessageRequest,
  HttpWeixinClient,
  buildSendTypingRequest,
  TypingState,
  UploadMediaType,
} from "../../src/weixin/weixin-api-client.js";

describe("Weixin API request builders", () => {
  test("builds authenticated headers with required Weixin fields", () => {
    const headers = buildAuthenticatedHeaders({
      token: "secret-token",
      appId: "bot",
      clientVersion: 65547,
      randomWechatUin: "MTIzNA==",
    });

    expect(headers).toMatchObject({
      AuthorizationType: "ilink_bot_token",
      Authorization: "Bearer secret-token",
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "65547",
      "X-WECHAT-UIN": "MTIzNA==",
    });
  });

  test("builds a final text message request with context token", () => {
    const request = buildSendMessageRequest({
      toUserId: "user-a@im.wechat",
      text: "Hello from Codex",
      clientId: "client-1",
      contextToken: "ctx-1",
    });

    expect(request).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "user-a@im.wechat",
        client_id: "client-1",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-1",
        item_list: [
          {
            type: 1,
            text_item: { text: "Hello from Codex" },
          },
        ],
      },
    });
  });

  test("builds an upload-url request for outbound media", () => {
    expect(buildGetUploadUrlRequest({
      fileKey: "file-1",
      mediaType: UploadMediaType.FILE,
      toUserId: "user-a@im.wechat",
      rawSize: 123,
      rawFileMd5: "abc",
      cipherSize: 128,
      aesKeyHex: "00112233445566778899aabbccddeeff",
      noNeedThumb: true,
    })).toEqual({
      filekey: "file-1",
      media_type: 3,
      to_user_id: "user-a@im.wechat",
      rawsize: 123,
      rawfilemd5: "abc",
      filesize: 128,
      no_need_thumb: true,
      aeskey: "00112233445566778899aabbccddeeff",
    });
  });

  test("builds an outbound image message request", () => {
    expect(buildImageMessageRequest({
      toUserId: "user-a@im.wechat",
      clientId: "client-1",
      contextToken: "ctx-1",
      encryptQueryParam: "enc-1",
      aesKeyBase64: "YWVzLWtleQ==",
      cipherSize: 4096,
    })).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "user-a@im.wechat",
        client_id: "client-1",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-1",
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: "enc-1",
                aes_key: "YWVzLWtleQ==",
                encrypt_type: 1,
              },
              mid_size: 4096,
            },
          },
        ],
      },
    });
  });

  test("builds an outbound file message request", () => {
    expect(buildFileMessageRequest({
      toUserId: "user-a@im.wechat",
      clientId: "client-2",
      contextToken: "ctx-2",
      fileName: "report.pdf",
      encryptQueryParam: "enc-2",
      aesKeyBase64: "YWVzLWtleQ==",
      plainSize: 2048,
    })).toEqual({
      msg: {
        from_user_id: "",
        to_user_id: "user-a@im.wechat",
        client_id: "client-2",
        message_type: 2,
        message_state: 2,
        context_token: "ctx-2",
        item_list: [
          {
            type: 4,
            file_item: {
              media: {
                encrypt_query_param: "enc-2",
                aes_key: "YWVzLWtleQ==",
                encrypt_type: 1,
              },
              file_name: "report.pdf",
              len: "2048",
            },
          },
        ],
      },
    });
  });

  test("builds typing requests for start and stop", () => {
    expect(buildSendTypingRequest({
      ilinkUserId: "user-a@im.wechat",
      typingTicket: "ticket-1",
      state: TypingState.Start,
    })).toEqual({
      ilink_user_id: "user-a@im.wechat",
      typing_ticket: "ticket-1",
      status: 1,
    });

    expect(buildSendTypingRequest({
      ilinkUserId: "user-a@im.wechat",
      typingTicket: "ticket-1",
      state: TypingState.Stop,
    })).toEqual({
      ilink_user_id: "user-a@im.wechat",
      typing_ticket: "ticket-1",
      status: 2,
    });
  });

  test("treats sendmessage business failures as errors even when HTTP is 200", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ret: -2, errmsg: "business reject" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new HttpWeixinClient({
      baseUrl: "https://example.test/",
      token: "token",
      appId: "app-id",
      clientVersion: 65547,
      packageVersion: "0.1.0",
    });

    await expect(
      client.sendTextMessage({
        peerUserId: "user-a@im.wechat",
        contextToken: "ctx-1",
        text: "hello",
      }),
    ).rejects.toThrow(/context is no longer valid/i);

    globalThis.fetch = originalFetch;
  });

  test("retries transient transport fetch failures for sendmessage with the same client id", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ret: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new HttpWeixinClient({
      baseUrl: "https://example.test/",
      token: "token",
      appId: "app-id",
      clientVersion: 65547,
      packageVersion: "0.1.0",
    });

    const result = await client.sendTextMessage({
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      text: "hello",
    });

    expect(result.messageId).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));

    expect(firstBody.msg.client_id).toBeTruthy();
    expect(secondBody.msg.client_id).toBe(firstBody.msg.client_id);

    globalThis.fetch = originalFetch;
  });

  test("times out fetchUpdates even when the underlying fetch never settles", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new HttpWeixinClient({
      baseUrl: "https://example.test/",
      token: "token",
      appId: "app-id",
      clientVersion: 65547,
      packageVersion: "0.1.0",
    });

    await expect(client.fetchUpdates({ timeoutMs: 5 })).rejects.toThrow(/request timed out after 5ms/i);

    globalThis.fetch = originalFetch;
  });

  test("requests upload parameters for outbound media", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ upload_full_url: "https://cdn.example/upload" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new HttpWeixinClient({
      baseUrl: "https://example.test/",
      token: "token",
      appId: "app-id",
      clientVersion: 65547,
      packageVersion: "0.1.0",
    });

    const result = await client.getUploadUrl({
      fileKey: "file-1",
      mediaType: UploadMediaType.FILE,
      toUserId: "user-a@im.wechat",
      rawSize: 123,
      rawFileMd5: "abc",
      cipherSize: 128,
      aesKeyHex: "00112233445566778899aabbccddeeff",
      noNeedThumb: true,
    });

    expect(result).toEqual({ uploadFullUrl: "https://cdn.example/upload" });

    const uploadCalls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const uploadRequest = uploadCalls[0]?.[1];
    const body = JSON.parse(String(uploadRequest?.body));
    expect(body).toMatchObject({
      filekey: "file-1",
      media_type: 3,
      to_user_id: "user-a@im.wechat",
      rawsize: 123,
      rawfilemd5: "abc",
      filesize: 128,
      no_need_thumb: true,
      aeskey: "00112233445566778899aabbccddeeff",
    });

    globalThis.fetch = originalFetch;
  });

  test("sends an outbound file item", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ret: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new HttpWeixinClient({
      baseUrl: "https://example.test/",
      token: "token",
      appId: "app-id",
      clientVersion: 65547,
      packageVersion: "0.1.0",
    });

    const result = await client.sendFileMessage({
      peerUserId: "user-a@im.wechat",
      contextToken: "ctx-1",
      fileName: "report.pdf",
      encryptQueryParam: "enc-1",
      aesKeyBase64: "YWVzLWtleQ==",
      plainSize: 2048,
    });

    expect(result.messageId).toBeTruthy();
    const sendCalls = fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const sendRequest = sendCalls[0]?.[1];
    const body = JSON.parse(String(sendRequest?.body));
    expect(body.msg.item_list[0]).toEqual({
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: "enc-1",
          aes_key: "YWVzLWtleQ==",
          encrypt_type: 1,
        },
        file_name: "report.pdf",
        len: "2048",
      },
    });

    globalThis.fetch = originalFetch;
  });
});
