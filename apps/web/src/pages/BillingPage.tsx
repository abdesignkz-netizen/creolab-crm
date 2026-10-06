import { systemText } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { BillingHistory } from "../components/BillingHistory";
import { useBillingText } from "../components/BillingCheckoutUi";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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


function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale === "kk" ? "kk-KZ" : "ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Almaty" }).format(date);
}

export function BillingPage() {
  const locale = useLocale();
  const navigate = useNavigate(), bt = useBillingText();
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

  function warningText(item: { code: string; message: string }) {
    if (locale !== "kk") return item.message;
    if (item.code === "expires_soon") return systemText(locale, "До окончания подписки: {days} дн.", { days: data?.daysLeft ?? 0 });
    const key = item.code.replace(/_(exhausted|80)$/, "");
    const row = data?.usage?.find((value: { key: string }) => value.key === key);
    if (!row) return systemText(locale, item.message);
    return systemText(locale, "{label}: использовано {used} из {cap}. {remaining}", {
      label: systemText(locale, row.label), used: row.used, cap: row.cap,
      remaining: row.used >= row.cap ? systemText(locale, "Остальные ресурсы и ручная работа доступны.") : systemText(locale, "Осталось {count}.", { count: Math.max(0, row.cap - row.used) }),
    });
  }

  async function loadBilling() { setData(await api.billing()); }
  useEffect(() => { loadBilling().catch((err) => setError(locale !== "kk" && err instanceof Error ? err.message : systemText(locale, "Не удалось загрузить тариф"))); }, []);
  useEffect(() => {
    let cancelled = false;
    api.billingPlans(period).then((res) => {
      if (!cancelled) { setCatalog((res as { items: BillingCatalogItem[] }).items); setCatalogError(false); }
    }).catch(() => { if (!cancelled) setCatalogError(true); });
    return () => { cancelled = true; };
  }, [period, retry]);

  const items = catalog ?? [];
  const plan = items.find((item) => item.code === planCode);
  const selectedAddOns = useMemo(() => Object.entries(addons).filter(([, qty]) => qty > 0).map(([code, qty]) => ({ code, qty })), [addons]);
  const quoteKey = JSON.stringify([planCode, period, selectedAddOns, retry, requestType]);
  const quote = quoteResult?.key === quoteKey ? quoteResult.value : null;
  useEffect(() => {
    setQuoteError("");
    if (!planCode) return;
    let cancelled = false;
    api.billingQuote({ planCode, addOns: selectedAddOns, billingPeriod: period, requestType }).then((res) => {
      if (!cancelled) setQuoteResult({ key: quoteKey, value: res as Quote });
    }).catch((err) => {
      if (!cancelled) setQuoteError(locale !== "kk" && err instanceof Error ? err.message : systemText(locale, "Не удалось рассчитать стоимость"));
    });
    return () => { cancelled = true; };
  }, [quoteKey]);

  const preview = Boolean(data?.previewMode);
  const currentRequest = data?.currentRequest;
  const free = planCode === "BASQAR_FREE";
  const currentFree = data?.planCode === "BASQAR_FREE";
  const enterprise = planCode === "CRM_ENTERPRISE";
  const periodLabel = period === "YEARLY" ? systemText(locale, "год") : systemText(locale, "месяц");
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
    if (type !== "RENEWAL" && !items.some((item) => item.code === data?.planCode && item.catalogStatus === "AVAILABLE")) {
      setError(systemText(locale, "Для этого тарифа выберите актуальное предложение из каталога."));
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
      if (!plan?.features.AI_MANAGER && !plan?.features.AI_CONTROL && !AI_TIERS.some((key) => next[key])) delete next.ADDON_AI_PACK;
      return next;
    });
    if (requestType === "RENEWAL") setRequestType("ADD_ADDON");
  }
  async function submit() {
    if (!planCode || !quote || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!free && !enterprise) {
        const order = await api.billingCheckout({planCode, addOns:selectedAddOns, billingPeriod:period, renewal:requestType === "RENEWAL"});
        navigate(`/billing/checkout/${order.id}`); return;
      }
      await api.createBillingRequest({ planCode, addOns: selectedAddOns, billingPeriod: period, ...(requestType ? { requestType } : {}) });
      setNotice(free ? systemText(locale, "BasQar Free подключён без оплаты.") : enterprise ? systemText(locale, "Запрос на индивидуальные условия отправлен.") : systemText(locale, "Запрос на подключение отправлен. Доступ откроется после подтверждения оплаты."));
      await loadBilling();
    } catch (err) { setError(locale !== "kk" && err instanceof Error ? err.message : systemText(locale, "Не удалось отправить запрос")); }
    finally { setBusy(false); }
  }
  async function cancelRequest() {
    if (!currentRequest?.id) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.cancelBillingRequest(currentRequest.id); await loadBilling(); }
    catch (err) { setError(locale !== "kk" && err instanceof Error ? err.message : systemText(locale, "Не удалось отменить запрос")); }
    finally { setBusy(false); }
  }

  return <section className="billing-page stack">
    <div className="page-head">
      <div><h2>{systemText(locale, "Тарифы и оплата")}</h2><p className="muted">{bt("Выберите тариф, сравните лимиты и перейдите к оплате.", "Тарифті таңдап, лимиттерді салыстырыңыз да, төлемге өтіңіз.", "Choose a plan, compare limits and continue to checkout.")}</p></div>
      <div className="billing-period-toggle" aria-label={systemText(locale, "Период оплаты")}>
        <button type="button" disabled={busy} aria-pressed={period === "MONTHLY"} className={`btn secondary ${period === "MONTHLY" ? "active" : ""}`} onClick={() => setPeriod("MONTHLY")}>{systemText(locale, "Месяц")}</button>
        <button type="button" disabled={busy} aria-pressed={period === "YEARLY"} className={`btn secondary ${period === "YEARLY" ? "active" : ""}`} onClick={() => setPeriod("YEARLY")}>{systemText(locale, "Год")}</button>
      </div>
    </div>
    <BillingHistory onPay={() => data?.planCode && !currentFree ? configureCurrent("RENEWAL") : document.getElementById("billing-catalog")?.scrollIntoView({behavior:"smooth"})} />
    {error ? <p className="error" role="alert">{error}</p> : null}
    {notice ? <p className="billing-notice" role="status">{notice}</p> : null}
    {(data?.warnings || []).map((item: { code: string; message: string }) => <p key={item.code} className="warn">{warningText(item)}</p>)}
    <div className="panel stack">
      <h3>{systemText(locale, "Ваш тариф")}</h3>
      <p><b>{preview ? systemText(locale, "Ознакомительный режим") : data?.planName || systemText(locale, "Не подключён")}</b>{data?.amountMinor ? ` · ${formatKzt(data.priceBreakdown?.recurring ?? data.amountMinor)} / ${data.billingPeriod === "YEARLY" ? systemText(locale, "год") : systemText(locale, "месяц")}` : ""}</p>
      <p className="muted">{systemText(locale, "Статус:")}{" "}{systemText(locale, STATUS_LABEL[data?.subscriptionStatus] || data?.subscriptionStatus || "—")}.{data?.expiresAt ? systemText(locale, " Активен до {p0}", { p0: formatDate(data.expiresAt, locale) }) : preview ? systemText(locale, " Платная подписка не подключена.") : ""}</p>
      {data?.priceBreakdown && !currentFree ? <dl className="billing-quote"><div>{systemText(locale, "Базовая стоимость:")}{" "}{formatKzt(data.priceBreakdown.base)}</div><div>{systemText(locale, "Дополнения:")}{" "}{formatKzt(data.priceBreakdown.addOns)}</div><div>{systemText(locale, "Итого:")}{" "}{formatKzt(data.priceBreakdown.recurring)} / {data.billingPeriod === "YEARLY" ? systemText(locale, "год") : systemText(locale, "месяц")}</div>{data.priceBreakdown.oneTime > 0 ? <div>{systemText(locale, "Разовые услуги:")}{" "}{formatKzt(data.priceBreakdown.oneTime)}</div> : null}</dl> : null}
      {data?.enterpriseTerms?.sla ? <p>{systemText(locale, "Поддержка / SLA:")}{" "}{data.enterpriseTerms.sla}</p> : null}
      {data?.enterpriseTerms?.integrations ? <p>{systemText(locale, "Согласованные интеграции:")}{" "}{data.enterpriseTerms.integrations}</p> : null}
      {currentFree ? <p>{systemText(locale, "0 ₸ · Для самостоятельной работы и знакомства с BasQar.")}</p> : null}
      {data?.entitlements?.AI_MANAGER && currentFree ? <p className="muted">{systemText(locale, "ИИ-менеджер доступен в пробном режиме для ознакомления с консультациями клиентов и обработкой заявок. 100 AI-кредитов выдаются один раз и используются всеми AI-функциями.")}</p> : data?.planCode === "CRM_START" && !data?.entitlements?.AI_MANAGER ? <p className="muted">{systemText(locale, "ИИ-менеджер не входит в Start. AI-кредиты доступны для BasQar Control и других AI-действий тарифа.")}</p> : null}
      <div className="billing-usage-grid">{(data?.usage || []).map((row: { key: string; label: string; used: number; cap: number; unit?: string; measured?: boolean }) => <div key={row.key} className="billing-usage"><div className="billing-usage-label"><span>{systemText(locale, row.label)}</span><span>{row.measured === false ? systemText(locale, "Ещё не рассчитано") : `${row.used} / ${row.cap < 0 ? systemText(locale, "без квоты") : row.cap}${row.unit ? ` ${row.unit}` : ""}`}</span></div><div className="usage-bar"><span style={{ width: `${row.cap > 0 ? Math.min(100, row.used / row.cap * 100) : 0}%` }} /></div></div>)}</div>
      {data?.massCampaignsEnabled === false ? <p className="muted">{systemText(locale, "Массовые рассылки — с тарифа Start. Индивидуальные сообщения клиентам доступны.")}</p> : null}
      {!preview ? <div className="actions">
        <button className="btn secondary" type="button" disabled={busy} onClick={() => document.getElementById("billing-catalog")?.scrollIntoView({ behavior: "smooth" })}>{systemText(locale, "Изменить тариф")}</button>
        <button className="btn secondary" type="button" disabled={busy || !data?.planCode || currentFree} onClick={() => configureCurrent("ADD_ADDON")}>{systemText(locale, "Дополнительные ресурсы")}</button>
        <button className="btn" type="button" disabled={busy || !data?.planCode || currentFree} onClick={() => configureCurrent("RENEWAL")}>{systemText(locale, "Продлить")}</button>
      </div> : null}
    </div>
    {currentRequest ? <div className="panel stack">
      <h3>{systemText(locale, "Ваш запрос")}</h3><p>{currentRequest.planName || currentRequest.planCode} · {currentRequest.planCode === "CRM_ENTERPRISE" ? systemText(locale, "Индивидуальные условия") : systemText(locale, "{p0} за выбранный период и разовые услуги", { p0: formatKzt(currentRequest.finalAmountMinor) })}</p>
      <p>{systemText(locale, "Статус:")}{" "}<b>{systemText(locale, currentRequest.statusLabel || "Ожидает подтверждения оплаты")}</b></p>
      <p className="muted">{currentRequest.planCode === "CRM_ENTERPRISE" ? systemText(locale, "Администратор согласует с вами состав и стоимость.") : systemText(locale, "Оплата проходит вне системы. Администратор BasQar подтверждает оплату и открывает доступ.")}</p>
      <div className="actions"><button className="btn secondary" type="button" disabled={busy} onClick={() => void cancelRequest()}>{systemText(locale, "Отменить запрос")}</button></div>
    </div> : null}
    {catalogError ? <p className="warn">{systemText(locale, "Не удалось обновить каталог. Показаны справочные условия; итоговую стоимость проверим при выборе тарифа.")}{" "}<button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>{systemText(locale, "Обновить каталог")}</button></p> : null}
    <BillingCatalog items={items} period={period} selected={planCode} current={preview ? undefined : data?.planCode} disabled={busy} onSelect={pickOffer} />
    <section className="panel stack"><h3>{systemText(locale, "Дополнительные ресурсы")}</h3>
      <p className="muted">{systemText(locale, "Для подходящего платного тарифа. Дополнительные ресурсы не открывают функции другого тарифа.")}</p>
      <div className="billing-addons">{extras.map(item => <div className="billing-addon" key={item.code}><div><b>{systemText(locale, item.name)}</b><p>{systemText(locale, item.description)}</p><p>{item.code === "ADDON_INTEGRATION" ? systemText(locale, "от ") : ""}{formatKzt(catalogPrice(item, period))} / {item.chargeType === "ONE_TIME" ? systemText(locale, "разово") : periodLabel}</p></div></div>)}</div>
      {(data?.addOns || []).length ? <p>{systemText(locale, "Купленные ресурсы:")}{" "}{(data.addOns as Array<{code:string;qty:number}>).map(row => `${systemText(locale, items.find(item=>item.code===row.code)?.name || "Прежний модуль")} × ${row.qty}`).join(", ")}</p> : null}
      {data?.accessBreakdown?.baseLimits ? <div className="billing-table-scroll"><table><thead><tr><th>{systemText(locale, "Ресурс")}</th><th>{systemText(locale, "В тарифе")}</th><th>{systemText(locale, "Итоговый лимит")}</th></tr></thead><tbody>{(data.usage || []).map((row: {key:string;label:string;cap:number}) => <tr key={row.key}><th>{systemText(locale, row.label)}</th><td>{data.accessBreakdown.baseLimits[row.key] ?? "—"}</td><td>{row.cap < 0 ? systemText(locale, "Без квоты") : row.cap}</td></tr>)}</tbody></table></div> : null}
    </section>
    <div ref={selection} className="billing-selection" tabIndex={-1}>
      {planCode ? <div className="panel stack">
        <div className="page-head"><div><h3>{requestType === "RENEWAL" ? systemText(locale, "Продление: ") : systemText(locale, "Ваш выбор: ")}{plan?.name || planCode}</h3><p className="muted">{enterprise ? systemText(locale, "Стоимость и состав согласуем индивидуально.") : systemText(locale, "Период оплаты: {p0}.", { p0: period === "YEARLY" ? systemText(locale, "12 месяцев") : systemText(locale, "1 месяц") })}</p></div>
          {!enterprise && !free ? <button className="btn secondary" disabled={busy} type="button" aria-expanded={constructorOpen} onClick={() => setConstructorOpen((open) => !open)}>{constructorOpen ? systemText(locale, "Скрыть дополнения") : systemText(locale, "Настроить под себя")}</button> : null}
        </div>
        {constructorOpen && !enterprise && !free ? <div className="stack">
          <h4>{systemText(locale, "Дополнительные ресурсы")}</h4><p className="muted">{systemText(locale, "Ресурсы увеличивают лимиты тарифа и не открывают функции другого тарифа.")}</p>
          <div className="billing-addons">{extras.map((item) => {
            const isIncluded = included.has(item.code) || (item.code === "ADDON_CONTROL" && plan?.features.AI_CONTROL);
            const aiAlreadyIncluded = AI_TIERS.includes(item.code) && plan?.features.AI_MANAGER;
            const needsAi = item.code === "ADDON_AI_PACK" && !plan?.features.AI_MANAGER && !plan?.features.AI_CONTROL && !AI_TIERS.some((code) => addons[code]);
            const disabled = busy || Boolean(isIncluded || aiAlreadyIncluded || needsAi || (item.code === "ADDON_WHATSAPP" && !plan?.features.CHANNELS));
            const qty = addons[item.code] || 0;
            const explanation = isIncluded ? systemText(locale, "Уже включено в тариф") : aiAlreadyIncluded ? systemText(locale, "AI уже включён — используйте дополнительный пакет") : needsAi ? systemText(locale, "Доступно начиная с Control") : "";
            return <div key={item.code} className="billing-addon">
              <div><b>{systemText(locale, item.name)}</b><p className="muted">{systemText(locale, item.description)}</p>{AI_TIERS.includes(item.code) ? <p className="muted">{systemText(locale, "AI-кредиты:")}{" "}{item.limits.AI_CREDITS || item.limits.AI_USAGE?.toLocaleString("ru-RU")} · WhatsApp: {item.limits.WHATSAPP_CONNECTIONS}</p> : null}<p>{isIncluded ? systemText(locale, "Без доплаты") : `${item.code === "ADDON_INTEGRATION" ? systemText(locale, "от +") : "+"}${formatKzt(catalogPrice(item, period))} / ${item.chargeType === "ONE_TIME" ? systemText(locale, "разово") : periodLabel}`}</p>{explanation ? <small className="muted">{explanation}</small> : null}</div>
              {STEPPERS.includes(item.code) ? <div className="billing-stepper"><button type="button" aria-label={systemText(locale, "Уменьшить: {p0}", { p0: systemText(locale, item.name) })} disabled={disabled || qty === 0} onClick={() => setAddonQty(item.code, qty - 1)}>−</button><output aria-label={systemText(locale, "Количество: {p0}", { p0: systemText(locale, item.name) })}>{qty}</output><button type="button" aria-label={systemText(locale, "Добавить: {p0}", { p0: systemText(locale, item.name) })} disabled={disabled || qty >= 99} onClick={() => setAddonQty(item.code, qty + 1)}>+</button></div> : <input type="checkbox" aria-label={systemText(locale, item.name)} disabled={disabled} checked={Boolean(isIncluded || qty > 0)} onChange={(event) => setAddonQty(item.code, event.target.checked ? 1 : 0)} />}
            </div>;
          })}</div>
        </div> : null}
        {quoteError ? <p className="error" role="alert">{quoteError} <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>{systemText(locale, "Повторить расчёт")}</button></p> : !quote ? <p className="muted" role="status">{systemText(locale, "Рассчитываем стоимость…")}</p> : !enterprise ? <div className="billing-quote" aria-live="polite">
          {quote.recommendation ? <div className="billing-notice"><p>{locale === "kk" ? systemText(locale, "{plan} выгоднее на {saving}.", { plan: quote.recommendation.name, saving: formatKzt(quote.recommendation.saveMinor) }) : quote.recommendation.message}</p><button className="btn secondary" onClick={() => pickOffer(quote.recommendation!.code)}>{systemText(locale, "Посмотреть")}{" "}{systemText(locale, quote.recommendation.name)}</button></div> : null}
          <h4>{systemText(locale, "Что входит в оплату")}</h4><dl>{quote.lines.map((line, index) => <div key={`${line.code}-${index}`}><dt>{systemText(locale, line.name)}{line.qty > 1 ? ` × ${line.qty}` : ""}{line.chargeType === "ONE_TIME" ? systemText(locale, " · разово") : ""}</dt><dd>{formatKzt(line.amountMinor)}</dd></div>)}</dl>
          <p>{systemText(locale, "Подписка:")}{" "}<b>{formatKzt(recurring)} / {periodLabel}</b>{oneTime > 0 ? systemText(locale, " · Разовые услуги: {p0}", { p0: formatKzt(oneTime) }) : ""}</p><p className="billing-total">{systemText(locale, "Итого к оплате:")}{" "}<strong>{formatKzt(quote.finalAmountMinor)}</strong></p>
          {selectedAddOns.some((item) => item.code === "ADDON_INTEGRATION") ? <p className="muted">{systemText(locale, "Интеграция рассчитана по начальной стоимости. Окончательную цену согласуем по задаче.")}</p> : null}
          <p className="muted">{systemText(locale, "С учётом дополнений: пользователей —")}{" "}{quote.limits.USERS}{systemText(locale, ", воронок —")}{" "}{quote.limits.PIPELINES}{systemText(locale, ", коммуникационные подключения —")}{" "}{quote.limits.WHATSAPP_CONNECTIONS}{systemText(locale, ", AI-кредитов —")}{" "}{quote.limits.AI_USAGE?.toLocaleString("ru-RU")}{systemText(locale, ", хранилище —")}{" "}{quote.limits.STORAGE_GB} {" "}{systemText(locale, "ГБ.")}</p>
        </div> : null}
        <div className="actions"><button className="btn" type="button" disabled={busy || !quote || Boolean(currentRequest)} onClick={() => void submit()}>{enterprise ? systemText(locale, "Отправить запрос на индивидуальные условия") : requestType === "RENEWAL" ? bt("Продлить подписку", "Жазылымды ұзарту", "Renew subscription") : bt("Перейти к оплате", "Төлемге өту", "Continue to checkout")}</button></div>
        {currentRequest ? <p className="muted">{systemText(locale, "У вас уже есть открытый запрос. Дождитесь его обработки или отмените его, чтобы отправить новый.")}</p> : null}
      </div> : <p className="muted">{systemText(locale, "Выберите тариф выше — здесь появится его состав и итоговый расчёт.")}</p>}
    </div>
    <section className="panel stack"><h3>{systemText(locale, "Как подключить")}</h3><ol className="billing-steps"><li>{systemText(locale, "Выберите тариф и нужные дополнения.")}</li><li>{bt("Выберите карту, Kaspi или счёт на компанию.", "Картаны, Kaspi-ді немесе компанияға шотты таңдаңыз.", "Choose card, Kaspi or a company invoice.")}</li><li>{bt("После подтверждения оплаты тариф подключится автоматически.", "Төлем расталғаннан кейін тариф автоматты түрде қосылады.", "Your plan activates when payment is confirmed.")}</li></ol><p className="muted">{bt("Доступные способы показаны на странице оплаты. Поступления по Kaspi и счёту проверяет администратор.", "Қолжетімді тәсілдер төлем бетінде көрсетілген. Kaspi және шот бойынша төлемдерді әкімші тексереді.", "Available methods are shown at checkout. Kaspi and bank transfers are verified by an administrator.")}</p>
      {upcoming.length ? <p className="muted">{systemText(locale, "Дополнения в подготовке:")}{" "}{upcoming.map((item) => systemText(locale, item.name)).join(", ")}{systemText(locale, ". Они недоступны для заказа в этом каталоге.")}</p> : null}
    </section>
    <OnboardingWizard />{data?.entitlements?.SUPPORT ? <p className="muted">{systemText(locale, "Вопросы по подключению можно задать в")}{" "}<Link to="/billing?support=1">{systemText(locale, "поддержке")}</Link>.</p> : null}
  </section>;
}
