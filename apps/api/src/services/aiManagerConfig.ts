import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { assertExternalCallbackUrl } from "../lib/externalUrl.ts";

export type WhatsAppSellerSchema = {
  sellerUrl?: string;
  secretEnc?: string;
  instanceId?: string;
  apiTokenEnc?: string;
  sendOwner?: string;
  webhookToken?: string;
  webhookUrl?: string;
  greenApiHost?: string;
  aiSync?: {
    lastAttemptAt?: string;
    lastAttemptOk?: boolean;
    lastAttemptRegistered?: boolean;
    lastAttemptNote?: string;
    liveAt?: string;
    livePromptFp?: string;
    liveKnowledgeFp?: string;
  };
};

export function sharedAiManagerUrl() {
  return String(process.env.AI_MANAGER_URL || config.whatsappSellerUrl || "")
    .trim()
    .replace(/\/$/, "");
}

export function platformBridgeSecret() {
  return String(config.crmBridgeSecret || config.whatsappSellerSecret || "").trim();
}

export function internalServiceSecret() {
  return String(config.internalServiceSecret || process.env.INTERNAL_SERVICE_SECRET || "").trim() || platformBridgeSecret();
}

export function aiManagerWebhookUrl(managerUrl: string, webhookToken: string) {
  const token = String(webhookToken || "").trim();
  const base = String(managerUrl || "").trim().replace(/\/$/, "");
  if (!base || !token) return "";
  return `${base}/webhook/${token}`;
}

export function resolveAiManagerUrl(legacySellerUrl?: string | null) {
  return sharedAiManagerUrl() || String(legacySellerUrl || "").trim().replace(/\/$/, "");
}

export function assertAiManagerReachableUrl(url: string) {
  if (!url) {
    throw new ApiError(422, "ai_manager_unconfigured", "Общий AI Manager не задан. Нужен AI_MANAGER_URL.");
  }
  assertExternalCallbackUrl(url, "sellerUrl");
  const shared = sharedAiManagerUrl();
  if (shared && url.replace(/\/$/, "") !== shared) {
    throw new ApiError(422, "invalid_url", "Адрес AI Manager задаётся платформой и не принимается из кабинета компании");
  }
}

export function extractWhatsAppInstanceId(payload: unknown) {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested = body.instanceData && typeof body.instanceData === "object" ? (body.instanceData as Record<string, unknown>) : {};
  const messageData = body.messageData && typeof body.messageData === "object" ? (body.messageData as Record<string, unknown>) : {};
  return String(
    body.instanceId ||
      body.idInstance ||
      nested.idInstance ||
      nested.instanceId ||
      messageData.idInstance ||
      "",
  ).trim();
}
