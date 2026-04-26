import { describe, expect, test } from "vitest";

import { parseDeliveryIntent } from "../../src/daemon/delivery-intent.js";

describe("parseDeliveryIntent", () => {
  test("does not enable delivery when the user only asks for local generation", () => {
    expect(parseDeliveryIntent("Generate a PDF report.")).toEqual({
      enabled: false,
      requestedKinds: [],
      evidenceText: [],
    });

    expect(parseDeliveryIntent("\u8bf7\u5e2e\u6211\u751f\u6210\u4e00\u4e2a PDF \u62a5\u544a")).toEqual({
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

    expect(parseDeliveryIntent("\u8bf7\u8fdb\u884c\u6574\u7406\uff0c\u7136\u540e\u628a\u751f\u6210\u7684 PDF \u6587\u4ef6\u53d1\u7ed9\u6211")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf"],
      evidenceText: expect.arrayContaining(["PDF", "\u53d1\u7ed9\u6211"]),
    });
  });

  test("enables delivery for real Chinese WeChat send-file wording", () => {
    expect(parseDeliveryIntent("\u7ed9\u6211\u53d1\u9001\u4e00\u4e2a\u6d4b\u8bd5\u6587\u4ef6pdf")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf"],
      evidenceText: expect.arrayContaining(["PDF", "\u53d1\u9001"]),
    });

    expect(parseDeliveryIntent("\u628a\u751f\u6210\u7684 PDF \u6587\u4ef6\u53d1\u7ed9\u6211")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf"],
      evidenceText: expect.arrayContaining(["PDF", "\u53d1\u7ed9\u6211"]),
    });
  });

  test("maps broad file requests conservatively", () => {
    expect(parseDeliveryIntent("\u8bf7\u5b8c\u6210\u4efb\u52a1\u540e\u628a\u6700\u7ec8\u6587\u4ef6\u53d1\u9001\u5230\u5fae\u4fe1")).toMatchObject({
      enabled: true,
      requestedKinds: ["file"],
      evidenceText: expect.arrayContaining(["\u6587\u4ef6", "\u53d1\u9001"]),
    });
  });

  test("keeps multiple requested kinds in stable order without duplicates", () => {
    expect(parseDeliveryIntent("\u8bf7\u751f\u6210 PDF \u548c zip\uff0c\u7136\u540e\u628a zip \u548c PDF \u90fd\u53d1\u7ed9\u6211")).toMatchObject({
      enabled: true,
      requestedKinds: ["pdf", "zip"],
      evidenceText: expect.arrayContaining(["PDF", "zip", "\u53d1\u7ed9\u6211"]),
    });
  });
});
