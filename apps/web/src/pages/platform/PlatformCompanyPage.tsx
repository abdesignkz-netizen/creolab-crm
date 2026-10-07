import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions, uiMessage, uiFormatLocale } from "../../lib/uiText";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";
import { statusBadgeClass } from "../../lib/statusBadge";
import { AssignIntegrationForm } from "./PlatformAssignIntegration";
import { PlatformCompanyAiManager } from "./PlatformCompanyAiManager";
import { PlatformAiUsagePage } from "./PlatformAiUsagePage";
import { LIMIT_LABEL, type LimitKey } from "@creolab/contracts";

const EDITABLE_LIMITS = ["USERS", "WHATSAPP_CONNECTIONS", "AI_CREDITS", "AUTOMATION_RUNS", "DOCUMENTS_COUNT", "CAMPAIGN_RECIPIENTS", "STORAGE_GB"] as const;

const TABS = [
  ["info", "Основные данные"],
  ["subscription", "Подписка"],
  ["members", "Участники"],
  ["integrations", "Интеграции"],
  ["ai-manager", "AI-менеджер"],
  ["ai-usage", "Расход AI"],
  ["settings", "Настройки"],
  ["audit", "История действий"],
] as const;

export function PlatformCompanyPage() {
  const uiText = useUiText();
  const params = useParams();
  const { pathname, search } = useLocation();
  const id = params.id || pathname.match(/^\/admin\/companies\/([^/]+)$/)?.[1] || "";
  const [tab, setTab] = useState<(typeof TABS)[number][0]>(() => new URLSearchParams(search).get("tab") === "ai-manager" ? "ai-manager" : "info");
  const [company, setCompany] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setTab(new URLSearchParams(search).get("tab") === "ai-manager" ? "ai-manager" : "info");
  }, [id, search]);

  async function load() {
    setCompany(await api.adminCompany(id));
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, [id]);

  if (error) return <InlineFeedback kind="error" className="error">{error}</InlineFeedback>;
  if (!company) return <div className="state">{uiText("Загрузка…")}</div>;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted"><Link to="/admin/companies">{uiText("Компании")}</Link></p>
          <h3>{company.name}</h3>
          <p className="muted integ-status-line">
            <span className={statusBadgeClass(company.status === "suspended" ? "Приостановлена" : "Активна")}>
              {company.status === "suspended" ? uiText("Приостановлена") : uiText("Активна")}
            </span>
            {company.subscriptionStatus === "none" ? uiText(" · режим просмотра") : company.planName ? ` · ${company.planName}` : ""}
            {company.slug}
          </p>
        </div>
        <div className="actions">
          {company.status === "active" ? (
            <button className="btn secondary" onClick={async () => {
              setCompany(await api.adminSuspendCompany(id));
              notifySaved(uiText("Доступ приостановлен"));
            }}>{uiText("Приостановить")}</button>
          ) : (
            <button className="btn" onClick={async () => {
              setCompany(await api.adminRestoreCompany(id));
              notifySaved(uiText("Доступ восстановлен"));
            }}>{uiText("Восстановить")}</button>
          )}
          {company.subscriptionStatus === "none" || company.previewMode ? (
            <button className="btn" onClick={async () => {
              const billing = (await api.adminActivateSubscription(id)) as {
                subscriptionStatus?: string;
                previewMode?: boolean;
                planName?: string;
              };
              setCompany({ ...company, ...billing, subscriptionStatus: billing.subscriptionStatus, previewMode: billing.previewMode, planName: billing.planName });
              notifySaved(uiText("Тариф активирован"));
            }}>{uiText("Активировать тариф")}</button>
          ) : null}
        </div>
      </div>
      <nav className="settings-nav horizontal">
        {localizeUiOptions(TABS, uiText).map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      {tab === "info" ? <CompanyInfo company={company} onSaved={setCompany} /> : null}
      {tab === "subscription" ? <CompanySubscription company={company} onSaved={setCompany} /> : null}
      {tab === "members" ? <CompanyMembers tenantId={id} /> : null}
      {tab === "integrations" ? <CompanyIntegrations tenantId={id} /> : null}
      {tab === "ai-manager" ? <PlatformCompanyAiManager tenantId={id} /> : null}
      {tab === "ai-usage" ? <PlatformAiUsagePage lockedTenantId={id} /> : null}
      {tab === "settings" ? <CompanySettings company={company} onSaved={setCompany} /> : null}
      {tab === "audit" ? <CompanyAudit tenantId={id} /> : null}
    </div>
  );
}

