import crypto from "node:crypto";

import type { BridgeConfig } from "../config/app-config.js";
import { classifyQrStatus, normalizeQrPollFailure, QR_STATUS } from "./qr-login.js";
import { HttpWeixinClient } from "./weixin-api-client.js";

export type ActiveLoginSession = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  currentBaseUrl: string;
  startedAt: number;
};

export class LoginManager {
  private readonly sessions = new Map<string, ActiveLoginSession>();

  public constructor(private readonly config: BridgeConfig) {}

  async startLogin(accountId?: string): Promise<{ sessionKey: string; qrcodeUrl: string; message: string }> {
    const client = new HttpWeixinClient({
      baseUrl: this.config.weixinBaseUrl,
      appId: this.config.ilinkAppId,
      clientVersion: this.config.clientVersion,
      packageVersion: this.config.packageVersion,
    });
    const started = await client.startQrLogin(this.config.ilinkBotType);
    const sessionKey = accountId ?? crypto.randomUUID();
    this.sessions.set(sessionKey, {
      sessionKey,
      qrcode: started.qrcode,
      qrcodeUrl: started.qrcodeUrl,
      currentBaseUrl: this.config.weixinBaseUrl,
      startedAt: Date.now(),
    });
    return {
      sessionKey,
      qrcodeUrl: started.qrcodeUrl,
      message: "QR code created. Scan it with WeChat and poll get_login_status until confirmed.",
    };
  }

  getActiveSession(sessionKey: string): ActiveLoginSession | undefined {
    return this.sessions.get(sessionKey);
  }

  async getLoginStatus(sessionKey: string): Promise<
    | { connected: false; status: string; message: string; qrcodeUrl?: string | undefined }
    | { connected: true; status: string; accountId: string; botToken: string; baseUrl: string; linkedUserId?: string | undefined }
  > {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return { connected: false, status: "missing", message: "No active login session found for that session key." };
    }

    const client = new HttpWeixinClient({
      baseUrl: session.currentBaseUrl,
      appId: this.config.ilinkAppId,
      clientVersion: this.config.clientVersion,
      packageVersion: this.config.packageVersion,
    });

    try {
      const status = await client.pollQrLoginStatus(session.qrcode);
      const phase = classifyQrStatus({
        status: status.status as typeof QR_STATUS[keyof typeof QR_STATUS],
        redirect_host: status.redirectHost,
        ilink_bot_id: status.accountId,
      });

      if (phase === "redirect" && status.redirectHost) {
        session.currentBaseUrl = `https://${status.redirectHost}`;
      }

      if (phase === "confirmed" && status.accountId && status.botToken) {
        this.sessions.delete(sessionKey);
        return {
          connected: true,
          status: status.status,
          accountId: status.accountId,
          botToken: status.botToken,
          baseUrl: status.baseUrl ?? session.currentBaseUrl,
          linkedUserId: status.linkedUserId,
        };
      }

      if (phase === "expired") {
        this.sessions.delete(sessionKey);
      }

      return {
        connected: false,
        status: status.status,
        message: `Current QR login status: ${status.status}`,
        qrcodeUrl: session.qrcodeUrl,
      };
    } catch (error) {
      const normalized = normalizeQrPollFailure(error);
      return {
        connected: false,
        status: normalized.status,
        message: `Current QR login status: ${normalized.status}`,
        qrcodeUrl: session.qrcodeUrl,
      };
    }
  }
}
