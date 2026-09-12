import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sanitizeEsfSignerPublicMeta } from "@creolab/contracts";
import { api } from "../lib/api";
import { createEsfNcaLayerClient, ESF_MODULE_REQUIRED_MESSAGE } from "../lib/signing/esfNcaLayerClient";
import { signPlainDataPemFingerprint, verifyFrozenAvrPayload } from "../lib/signing/avrPocPreflight";
import { createNcalayerClient, NcalayerError } from "../lib/signing/ncalayerClient";

type ConnectionPayload = {
  connection: {
    status: string;
    organizationBin: string | null;
    signerIin: string | null;
    certificateSerial: string | null;
    lastConnectedAt: string | null;
    lastErrorMessage: string | null;
    sessionActive: boolean;
    reauthRequired: boolean;
    reauthMessage: string | null;
  };
  organization: { legalName: string | null; bin: string | null };
  system: { provider: string; esfEnv: string; endpointHost?: string; liveSendAllowed: boolean; legacyPocEnabled?: boolean };
  avrPoc?: { ready: boolean; reasons: string[]; sessionExpiresAt: string | null };
  authCertificate?: Record<string, unknown> | null;
  wsseRequired?: boolean;
  message?: string;
  code?: string;
};

const STATUS_LABEL: Record<string, string> = {
  NOT_CONNECTED: "Не подключено",
  CONNECTING: "Подключение…",
  CONNECTED: "Подключено",
  SESSION_EXPIRED: "Сессия истекла",
  REAUTH_REQUIRED: "Нужна повторная авторизация",
  ERROR: "Ошибка",
};

function statusClass(status: string) {
  if (status === "CONNECTED") return "ok";
  if (status === "CONNECTING") return "";
  if (status === "ERROR") return "danger";
  return "warn";
}

