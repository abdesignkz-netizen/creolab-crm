import { existsSync, readFileSync } from "node:fs";

export const ESF_OFFICIAL = {
  prodBaseUrl: "https://esf.gov.kz:8443/esf-web",
  testBaseUrl: "https://test3.esf.kgd.gov.kz:8443/esf-web",
  localWebBaseUrl: "http://127.0.0.1:8009/esf-web",
  sessionPath: "/ws/api1/SessionService",
  awpPath: "/ws/api1/AwpWebService",
  invoiceUploadPath: "/ws/api1/UploadInvoiceService",
  invoicePath: "/ws/api1/InvoiceService",
  localServiceDefault: "http://127.0.0.1:6666",
  awpVersion: "AwpV1",
  invoiceVersion: "InvoiceV2",
  signatureTypeCompany: "COMPANY",
  sourceTypeOther: "OTHER",
} as const;

export type EsfEnv = "off" | "test" | "local" | "prod";
export type EsfProvider = "mock" | "live";

function envFlag(name: string) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function envText(name: string) {
  return String(process.env[name] || "").trim();
}

/** Inline PEM, or public cert file via ESF_*_PEM_FILE. Never reads a private key. */
export function envPem(name: string) {
  const inline = envText(name).replace(/\\n/g, "\n");
  if (inline) return inline;
  const file = envText(`${name}_FILE`);
  if (!file || !existsSync(file)) return "";
  return readFileSync(file, "utf8").trim();
}

export function resolveEsfProvider(input?: { provider?: string | null; nodeEnv?: string | null }) {
  const requested = String(input?.provider ?? process.env.ESF_PROVIDER ?? "").trim().toLowerCase();
  const nodeEnv = String(input?.nodeEnv ?? process.env.NODE_ENV ?? "").trim().toLowerCase();
  if (requested === "mock" && nodeEnv === "production") return "live" as const;
  if (requested === "mock") return "mock" as const;
  return "live" as const;
}

export function sanitizedEsfHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isProductionEsfUrl(url: string) {
  const host = sanitizedEsfHost(url);
  return host === "esf.gov.kz" || host.endsWith(".esf.gov.kz");
}

/** ESF_ALLOW_LIVE_SEND never changes the contour. TEST cannot resolve to production. */
export function resolveEsfBaseUrl(input?: {
  esfEnv?: EsfEnv;
  baseUrl?: string | null;
  testApiUrl?: string | null;
  productionApiUrl?: string | null;
}) {
  const esfEnv = input?.esfEnv;
  const override = String(input?.baseUrl ?? "").trim().replace(/\/$/, "");
  const testUrl = String(input?.testApiUrl ?? "").trim().replace(/\/$/, "");
  const productionUrl = String(input?.productionApiUrl ?? "").trim().replace(/\/$/, "");
  let baseUrl =
    override ||
    (esfEnv === "prod"
      ? productionUrl || ESF_OFFICIAL.prodBaseUrl
      : esfEnv === "local"
        ? ESF_OFFICIAL.localWebBaseUrl
        : testUrl || ESF_OFFICIAL.testBaseUrl);
  if (esfEnv === "test" && isProductionEsfUrl(baseUrl)) {
    baseUrl = ESF_OFFICIAL.testBaseUrl;
  }
  return baseUrl.replace(/\/$/, "");
}

export function assertTestEndpointNotProduction(config: { esfEnv: EsfEnv; baseUrl: string }) {
  if (config.esfEnv === "test" && isProductionEsfUrl(config.baseUrl)) {
    throw new Error("ESF_ENV=test запрещает production endpoint ИС ЭСФ");
  }
}

export function readEsfConfig() {
  const rawEnv = String(process.env.ESF_ENV || "off").trim().toLowerCase();
  const esfEnv: EsfEnv =
    rawEnv === "test" || rawEnv === "local" || rawEnv === "prod" || rawEnv === "off" ? rawEnv : "off";
  const provider = resolveEsfProvider();
  const baseUrl = resolveEsfBaseUrl({
    esfEnv,
    baseUrl: process.env.ESF_BASE_URL,
    testApiUrl: process.env.ESF_TEST_API_URL,
    productionApiUrl: process.env.ESF_PRODUCTION_API_URL,
  });
  assertTestEndpointNotProduction({ esfEnv, baseUrl });
  const allowLiveSend = envFlag("ESF_ALLOW_LIVE_SEND");
  const allowProd = envFlag("ESF_ALLOW_PROD");
  const liveSendAllowed = allowLiveSend && esfEnv !== "off" && (esfEnv !== "prod" || allowProd);
  return {
    provider,
    esfEnv,
    baseUrl,
    endpointHost: sanitizedEsfHost(baseUrl),
    sessionUrl: `${baseUrl}${ESF_OFFICIAL.sessionPath}`,
    awpUrl: `${baseUrl}${ESF_OFFICIAL.awpPath}`,
    invoiceUploadUrl: `${baseUrl}${ESF_OFFICIAL.invoiceUploadPath}`,
    invoiceUrl: `${baseUrl}${ESF_OFFICIAL.invoicePath}`,
    localServiceUrl: String(process.env.ESF_LOCAL_SERVICE_URL || ESF_OFFICIAL.localServiceDefault).replace(/\/$/, ""),
    /** @deprecated LEGACY/DEV POC ONLY. Production identity comes from TenantLegalProfile.bin */
    tin: envText("ESF_TIN"),
    /** @deprecated LEGACY/DEV POC ONLY. Signer IIN comes from the selected AUTH certificate */
    iin: envText("ESF_IIN"),
    /** @deprecated LEGACY/DEV POC ONLY. Cabinet password is in-memory per connect, never stored */
    passwordConfigured: Boolean(envText("ESF_PASSWORD")),
    authCertificatePem: envPem("ESF_AUTH_CERT_PEM"),
    signCertificatePem: envPem("ESF_SIGN_CERT_PEM"),
    signCertificatePath: envText("ESF_SIGN_CERT_PATH"),
    signCertificatePinConfigured: Boolean(envText("ESF_SIGN_CERT_PIN")),
    /** LocalService .p12+PIN is not allowed in multi-tenant production. */
    legacyServerP12Allowed: envFlag("ESF_ALLOW_SERVER_P12") && String(process.env.NODE_ENV || "") !== "production",
    allowLiveSend,
    allowProd,
    liveSendAllowed,
    tlsInsecure: envFlag("ESF_TLS_INSECURE"),
    legacyPocEnabled: esfLegacyPocEnabled(),
  };
}

/** Server-P12 / LocalService POC only. Never on in production. */
export function esfLegacyPocEnabled() {
  const env = String(process.env.NODE_ENV || "");
  if (env === "production") return false;
  if (env === "test") return true;
  return envFlag("ESF_LEGACY_POC_ENABLED");
}

export type EsfConfig = ReturnType<typeof readEsfConfig>;
