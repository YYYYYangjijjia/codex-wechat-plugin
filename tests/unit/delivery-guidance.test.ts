import { describe, expect, test } from "vitest";

import { appendDeliverySkillPrompt, extractDeliveredFileMarkers, stripDeliveredFileMarkers } from "../../src/daemon/delivery-guidance.js";

describe("delivery guidance helpers", () => {
  test("appends deliver-file guidance for authorized turns", () => {
    const result = appendDeliverySkillPrompt("请生成一个 PDF。", {
      enabled: true,
      requestedKinds: ["pdf", "image"],
      evidenceText: ["PDF", "发给我"],
    });

    expect(result).toContain("deliver-file");
    expect(result).toContain("send_file_message");
    expect(result).toContain("send_image_message");
    expect(result).toContain("This is an execution request, not a research request.");
    expect(result).toContain("Do not inspect the skill catalog");
    expect(result).toContain("node skills/deliver-file/scripts/send_wechat_file.mjs --file <absolute-path>");
    expect(result).toContain("If `deliver-file` is not discoverable");
    expect(result).toContain("Do not spend time auditing whether the bridge supports delivery");
    expect(result).toContain("Create the requested artifact first, then send it immediately.");
    expect(result).toContain("[[WECHAT_DELIVERED:<absolute-path>]]");
    expect(result).toContain("pdf, image");
  });

  test("extracts and strips delivered file markers", () => {
    const text = [
      "任务完成。",
      "[[WECHAT_DELIVERED:C:\\temp\\a.pdf]]",
      "[[WECHAT_DELIVERED:D:\\out\\b.png]]",
    ].join("\n");

    expect(extractDeliveredFileMarkers(text)).toEqual([
      "C:\\temp\\a.pdf",
      "D:\\out\\b.png",
    ]);
    expect(stripDeliveredFileMarkers(text)).toBe("任务完成。");
  });
});