export function EsfIntegrationPage() {
  const [data, setData] = useState<ConnectionPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [askCabinet, setAskCabinet] = useState(false);
  const [cabinetUsername, setCabinetUsername] = useState("");
  const [cabinetPassword, setCabinetPassword] = useState("");
  const [authCms, setAuthCms] = useState("");
  const [authPem, setAuthPem] = useState("");
  const [poc, setPoc] = useState<any>(null);
  const [probe, setProbe] = useState<any>(null);
  const [pocNote, setPocNote] = useState("");
  const [avrPoc, setAvrPoc] = useState<any>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function load() {
    setError("");
    try {
      const next = (await api.esfConnection()) as ConnectionPayload;
      setData(next);
      if (next.connection.signerIin && !cabinetUsername) setCabinetUsername(next.connection.signerIin);
      setAskCabinet(Boolean(next.wsseRequired && next.connection.status !== "CONNECTED"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить ИС ЭСФ");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function obtainAuthPublic(reuse = true) {
    if (reuse && authPem) return { pem: authPem };
    if (reuse && authCms) return { cms: authCms };
    const esf = createEsfNcaLayerClient();
    try {
      if (await esf.isAvailable()) {
        const live = await esf.probe();
        setProbe(live);
        if (live.officialModuleInstalled) {
          const auth = await esf.auth();
          setPoc((current: any) => ({ ...current, esfAuth: auth.raw }));
          setPocNote(
            auth.publicCertificate
              ? `AUTH через модуль ИС ЭСФ: ${auth.keyInfo?.subjectCn || "сертификат получен"}`
              : "method auth не вернул PEM — fallback на basics",
          );
          if (auth.publicCertificate) {
            setAuthPem(auth.publicCertificate);
            return { pem: auth.publicCertificate, auth };
          }
        }
      }
    } finally {
      esf.disconnect();
    }
    const basics = createNcalayerClient();
    try {
      if (!(await basics.isAvailable())) {
        throw new NcalayerError("NCALAYER_NOT_RUNNING", "Запустите NCALayer и повторите подключение");
      }
      const cms = await basics.selectAuthCertificate();
      setAuthCms(cms);
      return { cms };
    } finally {
      basics.disconnect();
    }
  }

  async function connect(reuse = true) {
    setBusy(true);
    setError("");
    try {
      if (data?.system.provider === "live") {
        const iin = cabinetUsername.trim();
        if (!/^\d{12}$/.test(iin)) throw new Error("Укажите ИИН пользователя — 12 цифр");
        const ticket = await api.esfAuthTicket(iin) as { authTicketXml: string };
        const client = createNcalayerClient();
        try {
          // Authentication XML only. AVR/ESF still use the official signPlainData flow.
          const signedAuthTicket = await client.signXml(ticket.authTicketXml, { extKeyUsageOids: [] });
          await api.esfConnect({ signedAuthTicket });
        } finally { client.disconnect(); }
      } else {
      const cert = await obtainAuthPublic(reuse);
      await api.esfConnect({
        authCertificatePem: cert.pem,
        authCmsBase64: cert.cms,
        cabinetUsername: cabinetUsername || undefined,
        cabinetPassword: cabinetPassword || undefined,
      });
      }
      setCabinetPassword("");
      setAskCabinet(false);
      await load();
    } catch (err: any) {
      const body = err?.body as Partial<ConnectionPayload> | undefined;
      if (body?.connection) {
        // Connect errors contain connection data, but not the system configuration.
        setData(current => current ? {
          ...current, ...body, system: current.system,
          avrPoc: { ready: false, reasons: [body.message || "Подключение ИС ЭСФ не завершено"], sessionExpiresAt: null },
        } : current);
      }
      setAskCabinet(Boolean(body?.wsseRequired || body?.code === "esf_wsse_required"));
      if (body?.wsseRequired || body?.code === "esf_wsse_required") {
        setAskCabinet(true);
        setError(body?.message || "ИС ЭСФ запросила пароль кабинета. Это не PIN ЭЦП.");
      } else if (body?.code === "CERTIFICATE_NOT_VALID") {
        setError("TEST ИС ЭСФ не принял AUTH-сертификат. Upload не запускаем.");
      } else if (err instanceof NcalayerError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Не удалось подключить ИС ЭСФ");
      }
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await api.esfDisconnect();
      setAuthCms("");
      setCabinetPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отключить");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;

  const status = data?.connection.status || "NOT_CONNECTED";
  const connected = status === "CONNECTED";
  const pocReasons = [...(data?.avrPoc?.reasons || ["Проверка сессии ещё не выполнена"])];
  if (data?.avrPoc?.sessionExpiresAt && Date.parse(data.avrPoc.sessionExpiresAt) <= now) pocReasons.push("Сессия истекла");
  if (avrPoc?.code === "POC_AVR_NCALAYER_SUCCESS") pocReasons.push("POC завершён успешно");
  const pocReady = Boolean(data?.avrPoc?.ready && connected && data?.connection.sessionActive &&
    data.system.esfEnv === "test" && pocReasons.length === 0);

  return (
    <section className="esf-integration-page">
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/integrations">Интеграции</Link> → ИС ЭСФ
          </p>
          <h2>ИС ЭСФ</h2>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {data?.connection.reauthMessage ? <p className="error">{data.connection.reauthMessage}</p> : null}

      <div className="panel">
        <div className="esf-status-row">
          <span className={`esf-dot ${statusClass(status)}`} />
          <div>
            <b>{STATUS_LABEL[status] || status}</b>
            <p className="muted">
              Контур: {data?.system.esfEnv || "—"} · {data?.system.provider === "mock" ? "локальная заглушка" : "ИС ЭСФ"}
            </p>
          </div>
        </div>

        {connected ? (
          <dl className="esf-facts">
            <div>
              <dt>Организация</dt>
              <dd>{data?.organization.legalName || "—"}</dd>
            </div>
            <div>
              <dt>БИН</dt>
              <dd>{data?.organization.bin || data?.connection.organizationBin || "—"}</dd>
            </div>
            <div>
              <dt>Авторизован</dt>
              <dd>{data?.connection.signerIin || "—"}</dd>
            </div>
            <div>
              <dt>Сессия</dt>
              <dd>{data?.connection.sessionActive ? "активна" : "нет"}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">
            Для подключения запустите NCALayer и авторизуйтесь с помощью ЭЦП. Путь к файлу и PIN сервер не спрашивает
            — их принимает только NCALayer на этом компьютере.
          </p>
        )}

        {data?.system.provider === "live" ? (
          <div className="stack">
            <p className="muted">Вход через ЭЦП: NCALayer подпишет запрос авторизации ИС ЭСФ. Пароль кабинета для этого способа не требуется. PIN вводится только в NCALayer.</p>
            <label>ИИН пользователя<input value={cabinetUsername} onChange={(e) => setCabinetUsername(e.target.value)} inputMode="numeric" maxLength={12} autoComplete="username" /></label>
          </div>
        ) : null}
        {data?.system.provider !== "live" && askCabinet && !connected ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <p className="muted">Пароль кабинета ИС ЭСФ — не PIN ЭЦП. Он используется только для createSession и не сохраняется.</p>
            <label>
              ИИН / логин кабинета
              <input value={cabinetUsername} onChange={(e) => setCabinetUsername(e.target.value)} autoComplete="username" />
            </label>
            <label>
              Пароль кабинета ИС ЭСФ
              <input
                type="password"
                value={cabinetPassword}
                onChange={(e) => setCabinetPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <div className="actions">
              <button className="btn" disabled={busy}>
                {busy ? "Подключаем…" : "Продолжить"}
              </button>
            </div>
          </form>
        ) : null}

        <div className="actions" style={{ marginTop: 16 }}>
          {!connected ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void connect()}>
              {busy ? "Подключаем…" : status === "NOT_CONNECTED" ? "Подключить через NCALayer" : "Переподключить"}
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void connect(false)}>
                Переподключить
              </button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void disconnect()}>
                Отключить
              </button>
            </>
          )}
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          БИН организации задаётся в <Link to="/settings">реквизитах</Link>. Подключение кабинета и подпись АВР/ЭСФ —
          разные операции. PIN остаётся в NCALayer.
        </p>
      </div>

      {import.meta.env.DEV ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <h3>DEV: модуль ИС ЭСФ</h3>
          <p>Environment: {data?.system.esfEnv.toUpperCase() || "—"}<br />Endpoint host: {data?.system.endpointHost || "—"}</p>
          <p className="muted">Диагностика только в development. Подпись документа — через официальный модуль, не basics cms/xml.</p>
          {pocNote ? <p className={/ошиб|не /i.test(pocNote) ? "error" : "muted"}>{pocNote}</p> : null}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setPocNote("");
                void (async () => {
                  const [diagResult, liveResult] = await Promise.allSettled([
                    api.esfNcaLayerPoc(),
                    (async () => {
                      const client = createEsfNcaLayerClient();
                      try {
                        if (!(await client.isAvailable())) return { ncalayer: false, officialModuleInstalled: false, bundleName: null, bundleVersion: null, serviceName: null };
                        return await client.probe();
                      } finally {
                        client.disconnect();
                      }
                    })(),
                  ]);
                  if (diagResult.status === "fulfilled") setPoc(diagResult.value);
                  if (liveResult.status === "fulfilled") setProbe(liveResult.value);
                  const live = liveResult.status === "fulfilled" ? liveResult.value : null;
                  const moduleNote = live?.officialModuleInstalled
                    ? `Официальный модуль: ${live.bundleName || "—"} ${live.bundleVersion || ""} · ${live.serviceName || ""}`
                    : live?.ncalayer ? ESF_MODULE_REQUIRED_MESSAGE : "Не удалось подтвердить связь с NCALayer";
                  setPocNote(moduleNote + (diagResult.status === "rejected" ? ". Диагностика сервера ИС ЭСФ не выполнена; подключение NCALayer проверено отдельно." : ""));
                })()
                  .catch((err) => setPocNote(err instanceof Error ? err.message : "Не удалось получить диагностику"))
                  .finally(() => setBusy(false));
              }}
            >
              Проверить NCALayer
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setPocNote("");
                const client = createEsfNcaLayerClient();
                void (async () => {
                  if (!(await client.isAvailable())) throw new NcalayerError("NCALAYER_NOT_RUNNING", "Запустите NCALayer");
                  const live = await client.probe();
                  setProbe(live);
                  if (!live.officialModuleInstalled) throw new NcalayerError("SIGNATURE_FAILED", ESF_MODULE_REQUIRED_MESSAGE);
                  const auth = await client.auth();
                  setPoc((current: any) => ({ ...current, esfAuth: auth.raw, authHasPem: auth.hasPublicCertificate }));
                  if (auth.publicCertificate) setAuthPem(auth.publicCertificate);
                  setPocNote(
                    auth.publicCertificate
                      ? "DEV auth: публичный PEM получен. Схема ответа ниже, без private data."
                      : "DEV auth: PEM в ответе не найден. Для createSession остаётся basics AUTH.",
                  );
                })()
                  .catch((err) => setPocNote(err instanceof Error ? err.message : "DEV auth не выполнен"))
                  .finally(() => {
                    client.disconnect();
                    setBusy(false);
                  });
              }}
            >
              DEV: auth
            </button>
            {data?.system.legacyPocEnabled ? (
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setPocNote("");
                  void api
                    .esfNcaLayerLegacySign()
                    .then((row: any) => {
                      setPoc((current: any) => ({ ...current, legacySign: row }));
                      setPocNote(
                        row.ok
                          ? `TEST A: LocalService ${row.analysis?.format || ""} · ${row.analysis?.length || 0} байт`
                          : `TEST A: ${row.message || row.code}`,
                      );
                    })
                    .catch((err) => setPocNote(err instanceof Error ? err.message : "TEST A не выполнен"))
                    .finally(() => setBusy(false));
                }}
              >
                TEST A: LocalService
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy || !pocReady}
              onClick={() => {
                setBusy(true);
                setPocNote("");
                const client = createEsfNcaLayerClient();
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
                      attempt.soap.errorMessage = /^(ESF_POC_SESSION_GUARD|ESF_POC_SESSION_CHANGED|esf_bin_required)$/.test(err?.body?.code || "")
                        ? err.body.message
                        : "Подготовка или подпись не завершена. Проверьте TEST-сессию и NCALayer; uploadAwp не подтверждён.";
                      setAvrPoc({ ...attempt });
                      setPocNote(attempt.soap.errorMessage);
                    }
                  })
                  .finally(() => {
                    client.disconnect();
                    setBusy(false);
                  });
              }}
            >
              POC АВР: подписать и отправить
            </button>
          </div>
          {!pocReady ? <p className="muted">POC АВР: {pocReasons.join("; ") || "Нет активной TEST-сессии"}</p> : null}
          {probe ? (
            <dl className="esf-facts" style={{ marginTop: 12 }}>
              <div>
                <dt>NCALayer</dt>
                <dd>{probe.ncalayer ? "запущен" : "нет"}</dd>
              </div>
              <div>
                <dt>Модуль ИС ЭСФ</dt>
                <dd>{probe.officialModuleInstalled ? `${probe.bundleName} ${probe.bundleVersion || ""}` : "не установлен"}</dd>
              </div>
              <div>
                <dt>Service</dt>
                <dd>{probe.serviceName || "—"}</dd>
              </div>
              <div>
                <dt>Methods</dt>
                <dd>{(probe.methods || []).join(", ") || "—"}</dd>
              </div>
            </dl>
          ) : null}
          {poc?.esfAuth ? (
            <div style={{ marginTop: 12 }}>
              <p className="muted">DEV auth: sanitized response модуля ИС ЭСФ:</p>
              <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>
                {JSON.stringify(poc.esfAuth, null, 2)}
              </pre>
            </div>
          ) : null}
          {data?.authCertificate || poc?.certificate ? (
            <div style={{ marginTop: 12 }}>
              <p className="muted">AUTH-сертификат (без private key / PEM):</p>
              <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>
                {JSON.stringify(data?.authCertificate || poc?.certificate, null, 2)}
              </pre>
            </div>
          ) : null}
          {avrPoc ? (
            <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto", marginTop: 12 }}>
              {JSON.stringify(avrPoc, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
