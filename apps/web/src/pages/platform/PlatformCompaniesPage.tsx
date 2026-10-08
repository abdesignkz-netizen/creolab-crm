import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { Pagination } from "../../components/Pagination";
import { useRequestVersion } from "../../lib/useUrlState";
import "../../platform-workspace.css";
import { notifySaved } from "../../components/SaveNotice";
import { statusBadgeClass } from "../../lib/statusBadge";

const STATUS_LABEL: Record<string, string> = {
  active: "Активна",
  suspended: "Приостановлена",
};

const CONNECTION_LABEL: Record<string, string> = {
  not_configured: "Не настроено",
  needs_assignment: "Требуется назначение",
  pending_auth: "Ожидает авторизации",
  checking: "Проверяется",
  created: "Создано",
  working: "Работает",
  connected: "Подключено",
  reauth: "Нужна повторная авторизация",
  error: "Ошибка",
  disabled: "Отключено",
};

export function PlatformCompaniesPage({ mode }: { mode: "list" | "new" }) {
  if (mode === "new") return <CreateCompanyForm />;
  return <CompanyList />;
}

function CompanyList() {
  const uiText = useUiText();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState({ q: "", status: "", page: 1 });
  const version = useRequestVersion();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load() {
    const request = ++version.current;
    setError(""); setLoading(true);
    try {
      const result = await api.adminTenants({ ...query, limit: 20 });
      if (request === version.current) setData(result);
    } catch (err) {
      if (request === version.current) setError(err instanceof Error ? err.message : uiText("Ошибка"));
    } finally { if (request === version.current) setLoading(false); }
  }

  useEffect(() => { void load(); }, [query]);

  return (
    <div className="stack platform-workspace">
      <div className="page-head">
        <h2>{uiText("Компании")}</h2>
        <Link className="btn" to="/admin/companies/new">{uiText("Добавить компанию")}</Link>
      </div>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({ q: q.trim(), status, page: 1 });
        }}
      >
        <input aria-label={uiText("Поиск по названию")} value={q} onChange={(e) => setQ(e.target.value)} placeholder={uiText("Поиск по названию")} />
        <select value={status} aria-label={uiText("Статус")} onChange={(e) => { setStatus(e.target.value); setQuery({ q: q.trim(), status: e.target.value, page: 1 }); }}>
          <option value="">{uiText("Все статусы")}</option>
          <option value="active">{uiText("Активные")}</option>
          <option value="suspended">{uiText("Приостановленные")}</option>
        </select>
        <button className="btn secondary" type="submit" disabled={loading}>{uiText("Найти")}</button>
      </form>
      {error ? <InlineFeedback kind="error" className="error" message={error}>{error}<button type="button" className="btn secondary" onClick={() => void load()}>{uiText("Повторить")}</button></InlineFeedback> : null}
      {!data && loading ? <div className="state">{uiText("Загрузка…")}</div> : data ? (
        <>
          <Pagination total={data.total} offset={(data.page - 1) * data.pageSize} limit={data.pageSize} loading={loading} onChange={offset => setQuery(current => ({ ...current, page: offset / data.pageSize + 1 }))} />
          {!data.items.length ? <div className="empty"><b>{uiText("Компании не найдены")}</b><p>{uiText("Измените запрос или сбросьте фильтры.")}</p><button className="btn secondary" type="button" onClick={() => { setQ(""); setStatus(""); setQuery({ q: "", status: "", page: 1 }); }}>{uiText("Сбросить фильтры")}</button></div> : <div className="stats-table-wrap platform-directory" aria-busy={loading}>
            <table className="stats-table">
              <thead><tr><th>{uiText("Компания")}</th><th>{uiText("Тариф")}</th><th>{uiText("Подключения")}</th><th>{uiText("Статус")}</th><th>{uiText("Действия")}</th></tr></thead>
              <tbody>{data.items.map((item: any) => <tr key={item.id}>
                <td data-label={uiText("Компания")}><Link to={`/admin/companies/${item.id}`}><strong>{item.name}</strong></Link><div className="muted">{item.owner?.email || item.admin?.email || item.contactEmail || "—"}</div>{item.contactPhone ? <div className="muted">{item.contactPhone}</div> : null}</td>
                <td data-label={uiText("Тариф")}>{item.subscriptionStatus === "none" || item.previewMode ? uiText("Просмотр") : item.planName || item.subscriptionStatus || "—"}<div className="muted">{uiText("Участники")}: {item.memberCount}</div></td>
                <td data-label={uiText("Подключения")}>{item.connectionSummary?.length ? [...new Set<string>(item.connectionSummary)].map(status => uiText(CONNECTION_LABEL[status] || status)).join(" · ") : uiText("нет")}</td>
                <td data-label={uiText("Статус")}><span className={statusBadgeClass(STATUS_LABEL[item.status] || item.status)}>{localizeUiOptions(STATUS_LABEL, uiText)[item.status] || item.status}</span></td>
                <td data-label={uiText("Действия")}><div className="platform-row-actions"><Link className="btn secondary" to={`/admin/companies/${item.id}`}>{uiText("Открыть")}</Link><Link to={`/admin/ai-managers/${item.id}`}>{uiText("Промт и база")}</Link></div></td>
              </tr>)}</tbody>
            </table>
          </div>}

        </>
      ) : null}
    </div>
  );
}

