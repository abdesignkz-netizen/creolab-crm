import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import {
  useBillingText,
  BillingStatus,
  billingMoney,
  billingDate,
  downloadBillingInvoice,
} from "./BillingCheckoutUi";

export function BillingHistory({ onPay }: { onPay: () => void }) {
  const t = useBillingText();
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setData(await api.billingHistory());
      setError("");
    } catch {
      setError(
        t(
          "История оплаты доступна владельцу и директору компании. Если у вас есть эти права, обновите страницу.",
          "Төлем тарихы компания иесі мен директорына қолжетімді. Бұл құқықтарыңыз болса, бетті жаңартыңыз.",
          "Billing history is available to owners and directors. If you have access, refresh this page.",
        ),
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const method = (m: string) =>
    ({
      CARD: t("Карта", "Карта", "Card"),
      KASPI: "Kaspi",
      BANK_TRANSFER: t("Банковский перевод", "Банк аударымы", "Bank transfer"),
      MANUAL: t("По согласованию", "Келісім бойынша", "Manual"),
      FREE: t("Бесплатно", "Тегін", "Free"),
    })[m] || "—";
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch {
      setError(
        t(
          "Не удалось выполнить действие. Обновите страницу и проверьте состояние оплаты.",
          "Әрекетті орындау мүмкін болмады. Бетті жаңартып, төлем күйін тексеріңіз.",
          "Unable to complete the action. Refresh and check the payment status.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const period = (p: string) =>
    p === "YEARLY" ? t("Год", "Жыл", "Year") : t("Месяц", "Ай", "Month");
  const planName = (o: any) =>
    o?.snapshotJson?.lines?.find((l: any) => l.code === o.planCode)?.name ||
    "—";
  return (
    <section className="panel stack">
      {error && <p role="alert">{error}</p>}
      {!data && !error && (
        <p role="status">
          {t("Загружаем платежи…", "Төлемдер жүктелуде…", "Loading payments…")}
        </p>
      )}
      {data && (
        <>
          <div className="billing-checkout-head">
            <h3>
              {t(
                "Подписка и платежи",
                "Жазылым және төлемдер",
                "Subscription & payments",
              )}
            </h3>
            {data.subscription && (
              <BillingStatus status={data.subscription.status} />
            )}
          </div>
          {data.subscription && (
            <>
              <p>
                {billingMoney(data.subscription.amountMinor || 0)} /{" "}
                {period(data.subscription.billingPeriod)} ·{" "}
                {method(data.subscription.paymentMethod)}
              </p>
              <p>
                {t(
                  "Следующая дата оплаты",
                  "Келесі төлем күні",
                  "Next payment date",
                )}
                : {billingDate(data.subscription.endsAt)} ·{" "}
                {t("Автопродление", "Автоматты ұзарту", "Auto-renewal")}:{" "}
                {data.subscription.autoRenew
                  ? t("Включено", "Қосулы", "On")
                  : t("Выключено", "Өшірулі", "Off")}
              </p>
              {["past_due", "grace_period", "suspended", "expired"].includes(
                data.subscription.status,
              ) && (
                <div className="billing-warning">
                  {t(
                    "Для продолжения работы оплатите подписку. Данные компании сохранены.",
                    "Жұмысты жалғастыру үшін жазылым ақысын төлеңіз. Компания деректері сақталған.",
                    "Pay your subscription to continue. Your company data is preserved.",
                  )}{" "}
                  {data.subscription.gracePeriodEndsAt &&
                    `${t("Оплатить до", "Төлем мерзімі", "Pay by")} ${billingDate(data.subscription.gracePeriodEndsAt)}`}
                </div>
              )}
              {data.subscription.autoRenew && (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => void action(() => api.billingCancelRenewal())}
                >
                  {t(
                    "Отключить автопродление",
                    "Автоматты ұзартуды өшіру",
                    "Turn off auto-renewal",
                  )}
                </button>
              )}
              <button className="btn" disabled={busy} onClick={onPay}>
                {t(
                  "Оплатить / изменить способ оплаты",
                  "Төлеу / төлем тәсілін өзгерту",
                  "Pay / change payment method",
                )}
              </button>
              <p className="muted">
                {t(
                  "Способ оплаты выбирается перед новым платежом. Списаний без подтверждения не будет.",
                  "Төлем тәсілі жаңа төлем алдында таңдалады. Растаусыз ақша алынбайды.",
                  "Choose the method before your new payment. This button does not charge you.",
                )}
              </p>
            </>
          )}
          <h3>{t("Заказы", "Тапсырыстар", "Orders")}</h3>
          {!data.orders.some((o: any) => o.status === "PENDING_PAYMENT") && (
            <p className="muted">
              {t(
                "Неоплаченных заказов нет",
                "Төленбеген тапсырыстар жоқ",
                "No unpaid orders",
              )}
            </p>
          )}
          {data.orders
            .filter((o: any) => o.status === "PENDING_PAYMENT")
            .map((o: any) => (
              <Link
                key={o.id}
                className="btn secondary"
                to={`/billing/checkout/${o.id}`}
              >
                {t(
                  "Продолжить оплату",
                  "Төлемді жалғастыру",
                  "Continue checkout",
                )}{" "}
                · {o.orderNumber} · {billingMoney(o.amountMinor)}
              </Link>
            ))}
          <h3>{t("История платежей", "Төлем тарихы", "Payment history")}</h3>
          {!data.payments.length ? (
            <p className="muted">
              {t("Платежей пока нет", "Төлемдер әлі жоқ", "No payments yet")}
            </p>
          ) : (
            <div className="billing-table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      t("Дата", "Күні", "Date"),
                      t("Документ / тариф", "Құжат / тариф", "Document / plan"),
                      t("Период", "Кезең", "Period"),
                      t("Сумма", "Сома", "Amount"),
                      t("Способ оплаты", "Төлем тәсілі", "Method"),
                      t("Статус", "Мәртебе", "Status"),
                      "PDF",
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((p: any) => {
                    const o = data.orders.find((x: any) => x.id === p.orderId),
                      inv = data.invoices.find(
                        (x: any) => x.orderId === p.orderId,
                      );
                    return (
                      <tr key={p.id}>
                        <td>{billingDate(p.paidAt || p.createdAt)}</td>
                        <td>
                          {o ? (
                            <Link to={`/billing/checkout/${o.id}`}>
                              {inv?.invoiceNumber || o.orderNumber}
                            </Link>
                          ) : (
                            t(
                              "Прежний платёж",
                              "Бұрынғы төлем",
                              "Earlier payment",
                            )
                          )}
                          <small className="billing-block muted">
                            {planName(o)}
                          </small>
                        </td>
                        <td>{o ? period(o.billingPeriod) : "—"}</td>
                        <td>{billingMoney(p.amountMinor)}</td>
                        <td>{method(p.method)}</td>
                        <td>
                          <BillingStatus status={p.status} />
                        </td>
                        <td>
                          {inv ? (
                            <button
                              className="btn secondary"
                              onClick={() =>
                                void action(() =>
                                  downloadBillingInvoice(inv.id),
                                )
                              }
                            >
                              PDF
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
