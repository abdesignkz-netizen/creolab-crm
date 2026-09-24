import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
import { signatureCheckLabel } from "../lib/signing/verificationLabels";

export function VerifyPage({ avr = false }: { avr?: boolean }) {
  const label = avr ? "АВР" : "договора";
  const { verificationId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!CONTRACT_SIGNING_ENABLED) return;
    void (avr ? api.publicAvrVerify(verificationId) : api.publicVerify(verificationId))
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Проверка не найдена"));
  }, [verificationId, avr]);

  if (!CONTRACT_SIGNING_ENABLED) {
    return (
      <div className="login">
        <div className="login-stage">
          <div className="panel" style={{ maxWidth: 560 }}>
            <h2>Проверка {label}</h2>
            <p className="muted">Проверка подписи {label} пока недоступна.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;

  return (
    <div className="login">
      <div className="login-stage">
        <div className="panel" style={{ maxWidth: 560 }}>
          <h2>Проверка {label}</h2>
          {error ? <p className="error">{error}</p> : null}
          {data ? (
            <>
              <p>
                <b>{avr ? "АВР" : "Договор"} {data.number}</b>
              </p>
              <p className="muted">
                {data.date ? new Date(data.date).toLocaleDateString("ru-RU") : ""} · версия {data.version || "—"} ·{" "}
                {({ SIGNED: "Подписан обеими сторонами", PARTIALLY_SIGNED: "Подписан исполнителем, ожидается подпись заказчика", PENDING_SIGNATURE: "Ожидает подписания", READY_TO_SIGN: "Готов к подписанию", DRAFT: "Черновик" } as Record<string, string>)[data.status] || data.status}
              </p>
              <p className="muted">
                {data.sellerName || "Исполнитель"} / {data.buyerName || "Заказчик"}
              </p>
              <p>
                {data.hashAlgorithm || "SHA-256"}: <code style={{ wordBreak: "break-all" }}>{data.documentHash || "—"}</code>
              </p>
              {(data.signers || []).map((signer: any, index: number) => (
                <p key={`${signer.iin}-${index}`}>
                  Подписант {index + 1}: {signer.name || "—"}
                  {signer.iin ? ` · ИИН ${signer.iin}` : ""}
                  {signer.signedAt ? ` · ${new Date(signer.signedAt).toLocaleString("ru-RU")}` : ""}
                  {signatureCheckLabel(signer)
                    ? ` · ${signatureCheckLabel(signer)}`
                    : signer.verificationStatus
                      ? ` · ${signer.verificationStatus}`
                      : ""}
                </p>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