function CompanyInfo({ company, onSaved }: { company: any; onSaved: (row: any) => void }) {
  const uiText = useUiText();
  const [error, setError] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      onSaved(await api.adminUpdateCompany(company.id, {
        name: String(form.get("name") || ""),
        legalName: String(form.get("legalName") || ""),
        bin: String(form.get("bin") || ""),
        contactEmail: String(form.get("contactEmail") || ""),
        contactPhone: String(form.get("contactPhone") || ""),
        city: String(form.get("city") || ""),
        timezone: String(form.get("timezone") || ""),
      }));
      notifySaved(uiText("Данные компании сохранены"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }
  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <p className="muted">
        {uiText("Владелец:")}{" "}{company.owner?.name || "—"} · {company.ownerEmail || company.owner?.email || "—"}
      </p>
      <p className="muted">
        {uiText("Подписка:")}{" "}{company.subscriptionStatus || "—"}
        {company.planName ? ` · ${company.planName}` : ""}
        {company.whatsappConnected ? uiText(" · WhatsApp подключён") : uiText(" · WhatsApp не подключён")}
        {company.aiEnabled ? uiText(" · AI включён") : uiText(" · AI выключен")}
        {company.onboardingStatus ? ` · onboarding: ${company.onboardingStatus}` : ""}
      </p>
      <label>{uiText("Название")}<input name="name" defaultValue={company.name} required /></label>
      <label>{uiText("Юридическое название")}<input name="legalName" defaultValue={company.legalName || ""} /></label>
      <label>{uiText("БИН")}<input name="bin" defaultValue={company.bin || ""} /></label>
      <label>Email<input name="contactEmail" defaultValue={company.contactEmail || ""} /></label>
      <label>{uiText("Телефон")}<input name="contactPhone" defaultValue={company.contactPhone || ""} /></label>
      <label>{uiText("Город")}<input name="city" defaultValue={company.city || ""} /></label>
      <label>{uiText("Часовой пояс")}<input name="timezone" defaultValue={company.timezone || ""} /></label>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <button className="btn">{uiText("Сохранить")}</button>
    </form>
  );
}

