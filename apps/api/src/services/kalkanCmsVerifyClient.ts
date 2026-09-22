import { readKalkanVerifyConfig } from "../lib/kalkanVerifyConfig.ts";

export type KalkanCryptoStatus = "VERIFIED" | "FAILED" | "UNAVAILABLE";
export type KalkanAuthorityStatus = "VALID" | "REVOKED" | "UNCHECKED";

export type KalkanCmsVerifyResult = {
  skipped: boolean;
  cryptoStatus: KalkanCryptoStatus;
  authorityStatus: KalkanAuthorityStatus;
  error?: string;
};

type SidecarBody = {
  ok?: boolean;
  cryptoStatus?: string;
  authorityStatus?: string;
  error?: string;
};

function asCryptoStatus(value: unknown): KalkanCryptoStatus | null {
  if (value === "VERIFIED" || value === "FAILED" || value === "UNAVAILABLE") return value;
  return null;
}

function asAuthorityStatus(value: unknown): KalkanAuthorityStatus {
  if (value === "VALID" || value === "REVOKED" || value === "UNCHECKED") return value;
  return "UNCHECKED";
}

export async function verifyCmsWithKalkan(input: {
  cmsBase64: string;
  documentBytes: Buffer;
}): Promise<KalkanCmsVerifyResult> {
  const config = readKalkanVerifyConfig();
  if (!config) {
    return { skipped: true, cryptoStatus: "UNAVAILABLE", authorityStatus: "UNCHECKED", error: "gost_kalkan_adapter_missing" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (config.secret) headers.Authorization = `Bearer ${config.secret}`;
    const response = await fetch(`${config.url}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cmsBase64: input.cmsBase64,
        documentBase64: input.documentBytes.toString("base64"),
      }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as SidecarBody;
    if (!response.ok) {
      return {
        skipped: false,
        cryptoStatus: response.status === 503 ? "UNAVAILABLE" : "FAILED",
        authorityStatus: "UNCHECKED",
        error: String(body.error || `kalkan_http_${response.status}`),
      };
    }
    const cryptoStatus = asCryptoStatus(body.cryptoStatus) || "FAILED";
    return {
      skipped: false,
      cryptoStatus: body.ok === false && body.authorityStatus !== "REVOKED" && body.authorityStatus !== "UNCHECKED" ? "FAILED" : cryptoStatus,
      authorityStatus: asAuthorityStatus(body.authorityStatus),
      error: body.ok ? undefined : String(body.error || "cms_verify_failed"),
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      skipped: false,
      cryptoStatus: "UNAVAILABLE",
      authorityStatus: "UNCHECKED",
      error: aborted ? "kalkan_timeout" : "kalkan_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}
