import forge from "node-forge";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import {
  ESF_NCALAYER_AUTH,
  ESF_NCALAYER_BUNDLE_NAME,
  ESF_NCALAYER_BUNDLE_SYMBOLIC_NAME,
  ESF_NCALAYER_BUNDLE_VERSION,
  ESF_NCALAYER_METHODS,
  ESF_NCALAYER_SERVICE,
  ESF_NCALAYER_SIGN_PLAIN_DATA,
  ESF_NCALAYER_SIGN_PLAIN_DATA_MAP,
  normalizeKzTaxId,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import {
  assertTestEndpointNotProduction,
  esfLegacyPocEnabled,
  readEsfConfig,
  sanitizedEsfHost,
} from "../integrations/esf/EsfConfig.ts";
import {
  OFFICIAL_AWP_SENDER_TIN_SESSION_ERROR,
  bindAvrFixtureSenderTin,
  senderTinFromAvrXml,
} from "../integrations/esf/poc/bindAvrFixtureSenderTin.ts";
import { mockSyncInvoice, mockUploadAwp } from "../integrations/esf/EsfMock.ts";
import { analyzeEsfSignature } from "../integrations/esf/poc/analyzeEsfSignature.ts";
import { diagnosePublicCertificate, officialEsfFaultCode } from "../integrations/esf/poc/diagnosePublicCertificate.ts";
import {
  buildCurrentSessionStatusEnvelope,
  parseSessionStatus,
  buildSyncInvoiceEnvelope,
  buildUploadAwpEnvelope,
  parseAwpUploadResult,
  parseSoapFault,
  parseSyncInvoiceResult,
  postSoap,
} from "../integrations/esf/EsfSoap.ts";
import { signInvoiceXml, signingReadiness } from "../integrations/esf/EsfSignatureService.ts";
import { queryAwpStatusById, queryInvoiceById } from "../integrations/esf/sync/EsfDocumentSyncService.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { serializeElectronicDocument } from "./documentDraftService.ts";
import { describeAvrPocReadiness, getEsfConnectionRow, getUsableEsfSession } from "./esfConnectionService.ts";
import { previewAvrEsf } from "./esfPocService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { normalizeCertificatePem, publicCertificateFingerprint } from "./cmsInspect.ts";

const FORBIDDEN_KEY_FIELDS = [
  "pin",
  "certificatePin",
  "certificatePath",
  "p12",
  "pkcs12",
  "privateKey",
  "private_key",
  "esfSignCertPin",
  "signCertPin",
  "password",
  "cabinetPassword",
];

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireSendEsf(auth: AuthContext) {
  if (!can(auth, "send_esf")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для отправки в ИС ЭСФ");
  }
}

function requireDevPoc() {
  if (String(process.env.NODE_ENV || "") === "production") {
    throw new ApiError(404, "not_found", "Not found");
  }
}

export function rejectPrivateKeyFields(input: Record<string, unknown>) {
  for (const key of FORBIDDEN_KEY_FIELDS) {
    if (input[key] != null && String(input[key]).trim()) {
      throw new ApiError(400, "esf_private_key_forbidden", "ЭЦП, .p12 и PIN нельзя передавать на сервер");
    }
  }
}

export function sha256Utf8(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireLegacyPoc() {
  requireDevPoc();
  if (!esfLegacyPocEnabled()) {
    throw new ApiError(403, "esf_legacy_poc_disabled", "Legacy LocalService POC выключен");
  }
}

export function officialAvrFixturePath() {
  return path.resolve(
    process.cwd().endsWith("apps/api")
      ? "src/integrations/esf/schemas/One AwpV1.xml"
      : "apps/api/src/integrations/esf/schemas/One AwpV1.xml",
  );
}

export function officialAvrBody() {
  return readFileSync(officialAvrFixturePath());
}

function pocRoot() {
  return path.resolve(process.cwd().endsWith("apps/api") ? "data/esf-poc" : "apps/api/data/esf-poc");
}

function tenantAvrPayloadPath(tenantId: string, sha256: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ApiError(409, "ESF_SIGNED_PAYLOAD_CHANGED", "Некорректный SHA-256 payload");
  return path.join(pocRoot(), tenantId, `avr-payload-${sha256}.xml`);
}

function pocSessionBinding(row: { sessionId: string | null; organizationBin: string | null }) {
  return sha256Utf8(JSON.stringify([row.sessionId, row.organizationBin, "test"]));
}

export function officialInvoiceBody() {
  const file = path.resolve(
    process.cwd().endsWith("apps/api")
      ? "src/integrations/esf/schemas/One InvoiceV2.xml"
      : "apps/api/src/integrations/esf/schemas/One InvoiceV2.xml",
  );
  const xml = readFileSync(file, "utf8");
  const start = xml.indexOf("<v2:invoice");
  const end = xml.indexOf("</v2:invoice>");
  return start >= 0 && end > start ? xml.slice(start, end + "</v2:invoice>".length) : xml;
}

function payloadMeta(payload: string) {
  return {
    encoding: "utf-8" as const,
    byteLength: Buffer.byteLength(payload, "utf8"),
    payloadSha256: sha256Utf8(payload),
  };
}

async function readStoredXml(xmlStorageKey: string | null) {
  if (!xmlStorageKey) return "";
  try {
    return await readFile(resolveUploadPath(xmlStorageKey), "utf8");
  } catch {
    return "";
  }
}

export async function getEsfPayloadToSign(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const preview = await previewAvrEsf(prisma, auth, documentId);
  const payload = String(preview.xml || "");
  if (!payload) throw new ApiError(422, "esf_payload_empty", "Не удалось собрать XML для подписи");
  return {
    document: preview.document,
    type: preview.document.type,
    payload,
    ...payloadMeta(payload),
    version: preview.version,
    validation: preview.validation,
    signedBytes: "utf8_xml_string",
    ncalayer: {
      service: ESF_NCALAYER_SERVICE,
      method: ESF_NCALAYER_SIGN_PLAIN_DATA,
      notUsed: ["kz.gov.pki.knca.basics", ESF_NCALAYER_SIGN_PLAIN_DATA_MAP],
    },
  };
}

export async function getEsfNcaLayerPoc(prisma: PrismaClient, auth: AuthContext) {
  requireDevPoc();
  const membership = requireTenant(auth);
  const config = readEsfConfig();
  const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  const row = await getEsfConnectionRow(prisma, membership.tenantId);
  const fixtureBuf = officialAvrBody();
  const fixture = fixtureBuf.toString("utf8");
  let certificate = null as ReturnType<typeof diagnosePublicCertificate> | null;
  try {
    if (row?.authCertificatePem) {
      certificate = diagnosePublicCertificate(row.authCertificatePem, {
        expectedEnv: config.esfEnv,
        expectedBin: legal?.bin || row.organizationBin,
        lastFault: row.lastErrorMessage || "",
      });
    }
  } catch {
    certificate = null;
  }
  const fixtureMeta = payloadMeta(fixture);
  return {
    officialModule: {
      installedOnThisMachine: "probe_via_browser_ncalayer",
      bundleSymbolicName: ESF_NCALAYER_BUNDLE_SYMBOLIC_NAME,
      bundleName: ESF_NCALAYER_BUNDLE_NAME,
      bundleVersion: ESF_NCALAYER_BUNDLE_VERSION,
      service: ESF_NCALAYER_SERVICE,
      methods: ESF_NCALAYER_METHODS,
      signPlainData: true,
      signPlainDataMapDeferred: true,
      authIsSeparateFromDocumentSign: ESF_NCALAYER_AUTH,
      payloadEncoding: "utf-8",
      signsExactStringBytes: true,
      response: {
        code: "200|500",
        message: "action.canceled|error",
        responseObject: ["signature", "pem", "keyInfo"],
      },
    },
    environment: {
      label: config.esfEnv === "test" ? "TEST" : config.esfEnv.toUpperCase(),
      esfEnv: config.esfEnv,
      endpointHost: sanitizedEsfHost(config.baseUrl),
    },
    fixturePayload: {
      source: "official One AwpV1.xml",
      kind: "AVR",
      payload: fixture,
      ...fixtureMeta,
      senderTinMustEqualSessionTin: OFFICIAL_AWP_SENDER_TIN_SESSION_ERROR,
    },
    avrPoc: describeAvrPocReadiness(row, config),
    connection: {
      status: row?.status || "NOT_CONNECTED",
      lastErrorCode: row?.lastErrorCode || null,
      lastErrorMessage: row?.lastErrorMessage || null,
      officialFault: officialEsfFaultCode(row?.lastErrorMessage || ""),
      sessionActive: describeAvrPocReadiness(row, config).sessionActive,
    },
    certificate,
    legacy: signingReadiness(config),
    safeToDeleteLegacy: [] as string[],
    note: "POC успешен только если TEST ИС ЭСФ принял документ, подписанный модулем ИС ЭСФ.",
  };
}

async function verifyPocSessionIsOpen(sessionId: string, config: ReturnType<typeof readEsfConfig>) {
  // ESF does not return an expiry timestamp at createSession: ask the TEST service.
  try {
    const response = await postSoap(config.sessionUrl, buildCurrentSessionStatusEnvelope(sessionId), { testOnly: true });
    if (response.ok && !parseSoapFault(response.text) && parseSessionStatus(response.text) === "OK") return;
  } catch { /* Fail closed without exposing SOAP or transport details. */ }
  throw new ApiError(422, "ESF_POC_SESSION_GUARD", "TEST ИС ЭСФ не подтвердил активность сессии. Подключитесь повторно.");
}

export async function prepareAvrPocPayload(prisma: PrismaClient, auth: AuthContext) {
  requireDevPoc();
  const membership = requireTenant(auth);
  requireSendEsf(auth);
  const config = readEsfConfig();
  assertTestEndpointNotProduction(config);
  const row = await getEsfConnectionRow(prisma, membership.tenantId);
  const readiness = describeAvrPocReadiness(row, config);
  if (!readiness.ready || !row) {
    throw new ApiError(422, "ESF_POC_SESSION_GUARD", readiness.reasons.join("; "));
  }
  await verifyPocSessionIsOpen(row.sessionId!, config);
  const sessionTin = normalizeKzTaxId(row.organizationBin || "");
  if (!/^\d{12}$/.test(sessionTin)) {
    throw new ApiError(422, "esf_bin_required", "Для POC АВР нужен БИН организации текущей сессии");
  }
  const official = officialAvrBody().toString("utf8");
  const bound = bindAvrFixtureSenderTin(official, sessionTin);
  const dest = tenantAvrPayloadPath(membership.tenantId, sha256Utf8(bound));
  await mkdir(path.dirname(dest), { recursive: true });
  // Create-only content-addressed storage: another prepare cannot overwrite signed bytes.
  let alreadyFrozen = false;
  try { await writeFile(dest, Buffer.from(bound, "utf8"), { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    alreadyFrozen = true;
  }
  const stored = readFileSync(dest);
  const payload = stored.toString("utf8");
  const payloadSha256 = sha256Utf8(payload);
  const fileSha256 = createHash("sha256").update(stored).digest("hex");
  if (fileSha256 !== payloadSha256 || payload !== bound) {
    throw new ApiError(422, "esf_payload_encoding", "AVR fixture не является валидным UTF-8. Exact-bytes подпись невозможна.");
  }
  return {
    pocId: `avr-fixture:${membership.tenantId}:${payloadSha256}`,
    sessionBinding: pocSessionBinding(row),
    kind: "AVR" as const,
    source: alreadyFrozen
      ? "stored exact AVR payload"
      : "official One AwpV1.xml + sender tin = session BIN",
    senderTin: senderTinFromAvrXml(payload),
    sessionTin,
    officialErrorIfSenderMismatch: OFFICIAL_AWP_SENDER_TIN_SESSION_ERROR,
    payload,
    encoding: "utf-8" as const,
    byteLength: Buffer.byteLength(payload, "utf8"),
    payloadSha256,
    locked: true,
    ncalayer: {
      service: ESF_NCALAYER_SERVICE,
      method: ESF_NCALAYER_SIGN_PLAIN_DATA,
      storageName: "PKCS12",
    },
  };
}

export function redactSoapText(value: string) {
  return String(value || "")
    .replace(/-----BEGIN[\s\S]+?-----END [^-]+-----/g, "[redacted]")
    .replace(/<(?:[\w-]+:)?(?:Password|PIN|privateKey|x509Certificate)\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?[\w-]+>/gi, "[redacted]")
    .replace(/(?:password|pin|private[_ ]?key|wsse)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s<,;]+)/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[b64]")
    .slice(0, 500);
}

/** Metadata only; no public-key algorithm support is needed to read X.509 fields. */
export function pocCertificateSummary(pem: string) {
  const normalized = normalizeCertificatePem(pem);
  const certificate = new X509Certificate(normalized);
  const der = forge.asn1.fromDer(certificate.raw.toString("binary"));
  const algorithm = (der.value as forge.asn1.Asn1[])[1];
  const oid = (algorithm.value as forge.asn1.Asn1[])[0];
  return {
    subject: redactSoapText(certificate.subject),
    serial: certificate.serialNumber,
    algorithm: forge.asn1.derToOid(oid.value as string),
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
  };
}

export function assertPocSignatureCertificate(pem: string, fingerprint: string, authPem: string) {
  const normalized = normalizeCertificatePem(pem);
  // Require one certificate, not a chain or a PEM containing private material.
  if ((normalized.match(/-----BEGIN CERTIFICATE-----/g) || []).length !== 1 || /PRIVATE KEY/.test(normalized)) {
    throw new ApiError(422, "ESF_SIGN_PEM_INVALID", "Нужен один публичный SIGN-сертификат");
  }
  try { pocCertificateSummary(normalized); }
  catch { throw new ApiError(422, "ESF_SIGN_PEM_INVALID", "Некорректный SIGN-сертификат"); }
  const actual = publicCertificateFingerprint(normalized);
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || fingerprint !== actual) {
    throw new ApiError(409, "ESF_SIGN_PEM_MISMATCH", "Fingerprint обязателен и должен совпадать с PEM из signPlainData");
  }
  if (!authPem || publicCertificateFingerprint(authPem) === actual) {
    throw new ApiError(422, "ESF_AUTH_PEM_USED_FOR_SIGN", "AUTH используется только для createSession; uploadAwp требует отдельный SIGN PEM");
  }
  return normalized;
}

export async function sendAvrPocSigned(
  prisma: PrismaClient,
  auth: AuthContext,
  raw: Record<string, unknown>,
) {
  requireDevPoc();
  rejectPrivateKeyFields(raw);
  const membership = requireTenant(auth);
  requireSendEsf(auth);
  const config = readEsfConfig();
  const row = await getEsfConnectionRow(prisma, membership.tenantId);
  const readiness = describeAvrPocReadiness(row, config);
  const signature = String(raw.signature || "");
  const pem = String(raw.pem || "");
  const summary = (value: string) => {
    try { return pocCertificateSummary(value); } catch { return null; }
  };
  const report = {
    code: "ESF_POC_NOT_SENT",
    ok: false,
    environment: readiness.environment,
    endpointHost: readiness.endpointHost,
    session: { status: readiness.sessionStatus, sessionActive: readiness.sessionActive },
    authCertificate: summary(row?.authCertificatePem || ""),
    payload: { byteLength: null as number | null, sha256: null as string | null, hashMatched: false },
    signCertificate: summary(pem),
    signature: { base64Length: signature.length, decodedLength: Buffer.from(signature, "base64").length },
    soap: {
      operation: "uploadAwp", httpStatus: null as number | null, result: "not_sent",
      errorCode: null as string | null, errorMessage: null as string | null, externalId: null as string | null,
    },
    externalId: null as string | null,
    sentAt: null as string | null,
  };
  try {
    assertTestEndpointNotProduction(config);
    if (!readiness.ready || !row?.sessionId) {
      throw new ApiError(422, "ESF_POC_SESSION_GUARD", readiness.reasons.join("; "));
    }
    const givenSha = String(raw.payloadSha256 || "").trim().toLowerCase();
    const dest = tenantAvrPayloadPath(membership.tenantId, givenSha);
    if (!existsSync(dest)) throw new ApiError(409, "ESF_SIGNED_PAYLOAD_CHANGED", "Замороженный XML не найден. Подготовьте payload заново.");
    const stored = readFileSync(dest);
    const payload = stored.toString("utf8");
    const expectedSha = createHash("sha256").update(stored).digest("hex");
    report.payload = { byteLength: stored.length, sha256: expectedSha, hashMatched: false };
    if (givenSha !== expectedSha || sha256Utf8(payload) !== expectedSha) {
      throw new ApiError(409, "ESF_SIGNED_PAYLOAD_CHANGED", "SHA-256 payload не совпал. XML после подписи пересобирать нельзя.");
    }
    report.payload.hashMatched = true;
    if (raw.sessionBinding !== pocSessionBinding(row) || senderTinFromAvrXml(payload) !== normalizeKzTaxId(row.organizationBin || "")) {
      throw new ApiError(409, "ESF_POC_SESSION_CHANGED", "Сессия или её БИН изменились. Подготовьте и подпишите XML заново.");
    }
    if (!signature || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature)) {
      throw new ApiError(422, "esf_signature_required", "Нужна base64 signature из signPlainData");
    }
    const signaturePem = assertPocSignatureCertificate(pem, String(raw.pemFingerprint || "").toLowerCase(), row.authCertificatePem || "");
    await verifyPocSessionIsOpen(row.sessionId, config);
    const current = await getEsfConnectionRow(prisma, membership.tenantId);
    if (!current || !describeAvrPocReadiness(current, config).ready || pocSessionBinding(current) !== raw.sessionBinding) {
      throw new ApiError(409, "ESF_POC_SESSION_CHANGED", "Сессия изменилась перед uploadAwp. Подготовьте XML заново.");
    }
    const envelope = buildUploadAwpEnvelope({
      sessionId: row.sessionId, awpBody: payload, signature, x509Certificate: signaturePem,
    });
    // The stored UTF-8 string goes directly into awpBody. No trim, XML serialization or auth PEM.
    report.sentAt = new Date().toISOString();
    report.soap.result = "transport_error";
    const response = await postSoap(config.awpUrl, envelope, { testOnly: true });
    report.soap.httpStatus = response.status;
    report.soap.result = "invalid_response";
    const fault = parseSoapFault(response.text);
    const uploaded = parseAwpUploadResult(response.text);
    if (!response.ok || fault || uploaded.declined || !uploaded.awpId) {
      report.soap.result = "declined";
      throw new ApiError(422, redactSoapText(uploaded.errors[0]?.errorCode || fault?.faultstring || "esf_upload_declined"),
        redactSoapText(uploaded.errors[0]?.text || fault?.description || "TEST ИС ЭСФ не принял uploadAwp"));
    }
    report.ok = true;
    report.code = "POC_AVR_NCALAYER_SUCCESS";
    report.soap.result = "accepted";
    report.externalId = report.soap.externalId = redactSoapText(uploaded.awpId);
    // Stop at acceptance: no query-status call and no invoice continuation.
  } catch (error) {
    report.code = error instanceof ApiError ? error.code : "ESF_POC_SOAP_ERROR";
    if (report.code === "ESF_POC_SESSION_GUARD" || report.code === "ESF_POC_SESSION_CHANGED") {
      report.session.sessionActive = false;
      report.session.status = "REAUTH_REQUIRED";
    }
    report.soap.errorCode = report.code;
    report.soap.errorMessage = error instanceof ApiError ? redactSoapText(error.message) : "Ошибка транспорта или ответа SOAP; секретные данные скрыты";
  }
  const reportDir = path.join(pocRoot(), membership.tenantId);
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "avr-result.json"), JSON.stringify(report, null, 2));
  if (!report.ok) throw new ApiError(422, report.code, report.soap.errorMessage || "POC АВР не выполнен", undefined, report);
  return report;
}

