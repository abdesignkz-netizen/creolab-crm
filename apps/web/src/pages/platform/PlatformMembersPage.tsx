import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";
import { statusBadgeClass } from "../../lib/statusBadge";

export function PlatformMembersPage() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [companies, setCompanies] = useState<any[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setData(await api.adminMembers({ q, tenantId, limit: 50 }));
  }

  useEffect(() => {
    api.adminTenants({ limit: 100 }).then((row: any) => setCompanies(row.items || [])).catch(() => undefined);
    void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  return (
    <div className="stack">
      <h2>Участники</h2>
      <form
        className="panel stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const companyId = String(form.get("tenantId") || "");
          try {
            const result = (await api.adminInviteMember(companyId, {
              email: String(form.get("email") || ""),
              name: String(form.get("name") || ""),
              role: String(form.get("role") || "manager"),
            })) as any;
            setInviteUrl(result.inviteUrl);
            notifySaved("Ссылка приглашения создана");
            await load();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Ошибка");
          }
        }}
      >
        <h3>Пригласить участника</h3>
        <label>
          Компания
          <select name="tenantId" required>
            <option value="">Выберите компанию</option>
            {companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Имя<input name="name" /></label>
        <label>Email<input name="email" type="email" required /></label>
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
        {inviteUrl ? <p>Статус: ссылка создана. <button type="button" className="btn secondary" onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Копировать</button></p> : null}
      </form>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" />
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
          <option value="">Все компании</option>
          {companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="btn secondary">Найти</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">Загрузка…</div> : (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>Имя</th><th>Email</th><th>Телефон</th><th>Компания</th><th>Роль</th><th>Статус</th><th>Добавлен</th><th>Последний вход</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map((item: any) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.email}</td>
                  <td>{item.phone || "—"}</td>
                  <td><Link to={`/admin/companies/${item.tenantId}`}>{item.tenantName}</Link></td>
                  <td>{item.roleLabel}</td>
                  <td>
                    <span className={statusBadgeClass(item.active ? "Активен" : "Приостановлен")}>
                      {item.active ? "Активен" : "Приостановлен"}
                    </span>
                  </td>
                  <td>{formatDateTime(item.createdAt)}</td>
                  <td>{item.lastSeenAt ? formatDateTime(item.lastSeenAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
