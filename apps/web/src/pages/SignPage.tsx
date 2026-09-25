import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { createSigningClient, ncalayerUserMessage } from "../lib/signing/ncalayerClient";
import { ContractSignatureSummary } from "../components/ContractSignatureSummary";
import { PdfDocumentViewer } from "../components/PdfDocumentViewer";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";

export function SignPage({ avr = false }: { avr?: boolean }) {
  const label = avr ? "АВР" : "договора";
  const documentName = avr ? "АВР" : "Договор";
  const signApi = avr ? { get: api.publicAvrSign, pdf: api.publicAvrSignPdfUrl, submit: api.publicSubmitAvrSign, decline: api.publicDeclineAvrSign, download: api.downloadPublicSignedAvr }
    : { get: api.publicSign, pdf: api.publicSignPdfUrl, submit: api.publicSubmitSign, decline: api.publicDeclineSign, download: api.downloadPublicSignedContract };
  const { token = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfError, setPdfError] = useState("");

  async function load() {
    try {
      setData(await signApi.get(token));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ссылка недействительна");
    }
  }

  useEffect(() => {
    if (!CONTRACT_SIGNING_ENABLED) return;
    setData(null); setDone(""); setPdfUrl(""); setPdfError("");
    void load();
  }, [token, avr]);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let objectUrl = "";
    setPdfError("");
    void fetch(signApi.pdf(token), { credentials: "include" })
      .then(async response => {
        if (!response.ok) throw new Error("Не удалось открыть документ");
        const blob = await response.blob();
        if (!/^application\/pdf(?:$|;)/i.test(blob.type)) throw new Error("Сервер вернул документ не в формате PDF");
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(error => {
        if (!cancelled) setPdfError(error instanceof Error ? error.message : "Не удалось открыть PDF");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [data, token, avr]);

  if (!CONTRACT_SIGNING_ENABLED) {
    return (
      <div className="login">
        <div className="login-stage">
          <div className="panel" style={{ maxWidth: 560 }}>
            <h2>Подписание {label}</h2>
            <p className="muted">Подписание {label} пока недоступно.</p>
          </div>
        </div>
      </div>
    );
  }

  async function sign() {
    setBusy(true);
    setError("");
    const client = createSigningClient();
    try {
      const pdf = await fetch(signApi.pdf(token), { credentials: "include" });
      if (!pdf.ok) throw new Error("Не удалось открыть документ");
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      const base64 = btoa(binary);
      await client.connect();
      const cms = await client.signDocument(base64);
      await signApi.submit(token, cms);
      setDone(`${documentName} подписан обеими сторонами`);
      await load();
    } catch (err: any) {
      setError(ncalayerUserMessage(err));
    } finally {
      client.disconnect();
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;

  return (
    <div className="login">
      <div className="login-stage sign-doc-stage">
          <div className="panel" style={{ maxWidth: 920 }}>
            <h2>Подписание {label}</h2>
            <p className="muted">Нужен NCALayer с ключом подписи НУЦ. PIN на сервер не передаётся.</p>
            {error ? <p className="error">{error}</p> : null}
          {done ? <p className="muted">{done}</p> : null}
          {data ? (
            <>
              <p>
                <b>{data.subject || `${documentName} ${data.number}`}</b>
              </p>
              <p className="muted">
                № {data.number}
                {data.version ? ` · версия ${data.version}` : ""}
                {data.date ? ` · ${new Date(data.date).toLocaleDateString("ru-RU")}` : ""}
              </p>
              <p className="muted">
                {data.sellerName || "Исполнитель"} → {data.buyerName || "Заказчик"}
              </p>
              <p>
                Сумма: <b>{Number(data.amount || 0).toLocaleString("ru-RU")} {data.currency}</b>
              </p>
              {pdfUrl ? <PdfDocumentViewer className="sign-doc-frame" title={`${documentName} PDF`} src={pdfUrl} /> : null}
              {!pdfUrl && !pdfError ? <p className="muted">Открываем PDF…</p> : null}
              {pdfError ? <p className="error">{pdfError}. Используйте кнопку скачивания ниже.</p> : null}
              <ContractSignatureSummary documentLabel={label} signed={data.contractStatus === "SIGNED"} signers={data.signers || []}
                verificationUrl={data.verificationUrl} sellerName={data.sellerName} buyerName={data.buyerName} download={format => signApi.download(token, format)} />
              {data.declinedAt ? <p className="error">Вы отклонили этот АВР. Обратитесь к исполнителю для согласования.</p> : null}
              {data.waitingForSeller ? <p className="muted">Сначала должен подписать исполнитель.</p> : null}
              <div className="actions">
                <a className="btn secondary" href={signApi.pdf(token)}>
                  Скачать исходный PDF
                </a>
                <button type="button" className="btn" disabled={busy || !data.canSign} onClick={() => void sign()}>
                  {busy ? "Подписываем…" : "Подписать ЭЦП"}
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || !data.canDecline}
                  onClick={() => {
                    setBusy(true);
                    void signApi
                      .decline(token)
                      .then(() => {
                        setDone(`${documentName} отклонён`);
                        return load();
                      })
                      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось отклонить"))
                      .finally(() => setBusy(false));
                  }}
                >
                  Отклонить
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
