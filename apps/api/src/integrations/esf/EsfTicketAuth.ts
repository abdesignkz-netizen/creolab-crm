import { ApiError } from "../../errors.ts";
import { readEsfConfig, assertTestEndpointNotProduction, ESF_OFFICIAL } from "./EsfConfig.ts";
import { SOAP_NS, postSoap, parseSessionId } from "./EsfSoap.ts";
import { findDeep, parseXml, textOf, xmlEscape } from "./xml.ts";

function ticketEnvelope(operation: string, body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:esf="esf"><soap:Header/><soap:Body><esf:${operation}>${body}</esf:${operation}></soap:Body></soap:Envelope>`;
}

// Signed tickets contain authentication material. Return only recognized fault codes.
function ticketFault(body: string) {
  return body.match(/\b(?:CERTIFICATE_NOT_VALID|CERTIFICATE_EXPIRED|CERTIFICATE_REVOKED|AUTH_TICKET_EXPIRED|AUTH_TICKET_NOT_FOUND|USER_NOT_FOUND|INVALID_SIGNATURE|INVALID_AUTH_TICKET)\b/)?.[0] || "ESF_TICKET_AUTH_FAILED";
}

export async function createEsfAuthTicket(iin: string, config = readEsfConfig()) {
  assertTestEndpointNotProduction(config);
  const url = `${config.baseUrl}/ws/api1/AuthService`;
  const response = await postSoap(url, ticketEnvelope("createAuthTicketRequest", `<iin>${xmlEscape(iin)}</iin><ttlInMinutes>5</ttlInMinutes>`));
  const root = parseXml(response.text);
  const ticket = textOf(findDeep(root, "authTicketXml"));
  if (!ticket || response.status >= 400 || findDeep(root, "Fault")) {
    throw new ApiError(422, ticketFault(response.text), `ИС ЭСФ не выдала тикет для входа: HTTP ${response.status}. ${ticketFault(response.text)}`);
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

export async function createEsfSessionFromSignedTicket(tin: string, signedAuthTicket: string, config = readEsfConfig()) {
  assertTestEndpointNotProduction(config);
  const envelope = ticketEnvelope("createSessionSignedRequest", `<tin>${xmlEscape(tin)}</tin><signedAuthTicket>${xmlEscape(signedAuthTicket)}</signedAuthTicket><sourceType>${ESF_OFFICIAL.sourceTypeOther}</sourceType>`);
  const response = await postSoap(config.sessionUrl, envelope);
  const root = parseXml(response.text);
  const sessionId = parseSessionId(response.text);
  const ok = response.status < 400 && !findDeep(root, "Fault") && Boolean(sessionId);
  return { ok, sessionId: ok ? sessionId : "", code: ok ? "ok" : ticketFault(response.text), message: ok ? "" : `ИС ЭСФ отклонила подписанный тикет: HTTP ${response.status}. ${ticketFault(response.text)}`, wsseRequired: false, officialFault: null };
}
