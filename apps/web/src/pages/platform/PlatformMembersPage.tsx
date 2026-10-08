import { InlineFeedback } from "../../components/InlineFeedback";
import { useUiText, uiMessage } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";
import { statusBadgeClass } from "../../lib/statusBadge";
import { Pagination } from "../../components/Pagination";
import { useRequestVersion } from "../../lib/useUrlState";
import "../../platform-workspace.css";

export function PlatformMembersPage() {
  const uiText = useUiText();
  const version = useRequestVersion();
  const [q, setQ] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [query, setQuery] = useState({ q: "", tenantId: "", page: 1 });
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<any[]>([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const request = ++version.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.adminMembers({ ...query, limit: 20 });
      if (request === version.current) setData(result);
    } catch (err) {
      if (request === version.current)
        setError(err instanceof Error ? err.message : uiText("Ошибка"));
    } finally {
      if (request === version.current) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    api
      .adminTenants({ limit: 100 })
      .then((row: any) => {
        if (!cancelled) setCompanies(row.items || []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    void load();
  }, [query]);

  return (
    <div className="stack platform-workspace">
      <div className="page-head">
        <div>
          <h2>{uiText("Участники")}</h2>
          <p className="muted">
            {uiText("Люди, компании и доступ к сервису.")}
          </p>
        </div>
        <button
          type="button"
          className="btn"
          aria-expanded={inviteOpen}
          aria-controls="member-invite-form"
          onClick={() => setInviteOpen((value) => !value)}
        >
          {inviteOpen ? uiText("Скрыть форму") : uiText("Пригласить участника")}
        </button>
      </div>
      <form
        className="panel stack platform-invite"
        id="member-invite-form"
        hidden={!inviteOpen}
        onSubmit={async (event) => {
          event.preventDefault();
          if (inviteBusy) return;
          const form = new FormData(event.currentTarget);
          setInviteBusy(true);
          setInviteError("");
          setInviteUrl("");
          try {
            const result: any = await api.adminInviteMember(
              String(form.get("tenantId") || ""),
              {
                email: String(form.get("email") || ""),
                name: String(form.get("name") || ""),
                role: String(form.get("role") || "manager"),
              },
            );
            setInviteUrl(result.inviteUrl);
            notifySaved(uiText("Ссылка приглашения создана"));
            setQuery(current => ({ ...current }));
          } catch (err) {
            setInviteError(
              err instanceof Error ? err.message : uiText("Ошибка"),
            );
          } finally {
            setInviteBusy(false);
          }
        }}
      >
        <h3>{uiText("Пригласить участника")}</h3>
        <div className="platform-form-grid">
          <label>
            {uiText("Компания")}
            <select name="tenantId" required disabled={inviteBusy}>
              <option value="">{uiText("Выберите компанию")}</option>
              {companies.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uiText("Роль")}
            <select name="role" defaultValue="manager" disabled={inviteBusy}>
              <option value="owner">{uiText("Администратор компании")}</option>
              <option value="director">{uiText("Директор")}</option>
              <option value="sales_lead">
                {uiText("Руководитель продаж")}
              </option>
              <option value="manager">{uiText("Менеджер")}</option>
            </select>
          </label>
          <label>
            {uiText("Имя")}
            <input name="name" disabled={inviteBusy} />
          </label>
          <label>
            Email
            <input name="email" type="email" required disabled={inviteBusy} />
          </label>
        </div>
        {inviteError ? (
          <InlineFeedback kind="error">{inviteError}</InlineFeedback>
        ) : null}
        <div className="actions">
          <button className="btn" disabled={inviteBusy}>
            {inviteBusy ? uiText("Создаём…") : uiText("Создать ссылку")}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setInviteOpen(false)}
          >
            {uiText("Скрыть форму")}
          </button>
        </div>
        {inviteUrl ? (
          <div className="platform-invite-result">
            <label>
              {uiText("Ссылка приглашения")}
              <input
                value={inviteUrl}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(inviteUrl);
                  notifySaved(uiText("Ссылка скопирована"));
                } catch {
                  setInviteError(
                    uiText(
                      "Не удалось скопировать. Выделите ссылку и скопируйте вручную.",
                    ),
                  );
                }
              }}
            >
              {uiText("Копировать")}
            </button>
          </div>
        ) : null}
      </form>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({ q: q.trim(), tenantId, page: 1 });
        }}
      >
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder={uiText("Имя или email")}
          aria-label={uiText("Поиск участников")}
        />
        <select
          value={tenantId}
          aria-label={uiText("Компания")}
          onChange={(event) => {
            setTenantId(event.target.value);
            setQuery({ q: q.trim(), tenantId: event.target.value, page: 1 });
          }}
        >
          <option value="">{uiText("Все компании")}</option>
          {companies.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button className="btn secondary" disabled={loading}>
          {uiText("Найти")}
        </button>
      </form>
      {error ? (
        <InlineFeedback kind="error" message={error}>
          {error}
          <button
            type="button"
            className="btn secondary"
            onClick={() => void load()}
          >
            {uiText("Повторить")}
          </button>
        </InlineFeedback>
      ) : null}
      {!data && loading ? (
        <div className="state">{uiText("Загрузка…")}</div>
      ) : null}
      {data ? (
        <>
          <Pagination
            total={data.total}
            offset={(data.page - 1) * data.pageSize}
            limit={data.pageSize}
            loading={loading}
            onChange={(offset) =>
              setQuery((current) => ({
                ...current,
                page: offset / data.pageSize + 1,
              }))
            }
          />
          {!data.items.length ? (
            <div className="empty">
              <b>{uiText("Участники не найдены")}</b>
              <p>{uiText("Измените запрос или сбросьте фильтры.")}</p>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setQ("");
                  setTenantId("");
                  setQuery({ q: "", tenantId: "", page: 1 });
                }}
              >
                {uiText("Сбросить фильтры")}
              </button>
            </div>
          ) : (
            <div
              className="stats-table-wrap platform-directory"
              aria-busy={loading}
            >
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>{uiText("Участник")}</th>
                    <th>{uiText("Компания")}</th>
                    <th>{uiText("Роль")}</th>
                    <th>{uiText("Статус")}</th>
                    <th>{uiText("Последний вход")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item: any) => (
                    <tr key={item.id}>
                      <td data-label={uiText("Участник")}>
                        <strong>{item.name}</strong>
                        <div className="muted">{item.email}</div>
                        {item.phone ? (
                          <div className="muted">{item.phone}</div>
                        ) : null}
                      </td>
                      <td data-label={uiText("Компания")}>
                        <Link to={`/admin/companies/${item.tenantId}`}>
                          {item.tenantName}
                        </Link>
                      </td>
                      <td data-label={uiText("Роль")}>
                        {uiMessage(item.roleLabel)}
                      </td>
                      <td data-label={uiText("Статус")}>
                        <span
                          className={statusBadgeClass(
                            item.active ? "Активен" : "Приостановлен",
                          )}
                        >
                          {item.active
                            ? uiText("Активен")
                            : uiText("Приостановлен")}
                        </span>
                      </td>
                      <td data-label={uiText("Последний вход")}>
                        {item.lastSeenAt
                          ? formatDateTime(item.lastSeenAt)
                          : "—"}
                        <div className="muted">
                          {uiText("Добавлен")}: {formatDateTime(item.createdAt)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
