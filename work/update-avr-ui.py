from pathlib import Path
p=Path('apps/web/src/pages/EsfIntegrationPage.tsx');s=p.read_text()
s=s.replace('import { createNcalayerClient,', 'import { signPlainDataPemFingerprint, verifyFrozenAvrPayload } from "../lib/signing/avrPocPreflight";\nimport { createNcalayerClient,')
s=s.replace('system: { provider: string; esfEnv: string; liveSendAllowed: boolean; legacyPocEnabled?: boolean };', '''system: { provider: string; esfEnv: string; endpointHost?: string; liveSendAllowed: boolean; legacyPocEnabled?: boolean };
  avrPoc?: { ready: boolean; reasons: string[]; sessionExpiresAt: string | null };''')
s=s.replace('  const [avrPoc, setAvrPoc] = useState<any>(null);', '''  const [avrPoc, setAvrPoc] = useState<any>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);''')
s=s.replace('  const connected = status === "CONNECTED";', '''  const connected = status === "CONNECTED";
  const pocReasons = [...(data?.avrPoc?.reasons || ["Проверка сессии ещё не выполнена"])];
  if (data?.avrPoc?.sessionExpiresAt && Date.parse(data.avrPoc.sessionExpiresAt) <= now) pocReasons.push("Сессия истекла");
  if (avrPoc?.code === "POC_AVR_NCALAYER_SUCCESS") pocReasons.push("POC завершён успешно");
  const pocReady = Boolean(data?.avrPoc?.ready && connected && data?.connection.sessionActive &&
    data.system.esfEnv === "test" && pocReasons.length === 0);''')
s=s.replace('          <h3>DEV: модуль ИС ЭСФ</h3>', '''          <h3>DEV: модуль ИС ЭСФ</h3>
          <p>Environment: {data?.system.esfEnv.toUpperCase() || "—"}<br />Endpoint host: {data?.system.endpointHost || "—"}</p>''')
s=s.replace('disabled={busy || !connected || data?.connection.status === "ERROR"}', 'disabled={busy || !pocReady}')
a=s.index('                const client = createEsfNcaLayerClient();', s.index('disabled={busy || !pocReady}'))
b=s.index('                  .finally(() => {',a)
s=s[:a]+'''                const client = createEsfNcaLayerClient();
                const authCert: any = data?.authCertificate;
                const attempt: any = {
                  environment: data?.system.esfEnv.toUpperCase(), endpointHost: data?.system.endpointHost,
                  session: { status, sessionActive: data?.connection.sessionActive },
                  authCertificate: authCert ? {
                    subject: authCert.subject, serial: authCert.serial, algorithm: authCert.signatureAlgorithm,
                    validFrom: authCert.validFrom, validTo: authCert.validTo,
                  } : null,
                  payload: { byteLength: null, sha256: null }, signCertificate: null,
                  signature: { base64Length: null, decodedLength: null },
                  soap: { operation: "uploadAwp", httpStatus: null, result: "not_sent", errorCode: null, errorMessage: null, externalId: null },
                };
                setAvrPoc(attempt);
                void (async () => {
                  const fresh: any = await api.esfNcaLayerPoc();
                  if (!fresh.avrPoc?.ready) throw new Error(fresh.avrPoc?.reasons?.join("; ") || "POC АВР недоступен");
                  if (!(await client.isAvailable())) throw new NcalayerError("NCALAYER_NOT_RUNNING", "Запустите NCALayer");
                  const prepared: any = Object.freeze(await api.esfPocAvrPayload());
                  await verifyFrozenAvrPayload(prepared);
                  attempt.payload = { byteLength: prepared.byteLength, sha256: prepared.payloadSha256 };
                  setAvrPoc({ ...attempt });
                  const signed = Object.freeze(await client.signPlainData(prepared.payload));
                  const pemFingerprint = await signPlainDataPemFingerprint(signed.publicCertificate);
                  const signMeta = sanitizeEsfSignerPublicMeta(signed);
                  attempt.signCertificate = {
                    subject: signMeta.subjectCn, serial: signMeta.serialNumber, algorithm: signMeta.algorithm,
                    validFrom: signMeta.certNotBefore, validTo: signMeta.certNotAfter,
                  };
                  attempt.signature = { base64Length: signed.signature.length, decodedLength: atob(signed.signature).length };
                  setAvrPoc({ ...attempt });
                  await verifyFrozenAvrPayload(prepared);
                  const sent: any = await api.esfPocAvrSend({
                    signature: signed.signature,
                    pem: signed.publicCertificate,
                    pemFingerprint,
                    payloadSha256: prepared.payloadSha256,
                    sessionBinding: prepared.sessionBinding,
                  });
                  setAvrPoc(sent);
                  setPocNote(`${sent.code}${sent.externalId ? ` · externalId: ${sent.externalId}` : ""}`);
                })()
                  .catch((err: any) => {
                    const details = err?.body?.details;
                    if (details?.soap) {
                      setAvrPoc(details);
                      setPocNote(details.soap.errorMessage || "POC АВР не выполнен");
                    } else {
                      // Do not render arbitrary NCALayer/transport errors: they may contain key material.
                      attempt.soap.errorCode = "ESF_POC_CLIENT_STOPPED";
                      attempt.soap.errorMessage = "Подготовка или подпись не завершена. Проверьте TEST-сессию и NCALayer; uploadAwp не подтверждён.";
                      setAvrPoc({ ...attempt });
                      setPocNote(attempt.soap.errorMessage);
                    }
                  })
''' + s[b:]
s=s.replace('          {probe ? (', '''          {!pocReady ? <p className="muted">POC АВР: {pocReasons.join("; ") || "Нет активной TEST-сессии"}</p> : null}
          {probe ? (''')
p.write_text(s)
