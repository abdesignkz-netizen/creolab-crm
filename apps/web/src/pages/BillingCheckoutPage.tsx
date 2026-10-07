import { CancelBillingOrder } from "../components/CancelBillingOrder";
import { InlineFeedback } from "../components/InlineFeedback";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  useBillingText,
  BillingStatus,
  billingMoney,
  billingDate,
  downloadBillingInvoice,
  BuyerForm,
  useBillingError,
} from "../components/BillingCheckoutUi";

export function BillingCheckoutPage() {
  const { orderId = "" } = useParams(),
    [search] = useSearchParams(),
    t = useBillingText(),
    errorText = useBillingError();
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [method, setMethod] = useState(""),
    [autoRenew, setAutoRenew] = useState(false),
    [buyer, setBuyer] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState(""),
    [qr, setQr] = useState("");
  async function load() {
    try {
      const d = await api.billingOrder(orderId);
      setData(d);
      return d;
    } catch {
      setError(
        t(
          "Не удалось загрузить оплату. Повторите попытку.",
          "Төлемді жүктеу мүмкін болмады. Қайталап көріңіз.",
          "Unable to load payment. Please retry.",
        ),
      );
    }
  }
  useEffect(() => {
    let stopped = false;
    api
      .billingOrder(orderId)
      .then((d) => {
        if (!stopped) {
          setData(d);
          setBuyer({ ...d.buyer, bin: d.buyer?.bin || d.buyer?.iin || "" });
        }
      })
      .catch(() => {
        if (!stopped)
          setError(
            t("Заказ недоступен", "Тапсырыс қолжетімсіз", "Order unavailable"),
          );
      });
    return () => {
      stopped = true;
    };
  }, [orderId]);
  useEffect(() => {
    if (
      !data ||
      data.order.status !== "PENDING_PAYMENT" ||
      (!search.has("return") &&
        !data.payments.some((p: any) => p.status === "PROCESSING"))
    )
      return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [
    data?.order.status,
    data?.payments.some((p: any) => p.status === "PROCESSING"),
    orderId,
    search.toString(),
  ]);
  const kaspiLink = data?.payments.find(
    (p: any) => p.method === "KASPI" && p.status === "PENDING",
  )?.checkoutUrl;
  useEffect(() => {
    if (!kaspiLink) {
      setQr("");
      return;
    }
    let active = true;
    api
      .billingKaspiQr(orderId)
      .then((v) => {
        if (active) setQr(v.image);
      })
      .catch(() => {
        if (active) setQr("");
      });
    return () => {
      active = false;
    };
  }, [kaspiLink, orderId]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      await load();
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function checkPayment() {
    await action(async () => {
      const r = await api.billingCheckOrder(orderId);
      const messages: Record<string, [string, string, string]> = {
        paid: ["Оплата подтверждена.", "Төлем расталды.", "Payment confirmed."],
        success: [
          "Банк подтвердил оплату. Ожидаем уведомление для активации подписки. Повторно платить не нужно.",
          "Банк төлемді растады. Жазылымды іске қосу үшін хабарламаны күтеміз. Қайта төлемеңіз.",
          "The bank confirmed payment. Awaiting its activation callback. Do not pay again.",
        ],
        not_found: [
          "В текущем магазине Freedom Pay платёж не найден. Администратору нужно сверить старую попытку и разблокировать заказ в разделе платежей.",
          "Қазіргі Freedom Pay дүкенінде төлем табылмады. Әкімші ескі әрекетті тексеріп, төлемдер бөлімінде тапсырыстың бұғатын ашуы керек.",
          "Payment was not found in the current Freedom Pay merchant. An administrator must reconcile the old attempt and release the order in Payments.",
        ],
        failed: [
          "Банк сообщает об отклонении платежа. Администратору нужно запросить повторное уведомление Freedom Pay.",
          "Банк төлемнің қабылданбағанын хабарлады. Әкімші Freedom Pay хабарламасын қайта жіберуді сұрауы керек.",
          "The bank reports a failed payment. An administrator must request a Freedom Pay callback replay.",
        ],
        pending: [
          "Проверено: банк ещё обрабатывает платёж. Повторно платить не нужно.",
          "Тексерілді: банк төлемді әлі өңдеп жатыр. Қайта төлемеңіз.",
          "Checked: the bank is still processing the payment. Do not pay again.",
        ],
        incomplete: [
          "Оплата в банке не завершена. Если деньги не списаны, откройте страницу оплаты по ссылке ниже.",
          "Банктегі төлем аяқталмады. Ақша алынбаса, төмендегі сілтеме арқылы төлем бетін ашыңыз.",
          "Payment is incomplete. If you were not charged, open the payment page below.",
        ],
        manual_pending: [
          "Подтверждение поступления пока не внесено. Ожидаем сверку администратором.",
          "Ақшаның түскені әлі расталмады. Әкімшінің тексеруін күтеміз.",
          "Receipt has not been confirmed yet. Awaiting administrator reconciliation.",
        ],
        no_attempt: [
          "Активной попытки нет. Выберите способ оплаты.",
          "Белсенді төлем әрекеті жоқ. Төлем тәсілін таңдаңыз.",
          "No active attempt. Choose a payment method.",
        ],
      };
      setNotice(
        t(
          ...(messages[r.status] || [
            "Статус требует сверки с Freedom Pay. Обратитесь к администратору.",
            "Мәртебені Freedom Pay арқылы тексеру қажет. Әкімшіге хабарласыңыз.",
            "The status needs reconciliation with Freedom Pay. Contact an administrator.",
          ]),
        ),
      );
    });
  }
  async function pay(chosen: string) {
    await action(async () => {
      const d = await api.billingPay({
        orderId,
        method: chosen,
        autoRenew,
        buyer: chosen === "BANK_TRANSFER" ? buyer : undefined,
      });
      setData(d);
      const p = d.payments.find((x: any) =>
        ["PROCESSING", "PENDING"].includes(x.status),
      );
      if (chosen === "CARD" && p?.checkoutUrl)
        window.location.assign(p.checkoutUrl);
    });
  }
  if (!data)
    return (
      <section className="billing-checkout">
        <h2>
          {t(
            "Оплата подписки",
            "Жазылым ақысын төлеу",
            "Subscription checkout",
          )}
        </h2>
        <p role="status">{error || t("Загрузка…", "Жүктелуде…", "Loading…")}</p>
        {error && (
          <button className="btn" onClick={() => void load()}>
            {t("Повторить", "Қайталау", "Retry")}
          </button>
        )}
      </section>
    );
  const { order, invoice, methods } = data,
    paid = order.status === "PAID",
    open =
      order.status === "PENDING_PAYMENT" &&
      new Date(order.expiresAt) > new Date(),
    payment = data.payments.find((p: any) =>
      ["PENDING", "PROCESSING"].includes(p.status),
    );
  return (
    <section className="billing-checkout stack">
      <Link to="/billing">
        ← {t("Тариф и оплата", "Тариф және төлем", "Plan & billing")}
      </Link>
      <div className="billing-checkout-head">
        <div>
          <span className="muted">{order.orderNumber}</span>
          <h1>
            {t(
              "Оплата подписки BasQar",
              "BasQar жазылымын төлеу",
              "BasQar subscription",
            )}
          </h1>
          <p>
            {order.snapshotJson?.lines?.find(
              (l: any) => l.code === order.planCode,
            )?.name || order.planCode}
          </p>
        </div>
        <div>
          <strong className="billing-total">
            {billingMoney(order.amountMinor)}
          </strong>
          <p>
            {order.billingPeriod === "YEARLY"
              ? t("за год", "бір жылға", "per year")
              : t("за месяц", "бір айға", "per month")}
          </p>
          <BillingStatus status={order.status} />
        </div>
      </div>
      {error && (
        <InlineFeedback kind="error" className="error">
          {error}
        </InlineFeedback>
      )}
      {notice && (
        <InlineFeedback kind="info" className="billing-notice">
          {notice}
        </InlineFeedback>
      )}
      {open &&
        !payment &&
        data.payments[0]?.failureReason === "provider_credentials" &&
        !error && (
          <p className="billing-warning" role="alert">
            {errorText({ code: "provider_credentials" })}
          </p>
        )}
      {paid ? (
        <div className="billing-success" role="status">
          <h2>
            ✓ {t("Оплата подтверждена", "Төлем расталды", "Payment confirmed")}
          </h2>
          <p>
            {order.effectiveAt && new Date(order.effectiveAt) > new Date()
              ? t(
                  "Новый тариф начнёт действовать",
                  "Жаңа тариф күшіне енеді",
                  "Your new plan starts",
                ) +
                " " +
                billingDate(order.effectiveAt)
              : t(
                  "Подписка активирована. Можно продолжать работу.",
                  "Жазылым іске қосылды. Жұмысты жалғастыра аласыз.",
                  "Your subscription is active. You can continue working.",
                )}
          </p>
          {data.subscription?.endsAt && (
            <p>
              {t(
                "Следующая дата оплаты",
                "Келесі төлем күні",
                "Next payment date",
              )}
              : {billingDate(data.subscription.endsAt)}
            </p>
          )}
          <a className="btn" href="/">
            {t("Вернуться в BasQar", "BasQar-ға оралу", "Return to BasQar")}
          </a>
        </div>
      ) : !open ? (
        <p role="status">
          {t(
            "Этот заказ закрыт или срок оплаты истёк. Создайте новый заказ в разделе тарифов.",
            "Бұл тапсырыс жабылды немесе төлем мерзімі аяқталды. Тарифтер бөлімінде жаңа тапсырыс жасаңыз.",
            "This order is closed or expired. Create a new order from plans.",
          )}
        </p>
      ) : (
        <>
          {!payment && (
            <>
              <h2>
                {t(
                  "Выберите способ оплаты",
                  "Төлем тәсілін таңдаңыз",
                  "Choose how to pay",
                )}
              </h2>
              <div className="billing-method-grid">
                {[
                  {
                    id: "CARD",
                    icon: "▣",
                    name: t("Банковская карта", "Банк картасы", "Bank card"),
                    text: "Visa / Mastercard",
                    help: t(
                      "Активация после подтверждения банком",
                      "Банк растағаннан кейін іске қосылады",
                      "Activated after bank confirmation",
                    ),
                    enabled: methods.card,
                  },
                  {
                    id: "KASPI",
                    icon: "K",
                    name: "Kaspi",
                    text: t(
                      "Через приложение Kaspi.kz",
                      "Kaspi.kz қосымшасы арқылы",
                      "Using the Kaspi.kz app",
                    ),
                    help: t(
                      "Оплату проверяет администратор",
                      "Төлемді әкімші тексереді",
                      "Payment verified by an administrator",
                    ),
                    enabled: methods.kaspi,
                  },
                  {
                    id: "BANK_TRANSFER",
                    icon: "▤",
                    name: t(
                      "Счёт на компанию",
                      "Компанияға шот",
                      "Company invoice",
                    ),
                    text: t(
                      "Для ИП и ТОО",
                      "ЖК және ЖШС үшін",
                      "For businesses",
                    ),
                    help: t(
                      "PDF-счёт для бухгалтерии",
                      "Бухгалтерияға арналған PDF-шот",
                      "PDF invoice for accounting",
                    ),
                    enabled: methods.bankTransfer,
                  },
                ].map((m) => (
                  <button
                    key={m.id}
                    disabled={!m.enabled || busy}
                    className={`billing-method ${method === m.id ? "selected" : ""}`}
                    aria-pressed={method === m.id}
                    onClick={() => setMethod(m.id)}
                  >
                    <span className="billing-method-icon" aria-hidden="true">
                      {m.icon}
                    </span>
                    <strong>{m.name}</strong>
                    <span>{m.text}</span>
                    <small>
                      {m.enabled
                        ? m.help
                        : t(
                            "Скоро будет доступно",
                            "Жақында қолжетімді болады",
                            "Not available yet",
                          )}
                    </small>
                  </button>
                ))}
              </div>
              {method === "CARD" && (
                <div className="panel stack">
                  {methods.recurring && (
                    <label className="billing-consent">
                      <input
                        type="checkbox"
                        checked={autoRenew}
                        onChange={(e) => setAutoRenew(e.target.checked)}
                      />
                      {t(
                        "Разрешаю автоматически списывать стоимость подписки каждый период. Можно отключить в любой момент.",
                        "Әр кезеңде жазылым ақысын автоматты түрде алуға келісемін. Кез келген уақытта өшіруге болады.",
                        "I authorize automatic subscription payments each period. I can turn this off at any time.",
                      )}
                    </label>
                  )}
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void pay("CARD")}
                  >
                    {t("Оплатить картой", "Картамен төлеу", "Pay by card")} ·{" "}
                    {billingMoney(order.amountMinor)}
                  </button>
                </div>
              )}
              {method === "KASPI" && (
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void pay("KASPI")}
                >
                  {t("Выбрать Kaspi", "Kaspi таңдау", "Choose Kaspi")}
                </button>
              )}
              {method === "BANK_TRANSFER" && (
                <form
                  className="panel stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void pay("BANK_TRANSFER");
                  }}
                >
                  <h3>
                    {t(
                      "Реквизиты покупателя",
                      "Сатып алушының деректемелері",
                      "Buyer details",
                    )}
                  </h3>
                  <BuyerForm buyer={buyer} setBuyer={setBuyer} />
                  <button className="btn" disabled={busy}>
                    {t("Получить счёт", "Шот алу", "Get invoice")}
                  </button>
                </form>
              )}
            </>
          )}
          {payment && (
            <div className="panel stack">
              {payment.method === "CARD" && !payment.checkoutUrl ? (
                <p className="billing-warning" role="status">
                  {t(
                    "Не удалось получить ссылку на оплату. Требуется проверка платёжного сервиса администратором. Если вы уже платили, не повторяйте оплату до сверки.",
                    "Төлем сілтемесін алу мүмкін болмады. Әкімші төлем сервисін тексеруі керек. Төлеп қойған болсаңыз, тексеру аяқталғанша қайта төлемеңіз.",
                    "The payment link is unavailable. An administrator needs to check the payment service. If you have paid, wait for verification before paying again.",
                  )}
                </p>
              ) : (
                <BillingStatus status={payment.status} />
              )}
              <p>
                {payment.method === "KASPI"
                  ? t(
                      "Администратор подготовит отдельную ссылку Kaspi для этого заказа. После оплаты проверит поступление.",
                      "Әкімші осы тапсырысқа жеке Kaspi сілтемесін дайындайды. Төлемнен кейін ақшаның түскенін тексереді.",
                      "An administrator will provide a Kaspi link for this order and verify your payment.",
                    )
                  : payment.method === "CARD"
                    ? payment.checkoutUrl
                      ? t(
                          "Ждём подтверждение от платёжного сервиса. Повторно платить не нужно.",
                          "Төлем сервисінің растауын күтіп отырмыз. Қайта төлеудің қажеті жоқ.",
                          "Waiting for confirmation. Please do not pay again.",
                        )
                      : ""
                    : t(
                        "Переведите сумму по реквизитам в счёте. Подписка включится после подтверждения поступления.",
                        "Шоттағы деректемелер бойынша төлеңіз. Ақшаның түскені расталғаннан кейін жазылым іске қосылады.",
                        "Pay using the invoice details. Your subscription activates after receipt is confirmed.",
                      )}
              </p>
              {qr && payment.method === "KASPI" && (
                <img
                  className="billing-kaspi-qr"
                  src={qr}
                  alt={t(
                    "QR для оплаты заказа в Kaspi",
                    "Тапсырысты Kaspi арқылы төлеуге арналған QR",
                    "Kaspi QR for this order",
                  )}
                  width={256}
                  height={256}
                />
              )}{" "}
              {payment.checkoutUrl && (
                <a className="btn" href={payment.checkoutUrl} rel="noreferrer">
                  {payment.method === "KASPI"
                    ? t("Открыть Kaspi", "Kaspi ашу", "Open Kaspi")
                    : t(
                        "Открыть страницу оплаты",
                        "Төлем бетін ашу",
                        "Open payment page",
                      )}
                </a>
              )}
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => void checkPayment()}
                aria-busy={busy}
              >
                {busy
                  ? t(
                      "Проверяем в банке…",
                      "Банкте тексерілуде…",
                      "Checking with bank…",
                    )
                  : t("Проверить оплату", "Төлемді тексеру", "Check payment")}
              </button>
            </div>
          )}
          <p className="muted">
            {t(
              "Безопасная оплата. BasQar не хранит данные банковских карт.",
              "Қауіпсіз төлем. BasQar банк карталарының деректерін сақтамайды.",
              "Secure payment. BasQar does not store card details.",
            )}
          </p>
        </>
      )}
      {order.status === "PENDING_PAYMENT" && (
        <CancelBillingOrder
          blocked={
            payment?.method === "CARD" && payment?.status === "PROCESSING"
          }
          busy={busy}
          orderNumber={order.orderNumber}
          onCancel={() => action(() => api.billingCancelOrder(orderId))}
        />
      )}
      {invoice && (
        <div className="panel stack">
          <h2>
            {t("Счёт", "Шот", "Invoice")} № {invoice.invoiceNumber}
          </h2>
          <p>
            {billingMoney(invoice.amountMinor)} ·{" "}
            {t("Оплатить до", "Төлем мерзімі", "Due")}{" "}
            {billingDate(invoice.dueDate)}
          </p>
          <BillingStatus status={invoice.status} />
          <div className="actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void action(() => downloadBillingInvoice(invoice.id))
              }
            >
              {t("Скачать PDF", "PDF жүктеп алу", "Download PDF")}
            </button>
            <button
              className="btn secondary"
              disabled={
                busy || ["CANCELLED", "EXPIRED"].includes(invoice.status)
              }
              onClick={() =>
                void action(async () => {
                  await api.billingEmailInvoice(invoice.id);
                  setNotice(
                    t(
                      "Письмо поставлено в очередь отправки",
                      "Хат жіберу кезегіне қойылды",
                      "Email queued for delivery",
                    ),
                  );
                })
              }
            >
              {t("Отправить на email", "Email-ге жіберу", "Email invoice")}
            </button>
            <button
              className="btn secondary"
              disabled={["CANCELLED", "EXPIRED"].includes(invoice.status)}
              onClick={() =>
                void action(async () => {
                  const s = invoice.sellerJson;
                  await navigator.clipboard.writeText(
                    `${s.legalName}\n${s.bin}\n${s.iban}\n${s.bankName}\n${s.bik}\n${invoice.invoiceNumber}`,
                  );
                  setNotice(
                    t(
                      "Реквизиты скопированы",
                      "Деректемелер көшірілді",
                      "Details copied",
                    ),
                  );
                })
              }
            >
              {t(
                "Скопировать реквизиты",
                "Деректемелерді көшіру",
                "Copy bank details",
              )}
            </button>
          </div>
        </div>
      )}
      {paid && !invoice && data.seller && (
        <form
          className="panel stack"
          onSubmit={(e) => {
            e.preventDefault();
            void action(() => api.billingDocument(orderId, buyer));
          }}
        >
          <h3>
            {t(
              "Получить документ для компании",
              "Компанияға құжат алу",
              "Get a company document",
            )}
          </h3>
          <BuyerForm buyer={buyer} setBuyer={setBuyer} />
          <button className="btn" disabled={busy}>
            {t("Сформировать счёт", "Шот дайындау", "Generate invoice")}
          </button>
        </form>
      )}
    </section>
  );
}
