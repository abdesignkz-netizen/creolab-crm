import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { createSigningClient } from "../lib/signing/ncalayerClient";

export function SignPage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  async function load() {
    try {
      setData(await api.publicSign(token));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ссылка недействительна");
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  async function sign() {
    setBusy(true);
    setError("");
    const client = createSigningClient();
    try {
      const pdf = await fetch(api.publicSignPdfUrl(token), { credentials: "include" });
      if (!pdf.ok) throw new Error("Не удалось открыть PDF");
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      const base64 = btoa(binary);
      await client.connect();
      const cms = await client.signDocument(base64);
      await api.publicSubmitSign(token, cms);
      setDone("Договор подписан");
      await load();
    } catch (err: any) {
      setError(err?.canceledByUser ? "Подпись отменена" : err instanceof Error ? err.message : "Не удалось подписать");
    } finally {
      client.disconnect();
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;

  return (
    <div className="login">
      <div className="login-stage">
        <div className="panel" style={{ maxWidth: 560 }}>
          <h2>Подписание договора</h2>
          {error ? <p className="error">{error}</p> : null}
          {done ? <p className="muted">{done}</p> : null}
          {data ? (
            <>
              <p>
                <b>{data.subject || `Договор ${data.number}`}</b>
              </p>
              <p className="muted">
                № {data.number} · {data.date ? new Date(data.date).toLocaleDateString("ru-RU") : ""}
              </p>
              <p className="muted">
                {data.sellerName || "Исполнитель"} → {data.buyerName || "Заказчик"}
              </p>
              <p>
                Сумма: <b>{Number(data.amount || 0).toLocaleString("ru-RU")} {data.currency}</b>
              </p>
              {data.waitingForSeller ? <p className="muted">Сначала должен подписать исполнитель.</p> : null}
              <div className="actions">
                <a className="btn secondary" href={api.publicSignPdfUrl(token)} target="_blank" rel="noreferrer">
                  Открыть PDF
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
                    void api
                      .publicDeclineSign(token)
                      .then(() => {
                        setDone("Договор отклонён");
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
