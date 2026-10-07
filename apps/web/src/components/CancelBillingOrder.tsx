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
  if (blocked)
    return (
      <div className="billing-cancel stack">
        <button className="btn secondary" disabled aria-describedby={id}>
          {t("Отменить заказ", "Тапсырыстан бас тарту", "Cancel order")}
        </button>
        <p id={id} className="muted">
          {t(
            "Отмена временно недоступна: результат оплаты картой ещё не подтверждён. Если страница оплаты не открылась или проверка зависла, администратор должен сверить попытку и разблокировать заказ. После этого здесь появится возможность отмены.",
            "Бас тарту уақытша қолжетімсіз: карта төлемінің нәтижесі әлі расталмады. Төлем беті ашылмаса немесе тексеру тоқтап қалса, әкімші әрекетті тексеріп, тапсырыстың бұғатын ашуы керек. Содан кейін осы жерде бас тартуға болады.",
            "Cancellation is temporarily unavailable while the card payment outcome is unconfirmed. If checkout never opened or verification is stuck, an administrator must reconcile the attempt and release the order. Cancellation will then become available here.",
          )}
        </p>
        <Link className="btn secondary" to={`${location.pathname}?${support}`}>
          {t(
            "Обратиться в поддержку",
            "Қолдау қызметіне хабарласу",
            "Contact support",
          )}
        </Link>
      </div>
    );
  if (!confirming)
    return (
      <button
        className="btn secondary"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        {t("Отменить заказ", "Тапсырыстан бас тарту", "Cancel order")}
      </button>
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
            ? t("Отменяем…", "Бас тартылуда…", "Cancelling…")
            : t("Да, отменить заказ", "Иә, бас тарту", "Yes, cancel order")}
        </button>
      </div>
    </div>
  );
}
