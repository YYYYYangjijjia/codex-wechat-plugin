export type DeliveryKind = "image" | "pdf" | "doc" | "text" | "zip" | "file";

export type DeliveryIntent = {
  enabled: boolean;
  requestedKinds: DeliveryKind[];
  evidenceText: string[];
};

type DeliveryRule = {
  kind: DeliveryKind;
  patterns: RegExp[];
  evidence: string;
};

const DELIVERY_VERBS: Array<{ pattern: RegExp; evidence: string }> = [
  { pattern: /\bsend(?:\s+it|\s+them|\s+the\s+result|\s+back)?\b/i, evidence: "send it back" },
  { pattern: /\bdeliver\b/i, evidence: "deliver" },
  { pattern: /\breturn\b/i, evidence: "return" },
  { pattern: /发给我/u, evidence: "发给我" },
  { pattern: /发送给我/u, evidence: "发送给我" },
  { pattern: /回传/u, evidence: "回传" },
  { pattern: /回发/u, evidence: "回发" },
  { pattern: /发送到微信/u, evidence: "发送到微信" },
  { pattern: /发到微信/u, evidence: "发到微信" },
  { pattern: /发回微信/u, evidence: "发回微信" },
  { pattern: /发我/u, evidence: "发我" },
];

const DELIVERY_RULES: DeliveryRule[] = [
  { kind: "pdf", patterns: [/\bpdf\b/i, /PDF/], evidence: "PDF" },
  { kind: "doc", patterns: [/\bdocx?\b/i, /\bword\b/i, /Word/, /文档/u, /Word 文档/u], evidence: "Word" },
  { kind: "text", patterns: [/\btxt\b/i, /\btext\b/i, /\bmarkdown\b/i, /\bmd\b/i, /文本/u, /文本文档/u], evidence: "text" },
  { kind: "zip", patterns: [/\bzip\b/i, /压缩包/u], evidence: "zip" },
  { kind: "image", patterns: [/\bimage\b/i, /\bimages\b/i, /\bpicture\b/i, /\bscreenshot\b/i, /图片/u, /截图/u], evidence: "image" },
  { kind: "file", patterns: [/\bfile\b/i, /\bfiles\b/i, /文件/u, /附件/u], evidence: "文件" },
];

export function parseDeliveryIntent(text: string): DeliveryIntent {
  const trimmed = text.trim();
  if (!trimmed) {
    return disabledIntent();
  }

  const matchedVerbs = DELIVERY_VERBS.filter((rule) => rule.pattern.test(trimmed));
  if (matchedVerbs.length === 0) {
    return disabledIntent();
  }

  const requestedKinds: DeliveryKind[] = [];
  const evidenceText = matchedVerbs.map((rule) => rule.evidence);

  for (const rule of DELIVERY_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(trimmed))) {
      continue;
    }
    if (!requestedKinds.includes(rule.kind)) {
      requestedKinds.push(rule.kind);
    }
    if (!evidenceText.includes(rule.evidence)) {
      evidenceText.push(rule.evidence);
    }
  }

  if (requestedKinds.length === 0) {
    return disabledIntent();
  }

  const narrowedKinds = requestedKinds.includes("file") && requestedKinds.length > 1
    ? requestedKinds.filter((kind) => kind !== "file")
    : requestedKinds;

  return {
    enabled: true,
    requestedKinds: narrowedKinds,
    evidenceText,
  };
}

function disabledIntent(): DeliveryIntent {
  return {
    enabled: false,
    requestedKinds: [],
    evidenceText: [],
  };
}
