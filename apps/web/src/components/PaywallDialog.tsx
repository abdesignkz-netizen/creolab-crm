import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FEATURE_LABEL, type Feature } from "@creolab/contracts";

type PaywallDetail = { message?: string; feature?: string };

export function PaywallDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState<PaywallDetail | null>(null);

  useEffect(() => {
    function onPaywall(event: Event) {
      const detail = (event as CustomEvent<PaywallDetail>).detail || {};
      setOpen({
        message: detail.message || "Эта функция доступна после подключения тарифа.",
        feature: detail.feature,
      });
    }
    window.addEventListener("basqar:paywall", onPaywall);
    return () => window.removeEventListener("basqar:paywall", onPaywall);
  }, []);

  if (!open) return null;
  const label = open.feature ? FEATURE_LABEL[open.feature as Feature] : "";

  return (
    <div className="paywall-backdrop" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <div className="panel paywall-card">
        <h2 id="paywall-title">Подключите подходящий тариф</h2>
        <p>
          {open.message ||
            (label
              ? `Эта функция доступна в тарифе с функцией «${label}».`
              : "Эта функция доступна после подключения тарифа.")}
        </p>
        <div className="actions">
          <button
            className="btn"
            type="button"
            onClick={() => {
              setOpen(null);
              navigate("/billing");
            }}
          >
            Посмотреть тариф
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              setOpen(null);
              navigate("/billing");
            }}
          >
            Отправить запрос на подключение
          </button>
          <button className="btn secondary" type="button" onClick={() => setOpen(null)}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

export function openPaywall(message?: string) {
  window.dispatchEvent(
    new CustomEvent("basqar:paywall", {
      detail: { message: message || "Эта функция доступна после подключения тарифа." },
    }),
  );
}
