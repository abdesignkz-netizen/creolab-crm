import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";

type BillingRequest = {
  id: string;
  company: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  planName?: string | null;
  planCode?: string | null;
  addOns?: Array<{ code: string; qty: number }>;
  billingPeriod: string;
  finalAmountMinor: number;
  status: string;
  statusLabel: string;
  createdAt: string;
  requestType: string;
};

function formatKzt(value: number) {
  return `${Number(value).toLocaleString("ru-RU")} ₸`;
}

export function PlatformBillingPage() {
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ items?: BillingRequest[]; pendingCount?: number } | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setData((await api.adminBillingRequests(status ? { status } : {})) as { items?: BillingRequest[]; pendingCount?: number });
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, [status]);

  async function openRequest(id: string) {
    setError("");
    setSelected(await api.adminBillingRequest(id));
  }

  async function confirm() {
    if (!selected?.request?.id) return;
    setBusy(true);
    try {
      const form = document.getElementById("billing-confirm-form") as HTMLFormElement | null;
      const startDate = form ? String(new FormData(form).get("startDate") || "") : "";
      const endDate = form ? String(new FormData(form).get("endDate") || "") : "";
      await api.adminConfirmBillingRequest(selected.request.id, { startDate, endDate });
      notifySaved("Оплата подтверждена, тариф активирован");
      setConfirmOpen(false);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось активировать");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!selected?.request?.id) return;
    const reason = window.prompt("Причина отклонения") || "";
    setBusy(true);
    try {
      await api.adminRejectBillingRequest(selected.request.id, { reason });
      notifySaved("Запрос отклонён");
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отклонить");
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items || [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Запросы на подключение</h2>
          <p className="muted">Клиент оплачивает вне системы. После проверки нажмите «Подтвердить оплату и активировать».</p>
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Все статусы</option>
          <option value="AWAITING_PAYMENT">Ожидает оплаты</option>
          <option value="PAYMENT_REVIEW">На проверке</option>
          <option value="ACTIVATED">Активированы</option>
          <option value="REJECTED">Отклонены</option>
          <option value="CANCELLED">Отменены</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="panel">
        {items.length === 0 ? (
          <p className="muted">Пока нет запросов на тариф.</p>
        ) : (
          <div className="signup-request-list">
            {items.map((item) => (
              <button key={item.id} type="button" className="signup-request-row" onClick={() => void openRequest(item.id)}>
                <div>
                  <b>{item.company}</b>
                  <div className="muted">{item.ownerName || "—"} · {item.ownerEmail || "—"}</div>
                  <div className="muted">
                    {item.planName || item.planCode} · {formatKzt(item.finalAmountMinor)} · {item.statusLabel} · {formatDateTime(item.createdAt)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <div className="panel stack">
          <h3>{selected.company?.name}</h3>
          <p>Владелец: {selected.owner?.name || "—"} · {selected.owner?.email || "—"} · {selected.owner?.phone || "—"}</p>
          <p>Текущий тариф: {selected.billing?.planName || "Нет"}</p>
          <p>Запрошено: {selected.request?.planName || selected.request?.planCode}</p>
          <p>
            Дополнения:{" "}
            {(selected.request?.addOns || []).length
              ? selected.request.addOns.map((row: { code: string; qty: number }) => `${row.code} × ${row.qty}`).join(", ")
              : "нет"}
          </p>
          <p>Период: {selected.request?.billingPeriod === "YEARLY" ? "1 год" : "1 месяц"}</p>
          <p>Стоимость: {formatKzt(selected.request?.finalAmountMinor || 0)}</p>
          <p>Статус: {selected.request?.statusLabel}</p>
          <p className="muted"><Link to={`/admin/companies/${selected.company?.id}`}>Открыть компанию</Link></p>
          <div className="actions">
            {selected.request?.status !== "ACTIVATED" && selected.request?.status !== "REJECTED" ? (
              <>
                <button className="btn" type="button" onClick={() => setConfirmOpen(true)}>Подтвердить оплату и активировать</button>
                <button className="btn secondary" type="button" disabled={busy} onClick={() => void reject()}>Отклонить</button>
              </>
            ) : null}
            <button className="btn secondary" type="button" onClick={() => setSelected(null)}>Закрыть</button>
          </div>
        </div>
      ) : null}

      {confirmOpen && selected ? (
        <div className="paywall-backdrop" role="dialog" aria-modal="true">
          <form id="billing-confirm-form" className="panel paywall-card stack" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
            <h2>Подтвердить оплату?</h2>
            <p>Компания: {selected.company?.name}</p>
            <p>Тариф: {selected.request?.planName}</p>
            <p>Сумма: {formatKzt(selected.request?.finalAmountMinor || 0)}</p>
            <p>Период: {selected.request?.billingPeriod === "YEARLY" ? "1 год" : "1 месяц"}</p>
            <label>Начало<input name="startDate" type="date" /></label>
            <label>Окончание<input name="endDate" type="date" /></label>
            <div className="actions">
              <button className="btn secondary" type="button" onClick={() => setConfirmOpen(false)}>Отмена</button>
              <button className="btn" disabled={busy}>Подтвердить и активировать</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
