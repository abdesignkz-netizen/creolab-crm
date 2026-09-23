import { CATALOG_BY_CODE } from "@creolab/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { OnboardingWizard } from "../components/OnboardingWizard";
import { BillingCatalog, catalogPrice, formatKzt, type BillingCatalogItem, type BillingPeriod } from "../components/BillingCatalog";

type Quote = {
  planCode: string | null;
  planName: string | null;
  lines: Array<{ code: string; name: string; qty: number; amountMinor: number; chargeType: string }>;
  finalAmountMinor: number;
  limits: Record<string, number>;
  recommendation?: { code: string; name: string; saveMinor: number; message: string } | null;
};

const STATUS_LABEL: Record<string, string> = {
  none: "Не подключён", pending: "Ожидает оплату", active: "Активен", past_due: "Просрочен",
  canceled: "Отменён", cancel_at_period_end: "Отмена в конце периода", expired: "Истёк", suspended: "Приостановлен",
};
const AI_TIERS = ["ADDON_AI_START", "ADDON_AI_BUSINESS", "ADDON_AI_PRO"];
const STEPPERS = ["ADDON_USER", "ADDON_WHATSAPP", "ADDON_AI_PACK", "ADDON_STORAGE_10GB", "ADDON_DEPARTMENT"];
const FALLBACK_CATALOG = Object.values(CATALOG_BY_CODE).filter((item) => item.public && item.active && item.catalogStatus !== "HIDDEN");

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Almaty" }).format(date);
}

