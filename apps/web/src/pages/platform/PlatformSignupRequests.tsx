import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions, uiMessage } from "../../lib/uiText";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";

type SignupRequest = {
  id: string;
  email: string;
  companyName: string;
  status: string;
  statusLabel: string;
  createdAt: string;
};

export function PlatformSignupRequests({ title }: { title?: string }) {
  const uiText = useUiText();
  const [items, setItems] = useState<SignupRequest[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    const data = (await api.adminSignupRequests()) as { items?: SignupRequest[]; pendingCount?: number };
    setItems(data.items || []);
    setPendingCount(Number(data.pendingCount || 0));
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось загрузить запросы")));
  }, [load]);

  async function setStatus(id: string, status: "NEW" | "DONE") {
    setBusyId(id);
    setError("");
    try {
      await api.adminUpdateSignupRequest(id, { status });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось обновить запрос"));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="panel stack">
      <div>
        <h3>{title || uiText("Регистрации")}{pendingCount > 0 ? ` · ${pendingCount}` : ""}</h3>
        <p className="muted">{uiText("Заявки с экрана входа и самостоятельные регистрации. Новые компании создаются автоматически — вручную заводить кабинет больше не обязательно.")}</p>
      </div>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {items.length === 0 ? (
        <p className="muted">{uiText("Пока нет запросов.")}</p>
      ) : (
        <div className="signup-request-list">
          {items.map((item) => (
            <div key={item.id} className={`signup-request-row ${item.status === "NEW" ? "is-new" : ""}`}>
              <div>
                <b>{item.companyName}</b>
                <div className="muted">{item.email}</div>
                <div className="muted">{formatDateTime(item.createdAt)} · {uiMessage(item.statusLabel)}</div>
              </div>
              {item.status === "NEW" ? (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busyId === item.id}
                  onClick={() => void setStatus(item.id, "DONE")}
                >
                  {uiText("Обработано")}</button>
              ) : (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busyId === item.id}
                  onClick={() => void setStatus(item.id, "NEW")}
                >
                  {uiText("Вернуть")}</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
