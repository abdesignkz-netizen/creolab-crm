import { readEsfConfig } from "./EsfConfig.ts";
import { ESF_MOCK_SIGNATURE } from "./EsfMock.ts";
import {
  buildGenerateAwpSignatureEnvelope,
  buildGenerateInvoiceSignatureEnvelope,
  parseAwpSignature,
  parseInvoiceSignature,
  parseSoapFault,
  postSoap,
} from "./EsfSoap.ts";

export const KALKAN_ADAPTER_MISSING = "kalkan_adapter_missing";
export const LEGACY_SERVER_P12_FORBIDDEN = "legacy_server_p12_forbidden";

/**
 * LEGACY / DEVELOPMENT POC ONLY.
 * Multi-tenant production must not load a user .p12 or PIN on the server.
 */
export function legacyServerSigningAllowed(config = readEsfConfig()) {
  return Boolean(config.legacyServerP12Allowed);
}

export function signingReadiness(config = readEsfConfig()) {
  if (config.provider === "mock") {
    return {
      ready: true,
      code: "esf_mock",
      message: "ESF_PROVIDER=mock: подпись не Kalkan/NCALayer, только локальный контур.",
      localServiceUrl: `${config.localServiceUrl}/LocalService`,
    };
  }
  if (!legacyServerSigningAllowed(config)) {
    return {
      ready: false,
      code: LEGACY_SERVER_P12_FORBIDDEN,
      message:
        "Server-side .p12/PIN отключён. Подпись XML — через NCALayer на компьютере пользователя. LocalService только для DEV POC (ESF_ALLOW_SERVER_P12=1, не production).",
      localServiceUrl: `${config.localServiceUrl}/LocalService`,
    };
  }
  const ready = Boolean(config.signCertificatePath && config.signCertificatePinConfigured);
  return {
    ready,
    code: ready ? "localserver" : KALKAN_ADAPTER_MISSING,
    message: ready
      ? "LEGACY POC: Official LocalService.generateSignature is configured"
      : "Official ESF XML signing needs Kalkan LocalService (certificatePath + PIN). This is not NCALayer CMS.",
    localServiceUrl: `${config.localServiceUrl}/LocalService`,
  };
}

export async function signAwpXml(awpBody: string, config = readEsfConfig()) {
  if (config.provider === "mock") {
    return {
      ok: true as const,
      code: "esf_mock",
      message: "ESF_PROVIDER=mock: подпись не Kalkan/NCALayer, только локальный контур.",
      signature: ESF_MOCK_SIGNATURE,
    };
  }
  const readiness = signingReadiness(config);
  if (!readiness.ready) {
    return { ok: false as const, code: readiness.code, message: readiness.message, signature: "" };
  }
  const pin = String(process.env.ESF_SIGN_CERT_PIN || "");
  const envelope = buildGenerateAwpSignatureEnvelope({
    awpBody,
    certificatePath: config.signCertificatePath,
    certificatePin: pin,
  });
  try {
    const response = await postSoap(`${config.localServiceUrl}/LocalService`, envelope);
    const fault = parseSoapFault(response.text);
    const signature = parseAwpSignature(response.text);
    if (!response.ok || fault || !signature) {
      return {
        ok: false as const,
        code: "esf_localserver_failed",
        message: fault?.description || fault?.faultstring || "LocalService.generateSignature не вернул signature",
        signature: "",
      };
    }
    return { ok: true as const, code: "signed", message: readiness.message, signature };
  } catch (error) {
    return {
      ok: false as const,
      code: "esf_localserver_unreachable",
      message: error instanceof Error ? error.message : "LocalService недоступен",
      signature: "",
    };
  }
}

export async function signInvoiceXml(invoiceBody: string, config = readEsfConfig()) {
  if (config.provider === "mock") {
    return {
      ok: true as const,
      code: "esf_mock",
      message: "ESF_PROVIDER=mock: подпись не Kalkan/NCALayer, только локальный контур.",
      signature: ESF_MOCK_SIGNATURE,
    };
  }
  const readiness = signingReadiness(config);
  if (!readiness.ready) {
    return { ok: false as const, code: readiness.code, message: readiness.message, signature: "" };
  }
  const pin = String(process.env.ESF_SIGN_CERT_PIN || "");
  const envelope = buildGenerateInvoiceSignatureEnvelope({
    invoiceBody,
    certificatePath: config.signCertificatePath,
    certificatePin: pin,
  });
  try {
    const response = await postSoap(`${config.localServiceUrl}/LocalService`, envelope);
    const fault = parseSoapFault(response.text);
    const signature = parseInvoiceSignature(response.text);
    if (!response.ok || fault || !signature) {
      return {
        ok: false as const,
        code: "esf_localserver_failed",
        message: fault?.description || fault?.faultstring || "LocalService.generateSignature не вернул signature",
        signature: "",
      };
    }
    return { ok: true as const, code: "signed", message: readiness.message, signature };
  } catch (error) {
    return {
      ok: false as const,
      code: "esf_localserver_unreachable",
      message: error instanceof Error ? error.message : "LocalService недоступен",
      signature: "",
    };
  }
}
