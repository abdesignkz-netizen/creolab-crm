import { CATALOG_BY_CODE, PUBLIC_OFFERS } from "@creolab/contracts";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { OnboardingWizard } from "../components/OnboardingWizard";

type CatalogItem = {
  code: string;
  name: string;
  kind: string;
  product?: string;
  description?: string;
  price: number | null;
  monthlyPriceMinor?: number;
  yearlyPriceMinor?: number;
  catalogStatus?: string;
  recommended?: boolean;
  chargeType?: string;
  title?: string;
  subtitle?: string;
  limits?: Record<string, number>;
};

type Quote = {
  planCode: string | null;
  planName: string | null;
  billingPeriod: string;
  lines: Array<{ code: string; name: string; qty: number; amountMinor: number }>;
  finalAmountMinor: number;
  recommendation: { code: string; name: string; saveMinor: number; message: string } | null;
};

const STATUS_LABEL: Record<string, string> = {
  none: "Не подключён",
  pending: "Ожидает оплату",
  active: "Активен",
  past_due: "Просрочен",
  canceled: "Отменён",
  cancel_at_period_end: "Отмена в конце периода",
  expired: "Истёк",
  suspended: "Приостановлен",
};

const ADDON_GROUPS: Array<{ code: string; label: string; stepper?: boolean }> = [
  { code: "ADDON_AI_START", label: "AI Manager Start" },
  { code: "ADDON_AI_BUSINESS", label: "AI Manager Business" },
  { code: "ADDON_AI_PRO", label: "AI Manager Pro" },
  { code: "ADDON_CONTROL", label: "BasQar Control" },
  { code: "ADDON_USER", label: "Доп. пользователь", stepper: true },
  { code: "ADDON_WHATSAPP", label: "Доп. WhatsApp", stepper: true },
  { code: "ADDON_AI_PACK", label: "Пакет AI +1000", stepper: true },
  { code: "ADDON_STORAGE_10GB", label: "Хранилище +10 ГБ", stepper: true },
  { code: "ADDON_INTEGRATION", label: "Индивидуальная интеграция" },
];

function formatKzt(value: number | null | undefined) {
  if (value == null) return "индивидуально";
  return `${Number(value).toLocaleString("ru-RU")} ₸`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Almaty",
  }).format(date);
}

function localQuote(planCode: string, selectedAddOns: Array<{ code: string; qty: number }>, period: "MONTHLY" | "YEARLY"): Quote {
  const plan = CATALOG_BY_CODE[planCode];
  const included = new Set((plan?.included || []).map((item) => item.code));
  const unit = (item?: { monthlyPriceMinor?: number; yearlyPriceMinor?: number; chargeType?: string }) => {
    if (!item) return 0;
    if (item.chargeType === "ONE_TIME") return item.monthlyPriceMinor || 0;
    return period === "YEARLY" ? item.yearlyPriceMinor || 0 : item.monthlyPriceMinor || 0;
  };
  const lines: Quote["lines"] = [];
  let total = 0;
  if (plan) {
    const amount = unit(plan);
    total += amount;
    lines.push({ code: plan.code, name: plan.name, qty: 1, amountMinor: amount });
  }
  for (const row of selectedAddOns) {
    if (included.has(row.code)) continue;
    const item = CATALOG_BY_CODE[row.code];
    if (!item) continue;
    const amount = unit(item) * row.qty;
    total += amount;
    lines.push({ code: row.code, name: item.name, qty: row.qty, amountMinor: amount });
  }
  return {
    planCode,
    planName: plan?.name || planCode,
    billingPeriod: period,
    lines,
    finalAmountMinor: total,
    recommendation: null,
  };
}