function CompanySubscription({ company, onSaved }: { company: any; onSaved: (row: any) => void }) {
  const uiText = useUiText();
  const [planCode, setPlanCode] = useState(company.planCode && company.planCode !== "starter" ? company.planCode : "CRM_START");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [overrideError, setOverrideError] = useState("");

  async function run(label: string, fn: () => Promise<any>) {
    setBusy(label);
    setError("");
    try {
      await fn();
      onSaved(await api.adminCompany(company.id));
      notifySaved(uiText("Подписка обновлена"));
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="panel stack">
      <h3>{uiText("Подписка")}</h3>
      {company.accessBreakdown ? <details><summary>{uiText("Источники доступа и лимитов")}</summary>
        <p>Base plan: {company.accessBreakdown.basePlan || "Grandfathered"} · Legacy: {company.accessBreakdown.legacy ? uiText("да") : uiText("нет")} · Grandfathered: {company.accessBreakdown.grandfathered ? uiText("да") : uiText("нет")}</p>
        {[["Base features", company.accessBreakdown.baseFeatures], ["Base limits", company.accessBreakdown.baseLimits], ["Addons", company.accessBreakdown.addOns], ["Overrides", company.accessBreakdown.overrides], [uiText("Согласованные функции"), company.accessBreakdown.subscriptionFeatures], [uiText("Согласованные лимиты"), company.accessBreakdown.subscriptionLimits], ["Effective features", company.accessBreakdown.effectiveFeatures], ["Effective limits", company.accessBreakdown.effectiveLimits], ["Enterprise custom settings", company.enterpriseTerms]].map(([label,value]) => <div key={String(label)}><b>{String(label)}</b><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{value == null ? uiText("Отдельный снимок отсутствует в прежнем договоре") : JSON.stringify(value,null,2)}</pre></div>)}
      </details> : null}
      <p>{uiText("Тариф:")}{" "}<b>{company.planName || uiText("Нет")}</b></p>
      <p>{uiText("Статус:")}{" "}<b>{company.subscriptionStatus || "—"}</b></p>
      <p>{uiText("Стоимость:")}{" "}{company.amountMinor != null ? `${Number(company.amountMinor).toLocaleString(uiFormatLocale())} ₸` : "—"}</p>
      <p>{uiText("Начало:")}{" "}{company.activatedAt ? new Date(company.activatedAt).toLocaleDateString(uiFormatLocale()) : "—"}</p>
      <p>{uiText("Окончание:")}{" "}{company.expiresAt ? new Date(company.expiresAt).toLocaleDateString(uiFormatLocale()) : "—"}</p>
      <p>{uiText("Оплата:")}{" "}{company.paymentMethod === "MANUAL" ? uiText("Подтверждена вручную") : company.paymentMethod || "—"}</p>
      <p>{uiText("Подтвердил:")}{" "}{company.confirmedBy?.name || "—"}</p>
      {company.currentRequest ? (
        <p className="muted">
          {uiText("Открытый запрос:")}{" "}{company.currentRequest.planName} · {uiMessage(company.currentRequest.statusLabel)} ·{" "}
          <Link to="/admin/billing">{uiText("открыть")}</Link>
        </p>
      ) : null}
      {(company.usage || []).map((row: { key: string; label: string; used: number; cap: number }) => (
        <p key={row.key} className="muted">{row.label}: {row.used} / {row.cap < 0 ? uiText("Без квоты") : row.cap}</p>
      ))}
      <form className="panel stack" onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const limits: Record<string, number> = {};
        for (const key of EDITABLE_LIMITS) {
          const value = String(form.get(key) || "").trim();
          if (value) limits[key] = Number(value);
        }
        try {
          setBusy("override");
          setOverrideError("");
          const messaging = String(form.get("MASS_MESSAGING") || "keep");
          const features = messaging === "keep" ? {} : { MASS_MESSAGING: messaging === "on", MASS_CAMPAIGNS: messaging === "on" };
          const price = String(form.get("customPriceMinor") || "").trim();
          await api.adminBillingOverride(company.id, { merge: true, limits, features,
            ...(price ? { customPriceMinor: Number(price) } : {}),
            grantAiCredits: Number(form.get("grantAiCredits") || 0), reason: String(form.get("reason") || "") });
          onSaved(await api.adminCompany(company.id));
          notifySaved(uiText("Индивидуальные лимиты сохранены"));
        } catch (err) { setOverrideError(err instanceof Error ? err.message : uiText("Ошибка")); }
        finally { setBusy(""); }
      }}>
        <h4>{uiText("Индивидуальные лимиты и функции")}</h4>
        <p className="muted">{uiText("Пустое поле сохраняет текущие условия, включая ранее согласованные лимиты. −1 означает без квоты.")}</p>
        {EDITABLE_LIMITS.map((key) => <label key={key}>{LIMIT_LABEL[key as LimitKey]}<input name={key} type="number" min="-1" step={key === "STORAGE_GB" ? "0.01" : "1"} placeholder={uiText("Сейчас: {p0}", {p0: company.accessBreakdown?.effectiveLimits?.[key] ?? uiText("по тарифу")})} /></label>)}
        <label>{uiText("Дополнительные AI-кредиты")}<input name="grantAiCredits" type="number" min="0" step="1" placeholder="0" /></label>
        <p className="muted">{uiText("Увеличивает согласованный лимит AI. На Free пакет остаётся разовым, на платном тарифе — ежемесячным.")}</p>
        <label>{uiText("Индивидуальная цена за период, ₸")}<input name="customPriceMinor" type="number" min="0" step="1" placeholder={uiText("Без изменения")} /></label>
        <label>{uiText("Массовые рассылки")}<select name="MASS_MESSAGING" defaultValue="keep"><option value="keep">{uiText("Без изменения")}</option><option value="on">{uiText("Разрешить")}</option><option value="off">{uiText("Запретить")}</option></select></label>
        <label>{uiText("Причина")}<input name="reason" placeholder={uiText("Причина изменения")} /></label>
        {overrideError ? <InlineFeedback kind="error" className="error">{overrideError}</InlineFeedback> : null}
        <button className="btn secondary" type="submit" disabled={Boolean(busy)}>{uiText("Сохранить индивидуальные настройки")}</button>
      </form>
      <label>
        {uiText("Тариф")}<select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
          <option value="BASQAR_FREE">BasQar Free</option>
          <option value="CRM_START">BasQar Start</option>
          <option value="CONTROL">BasQar Business</option>
          <option value="SALES">BasQar Pro</option>
          {company.planCode === 'FULL' ? <option value="FULL">{uiText("Full (действующий договор)")}</option> : null}
          {company.accessBreakdown?.legacy ? <option value={company.planCode}>{company.planName} {" "}{uiText("(legacy, продление по договору)")}</option> : null}
          <option value="CRM_ENTERPRISE">Enterprise</option>
        </select>
      </label>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <div className="actions" style={{ flexWrap: "wrap" }}>
        <button className="btn" disabled={Boolean(busy)} onClick={() => void run("plan", () => api.adminActivateSubscription(company.id, { planCode, source: "platform_admin", reason: "Ручная активация" }))}>{uiText("Изменить тариф")}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run("extend", () => api.adminExtendSubscription(company.id, { reason: "Продление администратором" }))}>{uiText("Продлить")}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run("suspend", () => api.adminSuspendSubscription(company.id, { reason: "Приостановлено администратором" }))}>{uiText("Приостановить")}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run("reactivate", () => api.adminReactivateSubscription(company.id, { reason: "Восстановлено администратором" }))}>{uiText("Активировать")}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run("free", () => api.adminActivateSubscription(company.id, { planCode, source: "complimentary", reason: "Бесплатный период" }))}>{uiText("Дать бесплатный период")}</button>
      </div>
    </div>
  );
}

