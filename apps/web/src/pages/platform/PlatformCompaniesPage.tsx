import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";
import { statusBadgeClass } from "../../lib/statusBadge";

const STATUS_LABEL: Record<string, string> = {
  active: "Активна",
  suspended: "Приостановлена",
};

export function PlatformCompaniesPage({ mode }: { mode: "list" | "new" }) {
  if (mode === "new") return <CreateCompanyForm />;
  return <CompanyList />;
}

function CompanyList() {
  const uiText = useUiText();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load(nextPage = page) {
    setError("");
    try {
      setData(await api.adminTenants({ q, status, page: nextPage, limit: 20 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    void load(1);
    setPage(1);
  }, [status]);

  return (
    <div className="stack">
      <div className="page-head">
        <h2>{uiText("Компании")}</h2>
        <Link className="btn" to="/admin/companies/new">{uiText("Добавить компанию")}</Link>
      </div>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          void load(1);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={uiText("Поиск по названию")} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{uiText("Все статусы")}</option>
          <option value="active">{uiText("Активные")}</option>
          <option value="suspended">{uiText("Приостановленные")}</option>
        </select>
        <button className="btn secondary" type="submit">{uiText("Найти")}</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">{uiText("Загрузка…")}</div> : (
        <>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Название")}</th>
                  <th>{uiText("Владелец")}</th>
                  <th>{uiText("Тариф")}</th>
                  <th>{uiText("БИН/ИИН")}</th>
                  <th>{uiText("Администратор")}</th>
                  <th>{uiText("Контакт")}</th>
                  <th>{uiText("Участники")}</th>
                  <th>{uiText("Подключения")}</th>
                  <th>WhatsApp AI</th>
                  <th>{uiText("Статус")}</th>
                  <th>{uiText("Создана")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.items || []).map((item: any) => (
                  <tr key={item.id}>
                    <td><Link to={`/admin/companies/${item.id}`}>{item.name}</Link></td>
                    <td>{item.owner?.email || item.admin?.email || "—"}</td>
                    <td>
                      {item.subscriptionStatus === "none" || item.previewMode
                        ? uiText("Просмотр")
                        : item.planName || item.subscriptionStatus || "—"}
                    </td>
                    <td>{item.bin || "—"}</td>
                    <td>{item.admin ? `${item.admin.name} (${item.admin.email})` : "—"}</td>
                    <td>{[item.contactEmail, item.contactPhone].filter(Boolean).join(" · ") || "—"}</td>
                    <td>{item.memberCount}</td>
                    <td>{item.connectionsLabel}</td>
                    <td><Link to={`/admin/ai-managers/${item.id}`}>{uiText("Промт и база")}</Link></td>
                    <td>
                      <span className={statusBadgeClass(STATUS_LABEL[item.status] || item.status)}>
                        {localizeUiOptions(STATUS_LABEL, uiText)[item.status] || item.status}
                      </span>
                    </td>
                    <td>{formatDateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn secondary" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); void load(next); }}>{uiText("Назад")}</button>
            <span className="muted">{uiText("Стр.")}{" "}{data.page} · {data.total}</span>
            <button className="btn secondary" disabled={page * data.pageSize >= data.total} onClick={() => { const next = page + 1; setPage(next); void load(next); }}>{uiText("Дальше")}</button>
          </div>
        </>
      )}
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
      {error ? <p className="error">{error}</p> : null}
      <p className="muted">{uiText("После сохранения будет создана ссылка приглашения. Статус: «Ссылка создана», без отправки email.")}</p>
      <div className="actions">
        <button className="btn" disabled={busy}>{busy ? uiText("Сохранение…") : uiText("Создать")}</button>
        <Link className="btn secondary" to="/admin/companies">{uiText("Отмена")}</Link>
      </div>
    </form>
  );
}
