import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";
import { AssignIntegrationForm } from "./PlatformAssignIntegration";
import { PlatformCompanyAiManager } from "./PlatformCompanyAiManager";
import { PlatformAiUsagePage } from "./PlatformAiUsagePage";

const TABS = [
  ["info", "Основные данные"],
  ["members", "Участники"],
  ["integrations", "Интеграции"],
  ["ai-manager", "AI Manager"],
  ["ai-usage", "AI Usage"],
  ["settings", "Настройки"],
  ["audit", "История действий"],
] as const;

export function PlatformCompanyPage() {
  const params = useParams();
  const { pathname } = useLocation();
  const id = params.id || pathname.match(/^\/admin\/companies\/([^/]+)$/)?.[1] || "";
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("info");
  const [company, setCompany] = useState<any>(null);
  const [error, setError] = useState("");

  async function load() {
    setCompany(await api.adminCompany(id));
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!company) return <div className="state">Загрузка…</div>;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted"><Link to="/admin/companies">Компании</Link></p>
          <h3>{company.name}</h3>
          <p className="muted">{company.status === "suspended" ? "Приостановлена" : "Активна"} · {company.slug}</p>
        </div>
        <div className="actions">
          {company.status === "active" ? (
            <button className="btn secondary" onClick={async () => {
              setCompany(await api.adminSuspendCompany(id));
              notifySaved("Доступ приостановлен");
            }}>Приостановить</button>
          ) : (
            <button className="btn" onClick={async () => {
              setCompany(await api.adminRestoreCompany(id));
              notifySaved("Доступ восстановлен");
            }}>Восстановить</button>
          )}
        </div>
      </div>
      <nav className="settings-nav horizontal">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>
      {tab === "info" ? <CompanyInfo company={company} onSaved={setCompany} /> : null}
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
      notifySaved("Данные компании сохранены");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }
  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <label>Название<input name="name" defaultValue={company.name} required /></label>
      <label>Юридическое название<input name="legalName" defaultValue={company.legalName || ""} /></label>
      <label>БИН<input name="bin" defaultValue={company.bin || ""} /></label>
      <label>Email<input name="contactEmail" defaultValue={company.contactEmail || ""} /></label>
      <label>Телефон<input name="contactPhone" defaultValue={company.contactPhone || ""} /></label>
      <label>Город<input name="city" defaultValue={company.city || ""} /></label>
      <label>Часовой пояс<input name="timezone" defaultValue={company.timezone || ""} /></label>
      {error ? <p className="error">{error}</p> : null}
      <button className="btn">Сохранить</button>
    </form>
  );
}

function sourceLabel(source: string) {
  return source === "tenant" ? "изменено" : source === "plan" ? "план" : source === "env" ? "инфраструктура" : "по умолчанию сервиса";
}

function CompanySettings({ company, onSaved }: { company: any; onSaved: (row: any) => void }) {
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
      notifySaved("Настройки компании сохранены");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }
  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <p className="muted">Значения сервиса по умолчанию можно переопределить для этой компании. Секреты других компаний не наследуются.</p>
      {(["forms", "webhook", "whatsapp", "documents", "ai", "esf"] as const).map((key) => (
        <label key={key} className="check">
          <input type="checkbox" name={key} defaultChecked={Boolean(features[key]?.value)} />
          {key} <span className="muted">({sourceLabel(features[key]?.source)})</span>
        </label>
      ))}
      <label>Лимит участников<input name="members" type="number" defaultValue={limits.members?.value || 20} /></label>
      <p className="muted">Сейчас: {limits.members?.value} ({sourceLabel(limits.members?.source)})</p>
      <h4>AI компании</h4>
      <label>Провайдер<input name="aiProvider" defaultValue={company.settings?.ai?.provider || ""} /></label>
      <label>Модель<input name="aiModel" defaultValue={company.settings?.ai?.model || ""} /></label>
      <label>Ключ API (не показывается, замена)<input name="aiKey" type="password" autoComplete="off" /></label>
      <p className="muted">Текущий ключ компании {company.settings?.ai?.hasOwnCredential ? "задан" : "не задан, используется инфраструктура сервиса, если AI включён"}.</p>
      {error ? <p className="error">{error}</p> : null}
      <button className="btn">Сохранить настройки</button>
    </form>
  );
}

