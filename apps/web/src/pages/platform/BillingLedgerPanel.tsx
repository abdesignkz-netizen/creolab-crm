import { useEffect, useState, useRef } from "react";
import { api } from "../../lib/api";
import {
  useBillingText,
  BillingStatus,
  BillingField,
  billingMoney,
  billingDate,
  downloadBillingInvoice,
} from "../../components/BillingCheckoutUi";

type Tab = "payments" | "subscriptions" | "invoices" | "plans" | "seller";
export function BillingLedgerPanel() {
  const t = useBillingText(),
    [data, setData] = useState<any>(null),
    [tab, setTab] = useState<Tab>("payments"),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<any>(null),
    [modal, setModal] = useState(""),
    [form, setForm] = useState<Record<string, any>>({}),
    [seller, setSeller] = useState<Record<string, any>>({}),
    [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
  }, [selected]);
  async function load() {
    try {
      const d = await api.adminBillingLedger(status, page);
      setData(d);
      setSeller(
        d.seller || { invoicePrefix: "BSQ-INV", vatEnabled: false, vatRate: 0 },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }
  useEffect(() => {
    void load();
  }, [status, page]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setSelected(null);
      await load();
      setNotice(t("Сохранено", "Сақталды", "Saved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }
  function open(p: any, kind: string) {
    setSelected(p);
    setModal(kind);
    setForm(
      kind === "confirm"
        ? {
            amount: p.amountMinor,
            paidAt: new Date().toISOString().slice(0, 16),
            reference: "",
            comment: "",
          }
        : kind === "plan"
          ? { ...p }
          : { url: "", reference: "" },
    );
  }
  const name = (id: string) =>
    data?.tenants.find((x: any) => x.id === id)?.name || id;
  const labels: Record<Tab, string> = {
    payments: t("Платежи", "Төлемдер", "Payments"),
    subscriptions: t("Подписки", "Жазылымдар", "Subscriptions"),
    invoices: t("Счета", "Шоттар", "Invoices"),
    plans: t("Тарифы", "Тарифтер", "Plans"),
    seller: t("Реквизиты продавца", "Сатушы деректемелері", "Seller details"),
  };
  const field = (
    key: string,
    label: string,
    type = "text",
    obj = form,
    set = setForm,
  ) => (
    <BillingField key={key} label={label}>
      <input
        required={key !== "comment"}
        type={type}
        step={type === "number" ? "1" : undefined}
        min={type === "number" ? 0 : undefined}
        value={obj[key] ?? ""}
        onChange={(e) =>
          set({
            ...obj,
            [key]: type === "number" ? Number(e.target.value) : e.target.value,
          })
        }
      />
    </BillingField>
  );
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h2>
            {t("Тарифы и платежи", "Тарифтер мен төлемдер", "Plans & payments")}
          </h2>
          <p className="muted">
            {t(
              "Подписки, поступления и документы компаний",
              "Компаниялардың жазылымдары, төлемдері және құжаттары",
              "Company subscriptions, payments and documents",
            )}
          </p>
        </div>
        <button className="btn secondary" onClick={() => void load()}>
          {t("Обновить", "Жаңарту", "Refresh")}
        </button>
      </div>
      <nav className="billing-tabs">
        {(Object.keys(labels) as Tab[]).map((k) => (
          <button
            key={k}
            className={`btn ${tab === k ? "" : "secondary"}`}
            aria-pressed={tab === k}
            onClick={() => setTab(k)}
          >
            {labels[k]}
          </button>
        ))}
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data ? (
        <p>{t("Загрузка…", "Жүктелуде…", "Loading…")}</p>
      ) : (
        <div className="panel stack">
          {tab === "payments" && (
            <>
              <select
                aria-label={t("Статус", "Мәртебе", "Status")}
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                {[
                  ["", t("Все", "Барлығы", "All")],
                  ["PENDING", t("Ожидают оплаты", "Төлем күтілуде", "Pending")],
                  ["PROCESSING", t("Проверяются", "Тексерілуде", "Processing")],
                  ["PAID", t("Оплачены", "Төленді", "Paid")],
                  ["FAILED", t("Ошибка", "Қате", "Failed")],
                  ["REFUNDED", t("Возврат", "Қайтарым", "Refunded")],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <div className="billing-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        t("Дата", "Күні", "Date"),
                        t(
                          "Компания / БИН",
                          "Компания / БСН",
                          "Company / Tax ID",
                        ),
                        t("Тариф / Заказ", "Тариф / Тапсырыс", "Plan / Order"),
                        t("Сумма", "Сома", "Amount"),
                        t("Способ", "Тәсіл", "Method"),
                        "Provider",
                        t("Статус", "Мәртебе", "Status"),
                        "Payment ID",
                        t("Действия", "Әрекеттер", "Actions"),
                      ].map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((p: any) => {
                      const order = data.orders.find(
                          (o: any) => o.id === p.orderId,
                        ),
                        profile = data.profiles.find(
                          (x: any) => x.tenantId === p.tenantId,
                        );
                      return (
                        <tr key={p.id}>
                          <td>{billingDate(p.createdAt)}</td>
                          <td>
                            {name(p.tenantId)}
                            <small className="billing-block muted">
                              {profile?.bin || profile?.iin || "—"}
                            </small>
                          </td>
                          <td>
                            {order?.description || "—"}
                            <small className="billing-block">
                              {order?.orderNumber}
                            </small>
                          </td>
                          <td>{billingMoney(p.amountMinor)}</td>
                          <td>{p.method}</td>
                          <td>{p.provider}</td>
                          <td>
                            <BillingStatus status={p.status} />
                            {p.failureReason && (
                              <small className="billing-block">
                                {p.failureReason}
                              </small>
                            )}
                          </td>
                          <td>{p.id}</td>
                          <td>
                            {p.provider === "FREEDOM_PAY" && (
                              <button
                                className="btn secondary"
                                disabled={busy}
                                onClick={async () => {
                                  setBusy(true);
                                  setError("");
                                  try {
                                    const r = await api.adminBillingCheck(p.id);
                                    setNotice(
                                      t(
                                        "Статус в Freedom Pay: ",
                                        "Freedom Pay мәртебесі: ",
                                        "Freedom Pay status: ",
                                      ) +
                                        r.status +
                                        (r.requiresCallback
                                          ? t(
                                              ". Для подтверждения в BasQar запросите повторное уведомление в кабинете Freedom Pay.",
                                              ". BasQar-да растау үшін Freedom Pay кабинетінде хабарламаны қайта жіберуді сұраңыз.",
                                              ". Request a result callback replay in the Freedom Pay dashboard to confirm it in BasQar.",
                                            )
                                          : ""),
                                    );
                                  } catch {
                                    setError(
                                      t(
                                        "Не удалось проверить платёж. Проверьте его в кабинете Freedom Pay.",
                                        "Төлемді тексеру мүмкін болмады. Freedom Pay кабинетінде тексеріңіз.",
                                        "Unable to verify. Check the Freedom Pay dashboard.",
                                      ),
                                    );
                                  } finally {
                                    setBusy(false);
                                  }
                                }}
                              >
                                {t(
                                  "Проверить в банке",
                                  "Банкте тексеру",
                                  "Check with provider",
                                )}
                              </button>
                            )}
                            {p.status === "PENDING" &&
                              ["KASPI", "BANK_TRANSFER"].includes(
                                p.provider,
                              ) && (
                                <button
                                  className="btn"
                                  onClick={() => open(p, "confirm")}
                                >
                                  {t(
                                    "Подтвердить поступление",
                                    "Төлемді растау",
                                    "Confirm receipt",
                                  )}
                                </button>
                              )}
                            {p.status === "PENDING" &&
                              p.provider === "KASPI" && (
                                <button
                                  className="btn secondary"
                                  onClick={() => open(p, "kaspi")}
                                >
                                  {t(
                                    "Добавить ссылку Kaspi",
                                    "Kaspi сілтемесін қосу",
                                    "Add Kaspi link",
                                  )}
                                </button>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!data.payments.length && (
                  <p>{t("Платежей нет", "Төлемдер жоқ", "No payments")}</p>
                )}
              </div>
              <div className="actions">
                <button
                  className="btn secondary"
                  disabled={page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  ←
                </button>
                <span>
                  {page} / {Math.max(1, Math.ceil(data.total / 50))}
                </span>
                <button
                  className="btn secondary"
                  disabled={page * 50 >= data.total}
                  onClick={() => setPage(page + 1)}
                >
                  →
                </button>
              </div>
            </>
          )}
          {tab === "subscriptions" && (
            <div className="billing-table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      t("Компания", "Компания", "Company"),
                      t("Тариф", "Тариф", "Plan"),
                      t("Статус", "Мәртебе", "Status"),
                      t("Начало", "Басталуы", "Start"),
                      t("Следующая оплата", "Келесі төлем", "Next payment"),
                      t("Автопродление", "Автоматты ұзарту", "Auto-renewal"),
                      t("Способ оплаты", "Төлем тәсілі", "Method"),
                      t(
                        "Льготный период до",
                        "Жеңілдік кезеңінің соңы",
                        "Grace until",
                      ),
                    ].map((x) => (
                      <th key={x}>{x}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.subscriptions.map((s: any) => (
                    <tr key={s.id}>
                      <td>{name(s.tenantId)}</td>
                      <td>
                        {data.plans.find((p: any) => p.id === s.planId)?.name}
                      </td>
                      <td>
                        <BillingStatus status={s.status} />
                      </td>
                      <td>{billingDate(s.startsAt)}</td>
                      <td>{billingDate(s.endsAt)}</td>
                      <td>
                        {s.autoRenew
                          ? t("Да", "Иә", "Yes")
                          : t("Нет", "Жоқ", "No")}
                      </td>
                      <td>{s.paymentMethod}</td>
                      <td>{billingDate(s.gracePeriodEndsAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "invoices" && (
            <div className="billing-table-wrap">
              <table>
                <thead>
                  <tr>
                    {[
                      t("Счёт", "Шот", "Invoice"),
                      t("Компания", "Компания", "Company"),
                      t("Дата", "Күні", "Date"),
                      t("Сумма", "Сома", "Amount"),
                      t("Статус", "Мәртебе", "Status"),
                      "PDF",
                    ].map((x) => (
                      <th key={x}>{x}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((i: any) => (
                    <tr key={i.id}>
                      <td>{i.invoiceNumber}</td>
                      <td>{name(i.tenantId)}</td>
                      <td>{billingDate(i.issueDate)}</td>
                      <td>{billingMoney(i.amountMinor)}</td>
                      <td>
                        <BillingStatus status={i.status} />
                      </td>
                      <td>
                        <button
                          className="btn secondary"
                          onClick={() =>
                            void action(() =>
                              downloadBillingInvoice(i.id, true),
                            )
                          }
                        >
                          PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "plans" && (
            <>
              <p className="muted">
                {t(
                  "Новые цены применяются к новым заказам. Уже оплаченные условия сохраняются.",
                  "Жаңа бағалар жаңа тапсырыстарға қолданылады. Төленген шарттар сақталады.",
                  "New prices apply to new orders. Paid terms are preserved.",
                )}
              </p>
              <div className="billing-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Тариф", "Тариф", "Plan")}</th>
                      <th>{t("Месяц", "Ай", "Month")}</th>
                      <th>{t("Год", "Жыл", "Year")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.plans.map((p: any) => (
                      <tr key={p.id}>
                        <td>
                          {p.name}
                          <small className="billing-block muted">
                            {p.code}
                          </small>
                        </td>
                        <td>{billingMoney(p.monthlyPriceMinor)}</td>
                        <td>{billingMoney(p.yearlyPriceMinor)}</td>
                        <td>
                          <button
                            className="btn secondary"
                            onClick={() => open(p, "plan")}
                          >
                            {t("Изменить", "Өзгерту", "Edit")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {tab === "seller" && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void action(() => api.adminBillingSeller(seller));
              }}
            >
              <p className="muted">
                {t(
                  "Укажите реальные реквизиты продавца. Они попадут в новые счета. Старые документы сохранят прежние реквизиты.",
                  "Сатушының нақты деректемелерін көрсетіңіз. Олар жаңа шоттарға енгізіледі. Бұрынғы құжаттар өзгермейді.",
                  "Enter verified seller details. New invoices will use them; existing documents stay unchanged.",
                )}
              </p>
              <div className="billing-form-grid">
                {[
                  [
                    "legalName",
                    t("Юридическое название", "Заңды атауы", "Legal name"),
                  ],
                  ["bin", t("БИН", "БСН", "Tax ID")],
                  [
                    "legalAddress",
                    t("Юридический адрес", "Заңды мекенжай", "Legal address"),
                  ],
                  ["iban", "IBAN"],
                  ["bankName", t("Банк", "Банк", "Bank")],
                  ["bik", t("БИК", "БСК", "BIC")],
                  ["kbe", "КБе"],
                  ["supportEmail", "Email"],
                  ["supportPhone", t("Телефон", "Телефон", "Phone")],
                  [
                    "invoicePrefix",
                    t("Префикс счёта", "Шот префиксі", "Invoice prefix"),
                  ],
                ].map(([k, l]) =>
                  field(
                    k,
                    l,
                    k === "supportEmail" ? "email" : "text",
                    seller,
                    setSeller,
                  ),
                )}
                {field(
                  "vatRate",
                  t(
                    "НДС, % (включён в стоимость)",
                    "ҚҚС, % (бағаға кіреді)",
                    "VAT, % (included in price)",
                  ),
                  "number",
                  seller,
                  setSeller,
                )}
              </div>
              <label className="billing-consent">
                <input
                  type="checkbox"
                  checked={Boolean(seller.vatEnabled)}
                  onChange={(e) =>
                    setSeller({ ...seller, vatEnabled: e.target.checked })
                  }
                />
                {t("Плательщик НДС", "ҚҚС төлеуші", "VAT registered")}
              </label>
              <button className="btn" disabled={busy}>
                {t(
                  "Сохранить реквизиты",
                  "Деректемелерді сақтау",
                  "Save details",
                )}
              </button>
            </form>
          )}
        </div>
      )}
      {selected && (
        <dialog
          ref={dialog}
          className="billing-modal"
          aria-labelledby="billing-modal-title"
          onCancel={(e) => {
            e.preventDefault();
            if (!busy) setSelected(null);
          }}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void action(() =>
                modal === "confirm"
                  ? api.adminBillingConfirm(selected.id, {
                      ...form,
                      paidAt: new Date(form.paidAt + "Z").toISOString(),
                    })
                  : modal === "kaspi"
                    ? api.adminBillingKaspiLink(selected.id, form)
                    : api.adminBillingPlan(selected.id, form),
              );
            }}
          >
            <h3 id="billing-modal-title">
              {modal === "confirm"
                ? t(
                    "Подтвердить поступление денег",
                    "Ақшаның түскенін растау",
                    "Confirm receipt of funds",
                  )
                : modal === "kaspi"
                  ? t(
                      "Ссылка Kaspi для заказа",
                      "Тапсырысқа арналған Kaspi сілтемесі",
                      "Kaspi link for this order",
                    )
                  : t("Редактирование тарифа", "Тарифті өңдеу", "Edit plan")}
            </h3>
            {modal === "confirm" ? (
              <>
                {field(
                  "amount",
                  t(
                    "Полученная сумма, ₸",
                    "Түскен сома, ₸",
                    "Amount received, ₸",
                  ),
                  "number",
                )}
                {field(
                  "paidAt",
                  t(
                    "Дата поступления (UTC)",
                    "Төлем күні (UTC)",
                    "Received at (UTC)",
                  ),
                  "datetime-local",
                )}
                {field(
                  "reference",
                  t(
                    "Номер операции / reference",
                    "Операция нөмірі",
                    "Transaction reference",
                  ),
                )}
                {field("comment", t("Комментарий", "Түсініктеме", "Comment"))}
                <p className="muted">
                  {t(
                    "Подтверждайте только после проверки банковской выписки. Действие сохранится в журнале с вашим именем.",
                    "Банк үзіндісін тексергеннен кейін ғана растаңыз. Әрекет журналға сіздің атыңызбен жазылады.",
                    "Confirm only after checking the bank statement. Your identity is recorded in the audit log.",
                  )}
                </p>
              </>
            ) : modal === "kaspi" ? (
              <>
                {field(
                  "url",
                  t(
                    "Отдельная ссылка Kaspi",
                    "Жеке Kaspi сілтемесі",
                    "Unique Kaspi link",
                  ),
                  "url",
                )}
                {field(
                  "reference",
                  t(
                    "Номер счёта Kaspi",
                    "Kaspi шотының нөмірі",
                    "Kaspi invoice reference",
                  ),
                )}
              </>
            ) : (
              <>
                {field("name", t("Название", "Атауы", "Name"))}
                {field(
                  "description",
                  t("Описание", "Сипаттамасы", "Description"),
                )}
                {field(
                  "monthlyPriceMinor",
                  t("Цена за месяц, ₸", "Айлық баға, ₸", "Monthly price, ₸"),
                  "number",
                )}
                {field(
                  "yearlyPriceMinor",
                  t("Цена за год, ₸", "Жылдық баға, ₸", "Annual price, ₸"),
                  "number",
                )}
                {field(
                  "sortOrder",
                  t("Порядок", "Реті", "Sort order"),
                  "number",
                )}
                {["active", "public"].map((k) => (
                  <label key={k}>
                    <input
                      type="checkbox"
                      checked={Boolean(form[k])}
                      onChange={(e) =>
                        setForm({ ...form, [k]: e.target.checked })
                      }
                    />
                    {k === "active"
                      ? t("Доступен", "Қолжетімді", "Available")
                      : t(
                          "Показывать клиентам",
                          "Клиенттерге көрсету",
                          "Show to customers",
                        )}
                  </label>
                ))}
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button className="btn" disabled={busy}>
                {busy
                  ? t("Сохраняем…", "Сақталуда…", "Saving…")
                  : t("Подтвердить", "Растау", "Confirm")}
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => setSelected(null)}
              >
                {t("Закрыть", "Жабу", "Close")}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </section>
  );
}
