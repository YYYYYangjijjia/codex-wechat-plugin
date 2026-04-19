import {
  buildAuthenticatedHeaders,
  buildSendMessageRequest,
  HttpWeixinClient,
  buildSendTypingRequest,
  TypingState,
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
});
