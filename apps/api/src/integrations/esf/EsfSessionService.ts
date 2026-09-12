import { randomUUID } from "node:crypto";
import { officialEsfFaultCode } from "./poc/diagnosePublicCertificate.ts";
import { ESF_OFFICIAL, readEsfConfig, type EsfConfig } from "./EsfConfig.ts";
import {
  buildCloseSessionEnvelope,
  buildCreateSessionEnvelope,
  buildCurrentSessionStatusEnvelope,
  isWsseCredentialFault,
  parseSessionId,
  parseSessionStatus,
  parseSoapFault,
  postSoap,
} from "./EsfSoap.ts";

export function sessionReadiness(config = readEsfConfig()) {
  return {
    ready: Boolean(config.tin && config.authCertificatePem),
    tinConfigured: Boolean(config.tin),
    certificateConfigured: Boolean(config.authCertificatePem),
  };
}

/**
 * Official SessionService.createSession from SessionService.wsdl:
 * tin + x509Certificate. SoapUI examples add optional WSSE UsernameToken
 * (cabinet IIN + cabinet password, not ЭЦП PIN).
 */
export async function createEsfSessionFromPublicCert(
  input: {
    tin: string;
    x509Certificate: string;
    wsseUsername?: string;
    wssePassword?: string;
  },
  config: EsfConfig = readEsfConfig(),
) {
  if (config.provider === "mock") {
    return { ok: true as const, code: "esf_mock", sessionId: `mock-session-${randomUUID()}`, message: "" };
  }
  const envelope = buildCreateSessionEnvelope({
    tin: input.tin,
    x509Certificate: input.x509Certificate,
    sourceType: ESF_OFFICIAL.sourceTypeOther,
    wsseUsername: input.wsseUsername || undefined,
    wssePassword: input.wssePassword || undefined,
  });
  const response = await postSoap(config.sessionUrl, envelope);
  const fault = parseSoapFault(response.text);
  const sessionId = parseSessionId(response.text);
  if (!sessionId) {
    const rawMessage = fault?.description || fault?.faultstring || "createSession не вернул sessionId";
    // The remote fault may echo request values. Remove them before returning diagnostics.
    let safeMessage = rawMessage;
    for (const secret of [input.wssePassword, input.x509Certificate]) {
      if (secret) safeMessage = safeMessage.split(secret).join("[redacted]");
    }
    safeMessage = safeMessage
      .replace(/-----BEGIN[\s\S]+?-----END [^-]+-----/g, "[redacted]")
      .replace(/<(?:[\w-]+:)?(?:Password|PIN|privateKey|x509Certificate)\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?[\w-]+>/gi, "[redacted]")
      .replace(/(?:password|pin|private[_ ]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s<,;]+)/gi, "[redacted]")
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]")
      .slice(0, 500);
    const message = `createSession: HTTP ${response.status}. ${safeMessage}`;
    const wsseRequired = isWsseCredentialFault({
      faultstring: fault?.faultstring,
      description: fault?.description,
      body: response.text,
      status: response.status,
    });
    const officialFault = officialEsfFaultCode(message);
    return {
      ok: false as const,
      code: wsseRequired ? "esf_wsse_required" : officialFault || "esf_create_session_failed",
      sessionId: "",
      message,
      wsseRequired,
      officialFault: officialFault || null,
    };
  }
  return { ok: true as const, code: "ok", sessionId, message: "", wsseRequired: false };
}

/** @deprecated LEGACY sendAvr/sendEsf path. Do not use for tenant identity. */
export async function createEsfSession(config = readEsfConfig()) {
  const ready = sessionReadiness(config);
  if (!ready.ready) {
    return { ok: false as const, code: "esf_session_not_configured", sessionId: "", message: "Нужны ESF_TIN и ESF_AUTH_CERT_PEM" };
  }
  return createEsfSessionFromPublicCert(
    {
      tin: config.tin,
      x509Certificate: config.authCertificatePem,
      wsseUsername: config.iin || undefined,
      wssePassword: config.passwordConfigured ? String(process.env.ESF_PASSWORD || "") : undefined,
    },
    config,
  );
}

export async function currentEsfSessionStatus(sessionId: string, config = readEsfConfig()) {
  if (!sessionId) return { status: "NOT_FOUND" };
  if (config.provider === "mock") return { status: "OK" };
  try {
    const response = await postSoap(config.sessionUrl, buildCurrentSessionStatusEnvelope(sessionId));
    const status = parseSessionStatus(response.text);
    return { status: status || "NOT_FOUND" };
  } catch {
    return { status: "UNKNOWN" };
  }
}

export async function closeEsfSession(sessionId: string, config = readEsfConfig()) {
  if (!sessionId) return;
  try {
    await postSoap(config.sessionUrl, buildCloseSessionEnvelope(sessionId));
  } catch {
    // session close is best-effort
  }
}