function CreateCompanyForm() {
  const uiText = useUiText();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setFieldErrors({});
    try {
      const result = (await api.adminCreateCompany({
        name: String(form.get("name") || ""),
        legalName: String(form.get("legalName") || ""),
        bin: String(form.get("bin") || ""),
        contactEmail: String(form.get("contactEmail") || ""),
        contactPhone: String(form.get("contactPhone") || ""),
        city: String(form.get("city") || ""),
        timezone: String(form.get("timezone") || "Asia/Almaty"),
        adminName: String(form.get("adminName") || ""),
        adminEmail: String(form.get("adminEmail") || ""),
        adminPhone: String(form.get("adminPhone") || ""),
        adminRole: String(form.get("adminRole") || "owner"),
      })) as any;
      notifySaved(uiText("Компания создана. Ссылка приглашения создана, письмо не отправлялось."));
      if (result.invitation?.inviteUrl) {
        await navigator.clipboard.writeText(result.invitation.inviteUrl).catch(() => undefined);
      }
      navigate(`/admin/companies/${result.company.id}`);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : uiText("Не удалось создать"));
      setFieldErrors(err?.body?.field_errors || {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <h3>{uiText("Новая компания")}</h3>
      <label>{uiText("Название *")}<input name="name" required />{fieldErrors.name ? <p className="field-error">{fieldErrors.name}</p> : null}</label>
      <label>{uiText("Юридическое название")}<input name="legalName" /></label>
      <label>{uiText("БИН/ИИН")}<input name="bin" />{fieldErrors.bin ? <p className="field-error">{fieldErrors.bin}</p> : null}</label>
      <label>{uiText("Контактный email")}<input name="contactEmail" type="email" /></label>
      <label>{uiText("Телефон")}<input name="contactPhone" /></label>
      <label>{uiText("Город")}<input name="city" /></label>
      <label>{uiText("Часовой пояс")}<input name="timezone" defaultValue="Asia/Almaty" /></label>
      <h4>{uiText("Первый администратор / директор")}</h4>
      <label>{uiText("Имя")}<input name="adminName" /></label>
      <label>Email *<input name="adminEmail" type="email" required />{fieldErrors.adminEmail ? <p className="field-error">{fieldErrors.adminEmail}</p> : null}</label>
      <label>{uiText("Телефон")}<input name="adminPhone" /></label>
      <label>
        {uiText("Роль")}<select name="adminRole" defaultValue="owner">
          <option value="owner">{uiText("Администратор компании")}</option>
          <option value="director">{uiText("Директор")}</option>
        </select>
      </label>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <p className="muted">{uiText("После сохранения будет создана ссылка приглашения. Статус: «Ссылка создана», без отправки email.")}</p>
      <div className="actions">
        <button className="btn" disabled={busy}>{busy ? uiText("Сохранение…") : uiText("Создать")}</button>
        <Link className="btn secondary" to="/admin/companies">{uiText("Отмена")}</Link>
      </div>
    </form>
  );
}
