import { describe, expect, test } from "vitest";

import { parseDeliveryIntent } from "../../src/daemon/delivery-intent.js";

describe("parseDeliveryIntent", () => {
  test("does not enable delivery when the user only asks for local generation", () => {
    expect(parseDeliveryIntent("Generate a PDF report.")).toEqual({
      enabled: false,
      requestedKinds: [],
      evidenceText: [],
    });

    expect(parseDeliveryIntent("请帮我生成一个 PDF 报告")).toEqual({
      enabled: false,
      requestedKinds: [],
      evidenceText: [],
    });
  });

  test("enables delivery when send-back intent and artifact type both exist", () => {
    expect(parseDeliveryIntent("Generate a PDF report and send it back to me on WeChat.")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf"],
      evidenceText: expect.arrayContaining(["PDF", "send it back"]),
    });

    expect(parseDeliveryIntent("请进行整理，然后把生成的 PDF 文件发给我")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf"],
      evidenceText: expect.arrayContaining(["PDF", "发给我"]),
    });
  });

  test("maps broad file requests conservatively", () => {
    expect(parseDeliveryIntent("请完成任务后把最终文件发送到微信")).toMatchObject({
      enabled: true,
      requestedKinds: ["file"],
      evidenceText: expect.arrayContaining(["文件", "发送到微信"]),
    });
  });

  test("keeps multiple requested kinds in stable order without duplicates", () => {
    expect(parseDeliveryIntent("请生成 PDF 和 zip，然后把 zip 和 PDF 都发给我")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf", "zip"],
      evidenceText: expect.arrayContaining(["PDF", "zip", "发给我"]),
    });
  });
});