export async function runLegacyFixtureSign(auth: AuthContext) {
  requireLegacyPoc();
  requireTenant(auth);
  const payload = officialInvoiceBody();
  const signed = await signInvoiceXml(payload);
  return {
    test: "A",
    ok: signed.ok,
    code: signed.code,
    message: signed.ok ? "LocalService.generateSignature" : signed.message,
    payload: payloadMeta(payload),
    analysis: signed.ok ? analyzeEsfSignature(signed.signature) : null,
    publicCertificateConfigured: Boolean(readEsfConfig().signCertificatePem),
  };
}

export async function sendEsfWithNcaLayerSignature(
  prisma: PrismaClient,
  auth: AuthContext,
  documentId: string,
  raw: Record<string, unknown>,
) {
  rejectPrivateKeyFields(raw);
  const membership = requireTenant(auth);
  requireSendEsf(auth);
  const tid = membership.tenantId;
  const flags = await requireDocumentsEnabled(prisma, tid);
  if (!flags.esfIntegrationEnabled) {
    throw new ApiError(403, "esf_disabled", "Интеграция с ИС ЭСФ выключена в настройках");
  }
  const document = await prisma.electronicDocument.findFirst({ where: { id: documentId, tenantId: tid } });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "AVR" && document.type !== "ESF") {
    throw new ApiError(422, "unsupported_document", "ИС ЭСФ принимает только АВР и ЭСФ");
  }
  if (document.status === "DRAFT") {
    throw new ApiError(422, document.type === "ESF" ? "esf_not_validated" : "avr_not_validated", "Сначала проверьте документ");
  }
  if ((document.status === "SENT" || document.status === "ACCEPTED") && document.externalId) {
    return {
      document: serializeElectronicDocument(document),
      externalId: document.externalId,
      externalStatus: document.externalStatus,
      reused: true,
      signer: "ncalayer_esf_module",
    };
  }
  if (document.type === "ESF") {
    const avr = await prisma.electronicDocument.findFirst({
      where: { tenantId: tid, dealId: document.dealId, type: "AVR", externalId: { not: null } },
    });
    if (!avr?.externalId) throw new ApiError(422, "avr_not_sent", "Сначала отправьте АВР в ИС ЭСФ");
  }

  const signature = String(raw.signature || "");
  const publicCertificate = normalizeCertificatePem(String(raw.publicCertificate || raw.pem || ""));
  if (!signature || !publicCertificate) {
    throw new ApiError(422, "esf_signature_required", "Нужны signature и публичный сертификат из модуля ИС ЭСФ");
  }

  let payload = await readStoredXml(document.xmlStorageKey);
  if (!payload) {
    const prepared = await getEsfPayloadToSign(prisma, auth, documentId);
    payload = prepared.payload;
  }
  const expectedSha = sha256Utf8(payload);
  const givenSha = String(raw.payloadSha256 || "").trim().toLowerCase();
  if (givenSha && givenSha !== expectedSha) {
    throw new ApiError(409, "esf_payload_mismatch", "XML изменился после подписи. Получите payload заново.");
  }

  const analysis = analyzeEsfSignature(signature);
  const config = readEsfConfig();
  const uploaded = await uploadSignedDocument({
    type: document.type,
    payload,
    signature,
    publicCertificate,
    number: document.number,
    tenantId: tid,
    prisma,
  });
  if (!uploaded.ok) {
    await prisma.electronicDocument.update({
      where: { id: document.id },
      data: { errorCode: uploaded.code, errorMessage: uploaded.message },
    });
    throw new ApiError(422, uploaded.code, uploaded.message, undefined, {
      analysis,
      signer: "ncalayer_esf_module",
      errors: uploaded.errors,
    });
  }

  const officialStatus = uploaded.externalStatus;
  const accepted = document.type === "ESF" ? officialStatus === "DELIVERED" : officialStatus === "CONFIRMED";
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      status: accepted ? "ACCEPTED" : "SENT",
      signedAt: document.signedAt || new Date(),
      sentAt: new Date(),
      acceptedAt: accepted ? new Date() : document.acceptedAt,
      signedXmlStorageKey: document.xmlStorageKey,
      externalSystem: document.type === "ESF" ? "ESF_INVOICE" : "ESF_AWP",
      externalId: uploaded.externalId,
      externalNumber: uploaded.externalNumber || null,
      externalStatus: officialStatus,
      errorCode: null,
      errorMessage: null,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "electronic_document.esf_send_ncalayer",
      entityType: "electronic_document",
      entityId: updated.id,
      changesJson: {
        externalId: uploaded.externalId,
        externalStatus: officialStatus,
        signer: "ncalayer_esf_module",
        signatureFormat: analysis.format,
        signatureBytes: analysis.length,
      },
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    externalId: uploaded.externalId,
    externalStatus: officialStatus,
    provider: uploaded.provider,
    reused: false,
    signer: "ncalayer_esf_module",
    analysis,
    metadata: raw.metadata || null,
  };
}