export function BillingPage() {
  const { me } = useSession();
  const [data, setData] = useState<any>(me?.billing || null);
  const [catalog, setCatalog] = useState<BillingCatalogItem[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [period, setPeriod] = useState<BillingPeriod>("MONTHLY");
  const [planCode, setPlanCode] = useState("");
  const [addons, setAddons] = useState<Record<string, number>>({});
  const [quoteResult, setQuoteResult] = useState<{ key: string; value: Quote } | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [retry, setRetry] = useState(0);
  const [constructorOpen, setConstructorOpen] = useState(false);
  const [requestType, setRequestType] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const selection = useRef<HTMLDivElement>(null);

  async function loadBilling() { setData(await api.billing()); }
  useEffect(() => { loadBilling().catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить тариф")); }, []);
  useEffect(() => {
    let cancelled = false;
    api.billingPlans(period).then((res) => {
      if (!cancelled) { setCatalog((res as { items: BillingCatalogItem[] }).items); setCatalogError(false); }
    }).catch(() => { if (!cancelled) setCatalogError(true); });
    return () => { cancelled = true; };
  }, [period, retry]);

  const items = catalog ?? FALLBACK_CATALOG;
  const plan = items.find((item) => item.code === planCode);
  const selectedAddOns = useMemo(() => Object.entries(addons).filter(([, qty]) => qty > 0).map(([code, qty]) => ({ code, qty })), [addons]);
  const quoteKey = JSON.stringify([planCode, period, selectedAddOns, retry]);
  const quote = quoteResult?.key === quoteKey ? quoteResult.value : null;
  useEffect(() => {
    setQuoteError("");
    if (!planCode) return;
    let cancelled = false;
    api.billingQuote({ planCode, addOns: selectedAddOns, billingPeriod: period }).then((res) => {
      if (!cancelled) setQuoteResult({ key: quoteKey, value: res as Quote });
    }).catch((err) => {
      if (!cancelled) setQuoteError(err instanceof Error ? err.message : "Не удалось рассчитать стоимость");
    });
    return () => { cancelled = true; };
  }, [quoteKey]);

  const preview = Boolean(data?.previewMode);
  const currentRequest = data?.currentRequest;
  const free = planCode === "BASQAR_FREE";
  const currentFree = data?.planCode === "BASQAR_FREE";
  const enterprise = planCode === "CRM_ENTERPRISE";
  const periodLabel = period === "YEARLY" ? "год" : "месяц";
  const extras = items.filter((item) => item.kind === "addon" && item.catalogStatus === "AVAILABLE");
  const upcoming = items.filter((item) => item.kind === "addon" && item.catalogStatus === "COMING_SOON");
  const included = new Set((plan?.included || []).map((item) => item.code));
  const recurring = quote?.lines.filter((line) => line.chargeType !== "ONE_TIME").reduce((sum, line) => sum + line.amountMinor, 0) ?? 0;
  const oneTime = quote?.lines.filter((line) => line.chargeType === "ONE_TIME").reduce((sum, line) => sum + line.amountMinor, 0) ?? 0;

  function scrollToSelection() {
    requestAnimationFrame(() => selection.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  function pickOffer(code: string) {
    setPlanCode(code); setAddons({}); setRequestType(undefined); setConstructorOpen(false); setError(""); setNotice(""); scrollToSelection();
  }
  function configureCurrent(type: "RENEWAL" | "ADD_ADDON") {
    if (!items.some((item) => item.code === data?.planCode && item.catalogStatus === "AVAILABLE")) {
      setError("Для этого тарифа выберите актуальное предложение из каталога.");
      document.getElementById("billing-catalog")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    setPlanCode(data.planCode);
    setPeriod(data.billingPeriod === "YEARLY" ? "YEARLY" : "MONTHLY");
    setAddons(Object.fromEntries((data.addOns || []).filter((row: { code: string }) => items.find((item) => item.code === row.code)?.chargeType !== "ONE_TIME").map((row: { code: string; qty: number }) => [row.code, row.qty])));
    setRequestType(type); setConstructorOpen(type === "ADD_ADDON"); setError(""); setNotice(""); scrollToSelection();
  }
  function setAddonQty(code: string, qty: number) {
    setAddons((prev) => {
      const next = { ...prev };
      if (AI_TIERS.includes(code) && qty > 0) AI_TIERS.forEach((key) => delete next[key]);
      if (qty <= 0) delete next[code]; else next[code] = Math.min(99, qty);
      if (!plan?.features.AI_MANAGER && !AI_TIERS.some((key) => next[key])) delete next.ADDON_AI_PACK;
      return next;
    });
    if (requestType === "RENEWAL") setRequestType("ADD_ADDON");
  }
  async function submit() {
    if (!planCode || !quote || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.createBillingRequest({ planCode, addOns: selectedAddOns, billingPeriod: period, ...(requestType ? { requestType } : {}) });
      setNotice(enterprise ? "Запрос на индивидуальные условия отправлен." : "Запрос на подключение отправлен. Доступ откроется после подтверждения оплаты.");
      await loadBilling();
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось отправить запрос"); }
    finally { setBusy(false); }
  }
  async function cancelRequest() {
    if (!currentRequest?.id) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.cancelBillingRequest(currentRequest.id); await loadBilling(); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось отменить запрос"); }
    finally { setBusy(false); }
  }

  return <section className="billing-page stack">
    <div className="page-head">
      <div><h2>Тарифы и оплата</h2><p className="muted">Выберите возможности для команды, сравните лимиты и отправьте запрос на подключение.</p></div>
      <div className="billing-period-toggle" aria-label="Период оплаты">
        <button type="button" disabled={busy} aria-pressed={period === "MONTHLY"} className={`btn secondary ${period === "MONTHLY" ? "active" : ""}`} onClick={() => setPeriod("MONTHLY")}>Месяц</button>
        <button type="button" disabled={busy} aria-pressed={period === "YEARLY"} className={`btn secondary ${period === "YEARLY" ? "active" : ""}`} onClick={() => setPeriod("YEARLY")}>Год</button>
      </div>
    </div>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {notice ? <p className="billing-notice" role="status">{notice}</p> : null}
    {(data?.warnings || []).map((item: { code: string; message: string }) => <p key={item.code} className="warn">{item.message}</p>)}
    <div className="panel stack">
      <h3>Ваш тариф</h3>
      <p><b>{preview ? "Ознакомительный режим" : data?.planName || "Не подключён"}</b>{data?.amountMinor ? ` · ${formatKzt(data.priceBreakdown?.recurring ?? data.amountMinor)} / ${data.billingPeriod === "YEARLY" ? "год" : "месяц"}` : ""}</p>
      <p className="muted">Статус: {STATUS_LABEL[data?.subscriptionStatus] || data?.subscriptionStatus || "—"}.{data?.expiresAt ? ` Активен до ${formatDate(data.expiresAt)}` : preview ? " Платная подписка не подключена." : ""}</p>
      {data?.priceBreakdown && !currentFree ? <dl className="billing-quote"><div>Базовая стоимость: {formatKzt(data.priceBreakdown.base)}</div><div>Дополнения: {formatKzt(data.priceBreakdown.addOns)}</div><div>Итого: {formatKzt(data.priceBreakdown.recurring)} / {data.billingPeriod === "YEARLY" ? "год" : "месяц"}</div>{data.priceBreakdown.oneTime > 0 ? <div>Разовые услуги: {formatKzt(data.priceBreakdown.oneTime)}</div> : null}</dl> : null}
      {data?.enterpriseTerms?.sla ? <p>Поддержка / SLA: {data.enterpriseTerms.sla}</p> : null}
      {data?.enterpriseTerms?.integrations ? <p>Согласованные интеграции: {data.enterpriseTerms.integrations}</p> : null}
      {currentFree ? <p>0 ₸ · Для знакомства с BasQar и первых продаж</p> : null}
      <div className="billing-usage-grid">{(data?.usage || []).map((row: { key: string; label: string; used: number; cap: number; unit?: string; measured?: boolean }) => <div key={row.key} className="billing-usage"><div className="billing-usage-label"><span>{row.label}</span><span>{row.measured === false ? "Ещё не рассчитано" : `${row.used} / ${row.cap < 0 ? "без квоты" : row.cap}${row.unit ? ` ${row.unit}` : ""}`}</span></div><div className="usage-bar"><span style={{ width: `${row.cap > 0 ? Math.min(100, row.used / row.cap * 100) : 0}%` }} /></div></div>)}</div>
      {!preview ? <div className="actions">
        <button className="btn secondary" type="button" disabled={busy} onClick={() => document.getElementById("billing-catalog")?.scrollIntoView({ behavior: "smooth" })}>Изменить тариф</button>
        <button className="btn secondary" type="button" disabled={busy || !data?.planCode || currentFree} onClick={() => configureCurrent("ADD_ADDON")}>Подключить модуль</button>
        <button className="btn" type="button" disabled={busy || !data?.planCode || currentFree} onClick={() => configureCurrent("RENEWAL")}>Продлить</button>
      </div> : null}
    </div>
    {currentRequest ? <div className="panel stack">
      <h3>Ваш запрос</h3><p>{currentRequest.planName || currentRequest.planCode} · {currentRequest.planCode === "CRM_ENTERPRISE" ? "Индивидуальные условия" : `${formatKzt(currentRequest.finalAmountMinor)} за выбранный период и разовые услуги`}</p>
      <p>Статус: <b>{currentRequest.statusLabel || "Ожидает подтверждения оплаты"}</b></p>
      <p className="muted">{currentRequest.planCode === "CRM_ENTERPRISE" ? "Администратор согласует с вами состав и стоимость." : "Оплата проходит вне системы. Администратор BasQar подтверждает оплату и открывает доступ."}</p>
      <div className="actions"><button className="btn secondary" type="button" disabled={busy} onClick={() => void cancelRequest()}>Отменить запрос</button></div>
    </div> : null}
    {catalogError ? <p className="warn">Не удалось обновить каталог. Показаны справочные условия; итоговую стоимость проверим при выборе тарифа. <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>Обновить каталог</button></p> : null}
    <BillingCatalog items={items} period={period} selected={planCode} current={preview ? undefined : data?.planCode} disabled={busy} onSelect={pickOffer} />
    <div ref={selection} className="billing-selection" tabIndex={-1}>
      {planCode ? <div className="panel stack">
        <div className="page-head"><div><h3>{requestType === "RENEWAL" ? "Продление: " : "Ваш выбор: "}{plan?.name || planCode}</h3><p className="muted">{enterprise ? "Стоимость и состав согласуем индивидуально." : `Период оплаты: ${period === "YEARLY" ? "12 месяцев" : "1 месяц"}.`}</p></div>
          {!enterprise && !free ? <button className="btn secondary" disabled={busy} type="button" aria-expanded={constructorOpen} onClick={() => setConstructorOpen((open) => !open)}>{constructorOpen ? "Скрыть дополнения" : "Настроить под себя"}</button> : null}
        </div>
        {constructorOpen && !enterprise && !free ? <div className="stack">
          <h4>Дополнения к выбранному тарифу</h4><p className="muted">Модули и дополнительные лимиты оплачиваются сверх тарифа. Выберите один уровень AI Manager; если AI уже включён, объём можно увеличить пакетом взаимодействий.</p>
          <div className="billing-addons">{extras.map((item) => {
            const isIncluded = included.has(item.code) || (item.code === "ADDON_CONTROL" && plan?.features.AI_CONTROL);
            const aiAlreadyIncluded = AI_TIERS.includes(item.code) && plan?.features.AI_MANAGER;
            const needsAi = item.code === "ADDON_AI_PACK" && !plan?.features.AI_MANAGER && !AI_TIERS.some((code) => addons[code]);
            const disabled = busy || Boolean(isIncluded || aiAlreadyIncluded || needsAi);
            const qty = addons[item.code] || 0;
            const explanation = isIncluded ? "Уже включено в тариф" : aiAlreadyIncluded ? "AI уже включён — используйте дополнительный пакет" : needsAi ? "Сначала подключите AI Manager" : "";
            return <div key={item.code} className="billing-addon">
              <div><b>{item.name}</b><p className="muted">{item.description}</p>{AI_TIERS.includes(item.code) ? <p className="muted">AI-взаимодействия: {item.limits.AI_USAGE?.toLocaleString("ru-RU")} · WhatsApp: {item.limits.WHATSAPP_CONNECTIONS}</p> : null}<p>{isIncluded ? "Без доплаты" : `${item.code === "ADDON_INTEGRATION" || AI_TIERS.includes(item.code) || item.code === "ADDON_AI_PACK" || item.code === "ADDON_CONTROL" ? "от +" : "+"}${formatKzt(catalogPrice(item, period))} / ${item.chargeType === "ONE_TIME" ? "разово" : periodLabel}`}</p>{explanation ? <small className="muted">{explanation}</small> : null}</div>
              {STEPPERS.includes(item.code) ? <div className="billing-stepper"><button type="button" aria-label={`Уменьшить: ${item.name}`} disabled={disabled || qty === 0} onClick={() => setAddonQty(item.code, qty - 1)}>−</button><output aria-label={`Количество: ${item.name}`}>{qty}</output><button type="button" aria-label={`Добавить: ${item.name}`} disabled={disabled || qty >= 99} onClick={() => setAddonQty(item.code, qty + 1)}>+</button></div> : <input type="checkbox" aria-label={item.name} disabled={disabled} checked={Boolean(isIncluded || qty > 0)} onChange={(event) => setAddonQty(item.code, event.target.checked ? 1 : 0)} />}
            </div>;
          })}</div>
        </div> : null}
        {quoteError ? <p className="error" role="alert">{quoteError} <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>Повторить расчёт</button></p> : !quote ? <p className="muted" role="status">Рассчитываем стоимость…</p> : !enterprise ? <div className="billing-quote" aria-live="polite">
          {quote.recommendation ? <div className="billing-notice"><p>{quote.recommendation.message}</p><button className="btn secondary" onClick={() => pickOffer(quote.recommendation!.code)}>Посмотреть {quote.recommendation.name}</button></div> : null}
          <h4>Что входит в оплату</h4><dl>{quote.lines.map((line, index) => <div key={`${line.code}-${index}`}><dt>{line.name}{line.qty > 1 ? ` × ${line.qty}` : ""}{line.chargeType === "ONE_TIME" ? " · разово" : ""}</dt><dd>{formatKzt(line.amountMinor)}</dd></div>)}</dl>
          <p>Подписка: <b>{formatKzt(recurring)} / {periodLabel}</b>{oneTime > 0 ? ` · Разовые услуги: ${formatKzt(oneTime)}` : ""}</p><p className="billing-total">Итого к оплате: <strong>{formatKzt(quote.finalAmountMinor)}</strong></p>
          {selectedAddOns.some((item) => item.code === "ADDON_INTEGRATION") ? <p className="muted">Интеграция рассчитана по начальной стоимости. Окончательную цену согласуем по задаче.</p> : null}
          <p className="muted">С учётом дополнений: пользователей — {quote.limits.USERS}, воронок — {quote.limits.PIPELINES}, WhatsApp — {quote.limits.WHATSAPP_CONNECTIONS}, AI-взаимодействий — {quote.limits.AI_USAGE?.toLocaleString("ru-RU")}, хранилище — {quote.limits.STORAGE_GB} ГБ.</p>
        </div> : null}
        <div className="actions"><button className="btn" type="button" disabled={busy || !quote || Boolean(currentRequest)} onClick={() => void submit()}>{enterprise ? "Отправить запрос на индивидуальные условия" : requestType === "RENEWAL" ? "Отправить запрос на продление" : "Отправить запрос на подключение"}</button></div>
        {currentRequest ? <p className="muted">У вас уже есть открытый запрос. Дождитесь его обработки или отмените его, чтобы отправить новый.</p> : null}
      </div> : <p className="muted">Выберите тариф выше — здесь появится его состав и итоговый расчёт.</p>}
    </div>
    <section className="panel stack"><h3>Как подключить</h3><ol className="billing-steps"><li>Выберите тариф и нужные дополнения.</li><li>Отправьте запрос. Оплата проходит вне системы.</li><li>Администратор BasQar подтвердит оплату и откроет доступ.</li></ol><p className="muted">Онлайн-оплата пока не подключена. Настройка внешних сервисов выполняется отдельно от выбора тарифа.</p>
      {upcoming.length ? <p className="muted">Дополнения в подготовке: {upcoming.map((item) => item.name).join(", ")}. Они недоступны для заказа в этом каталоге.</p> : null}
    </section>
    <OnboardingWizard /><p className="muted">Вопросы по подключению можно задать в <Link to="/today">поддержке</Link> — она доступна и в режиме просмотра.</p>
  </section>;
}
