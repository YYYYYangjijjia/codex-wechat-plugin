import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

describe("task-finished notifier payload parsing", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a UTF-8 payload file with BOM", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-finished-notifier-"));
    tempDirs.push(tempDir);
    const payloadPath = path.join(tempDir, "payload.json");
    const json = JSON.stringify({
      overview: "已完成验证",
      results: "中文内容应保持可读。",
      nextStep: "继续下一步。",
    }, null, 2);
    fs.writeFileSync(payloadPath, `\uFEFF${json}`, "utf8");

    // @ts-expect-error local .mjs script is covered by a colocated declaration file at runtime
    return import("../../skills/task-finished-notifier/scripts/send_task_finished_notification.mjs")
      .then((module) => {
        expect(module.readPayloadFile(payloadPath)).toMatchObject({
          overview: "已完成验证",
          results: "中文内容应保持可读。",
          nextStep: "继续下一步。",
        });
      });
  });
});
