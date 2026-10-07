import { useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useBillingText } from "./BillingCheckoutUi";

export function CancelBillingOrder({
  blocked,
  busy,
  orderNumber,
  onCancel,
}: {
  blocked: boolean;
  busy: boolean;
  orderNumber: string;
  onCancel: () => Promise<unknown>;
}) {
  const t = useBillingText(),
    id = useId(),
    location = useLocation();
  const [confirming, setConfirming] = useState(false);
  const support = new URLSearchParams(location.search);
  support.set("support", "1");
  if (!confirming)
    return (
      <div className="billing-cancel stack">
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() => setConfirming(true)}
          aria-describedby={blocked ? id : undefined}
        >
          {t("Отменить заказ", "Тапсырыстан бас тарту", "Cancel order")}
        </button>
        {blocked && (
          <p id={id} className="muted">
            {t(
              "Перед отменой проверим результат попытки оплаты. Если банк отклонил платёж или срок оплаты истёк, заказ будет отменён.",
              "Бас тарту алдында төлем әрекетінің нәтижесін тексереміз. Банк төлемді қабылдамаса немесе төлем мерзімі өтсе, тапсырыс жойылады.",
              "We will check the payment outcome first. If the bank declined it or the payment expired, the order will be cancelled.",
            )}
          </p>
        )}
        {blocked && (
          <Link
            className="btn secondary"
            to={`${location.pathname}?${support}`}
          >
            {t(
              "Обратиться в поддержку",
              "Қолдау қызметіне хабарласу",
              "Contact support",
            )}
          </Link>
        )}
      </div>
    );
  return (
    <div
      className="billing-cancel-confirm stack"
      role="group"
      aria-labelledby={id}
    >
      <strong id={id}>
        {t("Отменить заказ", "Тапсырыстан бас тарту", "Cancel order")}{" "}
        {orderNumber}?
      </strong>
      <p>
        {t(
          "Действующий тариф сохранится. Отменяется только этот неоплаченный заказ. Если вы уже перечислили деньги, сначала обратитесь в поддержку.",
          "Қолданыстағы тариф сақталады. Тек осы төленбеген тапсырыс жойылады. Ақша аударып қойған болсаңыз, алдымен қолдау қызметіне хабарласыңыз.",
          "Your current plan stays active. Only this unpaid order will be cancelled. If you already transferred money, contact support first.",
        )}
      </p>
      <div className="actions">
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          {t("Оставить заказ", "Тапсырысты қалдыру", "Keep order")}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            await onCancel();
            setConfirming(false);
          }}
        >
          {busy
            ? blocked
              ? t(
                  "Проверяем оплату…",
                  "Төлемді тексеріп жатырмыз…",
                  "Checking payment…",
                )
              : t("Отменяем…", "Бас тартылуда…", "Cancelling…")
            : t("Да, отменить заказ", "Иә, бас тарту", "Yes, cancel order")}
        </button>
      </div>
    </div>
  );
}
