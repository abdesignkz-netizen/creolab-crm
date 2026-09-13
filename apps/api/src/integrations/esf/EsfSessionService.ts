import { randomUUID } from "node:crypto";
import { officialEsfFaultCode } from "./poc/diagnosePublicCertificate.ts";
import { ESF_OFFICIAL, readEsfConfig, type EsfConfig } from "./EsfConfig.ts";
import {
  buildCloseSessionByCredentialsEnvelope,
  buildCloseSessionBySignedCredentialsEnvelope,
  buildCloseSessionEnvelope,
  buildCreateSessionEnvelope,
  buildCurrentSessionStatusEnvelope,
  isExistingSessionFault,
  isWsseCredentialFault,
  parseBusinessProfileFromSessionId,
  parseExistingSessionIdFromFault,
  parseSessionId,
  parseSessionStatus,
  parseSoapFault,
  postSoap,
} from "./EsfSoap.ts";

export const ESF_EXISTING_SESSION_MESSAGE =
  "На портале ИС ЭСФ уже открыта сессия этого пользователя. Закройте кабинет ИС ЭСФ в браузере или другой программе и повторите отправку.";

export function sessionReadiness(config = readEsfConfig()) {
  return {
    ready: Boolean(config.tin && config.authCertificatePem),
    tinConfigured: Boolean(config.tin),
    certificateConfigured: Boolean(config.authCertificatePem),
  };
}

type PublicCertSessionInput = {
  tin: string;
  x509Certificate: string;
  wsseUsername?: string;
  wssePassword?: string;
};

function soapSessionId(xml: string) {
  try {
    return parseSessionId(xml) || "";
  } catch {
    return "";
  }
}

export async function createSoapSessionHandlingConflict(
  create: () => Promise<{ status: number; text: string }>,
  close: (existingId: string) => Promise<void>,
): Promise<
  | { ok: true; sessionId: string }
  | { ok: false; status: number; text: string; existingConflict: boolean }
> {
  let closedConflict = false;
  let last = { status: 500, text: "" };
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await create();
    const sessionId = soapSessionId(last.text);
    const created = last.status < 400 && !parseSoapFault(last.text) && Boolean(sessionId);
    if (created) return { ok: true, sessionId };
    if (!isExistingSessionFault(last.text)) {
      return { ok: false, status: last.status, text: last.text, existingConflict: false };
    }
    const existingId = parseExistingSessionIdFromFault(last.text) || sessionId;
    if (!closedConflict) {
      closedConflict = true;
      await close(existingId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (existingId) return { ok: true, sessionId: existingId };
    return { ok: false, status: last.status, text: last.text, existingConflict: true };
  }
  return { ok: false, status: last.status, text: last.text, existingConflict: true };
}

function publicCertSessionFailure(input: PublicCertSessionInput, status: number, raw: string) {
  const fault = parseSoapFault(raw);
  const rawMessage = fault?.description || fault?.faultstring || "createSession не вернул sessionId";
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
  const message = `createSession: HTTP ${status}. ${safeMessage}`;
  const wsseRequired = isWsseCredentialFault({
    faultstring: fault?.faultstring,
    description: fault?.description,
    body: raw,
    status,
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

/**
 * Official SessionService.createSession from SessionService.wsdl:
 * tin + x509Certificate. SoapUI examples add optional WSSE UsernameToken
 * (cabinet IIN + cabinet password, not ЭЦП PIN).
 */
export async function createEsfSessionFromPublicCert(
  input: PublicCertSessionInput,
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
  const recovered = await createSoapSessionHandlingConflict(
    () => postSoap(config.sessionUrl, envelope),
    (existingId) =>
      closeExistingEsfSession(
        {
          sessionId: existingId || undefined,
          tin: input.tin,
          x509Certificate: input.x509Certificate,
          credentials: input.wssePassword
            ? { username: input.wsseUsername || "", password: input.wssePassword }
            : undefined,
        },
        config,
      ),
  );
  if (recovered.ok) return { ok: true as const, code: "ok", sessionId: recovered.sessionId, message: "", wsseRequired: false };
  if (recovered.existingConflict) {
    return {
      ok: false as const,
      code: "esf_session_already_open",
      sessionId: "",
      message: ESF_EXISTING_SESSION_MESSAGE,
      wsseRequired: false,
      officialFault: null,
    };
  }
  return publicCertSessionFailure(input, recovered.status, recovered.text);
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
    if (status === "OK" || status === "CLOSED" || status === "NOT_FOUND") return { status };
    return { status: "UNKNOWN" };
  } catch {
    return { status: "UNKNOWN" };
  }
}

export async function closeEsfSession(sessionId: string, config = readEsfConfig()) {
  if (!sessionId || config.provider === "mock") return;
  try {
    await postSoap(config.sessionUrl, buildCloseSessionEnvelope(sessionId));
  } catch {
    // session close is best-effort
  }
}

export async function closeExistingEsfSession(
  input: {
    sessionId?: string;
    tin?: string;
    signedAuthTicket?: string;
    x509Certificate?: string;
    credentials?: { username: string; password: string };
  },
  config: EsfConfig = readEsfConfig(),
) {
  if (config.provider === "mock") return;
  const businessProfileType = parseBusinessProfileFromSessionId(input.sessionId || "") || undefined;
  const wsseUsername = input.credentials?.password ? input.credentials.username : undefined;
  const wssePassword = input.credentials?.password;
  if (input.sessionId) {
    await closeEsfSession(input.sessionId, config);
  }
  try {
    if (input.tin && input.signedAuthTicket) {
      await postSoap(
        config.sessionUrl,
        buildCloseSessionBySignedCredentialsEnvelope({
          tin: input.tin,
          signedAuthTicket: input.signedAuthTicket,
          businessProfileType,
          wsseUsername,
          wssePassword,
        }),
      );
    }
    if (input.tin && input.x509Certificate) {
      await postSoap(
        config.sessionUrl,
        buildCloseSessionByCredentialsEnvelope({
          tin: input.tin,
          x509Certificate: input.x509Certificate,
          businessProfileType,
          wsseUsername,
          wssePassword,
        }),
      );
    }
  } catch {
    // session close is best-effort
  }
}
