import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

type PaywallDetail = { message?: string; feature?: string };

export function PaywallDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState<PaywallDetail | null>(null);

  useEffect(() => {
    function onPaywall(event: Event) {
      const detail = (event as CustomEvent<PaywallDetail>).detail || {};
      setOpen({
        message: detail.message || "Эта функция доступна после активации тарифа BasQar.",
        feature: detail.feature,
      });
    }
    window.addEventListener("basqar:paywall", onPaywall);
    return () => window.removeEventListener("basqar:paywall", onPaywall);
  }, []);

  if (!open) return null;

  return (
    <div className="paywall-backdrop" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <div className="panel paywall-card">
        <h2 id="paywall-title">Подключите тариф</h2>
        <p>{open.message || "Эта функция доступна после активации тарифа BasQar."}</p>
        <div className="actions">
          <button
            className="btn"
            type="button"
            onClick={() => {
              setOpen(null);
              navigate("/billing");
            }}
          >
            Посмотреть тарифы
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
      detail: { message: message || "Эта функция доступна после активации тарифа BasQar." },
    }),
  );
}
