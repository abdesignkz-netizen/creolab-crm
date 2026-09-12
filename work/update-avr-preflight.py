from pathlib import Path
p=Path('apps/api/src/services/esfNcaLayerPocService.ts')
s=p.read_text().replace('import { createHash }', 'import { createHash, X509Certificate }')
s='import forge from "node-forge";\n'+s
s=s.replace('function tenantAvrPayloadPath(tenantId: string) {\n  return path.join(pocRoot(), tenantId, "avr-payload.xml");\n}', '''function tenantAvrPayloadPath(tenantId: string, sha256: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ApiError(409, "ESF_SIGNED_PAYLOAD_CHANGED", "Некорректный SHA-256 payload");
  return path.join(pocRoot(), tenantId, `avr-payload-${sha256}.xml`);
}

function pocSessionBinding(row: { sessionId: string | null; organizationBin: string | null }) {
  return sha256Utf8(JSON.stringify([row.sessionId, row.organizationBin, "test"]));
}''')
s=s.replace('      sessionActive: Boolean(row?.sessionId && row.status === "CONNECTED"),', '      sessionActive: describeAvrPocReadiness(row, config).sessionActive,',1)
a=s.index('  const legal =',s.index('export async function prepareAvrPocPayload'))
b=s.index('  const stored = readFileSync(dest);',a)
s=s[:a]+'''  const row = await getEsfConnectionRow(prisma, membership.tenantId);
  const readiness = describeAvrPocReadiness(row, config);
  if (!readiness.ready || !row) {
    throw new ApiError(422, "ESF_POC_SESSION_GUARD", readiness.reasons.join("; "));
  }
  const sessionTin = normalizeKzTaxId(row.organizationBin || "");
  if (!/^\\d{12}$/.test(sessionTin)) {
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
''' + s[b:]
s=s.replace('  if (fileSha256 !== payloadSha256) {', '  if (fileSha256 !== payloadSha256 || payload !== bound) {',1)
s=s.replace('    pocId: `avr-fixture:${membership.tenantId}`,', '    pocId: `avr-fixture:${membership.tenantId}:${payloadSha256}`,\n    sessionBinding: pocSessionBinding(row),')
a=s.index('function redactSoapText(')
b=s.index('export async function runLegacyFixtureSign',a)
s=s[:a]+'''export function redactSoapText(value: string) {
  return String(value || "")
    .replace(/-----BEGIN[\\s\\S]+?-----END [^-]+-----/g, "[redacted]")
    .replace(/<(?:[\\w-]+:)?(?:Password|PIN|privateKey|x509Certificate)\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w-]+:)?[\\w-]+>/gi, "[redacted]")
    .replace(/(?:password|pin|private[_ ]?key|wsse)\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s<,;]+)/gi, "[redacted]")
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
    const envelope = buildUploadAwpEnvelope({
      sessionId: row.sessionId, awpBody: payload, signature, x509Certificate: signaturePem,
    });
    // The stored UTF-8 string goes directly into awpBody. No trim, XML serialization or auth PEM.
    report.sentAt = new Date().toISOString();
    report.soap.result = "transport_error";
    const response = await postSoap(config.awpUrl, envelope);
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
    report.soap.errorCode = report.code;
    report.soap.errorMessage = error instanceof ApiError ? redactSoapText(error.message) : "Ошибка транспорта или ответа SOAP; секретные данные скрыты";
  }
  const reportDir = path.join(pocRoot(), membership.tenantId);
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "avr-result.json"), JSON.stringify(report, null, 2));
  if (!report.ok) throw new ApiError(422, report.code, report.soap.errorMessage || "POC АВР не выполнен", undefined, report);
  return report;
}

''' + s[b:]
p.write_text(s)
