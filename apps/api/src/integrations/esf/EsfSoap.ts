import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { AWP_VERSION } from "./avr/EsfAvrXml.ts";
import { assertTestEndpointNotProduction, isProductionEsfUrl, ESF_OFFICIAL } from "./EsfConfig.ts";
import { findDeep, parseXml, textOf, xmlEscape } from "./xml.ts";

export const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
export const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
export const WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";

function cdata(value: string) {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function envelope(nsAttr: string, body: string, header = "") {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" ${nsAttr}>`,
    header ? `<soapenv:Header>${header}</soapenv:Header>` : `<soapenv:Header/>`,
    `<soapenv:Body>${body}</soapenv:Body>`,
    `</soapenv:Envelope>`,
  ].join("");
}

export function buildWsseUsernameToken(username: string, passwordPlaceholder: string) {
  return [
    `<wsse:Security soapenv:mustUnderstand="1" xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}">`,
    `<wsse:UsernameToken>`,
    `<wsse:Username>${xmlEscape(username)}</wsse:Username>`,
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${xmlEscape(passwordPlaceholder)}</wsse:Password>`,
    `</wsse:UsernameToken>`,
    `</wsse:Security>`,
  ].join("");
}

export function buildCreateSessionEnvelope(input: {
  tin: string;
  x509Certificate: string;
  sourceType?: string;
  wsseUsername?: string;
  wssePassword?: string;
}) {
  const header = input.wsseUsername
    ? buildWsseUsernameToken(input.wsseUsername, input.wssePassword || "")
    : "";
  const body = [
    `<esf:createSessionRequest>`,
    `<tin>${xmlEscape(input.tin)}</tin>`,
    `<x509Certificate>${xmlEscape(input.x509Certificate)}</x509Certificate>`,
    input.sourceType ? `<sourceType>${xmlEscape(input.sourceType)}</sourceType>` : "",
    `</esf:createSessionRequest>`,
  ].join("");
  return envelope(`xmlns:esf="esf"`, body, header);
}

export function buildCloseSessionEnvelope(sessionId: string) {
  return envelope(
    `xmlns:esf="esf"`,
    `<esf:closeSessionRequest><sessionId>${xmlEscape(sessionId)}</sessionId></esf:closeSessionRequest>`,
  );
}

function optionalBusinessProfile(profile?: string) {
  return profile ? `<businessProfileType>${xmlEscape(profile)}</businessProfileType>` : "";
}

/** Official SessionService.closeSessionBySignedCredentials from SessionService.wsdl. */
export function buildCloseSessionBySignedCredentialsEnvelope(input: {
  tin: string;
  signedAuthTicket: string;
  businessProfileType?: string;
  wsseUsername?: string;
  wssePassword?: string;
}) {
  const header = input.wsseUsername
    ? buildWsseUsernameToken(input.wsseUsername, input.wssePassword || "")
    : "";
  const body = [
    `<esf:closeSessionBySignedCredentialsRequest>`,
    `<tin>${xmlEscape(input.tin)}</tin>`,
    optionalBusinessProfile(input.businessProfileType),
    `<signedAuthTicket>${xmlEscape(input.signedAuthTicket).replaceAll("\r", "&#13;")}</signedAuthTicket>`,
    `</esf:closeSessionBySignedCredentialsRequest>`,
  ].join("");
  return envelope(`xmlns:esf="esf"`, body, header);
}

/** Official SessionService.closeSessionByCredentials from SessionService.wsdl. */
export function buildCloseSessionByCredentialsEnvelope(input: {
  tin: string;
  x509Certificate: string;
  businessProfileType?: string;
  wsseUsername?: string;
  wssePassword?: string;
}) {
  const header = input.wsseUsername
    ? buildWsseUsernameToken(input.wsseUsername, input.wssePassword || "")
    : "";
  const body = [
    `<esf:closeSessionByCredentialsRequest>`,
    `<tin>${xmlEscape(input.tin)}</tin>`,
    optionalBusinessProfile(input.businessProfileType),
    `<x509Certificate>${xmlEscape(input.x509Certificate)}</x509Certificate>`,
    `</esf:closeSessionByCredentialsRequest>`,
  ].join("");
  return envelope(`xmlns:esf="esf"`, body, header);
}

export function buildCurrentSessionStatusEnvelope(sessionId: string) {
  return envelope(
    `xmlns:esf="esf"`,
    `<esf:currentSessionStatusRequest><sessionId>${xmlEscape(sessionId)}</sessionId></esf:currentSessionStatusRequest>`,
  );
}

export function cnFromCertificateSubject(subject: string) {
  const match = String(subject || "").match(/(?:^|[,\/\n])\s*CN\s*=\s*([^,\/\n]+)/i);
  return (match?.[1] || "").replace(/\s+/g, " ").trim();
}

/** Live AwpWebService requires senderSignerName after x509Certificate: «Должность сдавшего АВР». */
export function awpSenderSignerName(input: {
  directorName?: string | null;
  directorPosition?: string | null;
  certificateSubject?: string | null;
  certificateCn?: string | null;
}) {
  const name = String(input.directorName || "").replace(/\s+/g, " ").trim();
  const position = String(input.directorPosition || "").replace(/\s+/g, " ").trim();
  const cn = String(input.certificateCn || cnFromCertificateSubject(input.certificateSubject || "")).replace(/\s+/g, " ").trim();
  return ([position, name].filter(Boolean).join(" ") || cn || "Директор").slice(0, 200);
}

export function buildUploadAwpEnvelope(input: {
  sessionId: string;
  awpBody: string;
  signature: string;
  x509Certificate: string;
  senderSignerName: string;
  version?: string;
  signatureType?: string;
}) {
  const body = [
    `<v1:awpUploadRequest>`,
    `<sessionId>${xmlEscape(input.sessionId)}</sessionId>`,
    `<awpInfoList><awpInfo>`,
    `<awpBody>${cdata(input.awpBody)}</awpBody>`,
    `<version>${xmlEscape(input.version || AWP_VERSION)}</version>`,
    `<signature>${xmlEscape(input.signature)}</signature>`,
    `<signatureType>${xmlEscape(input.signatureType || ESF_OFFICIAL.signatureTypeCompany)}</signatureType>`,
    `</awpInfo></awpInfoList>`,
    `<x509Certificate>${xmlEscape(input.x509Certificate)}</x509Certificate>`,
    `<senderSignerName>${xmlEscape(awpSenderSignerName({ directorName: input.senderSignerName }))}</senderSignerName>`,
    `</v1:awpUploadRequest>`,
  ].join("");
  return envelope(`xmlns:v1="v1.awp"`, body);
}

export function buildQueryAwpStatusByIdEnvelope(sessionId: string, awpId: string) {
  return envelope(
    `xmlns:v1="v1.awp"`,
    [
      `<v1:awpQueryStatusByIdRequest>`,
      `<sessionId>${xmlEscape(sessionId)}</sessionId>`,
      `<idList><id>${xmlEscape(awpId)}</id></idList>`,
      `</v1:awpQueryStatusByIdRequest>`,
    ].join(""),
  );
}

export function buildSyncInvoiceEnvelope(input: {
  sessionId: string;
  invoiceBody: string;
  signature: string;
  x509Certificate: string;
  version?: string;
  signatureType?: string;
}) {
  const body = [
    `<esf:syncInvoiceRequest>`,
    `<sessionId>${xmlEscape(input.sessionId)}</sessionId>`,
    `<invoiceUploadInfoList><invoiceUploadInfo>`,
    `<invoiceBody>${cdata(input.invoiceBody)}</invoiceBody>`,
    `<version>${xmlEscape(input.version || ESF_OFFICIAL.invoiceVersion)}</version>`,
    `<signature>${xmlEscape(input.signature)}</signature>`,
    `<signatureType>${xmlEscape(input.signatureType || ESF_OFFICIAL.signatureTypeCompany)}</signatureType>`,
    `</invoiceUploadInfo></invoiceUploadInfoList>`,
    `<x509Certificate>${xmlEscape(input.x509Certificate)}</x509Certificate>`,
    `</esf:syncInvoiceRequest>`,
  ].join("");
  return envelope(`xmlns:esf="esf"`, body);
}

export function buildQueryInvoiceByIdEnvelope(sessionId: string, invoiceId: string) {
  return envelope(
    `xmlns:esf="esf"`,
    [
      `<esf:queryInvoiceByIdRequest>`,
      `<sessionId>${xmlEscape(sessionId)}</sessionId>`,
      `<idList><id>${xmlEscape(invoiceId)}</id></idList>`,
      `</esf:queryInvoiceByIdRequest>`,
    ].join(""),
  );
}

export function buildGenerateInvoiceSignatureEnvelope(input: {
  invoiceBody: string;
  certificatePath: string;
  certificatePin: string;
  version?: string;
}) {
  const body = [
    `<esf:signatureRequest>`,
    `<invoiceBodies><invoiceBody>${cdata(input.invoiceBody)}</invoiceBody></invoiceBodies>`,
    `<version>${xmlEscape(input.version || ESF_OFFICIAL.invoiceVersion)}</version>`,
    `<certificatePath>${xmlEscape(input.certificatePath)}</certificatePath>`,
    `<certificatePin>${xmlEscape(input.certificatePin)}</certificatePin>`,
    `</esf:signatureRequest>`,
  ].join("");
  return envelope(`xmlns:esf="esf"`, body);
}

export function buildGenerateAwpSignatureEnvelope(input: {
  awpBody: string;
  certificatePath: string;
  certificatePin: string;
  version?: string;
}) {
  const body = [
    `<awp:signatureRequest>`,
    `<awpBodies><awpBody>${cdata(input.awpBody)}</awpBody></awpBodies>`,
    `<version>${xmlEscape(input.version || AWP_VERSION)}</version>`,
    `<certificatePath>${xmlEscape(input.certificatePath)}</certificatePath>`,
    `<certificatePin>${xmlEscape(input.certificatePin)}</certificatePin>`,
    `</awp:signatureRequest>`,
  ].join("");
  return envelope(`xmlns:awp="awp"`, body);
}

export function parseSoapFault(xml: string) {
  try {
    const root = parseXml(xml);
    const fault = findDeep(root, "Fault") || findDeep(root, "fault");
    if (!fault) return null;
    return {
      faultstring: textOf(findDeep(fault, "faultstring")),
      description: textOf(findDeep(fault, "description")),
    };
  } catch {
    return null;
  }
}

export function parseSessionId(xml: string) {
  const root = parseXml(xml);
  return textOf(findDeep(root, "sessionId"));
}

export function parseSessionStatus(xml: string) {
  const root = parseXml(xml);
  return textOf(findDeep(root, "status")).toUpperCase();
}

export function isSessionClosedFault(message: string) {
  const text = String(message || "");
  return /SessionClosedFault|session closed|SessionClosed|No open session associated with user|no open session|сессия.*(закрыт|истекла)/i.test(text);
}

export const ESF_SESSION_CLOSED_USER_MESSAGE =
  "Сессия ИС ЭСФ закрыта. Закройте кабинет ИС ЭСФ в браузере, откройте «Интеграции» и подключитесь снова, затем повторите отправку.";

export const ESF_BUSINESS_PROFILES = [
  "ADMIN_ENTERPRISE",
  "ENTREPRENEUR_USER",
  "ENTREPRENEUR",
  "LAWYER_USER",
  "BAILIFF_USER",
  "MEDIATOR_USER",
  "NOTARY_USER",
  "PROJECT_ADMIN",
  "PROJECT_USER",
  "INDIVIDUAL",
  "LAWYER",
  "BAILIFF",
  "MEDIATOR",
  "NOTARY",
  "USER",
] as const;

const ESF_PROFILE_PATTERN = ESF_BUSINESS_PROFILES.join("|");
export const ESF_SESSION_ID_IN_TEXT = new RegExp(
  `([A-Za-z0-9][A-Za-z0-9+/=._-]{7,}--(?:${ESF_PROFILE_PATTERN}))`,
  "i",
);

const EXISTING_SESSION_FAULT =
  /already has opened session|opened session with id|Can't create a new user session|нельзя создать новую сессию|уже (?:есть|открыта).{0,40}сесси/i;

export function isExistingSessionFault(text: string) {
  const fault = parseSoapFault(text);
  return EXISTING_SESSION_FAULT.test(`${fault?.faultstring || ""} ${fault?.description || ""} ${text}`);
}

export function parseBusinessProfileFromSessionId(sessionId: string) {
  const match = String(sessionId || "").match(new RegExp(`--(${ESF_PROFILE_PATTERN})$`, "i"));
  return match ? match[1].toUpperCase() : "";
}

/** Portal echoes the live session id in the createSession fault. Parse it before any redaction. */
export function parseExistingSessionIdFromFault(text: string) {
  const fault = parseSoapFault(text);
  const source = `${fault?.description || ""} ${fault?.faultstring || ""} ${text}`;
  const match =
    source.match(ESF_SESSION_ID_IN_TEXT) ||
    source.match(/opened session with id[:\s]+([^\s<"']+)/i) ||
    source.match(/session with id[:\s]+([^\s<"']+)/i) ||
    source.match(/сесси[яи].*?id[:\s]+([^\s<"']+)/i);
  const id = (match?.[1] || "").replace(/[.,;]+$/g, "").trim();
  if (id.length < 8 || /[<>]/.test(id)) return "";
  return id;
}

export function isWsseCredentialFault(input: { faultstring?: string; description?: string; body?: string; status?: number }) {
  // Namespace declarations in the SOAP envelope do not indicate a credential failure.
  const text = `${input.faultstring || ""} ${input.description || ""}`.toLowerCase();
  if (input.status === 401 || input.status === 403) return true;
  return /username|password|wsse|wss-wssecurity|security error|verifying the message|unauthoriz|unauthenticated|access.?denied|credentials|login/.test(text);
}

function soapErrorRows(node: ReturnType<typeof findDeep>) {
  if (!node) return [];
  const listed = (findDeep(node, "errorList")?.children || []).filter((row) => row.local === "error");
  const nested = listed.length ? listed : node.children.filter((row) => row.local === "error");
  return nested.map((row) => ({
    property: textOf(findDeep(row, "property")),
    errorCode: textOf(findDeep(row, "errorCode")),
    text: textOf(findDeep(row, "text")),
  })).filter((row) => row.property || row.errorCode || row.text);
}

export function formatEsfUploadDecline(
  kind: "AVR" | "ESF",
  fault: { description?: string; faultstring?: string } | null | undefined,
  errors: Array<{ property?: string; errorCode?: string; text?: string }>,
) {
  const details = errors
    .map((row) => [row.errorCode, row.property, row.text].filter(Boolean).join(" — "))
    .filter(Boolean);
  const portal = String(fault?.description || fault?.faultstring || details[0] || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const label = kind === "ESF" ? "счёт-фактуру" : "АВР";
  if (isSessionClosedFault(portal) || details.some((row) => isSessionClosedFault(row))) {
    return ESF_SESSION_CLOSED_USER_MESSAGE;
  }
  if (portal) {
    return `ИС ЭСФ отклонила ${label}. ${portal}${details.length > 1 ? `. ${details.slice(1).join(". ")}` : ""}`;
  }
  return `ИС ЭСФ отклонила ${label} без текста причины. Проверьте заполненный документ и повторите отправку.`;
}

export function parseAwpUploadResult(xml: string) {
  const root = parseXml(xml);
  const accepted = findDeep(root, "acceptedList");
  const declined = findDeep(root, "declinedList");
  const firstAccepted = accepted?.children.find((row) => row.local === "awpUploadResult");
  const firstDeclined = declined?.children.find((row) => row.local === "awpUploadResult");
  const errors = soapErrorRows(firstDeclined);
  return {
    awpId: textOf(firstAccepted ? findDeep(firstAccepted, "awpId") : undefined),
    number: textOf(firstAccepted ? findDeep(firstAccepted, "number") : undefined),
    declined: Boolean(firstDeclined),
    errors,
  };
}

export function parseAwpStatus(xml: string) {
  const root = parseXml(xml);
  const summary = findDeep(root, "awpSummary");
  return {
    awpId: textOf(summary ? findDeep(summary, "awpId") : undefined),
    status: textOf(summary ? findDeep(summary, "status") : undefined),
    registrationNumber: textOf(summary ? findDeep(summary, "registrationNumber") : undefined),
  };
}

export function parseAwpSignature(xml: string) {
  const root = parseXml(xml);
  return textOf(findDeep(root, "signature"));
}

export function parseSyncInvoiceResult(xml: string) {
  const root = parseXml(xml);
  const accepted = findDeep(root, "acceptedSet");
  const declined = findDeep(root, "declinedSet");
  const firstAccepted = accepted?.children.find((row) => row.local === "standardResponse");
  const firstDeclined = declined?.children.find((row) => row.local === "standardResponse");
  const errors = (firstDeclined ? findDeep(firstDeclined, "errors")?.children || [] : [])
    .filter((row) => row.local === "error")
    .map((row) => ({
      property: textOf(findDeep(row, "property")),
      errorCode: textOf(findDeep(row, "errorCode")),
      text: textOf(findDeep(row, "text")),
    }));
  return {
    invoiceId: textOf(firstAccepted ? findDeep(firstAccepted, "id") : undefined),
    num: textOf(firstAccepted ? findDeep(firstAccepted, "num") : undefined),
    date: textOf(firstAccepted ? findDeep(firstAccepted, "date") : undefined),
    declined: Boolean(firstDeclined),
    errors,
  };
}

export function parseInvoiceById(xml: string) {
  const root = parseXml(xml);
  const info = findDeep(root, "invoiceInfo");
  return {
    invoiceId: textOf(info ? findDeep(info, "invoiceId") : undefined),
    status: textOf(info ? findDeep(info, "invoiceStatus") : undefined),
    registrationNumber: textOf(info ? findDeep(info, "registrationNumber") : undefined),
  };
}

export function parseInvoiceSignature(xml: string) {
  const root = parseXml(xml);
  const hash = findDeep(root, "invoiceHash");
  return textOf(hash ? findDeep(hash, "signature") : findDeep(root, "signature"));
}

export async function postSoap(url: string, xml: string, options?: { timeoutMs?: number; testOnly?: boolean }) {
  // Last boundary: a direct call or changed configuration cannot bypass TEST isolation.
  const testEnvironment = String(process.env.ESF_ENV || "").trim().toLowerCase() === "test";
  if (options?.testOnly || (testEnvironment && isProductionEsfUrl(url))) {
    assertTestEndpointNotProduction({ esfEnv: "test", baseUrl: url });
  }
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const insecure = /^(1|true|yes)$/i.test(String(process.env.ESF_TLS_INSECURE || "").trim());
  if (url.startsWith("http:")) {
    return postSoapHttp(url, xml, timeoutMs);
  }
  if (insecure && url.startsWith("https:")) {
    return postSoapInsecure(url, xml, timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: testEnvironment || options?.testOnly ? "error" : "follow",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '""',
      },
      body: xml,
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function postSoapHttp(url: string, xml: string, timeoutMs: number) {
  const parsed = new URL(url);
  const payload = Buffer.from(xml, "utf8");
  return new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: '""',
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}

function postSoapInsecure(url: string, xml: string, timeoutMs: number) {
  const parsed = new URL(url);
  const payload = Buffer.from(xml, "utf8");
  return new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: '""',
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const status = res.statusCode || 0;
          resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.write(payload);
    req.end();
  });
}