export function BillingPage() {
  const { me } = useSession();
  const [data, setData] = useState<any>(me?.billing || null);
  const [catalog, setCatalog] = useState<{ offers?: CatalogItem[]; addOns?: CatalogItem[]; items?: CatalogItem[] } | null>(null);
  const [period, setPeriod] = useState<"MONTHLY" | "YEARLY">("MONTHLY");
  const [planCode, setPlanCode] = useState("");
  const [addons, setAddons] = useState<Record<string, number>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [constructorOpen, setConstructorOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadBilling() {
    const next = await api.billing();
    setData(next);
  }

  useEffect(() => {
    loadBilling().catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить тариф"));
  }, []);

  useEffect(() => {
    api
      .billingPlans(period)
      .then((res) => setCatalog(res as { offers?: CatalogItem[]; addOns?: CatalogItem[]; items?: CatalogItem[] }))
      .catch(() => undefined);
  }, [period]);

  const selectedAddOns = useMemo(
    () => Object.entries(addons).filter(([, qty]) => qty > 0).map(([code, qty]) => ({ code, qty })),
    [addons],
  );

  useEffect(() => {
    if (!planCode) {
      setQuote(null);
      return;
    }
    const fallback = localQuote(planCode, selectedAddOns, period);
    setQuote(fallback);
    let cancelled = false;
    api
      .billingQuote({ planCode, addOns: selectedAddOns, billingPeriod: period })
      .then((res) => {
        if (!cancelled) setQuote(res as Quote);
      })
      .catch(() => {
        if (!cancelled) setQuote(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [planCode, period, selectedAddOns]);

  const preview = Boolean(data?.previewMode);
  const planName = data?.planName || "Не подключён";
  const currentRequest = data?.currentRequest;
  const offers = (catalog?.offers?.length
    ? catalog.offers
    : PUBLIC_OFFERS.map((offer) => {
        const item = CATALOG_BY_CODE[offer.code];
        const price = period === "YEARLY" ? item?.yearlyPriceMinor : item?.monthlyPriceMinor;
        return {
          code: offer.code,
          name: item?.name || offer.title,
          title: offer.title,
          subtitle: offer.subtitle,
          description: item?.description,
          recommended: Boolean("recommended" in offer && offer.recommended),
          price: price ?? null,
          monthlyPriceMinor: item?.monthlyPriceMinor,
          yearlyPriceMinor: item?.yearlyPriceMinor,
          catalogStatus: item?.catalogStatus,
        };
      })) as CatalogItem[];
  const addOnCatalog = (catalog?.addOns?.length
    ? catalog.addOns
    : Object.values(CATALOG_BY_CODE).filter((item) => item.kind === "addon")) as CatalogItem[];

  function setAddonQty(code: string, qty: number) {
    setAddons((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[code];
      else next[code] = qty;
      return next;
    });
  }

  function pickOffer(code: string) {
    setPlanCode(code);
    setConstructorOpen(code.startsWith("CRM_") && code !== "CRM_ENTERPRISE");
    if (code === "BUNDLE_FULL" || code === "BUNDLE_CRM_AI" || code === "AI_SALES" || code === "CONTROL_STANDALONE") {
      setAddons({});
    }
  }

  async function submit(requestType?: string) {
    if (!planCode) {
      setError("Выберите тариф");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.createBillingRequest({
        planCode,
        addOns: selectedAddOns,
        billingPeriod: period,
        ...(requestType ? { requestType } : {}),
      });
      await loadBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить запрос");
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest() {
    if (!currentRequest?.id) return;
    setBusy(true);
    try {
      await api.cancelBillingRequest(currentRequest.id);
      await loadBilling();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отменить запрос");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="billing-page stack">
      <div className="page-head">
        <div>
          <h2>Тариф и оплата</h2>
          <p className="muted">Онлайн-оплата пока не подключена. Вы отправляете запрос, оплачиваете вне системы, администратор BasQar подтверждает оплату и открывает доступ.</p>
        </div>
        <div className="billing-period-toggle">
          <button type="button" className={`btn secondary ${period === "MONTHLY" ? "active" : ""}`} onClick={() => setPeriod("MONTHLY")}>
            Месяц
          </button>
          <button type="button" className={`btn secondary ${period === "YEARLY" ? "active" : ""}`} onClick={() => setPeriod("YEARLY")}>
            Год · 10 месяцев
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {(data?.warnings || []).map((item: { code: string; message: string }) => (
        <p key={item.code} className="warn">{item.message}</p>
      ))}

      <div className="panel stack">
        <h3>Ваш тариф</h3>
        <p>
          {preview ? "Ознакомительный режим" : planName}
          {data?.amountMinor ? ` · ${formatKzt(data.amountMinor)} / ${data.billingPeriod === "YEARLY" ? "год" : "месяц"}` : ""}
        </p>
        <p className="muted">
          Статус: {STATUS_LABEL[data?.subscriptionStatus] || data?.subscriptionStatus || "—"}.
          {data?.expiresAt ? ` Активен до ${formatDate(data.expiresAt)}` : preview ? " Платная подписка не подключена." : ""}
        </p>
        <div className="billing-usage-grid">
          {(data?.usage || []).map((row: { key: string; label: string; used: number; cap: number; unit?: string }) => (
            <div key={row.key} className="billing-usage">
              <div className="billing-usage-label">
                <span>{row.label}</span>
                <span>
                  {row.used} / {row.cap || "—"}
                  {row.unit ? ` ${row.unit}` : ""}
                </span>
              </div>
              <div className="usage-bar">
                <span style={{ width: `${row.cap ? Math.min(100, (row.used / row.cap) * 100) : 0}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="actions">
          {!preview ? (
            <>
              <button className="btn secondary" type="button" onClick={() => setConstructorOpen(true)}>Изменить тариф</button>
              <button className="btn secondary" type="button" onClick={() => void submit("ADD_ADDON")}>Подключить модуль</button>
              <button className="btn" type="button" onClick={() => {
                if (data?.planCode) setPlanCode(data.planCode);
                void submit("RENEWAL");
              }}>Продлить</button>
            </>
          ) : null}
        </div>
      </div>

      {currentRequest ? (
        <div className="panel stack">
          <h3>Ваш запрос</h3>
          <p>
            {currentRequest.planName || currentRequest.planCode} · {formatKzt(currentRequest.finalAmountMinor)} /{" "}
            {currentRequest.billingPeriod === "YEARLY" ? "год" : "месяц"}
          </p>
          <p>
            Статус: <b>{currentRequest.statusLabel || "Ожидает подтверждения оплаты"}</b>
          </p>
          <p className="muted">Запрос на подключение отправлен. Оплатите вне системы и дождитесь подтверждения администратора BasQar.</p>
          <div className="actions">
            <button className="btn secondary" type="button" disabled={busy} onClick={() => void cancelRequest()}>Отменить</button>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="integ-section-title">Тарифы</h3>
        <div className="integ-grid billing-offers">
          {offers.map((offer) => (
            <button
              type="button"
              key={offer.code}
              className={`panel billing-offer ${planCode === offer.code ? "is-selected" : ""} ${offer.recommended ? "is-recommended" : ""}`}
              onClick={() => pickOffer(offer.code)}
            >
              {offer.recommended ? <span className="billing-recommend">Рекомендуем</span> : null}
              <h3>{offer.title || offer.name}</h3>
              <p className="muted">{offer.subtitle || (offer.price != null ? `от ${formatKzt(offer.price)}` : "Индивидуально")}</p>
              <p>{offer.description}</p>
            </button>
          ))}
        </div>
      </div>

      {planCode ? (
        <div className="panel stack">
          <div className="page-head">
            <h3>{quote?.planName || planCode}</h3>
            <button className="btn secondary" type="button" onClick={() => setConstructorOpen((open) => !open)}>
              Настроить под себя
            </button>
          </div>
          {constructorOpen ? (
            <div className="billing-addons">
              {ADDON_GROUPS.map((item) => {
                const meta = addOnCatalog.find((row) => row.code === item.code);
                const soon = meta?.catalogStatus === "COMING_SOON";
                const qty = addons[item.code] || 0;
                return (
                  <label key={item.code} className={`billing-addon ${soon ? "is-soon" : ""}`}>
                    <span>
                      {item.label}
                      {soon ? " · скоро" : ` · ${formatKzt(period === "YEARLY" ? meta?.yearlyPriceMinor : meta?.monthlyPriceMinor)}`}
                    </span>
                    {item.stepper ? (
                      <span className="billing-stepper">
                        <button type="button" disabled={soon} onClick={() => setAddonQty(item.code, Math.max(0, qty - 1))}>−</button>
                        <b>{qty}</b>
                        <button type="button" disabled={soon} onClick={() => setAddonQty(item.code, qty + 1)}>+</button>
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        disabled={soon}
                        checked={qty > 0}
                        onChange={(event) => setAddonQty(item.code, event.target.checked ? 1 : 0)}
                      />
                    )}
                  </label>
                );
              })}
            </div>
          ) : null}
          {quote?.recommendation ? (
            <div className="panel billing-best-value">
              <p>{quote.recommendation.message}</p>
              <button className="btn secondary" type="button" onClick={() => pickOffer(quote.recommendation!.code)}>
                Выбрать {quote.recommendation.name}
              </button>
            </div>
          ) : null}
          <p>
            Итого: <b>{formatKzt(quote?.finalAmountMinor || 0)}</b> / {period === "YEARLY" ? "год" : "месяц"}
          </p>
          <div className="actions">
            <button className="btn" type="button" disabled={busy || !planCode} onClick={() => void submit()}>
              {planCode === "CRM_ENTERPRISE" ? "Отправить запрос" : "Отправить запрос на подключение"}
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Выберите предложение, затем отправьте запрос на подключение. Доступ откроется после подтверждения оплаты администратором.</p>
      )}

      <OnboardingWizard />
      <p className="muted">
        Вопросы по подключению можно задать в <Link to="/today">поддержке</Link> — она доступна и в режиме просмотра.
      </p>
    </section>
  );
}
