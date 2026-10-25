import { systemText, kkSystemMessages, FEATURE_LABEL, type Feature } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { useNavigate } from "react-router-dom";
import type { PaywallDetail } from "./PaywallDialog";

export default function PaywallContent({ open, onClose }: { open: PaywallDetail; onClose: () => void }) {
  const locale = useLocale();
  const navigate = useNavigate();
  const label = open.feature ? systemText(locale, FEATURE_LABEL[open.feature as Feature] || "") : "";

  return (
    <div className="paywall-backdrop" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <div className="panel paywall-card">
        <h2 id="paywall-title">{systemText(locale, "Подключите подходящий тариф")}</h2>
        <p>
          {(locale === "kk" ? (kkSystemMessages[open.message || ""] || undefined) : open.message) ||
            (label
              ? systemText(locale, "Эта функция доступна в тарифе с функцией «{p0}».", { p0: label })
              : systemText(locale, "Эта функция доступна после подключения тарифа."))}
        </p>
        <div className="actions">
          <button
            className="btn"
            type="button"
            onClick={() => {
              onClose();
              navigate("/billing");
            }}
          >
            {systemText(locale, "Посмотреть тариф")}</button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              onClose();
              navigate("/billing");
            }}
          >
            {systemText(locale, "Отправить запрос на подключение")}</button>
          <button className="btn secondary" type="button" onClick={() => onClose()}>
            {systemText(locale, "Отмена")}</button>
        </div>
      </div>
    </div>
  );
}
