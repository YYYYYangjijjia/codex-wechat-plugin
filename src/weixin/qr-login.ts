export const QR_STATUS = {
  wait: "wait",
  scaned: "scaned",
  confirmed: "confirmed",
  expired: "expired",
  scaned_but_redirect: "scaned_but_redirect",
} as const;

export type QrStatus = (typeof QR_STATUS)[keyof typeof QR_STATUS];

export type QrStatusPayload = {
  status: QrStatus;
  redirect_host?: string | undefined;
  ilink_bot_id?: string | undefined;
};

export function normalizeQrPollFailure(error: unknown): QrStatusPayload {
  if (error instanceof Error && error.name === "AbortError") {
    return { status: QR_STATUS.wait };
  }
  throw error;
}

export function classifyQrStatus(payload: QrStatusPayload): "waiting" | "redirect" | "confirmed" | "expired" | "scanned" {
  switch (payload.status) {
    case QR_STATUS.confirmed:
      return "confirmed";
    case QR_STATUS.scaned_but_redirect:
      return "redirect";
    case QR_STATUS.expired:
      return "expired";
    case QR_STATUS.scaned:
      return "scanned";
    case QR_STATUS.wait:
    default:
      return "waiting";
  }
}
