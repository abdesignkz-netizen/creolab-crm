import { CancelBillingOrder } from "./CancelBillingOrder";
import { InlineFeedback } from "./InlineFeedback";
import { notifySaved } from "./SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import {
  useBillingText,
  useBillingError,
  BillingStatus,
  billingMoney,
  billingDate,
  downloadBillingInvoice,
} from "./BillingCheckoutUi";

export function BillingHistory({
  showHistory,
  onPendingOrder,
}: {
  showHistory: boolean;
  onPendingOrder: (id: string | null) => void;
}) {
  const t = useBillingText(),
    errorText = useBillingError();
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
  useEffect(() => {
    if (data)
      onPendingOrder(
        data.orders.find((o: any) => o.status === "PENDING_PAYMENT")?.id ||
          null,
      );
  }, [data, onPendingOrder]);
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
    setError("");
    try {
      await fn();
      await load();
    } catch (error) {
      await load();
      setError(errorText(error));
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
    <section
      className="billing-payments stack"
      aria-label={t(
        "Заказы и платежи",
        "Тапсырыстар мен төлемдер",
        "Orders and payments",
      )}
    >
      {error && <InlineFeedback className="error">{error}</InlineFeedback>}
      {!data && !error && (
        <p role="status">
          {t("Загружаем платежи…", "Төлемдер жүктелуде…", "Loading payments…")}
        </p>
      )}
      {data && (
        <>
          {data.subscription &&
            ["past_due", "grace_period", "suspended", "expired"].includes(
              data.subscription.status,
            ) && (
              <div className="billing-warning">
                {t(
                  "Для продолжения работы оплатите подписку. Данные компании сохранены.",
                  "Жұмысты жалғастыру үшін жазылым ақысын төлеңіз. Компания деректері сақталған.",
                  "Pay your subscription to continue. Your company data is preserved.",
                )}
                {data.subscription.gracePeriodEndsAt &&
                  ` ${t("Оплатить до", "Төлем мерзімі", "Pay by")} ${billingDate(data.subscription.gracePeriodEndsAt)}`}
              </div>
            )}
          {data.orders.some((o: any) => o.status === "PENDING_PAYMENT") && (
            <h3 id="billing-orders">
              {t("Требует внимания", "Назар аудару қажет", "Needs attention")}
            </h3>
          )}
          {data.orders
            .filter((o: any) => o.status === "PENDING_PAYMENT")
            .map((o: any) => {
              const blocked = data.payments.some(
                (p: any) =>
                  p.orderId === o.id &&
                  p.method === "CARD" &&
                  p.status === "PROCESSING",
              );
              return (
                <div key={o.id} className="panel billing-open-order stack">
                  <div className="billing-checkout-head">
                    <strong>
                      {o.orderNumber} · {planName(o)}
                    </strong>
                    <strong>{billingMoney(o.amountMinor)}</strong>
                  </div>
                  <BillingStatus status={blocked ? "PROCESSING" : o.status} />
                  <p className="muted">
                    {blocked
                      ? t(
                          "Результат оплаты ещё не подтверждён. Проверьте статус этого заказа.",
                          "Төлем нәтижесі әлі расталмады. Осы тапсырыстың мәртебесін тексеріңіз.",
                          "Payment is not confirmed yet. Check this order’s status.",
                        )
                      : t(
                          "Заказ создан, но ещё не оплачен. Продолжите оплату или отмените заказ.",
                          "Тапсырыс жасалды, бірақ әлі төленбеген. Төлемді жалғастырыңыз немесе тапсырысты жойыңыз.",
                          "This order is unpaid. Continue checkout or cancel it.",
                        )}
                  </p>
                  <div className="actions">
                    <Link className="btn" to={`/billing/checkout/${o.id}`}>
                      {blocked
                        ? t(
                            "Открыть и проверить оплату",
                            "Ашу және төлемді тексеру",
                            "Open and check payment",
                          )
                        : t(
                            "Продолжить оплату",
                            "Төлемді жалғастыру",
                            "Continue checkout",
                          )}
                    </Link>
                  </div>
                  <CancelBillingOrder
                    blocked={blocked}
                    busy={busy}
                    orderNumber={o.orderNumber}
                    onCancel={() =>
                      action(async () => {
                        await api.billingCancelOrder(o.id);
                        notifySaved(
                          t(
                            "Заказ отменён. Действующий тариф сохранён.",
                            "Тапсырыс жойылды. Қолданыстағы тариф сақталды.",
                            "Order cancelled. Your current plan is unchanged.",
                          ),
                        );
                      })
                    }
                  />
                </div>
              );
            })}

          {showHistory && (
            <section className="panel stack billing-history-panel">
              {data.subscription && (
                <details className="billing-details">
                  <summary>
                    {t(
                      "Настройки продления",
                      "Ұзарту параметрлері",
                      "Renewal settings",
                    )}
                  </summary>
                  <p>
                    {t("Автопродление", "Автоматты ұзарту", "Auto-renewal")}:{" "}
                    {data.subscription.autoRenew
                      ? t("Включено", "Қосулы", "On")
                      : t("Выключено", "Өшірулі", "Off")}
                  </p>
                  {data.subscription.autoRenew && (
                    <button
                      className="btn secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(() => api.billingCancelRenewal())
                      }
                    >
                      {t(
                        "Отключить автопродление",
                        "Автоматты ұзартуды өшіру",
                        "Turn off auto-renewal",
                      )}
                    </button>
                  )}
                </details>
              )}
              <h3>
                {t("История платежей", "Төлем тарихы", "Payment history")}
              </h3>
              {!data.payments.length ? (
                <p className="muted">
                  {t(
                    "Платежей пока нет",
                    "Төлемдер әлі жоқ",
                    "No payments yet",
                  )}
                </p>
              ) : (
                <div className="billing-payment-list">
                  {data.payments.map((p: any) => {
                    const o = data.orders.find((x: any) => x.id === p.orderId);
                    const inv = data.invoices.find(
                      (x: any) => x.orderId === p.orderId,
                    );
                    return (
                      <article key={p.id} className="billing-payment-row">
                        <div className="billing-payment-description">
                          <strong>
                            {o
                              ? planName(o)
                              : t(
                                  "Прежний платёж",
                                  "Бұрынғы төлем",
                                  "Earlier payment",
                                )}
                          </strong>
                          <span className="muted">
                            {billingDate(p.paidAt || p.createdAt)} ·{" "}
                            {method(p.method)}
                            {o ? ` · ${period(o.billingPeriod)}` : ""}
                          </span>
                          {o && (
                            <Link to={`/billing/checkout/${o.id}`}>
                              {inv?.invoiceNumber || o.orderNumber}
                            </Link>
                          )}
                        </div>
                        <div className="billing-payment-amount">
                          <strong>{billingMoney(p.amountMinor)}</strong>
                          <BillingStatus status={p.status} />
                        </div>
                        <div className="actions">
                          {inv && (
                            <button
                              className="btn secondary"
                              disabled={busy}
                              onClick={() =>
                                void action(() =>
                                  downloadBillingInvoice(inv.id),
                                )
                              }
                            >
                              {t(
                                "Скачать счёт",
                                "Шотты жүктеу",
                                "Download invoice",
                              )}{" "}
                              · PDF
                            </button>
                          )}
                          {o?.status === "PENDING_PAYMENT" && (
                            <Link
                              className="btn secondary"
                              to={`/billing/checkout/${o.id}`}
                            >
                              {t(
                                "Открыть заказ",
                                "Тапсырысты ашу",
                                "Open order",
                              )}
                            </Link>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
