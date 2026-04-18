import {
  QR_STATUS,
  classifyQrStatus,
  normalizeQrPollFailure,
} from "../../src/weixin/qr-login.js";

describe("QR login helpers", () => {
  test("treats abort timeouts as a wait state instead of a hard failure", () => {
    const result = normalizeQrPollFailure(new DOMException("timeout", "AbortError"));
    expect(result).toEqual({ status: QR_STATUS.wait });
  });

  test("classifies confirmed and redirect statuses explicitly", () => {
    expect(classifyQrStatus({ status: QR_STATUS.confirmed, ilink_bot_id: "bot-1" })).toEqual("confirmed");
    expect(classifyQrStatus({ status: QR_STATUS.scaned_but_redirect, redirect_host: "example.com" })).toEqual("redirect");
  });
});