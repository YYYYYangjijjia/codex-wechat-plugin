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
  { pattern: /\u53d1\u7ed9\u6211/u, evidence: "\u53d1\u7ed9\u6211" },
  { pattern: /\u53d1\u9001\u7ed9\u6211/u, evidence: "\u53d1\u9001\u7ed9\u6211" },
  { pattern: /\u7ed9\u6211\u53d1/u, evidence: "\u7ed9\u6211\u53d1" },
  { pattern: /\u7ed9\u6211\u53d1\u9001/u, evidence: "\u53d1\u9001" },
  { pattern: /\u53d1\u9001/u, evidence: "\u53d1\u9001" },
  { pattern: /\u53d1\u5230\u5fae\u4fe1/u, evidence: "\u53d1\u5230\u5fae\u4fe1" },
  { pattern: /\u53d1\u9001\u5230\u5fae\u4fe1/u, evidence: "\u53d1\u9001\u5230\u5fae\u4fe1" },
  { pattern: /\u53d1\u56de\u5fae\u4fe1/u, evidence: "\u53d1\u56de\u5fae\u4fe1" },
  { pattern: /\u56de\u4f20/u, evidence: "\u56de\u4f20" },
  { pattern: /\u56de\u53d1/u, evidence: "\u56de\u53d1" },
];

const DELIVERY_RULES: DeliveryRule[] = [
  { kind: "pdf", patterns: [/\bpdf\b/i, /PDF/], evidence: "PDF" },
  { kind: "doc", patterns: [/\bdocx?\b/i, /\bword\b/i, /Word/, /\u6587\u6863/u], evidence: "Word" },
  { kind: "text", patterns: [/\btxt\b/i, /\btext\b/i, /\bmarkdown\b/i, /\bmd\b/i, /\u6587\u672c/u], evidence: "text" },
  { kind: "zip", patterns: [/\bzip\b/i, /\u538b\u7f29\u5305/u], evidence: "zip" },
  { kind: "image", patterns: [/\bimage\b/i, /\bimages\b/i, /\bpicture\b/i, /\bscreenshot\b/i, /\u56fe\u7247/u, /\u622a\u56fe/u], evidence: "image" },
  { kind: "file", patterns: [/\bfile\b/i, /\bfiles\b/i, /\u6587\u4ef6/u, /\u9644\u4ef6/u], evidence: "\u6587\u4ef6" },
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
  const evidenceText = [...new Set(matchedVerbs.map((rule) => rule.evidence))];

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
