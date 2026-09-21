/**
 * Server-side GOST CMS verification via official NCA Kalkan.
 * Signing stays on the user's NCALayer. No .p12 / PIN on this path.
 */
export type KalkanVerifyConfig = {
  url: string;
  secret: string;
  timeoutMs: number;
};

function envTrim(name: string) {
  return String(process.env[name] || "").trim();
}

export function readKalkanVerifyConfig(): KalkanVerifyConfig | null {
  const url = envTrim("KALKAN_VERIFY_URL").replace(/\/$/, "");
  if (!url) return null;
  const timeoutRaw = Number(envTrim("KALKAN_VERIFY_TIMEOUT_MS") || "15000");
  return {
    url,
    secret: envTrim("KALKAN_VERIFY_SECRET"),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw >= 500 ? timeoutRaw : 15000,
  };
}