function sourceLabel(source: string) {
  return source === "tenant" ? uiText("изменено") : source === "plan" ? uiText("план") : source === "env" ? uiText("инфраструктура") : uiText("по умолчанию сервиса");
}

function CompanySettings({ company, onSaved }: { company: any; onSaved: (row: any) => void }) {
  const uiText = useUiText();
  const features = company.settings?.features || {};
  const limits = company.settings?.limits || {};
  const [error, setError] = useState("");
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const saved = (await api.adminUpdateCompany(company.id, {
        features: {
          forms: form.get("forms") === "on",
          webhook: form.get("webhook") === "on",
          whatsapp: form.get("whatsapp") === "on",
          documents: form.get("documents") === "on",
          ai: form.get("ai") === "on",
          esf: form.get("esf") === "on",
        },
        limits: {
          members: Number(form.get("members") || limits.members?.value || 20),
        },
        documentsEnabled: form.get("documents") === "on",
        esfIntegrationEnabled: form.get("esf") === "on",
      })) as any;
      const ai = (await api.adminUpdateCompanyAi(company.id, {
        provider: String(form.get("aiProvider") || ""),
        model: String(form.get("aiModel") || ""),
        enabled: form.get("ai") === "on",
        apiKey: String(form.get("aiKey") || ""),
      })) as any;
      onSaved({ ...saved, settings: { ...saved.settings, ai: ai.ai } });
      notifySaved(uiText("Настройки компании сохранены"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }
  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <p className="muted">{uiText("Значения сервиса по умолчанию можно переопределить для этой компании. Секреты других компаний не наследуются.")}</p>
      {(["forms", "webhook", "whatsapp", "documents", "ai", "esf"] as const).map((key) => (
        <label key={key} className="check">
          <input type="checkbox" name={key} defaultChecked={Boolean(features[key]?.value)} />
          {key} <span className="muted">({sourceLabel(features[key]?.source)})</span>
        </label>
      ))}
      <label>{uiText("Лимит участников")}<input name="members" type="number" defaultValue={limits.members?.value || 20} /></label>
      <p className="muted">{uiText("Сейчас:")}{" "}{limits.members?.value} ({sourceLabel(limits.members?.source)})</p>
      <h4>{uiText("AI компании")}</h4>
      <label>{uiText("Провайдер")}<input name="aiProvider" defaultValue={company.settings?.ai?.provider || ""} /></label>
      <label>{uiText("Модель")}<input name="aiModel" defaultValue={company.settings?.ai?.model || ""} /></label>
      <label>{uiText("Ключ API (не показывается, замена)")}<input name="aiKey" type="password" autoComplete="off" /></label>
      <p className="muted">{uiText("Текущий ключ компании")}{" "}{company.settings?.ai?.hasOwnCredential ? uiText("задан") : uiText("не задан, используется инфраструктура сервиса, если AI включён")}.</p>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <button className="btn">{uiText("Сохранить настройки")}</button>
    </form>
  );
}

