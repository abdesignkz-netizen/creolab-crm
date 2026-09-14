import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";

const STATUS_LABEL: Record<string, string> = {
  active: "Активна",
  suspended: "Приостановлена",
};

export function PlatformCompaniesPage({ mode }: { mode: "list" | "new" }) {
  if (mode === "new") return <CreateCompanyForm />;
  return <CompanyList />;
}

function CompanyList() {
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
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    void load(1);
    setPage(1);
  }, [status]);

  return (
    <div className="stack">
      <div className="page-head">
        <h3>Компании сервиса</h3>
        <Link className="btn" to="/admin/companies/new">Добавить компанию</Link>
      </div>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          void load(1);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по названию" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          <option value="active">Активные</option>
          <option value="suspended">Приостановленные</option>
        </select>
        <button className="btn secondary" type="submit">Найти</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">Загрузка…</div> : (
        <>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>БИН/ИИН</th>
                  <th>Администратор</th>
                  <th>Контакт</th>
                  <th>Участники</th>
                  <th>Подключения</th>
                  <th>Статус</th>
                  <th>Создана</th>
                </tr>
              </thead>
              <tbody>
                {(data.items || []).map((item: any) => (
                  <tr key={item.id}>
                    <td><Link to={`/admin/companies/${item.id}`}>{item.name}</Link></td>
                    <td>{item.bin || "—"}</td>
                    <td>{item.admin ? `${item.admin.name} (${item.admin.email})` : "—"}</td>
                    <td>{[item.contactEmail, item.contactPhone].filter(Boolean).join(" · ") || "—"}</td>
                    <td>{item.memberCount}</td>
                    <td>{item.connectionsLabel}</td>
                    <td>{STATUS_LABEL[item.status] || item.status}</td>
                    <td>{formatDateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn secondary" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); void load(next); }}>Назад</button>
            <span className="muted">Стр. {data.page} · {data.total}</span>
            <button className="btn secondary" disabled={page * data.pageSize >= data.total} onClick={() => { const next = page + 1; setPage(next); void load(next); }}>Дальше</button>
          </div>
        </>
      )}
    </div>
  );
}

function CreateCompanyForm() {
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
      notifySaved("Компания создана. Ссылка приглашения создана, письмо не отправлялось.");
      if (result.invitation?.inviteUrl) {
        await navigator.clipboard.writeText(result.invitation.inviteUrl).catch(() => undefined);
      }
      navigate(`/admin/companies/${result.company.id}`);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : "Не удалось создать");
      setFieldErrors(err?.body?.field_errors || {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <h3>Новая компания</h3>
      <label>Название *<input name="name" required />{fieldErrors.name ? <p className="field-error">{fieldErrors.name}</p> : null}</label>
      <label>Юридическое название<input name="legalName" /></label>
      <label>БИН/ИИН<input name="bin" />{fieldErrors.bin ? <p className="field-error">{fieldErrors.bin}</p> : null}</label>
      <label>Контактный email<input name="contactEmail" type="email" /></label>
      <label>Телефон<input name="contactPhone" /></label>
      <label>Город<input name="city" /></label>
      <label>Часовой пояс<input name="timezone" defaultValue="Asia/Almaty" /></label>
      <h4>Первый администратор / директор</h4>
      <label>Имя<input name="adminName" /></label>
      <label>Email *<input name="adminEmail" type="email" required />{fieldErrors.adminEmail ? <p className="field-error">{fieldErrors.adminEmail}</p> : null}</label>
      <label>Телефон<input name="adminPhone" /></label>
      <label>
        Роль
        <select name="adminRole" defaultValue="owner">
          <option value="owner">Администратор компании</option>
          <option value="director">Директор</option>
        </select>
      </label>
      {error ? <p className="error">{error}</p> : null}
      <p className="muted">После сохранения будет создана ссылка приглашения. Статус: «Ссылка создана», без отправки email.</p>
      <div className="actions">
        <button className="btn" disabled={busy}>{busy ? "Сохранение…" : "Создать"}</button>
        <Link className="btn secondary" to="/admin/companies">Отмена</Link>
      </div>
    </form>
  );
}
