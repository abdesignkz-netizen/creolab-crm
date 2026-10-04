import { uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { createSigningClient, ncalayerUserMessage } from "../lib/signing/ncalayerClient";
import { ContractSignatureSummary } from "../components/ContractSignatureSummary";
import { PdfDocumentViewer } from "../components/PdfDocumentViewer";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
import { BASQAR_PAGE_TITLE, BASQAR_TAGLINE, getDocumentSignMeta, publicDocumentText } from "@creolab/contracts";
import type { ReactNode } from "react";

function SignShell({ children }: { children: ReactNode }) {
  const uiText = useUiText();
  return <main className="public-sign-page"><div className="public-sign-container">
    <header className="public-sign-brand"><img src="/basqar-logo.svg" alt="BasQar" width="152" height="32" /><p>{uiText(BASQAR_TAGLINE)}</p></header>
    <section className="panel public-sign-card" aria-labelledby="sign-document-title">
      <p className="public-sign-eyebrow">{uiText("Документ на подпись")}</p>{children}
    </section>
    <p className="public-sign-footer">{uiText("BasQar · Документы и работа вашего бизнеса")}</p>
  </div></main>;
}

export function SignPage({ avr = false }: { avr?: boolean }) {
  const uiText = useUiText();
  const label = avr ? uiText("АВР") : uiText("договора");
  const documentName = avr ? uiText("АВР") : uiText("Договор");
  const signApi = avr ? { get: api.publicAvrSign, pdf: api.publicAvrSignPdfUrl, submit: api.publicSubmitAvrSign, decline: api.publicDeclineAvrSign, download: api.downloadPublicSignedAvr }
    : { get: api.publicSign, pdf: api.publicSignPdfUrl, submit: api.publicSubmitSign, decline: api.publicDeclineSign, download: api.downloadPublicSignedContract };
  const { token = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfError, setPdfError] = useState("");
  const meta = getDocumentSignMeta(avr ? "AVR" : "CONTRACT", data);
  const parties = [publicDocumentText(data?.sellerName), publicDocumentText(data?.buyerName)].filter(Boolean).join(" → ");

  useEffect(() => { document.title = BASQAR_PAGE_TITLE; }, []);

  async function load() {
    try {
      setData(await signApi.get(token));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ссылка недействительна"));
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
        if (!response.ok) throw new Error(uiText("Не удалось открыть документ"));
        const blob = await response.blob();
        if (!/^application\/pdf(?:$|;)/i.test(blob.type)) throw new Error(uiText("Сервер вернул документ не в формате PDF"));
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(error => {
        if (!cancelled) setPdfError(error instanceof Error ? error.message : uiText("Не удалось открыть PDF"));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [data, token, avr]);

  if (!CONTRACT_SIGNING_ENABLED) {
    return (
      <SignShell>
            <h1 id="sign-document-title">{uiText("Подписание документа")}</h1>
            <p className="muted">{uiText("Подписание документа пока недоступно.")}</p>
      </SignShell>
    );
  }

  async function sign() {
    setBusy(true);
    setError("");
    const client = createSigningClient();
    try {
      const pdf = await fetch(signApi.pdf(token), { credentials: "include" });
      if (!pdf.ok) throw new Error(uiText("Не удалось открыть документ"));
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      const base64 = btoa(binary);
      await client.connect();
      const cms = await client.signDocument(base64);
      await signApi.submit(token, cms);
      setDone(uiText("{p0} подписан обеими сторонами", {p0: documentName}));
      await load();
    } catch (err: any) {
      setError(ncalayerUserMessage(err));
    } finally {
      client.disconnect();
      setBusy(false);
    }
  }

  if (!data && !error) return <SignShell><h1 id="sign-document-title">{uiText("Открываем документ")}</h1><p role="status" className="muted">{uiText("Загрузка…")}</p></SignShell>;

  return (
    <SignShell>
            <h1 id="sign-document-title">{data ? (meta.date ? uiText("{p0} от {p1}", {p0: `${uiText(meta.name)}${meta.number ? ` №${meta.number}` : ""}`, p1: meta.date}) : `${uiText(meta.name)}${meta.number ? ` №${meta.number}` : ""}`) : uiText("Не удалось открыть документ")}</h1>
            {error ? <p className="error">{error}</p> : null}
          {done ? <p className="muted">{done}</p> : null}
          {data ? (
            <>
              {parties ? <p className="public-sign-parties">{parties}</p> : null}
              {data.amount != null && Number.isFinite(Number(data.amount)) ? <p className="muted">
                {uiText("Сумма:")}{" "}<b>{Number(data.amount || 0).toLocaleString(uiFormatLocale())} {data.currency}</b>
              </p> : null}
              {pdfUrl ? <PdfDocumentViewer className="sign-doc-frame" title={`${documentName} PDF`} src={pdfUrl} /> : null}
              {!pdfUrl && !pdfError ? <p className="muted">{uiText("Открываем PDF…")}</p> : null}
              {pdfError ? <p className="error">{pdfError}{uiText(". Используйте кнопку скачивания ниже.")}</p> : null}
              <ContractSignatureSummary documentLabel={label} signed={data.contractStatus === "SIGNED"} signers={data.signers || []}
                verificationUrl={data.verificationUrl} sellerName={data.sellerName} buyerName={data.buyerName} download={format => signApi.download(token, format)} />
              {data.declinedAt ? <p className="error">{uiText("Вы отклонили документ. Обратитесь к исполнителю для согласования.")}</p> : null}
              {data.waitingForSeller ? <p className="muted">{uiText("Сначала должен подписать исполнитель.")}</p> : null}
              <p className="muted public-sign-instructions">{uiText("Ознакомьтесь с документом и подпишите его ЭЦП через NCALayer. PIN остаётся на вашем устройстве.")}</p>
              <div className="actions public-sign-actions">
                <a className="btn secondary" href={signApi.pdf(token)}>
                  {uiText("Скачать исходный PDF")}</a>
                <button type="button" className="btn" disabled={busy || !data.canSign} onClick={() => void sign()}>
                  {busy ? uiText("Подписываем…") : uiText("Подписать документ")}
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
                        setDone(uiText("{p0} отклонён", {p0: documentName}));
                        return load();
                      })
                      .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось отклонить")))
                      .finally(() => setBusy(false));
                  }}
                >
                  {uiText("Отклонить")}</button>
              </div>
            </>
          ) : null}
    </SignShell>
  );
}