function CompanyMembers({ tenantId }: { tenantId: string }) {
  const uiText = useUiText();
  const [data, setData] = useState<any>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setData(await api.adminCompanyMembers(tenantId));
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка"))); }, [tenantId]);

  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;
  return (
    <div className="stack">
      <form
        className="panel stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          try {
            const result = (await api.adminInviteMember(tenantId, {
              email: String(form.get("email") || ""),
              name: String(form.get("name") || ""),
              phone: String(form.get("phone") || ""),
              role: String(form.get("role") || "manager"),
            })) as any;
            setInviteUrl(result.inviteUrl);
            notifySaved(result.existingUser ? uiText("Ссылка создана. Пользователь уже есть в сервисе — дубликат не создавался.") : uiText("Ссылка приглашения создана"));
            await load();
            setError("");
          } catch (err) {
            setError(err instanceof Error ? err.message : uiText("Ошибка"));
          }
        }}
      >
        <h4>{uiText("Пригласить")}</h4>
        <label>{uiText("Имя")}<input name="name" /></label>
        <label>Email<input name="email" type="email" required /></label>
        <label>{uiText("Телефон")}<input name="phone" /></label>
        <label>
          {uiText("Роль")}<select name="role" defaultValue="manager">
            <option value="owner">{uiText("Администратор компании")}</option>
            <option value="director">{uiText("Директор")}</option>
            <option value="sales_lead">{uiText("Руководитель продаж")}</option>
            <option value="manager">{uiText("Менеджер")}</option>
          </select>
        </label>
        <button className="btn">{uiText("Создать ссылку")}</button>
        {inviteUrl ? (
          <p>
            {uiText("Статус: ссылка создана.")}{" "}
            <button type="button" className="btn secondary" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>{uiText("Копировать")}</button>
          </p>
        ) : null}
      </form>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead><tr><th>{uiText("Участник")}</th><th>Email</th><th>{uiText("Роль")}</th><th>{uiText("Статус")}</th><th>{uiText("Добавлен")}</th><th>{uiText("Вход")}</th><th></th></tr></thead>
          <tbody>
            {(data.members || []).map((item: any) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.email}</td>
                <td>
                  <select defaultValue={item.role} onChange={async (e) => {
                    try {
                      await api.adminUpdateMember(item.id, { role: e.target.value });
                      notifySaved(uiText("Роль изменена"));
                    } catch (err) {
                      setError(err instanceof Error ? err.message : uiText("Ошибка"));
                      await load();
                    }
                  }}>
                    <option value="owner">{uiText("Администратор компании")}</option>
                    <option value="director">{uiText("Директор")}</option>
                    <option value="sales_lead">{uiText("Руководитель продаж")}</option>
                    <option value="manager">{uiText("Менеджер")}</option>
                  </select>
                </td>
                <td>
                  <span className={statusBadgeClass(item.active ? "Активен" : "Приостановлен")}>
                    {item.active ? uiText("Активен") : uiText("Приостановлен")}
                  </span>
                </td>
                <td>{formatDateTime(item.createdAt)}</td>
                <td>{item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "—"}</td>
                <td className="actions">
                  <button className="btn secondary" onClick={async () => {
                    await api.adminUpdateMember(item.id, { active: !item.active });
                    notifySaved(item.active ? uiText("Участие приостановлено") : uiText("Участие восстановлено"));
                    await load();
                  }}>{item.active ? uiText("Приостановить") : uiText("Восстановить")}</button>
                  <button className="btn secondary" onClick={async () => {
                    await api.adminRevokeMemberSessions(item.id);
                    notifySaved(uiText("Сессии пользователя завершены во всех компаниях"));
                  }}>{uiText("Завершить сессии")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>{uiText("Приглашения")}</h4>
      {(data.invitations || []).map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.email}</b>
            <div className="muted">{item.roleLabel} · {item.status} {" "}{uiText("· до")}{" "}{formatDateTime(item.expiresAt)}</div>
          </div>
          {item.status === "pending" || item.status === "expired" ? (
            <div className="actions">
              <button className="btn secondary" onClick={async () => {
                const result = (await api.adminRepeatInvitation(item.id)) as any;
                await navigator.clipboard.writeText(result.inviteUrl).catch(() => undefined);
                notifySaved(uiText("Ссылка создана и скопирована"));
              }}>{uiText("Повторить")}</button>
              <button className="btn secondary" onClick={async () => { await api.adminRevokeInvitation(item.id); notifySaved(uiText("Приглашение отозвано")); await load(); }}>{uiText("Отозвать")}</button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CompanyIntegrations({ tenantId }: { tenantId: string }) {
  const uiText = useUiText();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<any[] | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    setData(await api.adminCompanyIntegrations(tenantId));
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка"))); }, [tenantId]);
  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;
  const connectable = (data.catalog || []).filter((item: any) => item.connectable);
  const companies = [{ id: tenantId, name: "Эта компания", integrationTypes: (data.items || []).map((row: any) => row.type) }];

  return (
    <div className="stack">
      {(data.needsAssignment || []).length ? (
        <p className="error">{uiText("Есть подключения без назначения этой компании. Общие секреты сервера не используются автоматически.")}</p>
      ) : null}
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {connectable.map((item: any) => (
        <div className="panel stack" key={item.type}>
          <div className="page-head">
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.type}</div>
            </div>
          </div>
          {(item.steps || []).length ? (
            item.type === "form" ? (
              <p className="muted">{(item.steps as string[])[0]}</p>
            ) : (
            <div className="notify-steps">
              <b>{uiText("Как подключить")}</b>
              <ol>
                {(item.steps as string[]).map((step: string) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
            )
          ) : null}
          <AssignIntegrationForm item={item} companies={companies} lockedTenantId={tenantId} />
        </div>
      ))}
      {(data.items || []).map((item: any) => (
        <div className="panel stack" key={item.id}>
          <div className="page-head">
            <div>
              <b>{item.name}</b>
              <div className="muted">{item.type} · {uiMessage(item.lifecycleLabel)}</div>
            </div>
            <div className="actions">
              <button className="btn secondary" onClick={async () => {
                const result = (await api.adminTestCompanyIntegration(tenantId, item.id)) as any;
                setNote(result.message);
                await load();
              }}>{uiText("Проверить")}</button>
              {item.type === "webhook" ? (
                <button className="btn secondary" onClick={async () => {
                  const result = (await api.adminRotateCompanyWebhook(tenantId, item.id)) as any;
                  setNote(`${result.note || uiText("Ключ заменён")} ${result.secret || ""}`);
                  notifySaved(uiText("Ключ заменён. Значение в журнал не записано."));
                }}>{uiText("Заменить ключ")}</button>
              ) : null}
              <button className="btn secondary" onClick={async () => {
                await api.adminDisableCompanyIntegration(tenantId, item.id, item.lifecycle !== "disabled");
                notifySaved(item.lifecycle === "disabled" ? uiText("Включено") : uiText("Отключено"));
                await load();
              }}>{item.lifecycle === "disabled" ? uiText("Включить") : uiText("Отключить")}</button>
              <button className="btn secondary" onClick={async () => {
                const result = (await api.adminCompanyIntegrationEvents(tenantId, item.id)) as any;
                setEvents(result.items || []);
              }}>{uiText("События")}</button>
            </div>
          </div>
          {item.schema?.instanceId ? <p className="muted">Instance: {item.schema.instanceId}</p> : null}
          {item.forms?.[0]?.submitUrl ? <p className="muted">{uiText("Форма:")}{" "}{item.forms[0].submitUrl}</p> : null}
          {item.eventsUrl ? <p className="muted">Webhook: {item.eventsUrl}</p> : null}
          {item.lastError ? <p className="error">{item.lastError}</p> : null}
        </div>
      ))}
      {(data.esf || []).map((item: any) => (
        <div className="panel" key={item.id}>
          <b>{item.name}</b>
          <p className="muted">{item.lifecycle} · {item.connectHint}</p>
          {item.lastErrorMessage ? <p className="error">{item.lastErrorMessage}</p> : null}
        </div>
      ))}
      {note ? <InlineFeedback kind="success" className="ok">{note}</InlineFeedback> : null}
      {events ? (
        <div className="panel">
          <h4>{uiText("История событий")}</h4>
          {events.length === 0 ? <p className="muted">{uiText("Пока нет событий")}</p> : events.map((item) => (
            <p key={item.id} className="muted">{formatDateTime(item.receivedAt)} · {item.status} · {item.lastError || item.eventType}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CompanyAudit({ tenantId }: { tenantId: string }) {
  const uiText = useUiText();
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api.adminAudit({ tenantId, limit: 50 }).then(setData).catch(() => setData({ items: [] }));
  }, [tenantId]);
  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;
  return (
    <div className="stack">
      {(data.items || []).map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.action}</b>
            <div className="muted">{formatDateTime(item.createdAt)} · {item.actor?.email || uiText("система")}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