function CompanyMembers({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<any>(null);
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setData(await api.adminCompanyMembers(tenantId));
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка")); }, [tenantId]);

  if (!data) return <div className="state">Загрузка…</div>;
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
            notifySaved(result.existingUser ? "Ссылка создана. Пользователь уже есть в сервисе — дубликат не создавался." : "Ссылка приглашения создана");
            await load();
            setError("");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Ошибка");
          }
        }}
      >
        <h4>Пригласить</h4>
        <label>Имя<input name="name" /></label>
        <label>Email<input name="email" type="email" required /></label>
        <label>Телефон<input name="phone" /></label>
        <label>
          Роль
          <select name="role" defaultValue="manager">
            <option value="owner">Администратор компании</option>
            <option value="director">Директор</option>
            <option value="sales_lead">Руководитель продаж</option>
            <option value="manager">Менеджер</option>
          </select>
        </label>
        <button className="btn">Создать ссылку</button>
        {inviteUrl ? (
          <p>
            Статус: ссылка создана.{" "}
            <button type="button" className="btn secondary" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Копировать</button>
          </p>
        ) : null}
      </form>
      {error ? <p className="error">{error}</p> : null}
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead><tr><th>Участник</th><th>Email</th><th>Роль</th><th>Статус</th><th>Добавлен</th><th>Вход</th><th></th></tr></thead>
          <tbody>
            {(data.members || []).map((item: any) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.email}</td>
                <td>
                  <select defaultValue={item.role} onChange={async (e) => {
                    try {
                      await api.adminUpdateMember(item.id, { role: e.target.value });
                      notifySaved("Роль изменена");
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Ошибка");
                      await load();
                    }
                  }}>
                    <option value="owner">Администратор компании</option>
                    <option value="director">Директор</option>
                    <option value="sales_lead">Руководитель продаж</option>
                    <option value="manager">Менеджер</option>
                  </select>
                </td>
                <td>{item.active ? "Активен" : "Приостановлен"}</td>
                <td>{formatDateTime(item.createdAt)}</td>
                <td>{item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "—"}</td>
                <td className="actions">
                  <button className="btn secondary" onClick={async () => {
                    await api.adminUpdateMember(item.id, { active: !item.active });
                    notifySaved(item.active ? "Участие приостановлено" : "Участие восстановлено");
                    await load();
                  }}>{item.active ? "Приостановить" : "Восстановить"}</button>
                  <button className="btn secondary" onClick={async () => {
                    await api.adminRevokeMemberSessions(item.id);
                    notifySaved("Сессии пользователя завершены во всех компаниях");
                  }}>Завершить сессии</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Приглашения</h4>
      {(data.invitations || []).map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.email}</b>
            <div className="muted">{item.roleLabel} · {item.status} · до {formatDateTime(item.expiresAt)}</div>
          </div>
          {item.status === "pending" || item.status === "expired" ? (
            <div className="actions">
              <button className="btn secondary" onClick={async () => {
                const result = (await api.adminRepeatInvitation(item.id)) as any;
                await navigator.clipboard.writeText(result.inviteUrl).catch(() => undefined);
                notifySaved("Ссылка создана и скопирована");
              }}>Повторить</button>
              <button className="btn secondary" onClick={async () => { await api.adminRevokeInvitation(item.id); notifySaved("Приглашение отозвано"); await load(); }}>Отозвать</button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CompanyIntegrations({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [events, setEvents] = useState<any[] | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    setData(await api.adminCompanyIntegrations(tenantId));
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка")); }, [tenantId]);
  if (!data) return <div className="state">Загрузка…</div>;
  const connectable = (data.catalog || []).filter((item: any) => item.connectable);
  const companies = [{ id: tenantId, name: "Эта компания", integrationTypes: (data.items || []).map((row: any) => row.type) }];

  return (
    <div className="stack">
      {(data.needsAssignment || []).length ? (
        <p className="error">Есть подключения без назначения этой компании. Общие секреты сервера не используются автоматически.</p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
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
              <b>Как подключить</b>
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
              <div className="muted">{item.type} · {item.lifecycleLabel}</div>
            </div>
            <div className="actions">
              <button className="btn secondary" onClick={async () => {
                const result = (await api.adminTestCompanyIntegration(tenantId, item.id)) as any;
                setNote(result.message);
                await load();
              }}>Проверить</button>
              {item.type === "webhook" ? (
                <button className="btn secondary" onClick={async () => {
                  const result = (await api.adminRotateCompanyWebhook(tenantId, item.id)) as any;
                  setNote(`${result.note || "Ключ заменён"} ${result.secret || ""}`);
                  notifySaved("Ключ заменён. Значение в журнал не записано.");
                }}>Заменить ключ</button>
              ) : null}
              <button className="btn secondary" onClick={async () => {
                await api.adminDisableCompanyIntegration(tenantId, item.id, item.lifecycle !== "disabled");
                notifySaved(item.lifecycle === "disabled" ? "Включено" : "Отключено");
                await load();
              }}>{item.lifecycle === "disabled" ? "Включить" : "Отключить"}</button>
              <button className="btn secondary" onClick={async () => {
                const result = (await api.adminCompanyIntegrationEvents(tenantId, item.id)) as any;
                setEvents(result.items || []);
              }}>События</button>
            </div>
          </div>
          {item.schema?.instanceId ? <p className="muted">Instance: {item.schema.instanceId}</p> : null}
          {item.forms?.[0]?.submitUrl ? <p className="muted">Форма: {item.forms[0].submitUrl}</p> : null}
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
      {note ? <p className="ok">{note}</p> : null}
      {events ? (
        <div className="panel">
          <h4>История событий</h4>
          {events.length === 0 ? <p className="muted">Пока нет событий</p> : events.map((item) => (
            <p key={item.id} className="muted">{formatDateTime(item.receivedAt)} · {item.status} · {item.lastError || item.eventType}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CompanyAudit({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api.adminAudit({ tenantId, limit: 50 }).then(setData).catch(() => setData({ items: [] }));
  }, [tenantId]);
  if (!data) return <div className="state">Загрузка…</div>;
  return (
    <div className="stack">
      {(data.items || []).map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.action}</b>
            <div className="muted">{formatDateTime(item.createdAt)} · {item.actor?.email || "система"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
