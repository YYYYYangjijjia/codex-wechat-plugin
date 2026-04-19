import type { DeliveryIntent } from "./delivery-intent.js";

const DELIVERED_MARKER_PATTERN = /^\[\[WECHAT_DELIVERED:(.+?)\]\]$/gm;

export function appendDeliverySkillPrompt(basePrompt: string, intent: DeliveryIntent): string {
  if (!intent.enabled) {
    return basePrompt;
  }

  const requestedKinds = intent.requestedKinds.length > 0
    ? intent.requestedKinds.join(", ")
    : "file";
  const evidence = intent.evidenceText.length > 0
    ? intent.evidenceText.join(", ")
    : "explicit delivery request";

  const guidance = [
    "",
    "[WeChat delivery authorization]",
    "The user explicitly authorized sending one or more local files back to the current WeChat / Weixin chat in this turn.",
    `Requested file kinds: ${requestedKinds}.`,
    `Delivery evidence: ${evidence}.`,
    "This is an execution request, not a research request.",
    "Do not inspect the skill catalog, README files, plugin source code, or bridge implementation before acting.",
    "Do not spend the turn auditing whether delivery is supported.",
    "Preferred execution path:",
    "node skills/deliver-file/scripts/send_wechat_file.mjs --file <absolute-path>",
    "If you need to send a local artifact, use the installed skill `deliver-file` and the bridge MCP tools `send_file_message` or `send_image_message`.",
    "If `deliver-file` is not discoverable in the current skill catalog, call `send_file_message` or `send_image_message` directly instead of stalling.",
    "Do not spend time auditing whether the bridge supports delivery. The bridge already authorized this turn.",
    "Create the requested artifact first, then send it immediately.",
    "Only send files that are directly relevant to the user's current request.",
    "Prefer explicit absolute paths. Do not guess unrelated files.",
    "After each successful delivery, append one exact line to your final answer:",
    "[[WECHAT_DELIVERED:<absolute-path>]]",
    "Only emit that marker after the send actually succeeds.",
  ].join("\n");

  return [basePrompt.trimEnd(), guidance].filter((part) => part.length > 0).join("\n");
}

export function extractDeliveredFileMarkers(text: string): string[] {
  const results: string[] = [];
  for (const match of text.matchAll(DELIVERED_MARKER_PATTERN)) {
    const filePath = match[1]?.trim();
    if (filePath && !results.includes(filePath)) {
      results.push(filePath);
    }
  }
  return results;
}

export function stripDeliveredFileMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\[\[WECHAT_DELIVERED:.+\]\]$/.test(line.trim()))
    .join("\n")
    .trim();
}
