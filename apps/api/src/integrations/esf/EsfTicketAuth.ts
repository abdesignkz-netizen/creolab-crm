import { ApiError } from "../../errors.ts";
import { readEsfConfig, assertTestEndpointNotProduction, ESF_OFFICIAL } from "./EsfConfig.ts";
import { SOAP_NS, postSoap, parseSessionId, parseSoapFault, isWsseCredentialFault, buildWsseUsernameToken } from "./EsfSoap.ts";
import { findDeep, parseXml, textOf, xmlEscape } from "./xml.ts";

function ticketEnvelope(operation: string, body: string, header = "") {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:esf="esf"><soapenv:Header>${header}</soapenv:Header><soapenv:Body><esf:${operation}>${body}</esf:${operation}></soapenv:Body></soapenv:Envelope>`;
}

// Only SOAP fault fields are diagnostics. Never return an echoed request or ticket.
export function ticketFault(body: string, status: number, secrets: string[] = []) {
  const fault = parseSoapFault(body);
  let description = fault?.description || fault?.faultstring || "";
  for (const secret of secrets.filter(Boolean)) {
    description = description.split(xmlEscape(secret)).join("[скрыто]").split(secret).join("[скрыто]");
  }
  description = description
    .replace(/<(?:[\w-]+:)?(?:signedAuthTicket|authSign|authTicket|Signature|Security|Password|X509Certificate)\b[\s\S]*/gi, "[скрыто]")
    .replace(/-----BEGIN[\s\S]*?-----END [^-]+-----/g, "[скрыто]")
    .replace(/(?:password|pin|private[_ ]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s<,;]+)/gi, "[скрыто]")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[скрыто]")
    .replace(/\b\d{12}\b/g, "[скрыто]")
    .replace(/<[^>]*>/g, "")
    .slice(0, 500);
  const officialFault = description.match(/\b(?:CERTIFICATE_NOT_VALID|CERTIFICATE_EXPIRED|CERTIFICATE_REVOKED|AUTH_TICKET_EXPIRED|AUTH_TICKET_NOT_FOUND|USER_NOT_FOUND|INVALID_SIGNATURE|SIGNATURE_NOT_VALID|INVALID_AUTH_TICKET|METHOD_NOT_SUPPORT_GOST_2015)\b/)?.[0] || null;
  const wsseRequired = !officialFault && isWsseCredentialFault({ ...fault, status });
  return {
    code: officialFault || (wsseRequired ? "esf_wsse_required" : "ESF_TICKET_AUTH_FAILED"),
    description: description || "Портал не вернул описание причины отказа.",
    wsseRequired,
    officialFault,
  };
}

export async function createEsfAuthTicket(iin: string, config = readEsfConfig()) {
  assertTestEndpointNotProduction(config);
  const url = `${config.baseUrl}/ws/api1/AuthService`;
  const response = await postSoap(url, ticketEnvelope("createAuthTicketRequest", `<iin>${xmlEscape(iin)}</iin><ttlInMinutes>5</ttlInMinutes>`));
  const root = parseXml(response.text);
  const ticket = textOf(findDeep(root, "authTicketXml"));
  if (!ticket || response.status >= 400 || findDeep(root, "Fault")) {
    const fault = ticketFault(response.text, response.status);
    throw new ApiError(422, fault.code, `ИС ЭСФ не выдала тикет для входа: HTTP ${response.status}. ${fault.description}`);
  }
  return { authTicketXml: ticket, environment: config.esfEnv, method: "createSessionSigned" };
}

export function certificateFromSignedAuthTicket(xml: string) {
  if (xml.length > 200_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ApiError(422, "ESF_AUTH_TICKET_INVALID", "Некорректный тикет авторизации");
  const root = parseXml(xml);
  const signature = findDeep(root, "Signature");
  if (!signature || signature.ns !== "http://www.w3.org/2000/09/xmldsig#") throw new ApiError(422, "ESF_AUTH_TICKET_UNSIGNED", "Подпишите тикет авторизации через NCALayer");
  const certificate = findDeep(signature, "X509Certificate");
  const der = textOf(certificate).replace(/\s/g, "");
  if (!certificate || certificate.ns !== signature.ns || !/^[A-Za-z0-9+/]+={0,2}$/.test(der)) throw new ApiError(422, "ESF_AUTH_TICKET_CERTIFICATE", "Тикет не содержит сертификат авторизации");
  return `-----BEGIN CERTIFICATE-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
}

export async function createEsfSessionFromSignedTicket(tin: string, signedAuthTicket: string, config = readEsfConfig(), credentials?: { username: string; password: string }) {
  assertTestEndpointNotProduction(config);
  const header = credentials?.password ? buildWsseUsernameToken(credentials.username, credentials.password) : "";
  const envelope = ticketEnvelope("createSessionSignedRequest", `<tin>${xmlEscape(tin)}</tin><signedAuthTicket>${xmlEscape(signedAuthTicket).replaceAll("\r", "&#13;")}</signedAuthTicket><sourceType>${ESF_OFFICIAL.sourceTypeOther}</sourceType>`, header);
  const response = await postSoap(config.sessionUrl, envelope);
  let sessionId = "";
  try { sessionId = parseSessionId(response.text); } catch { /* Proxy errors may be HTML or plain text. */ }
  const ok = response.status < 400 && !parseSoapFault(response.text) && Boolean(sessionId);
  if (ok) return { ok: true, sessionId, code: "ok", message: "", wsseRequired: false, officialFault: null };
  const fault = ticketFault(response.text, response.status, [signedAuthTicket, credentials?.password || ""]);
  return { ok: false, sessionId: "", code: fault.code, message: `Авторизация ИС ЭСФ не завершена: HTTP ${response.status}. ${fault.description}`, wsseRequired: fault.wsseRequired, officialFault: fault.officialFault };
}