async function uploadSignedDocument(input: {
  type: string;
  payload: string;
  signature: string;
  publicCertificate: string;
  number: string;
  tenantId: string;
  prisma: PrismaClient;
}) {
  const config = readEsfConfig();
  if (config.provider === "mock") {
    if (input.type === "ESF") {
      const uploaded = mockSyncInvoice({ xml: input.payload, num: input.number });
      if (!uploaded.ok) {
        return { ok: false as const, code: "esf_upload_declined", message: "syncInvoice declined", errors: [], provider: "mock" as const, externalId: "", externalStatus: "", externalNumber: "", httpStatus: 200 };
      }
      return {
        ok: true as const,
        code: "sent",
        message: "",
        errors: [],
        provider: "mock" as const,
        externalId: uploaded.invoiceId,
        externalStatus: uploaded.status,
        externalNumber: uploaded.registrationNumber,
        httpStatus: 200,
      };
    }
    const uploaded = mockUploadAwp({ xml: input.payload, number: input.number });
    if (!uploaded.ok) {
        return { ok: false as const, code: "esf_upload_declined", message: "uploadAwp declined", errors: [], provider: "mock" as const, externalId: "", externalStatus: "", externalNumber: "", httpStatus: 200 };
    }
    return {
      ok: true as const,
      code: "sent",
      message: "",
      errors: [],
      provider: "mock" as const,
      externalId: uploaded.awpId,
      externalStatus: uploaded.status,
      externalNumber: uploaded.registrationNumber,
      httpStatus: 200,
    };
  }
  if (!config.liveSendAllowed) {
    return {
      ok: false as const,
      code: "esf_send_not_configured",
      message: "Живая отправка в ИС ЭСФ выключена. Нужны ESF_ENV=test|local и ESF_ALLOW_LIVE_SEND=1.",
      errors: [],
      provider: "live" as const,
      externalId: "",
      externalStatus: "",
      externalNumber: "",
      httpStatus: 0,
    };
  }
  const session = await getUsableEsfSession(input.prisma, input.tenantId, config);
  if (!session) {
    return {
      ok: false as const,
      code: "REAUTH_REQUIRED",
      message: "Для отправки нужна активная сессия ИС ЭСФ. Подключение кабинета отдельно от подписи документа.",
      errors: [],
      provider: "live" as const,
      externalId: "",
      externalStatus: "",
      externalNumber: "",
      httpStatus: 0,
    };
  }
  if (input.type === "ESF") {
    const envelope = buildSyncInvoiceEnvelope({
      sessionId: session.sessionId,
      invoiceBody: input.payload,
      signature: input.signature,
      x509Certificate: input.publicCertificate,
    });
    const response = await postSoap(config.invoiceUploadUrl, envelope);
    const fault = parseSoapFault(response.text);
    const uploaded = parseSyncInvoiceResult(response.text);
    if (uploaded.declined || !uploaded.invoiceId) {
      return {
        ok: false as const,
        code: "esf_upload_declined",
        message: fault?.description || uploaded.errors[0]?.text || "syncInvoice declined",
        errors: uploaded.errors,
        provider: "live" as const,
        externalId: "",
        externalStatus: "",
        externalNumber: "",
        httpStatus: response.status,
      };
    }
    const status = await queryInvoiceById(session.sessionId, uploaded.invoiceId, config);
    return {
      ok: true as const,
      code: "sent",
      message: "",
      errors: [],
      provider: "live" as const,
      externalId: uploaded.invoiceId,
      externalStatus: status.status || "CREATED",
      externalNumber: status.registrationNumber || uploaded.num,
      httpStatus: response.status,
    };
  }
  const envelope = buildUploadAwpEnvelope({
    sessionId: session.sessionId,
    awpBody: input.payload,
    signature: input.signature,
    x509Certificate: input.publicCertificate,
  });
  const response = await postSoap(config.awpUrl, envelope);
  const fault = parseSoapFault(response.text);
  const uploaded = parseAwpUploadResult(response.text);
  if (uploaded.declined || !uploaded.awpId) {
    return {
      ok: false as const,
      code: "esf_upload_declined",
      message: fault?.description || uploaded.errors[0]?.text || "uploadAwp declined",
      errors: uploaded.errors,
        provider: "live" as const,
        externalId: "",
        externalStatus: "",
        externalNumber: "",
        httpStatus: response.status,
      };
    }
    const status = await queryAwpStatusById(session.sessionId, uploaded.awpId, config);
  return {
    ok: true as const,
    code: "sent",
    message: "",
    errors: [],
    provider: "live" as const,
    externalId: uploaded.awpId,
    externalStatus: status.status || "NOT_VIEWED",
    externalNumber: status.registrationNumber || uploaded.number,
    httpStatus: response.status,
  };
}
