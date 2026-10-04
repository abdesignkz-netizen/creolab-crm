import { uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
import { signatureCheckLabel } from "../lib/signing/verificationLabels";

export function VerifyPage({ avr = false }: { avr?: boolean }) {
  const uiText = useUiText();
  const label = avr ? uiText("АВР") : uiText("договора");
  const { verificationId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!CONTRACT_SIGNING_ENABLED) return;
    void (avr ? api.publicAvrVerify(verificationId) : api.publicVerify(verificationId))
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : uiText("Проверка не найдена")));
  }, [verificationId, avr]);

  if (!CONTRACT_SIGNING_ENABLED) {
    return (
      <div className="login">
        <div className="login-stage">
          <div className="panel" style={{ maxWidth: 560 }}>
            <h2>{uiText("Проверка документа")}</h2>
            <p className="muted">{uiText("Проверка подписи документа пока недоступна.")}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data && !error) return <div className="state">{uiText("Загрузка…")}</div>;

  return (
    <div className="login">
      <div className="login-stage">
        <div className="panel" style={{ maxWidth: 560 }}>
          <h2>{uiText("Проверка документа")}</h2>
          {error ? <p className="error">{error}</p> : null}
          {data ? (
            <>
              <p>
                <b>{avr ? uiText("АВР") : uiText("Договор")} {data.number}</b>
              </p>
              <p className="muted">
                {data.date ? new Date(data.date).toLocaleDateString(uiFormatLocale()) : ""} {" "}{uiText("· версия")}{" "}{data.version || "—"} ·{" "}
                {({ SIGNED: uiText("Подписан обеими сторонами"), PARTIALLY_SIGNED: uiText("Подписан исполнителем, ожидается подпись заказчика"), PENDING_SIGNATURE: uiText("Ожидает подписания"), READY_TO_SIGN: uiText("Готов к подписанию"), DRAFT: uiText("Черновик") } as Record<string, string>)[data.status] || data.status}
              </p>
              <p className="muted">
                {data.sellerName || uiText("Исполнитель")} / {data.buyerName || uiText("Заказчик")}
              </p>
              <p>
                {data.hashAlgorithm || "SHA-256"}: <code style={{ wordBreak: "break-all" }}>{data.documentHash || "—"}</code>
              </p>
              {(data.signers || []).map((signer: any, index: number) => (
                <p key={`${signer.iin}-${index}`}>
                  {uiText("Подписант")}{" "}{index + 1}: {signer.name || "—"}
                  {signer.iin ? uiText(" · ИИН {p0}", {p0: signer.iin}) : ""}
                  {signer.signedAt ? ` · ${new Date(signer.signedAt).toLocaleString(uiFormatLocale())}` : ""}
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
