import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";

export function VerifyPage() {
  const { verificationId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .publicVerify(verificationId)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Проверка не найдена"));
  }, [verificationId]);

  if (!data && !error) return <div className="state">Загрузка…</div>;

  return (
    <div className="login">
      <div className="login-stage">
        <div className="panel" style={{ maxWidth: 560 }}>
          <h2>Проверка договора</h2>
          {error ? <p className="error">{error}</p> : null}
          {data ? (
            <>
              <p>
                <b>Договор {data.number}</b>
              </p>
              <p className="muted">
                {data.date ? new Date(data.date).toLocaleDateString("ru-RU") : ""} · версия {data.version || "—"} ·{" "}
                {data.status}
              </p>
              <p className="muted">
                {data.sellerName || "Исполнитель"} / {data.buyerName || "Заказчик"}
              </p>
              <p>
                SHA-256: <code style={{ wordBreak: "break-all" }}>{data.documentHash || "—"}</code>
              </p>
              {(data.signers || []).map((signer: any, index: number) => (
                <p key={`${signer.iin}-${index}`}>
                  Подписант {index + 1}: {signer.name || "—"}
                  {signer.iin ? ` · ИИН ${signer.iin}` : ""}
                  {signer.signedAt ? ` · ${new Date(signer.signedAt).toLocaleString("ru-RU")}` : ""}
                  {signer.verificationStatus ? ` · ${signer.verificationStatus}` : ""}
                </p>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
