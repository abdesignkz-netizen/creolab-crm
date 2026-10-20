import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useUiText, uiMessage } from "../lib/uiText";
import { formatDateTimeRu } from "../lib/period";
import { InlineFeedback } from "../components/InlineFeedback";

const STATUS: Record<string, string> = {
  draft: "Черновик", ready: "Ожидает запуска", awaiting_confirmation: "Ожидает запуска", scheduled: "Запланирована",
  running: "Отправляется", paused: "Приостановлена", completed: "Отправлена",
  partially_completed: "Отправлена частично", failed: "Ошибка отправки", cancelled: "Отменена",
  pending: "Ожидает отправки", queued: "В очереди", sending: "Отправляется",
  sent: "Отправлено", delivered: "Доставлено", read: "Прочитано", replied: "Ответили", skipped: "Пропущен",
  unknown: "Проверьте отправку",
};

/** History stays available after the compose panel is closed, including failed attempts. */
export function CampaignHistory({ onCreate }: { onCreate?: () => void }) {
  const t = useUiText();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailError, setDetailError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    api.request<any>(`/api/v1/campaigns?page=${page}`).then(value => { if (alive) setData(value); })
      .catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [page, reload]);
  useEffect(() => {
    let alive = true;
    setDetail(null); setDetailError("");
    if (selectedId) api.campaign(selectedId).then(value => { if (alive) setDetail(value); })
      .catch(error => { if (alive) setDetailError(error.message); });
    return () => { alive = false; };
  }, [selectedId, reload]);
  return <section className="panel campaign-history" aria-label={t("История рассылок")}>
    <div className="task-create-head"><div><h3>{t("История рассылок")}</h3>
      <p className="muted">{t("Результаты отправки и причины ошибок по каждому получателю.")}</p></div>
      <div className="actions">
        <button type="button" className="btn secondary" onClick={() => setReload(value => value + 1)}>{t("Обновить")}</button>
        {onCreate ? <button type="button" className="btn" onClick={onCreate}>{t("Новая рассылка")}</button> : null}
      </div>
    </div>
    {error ? <InlineFeedback kind="error">{error}</InlineFeedback> : null}
    {!data && !error ? <p role="status">{t("Загрузка…")}</p> : null}
    {data?.items.length === 0 ? <p className="empty">{t("Рассылок пока нет.")}</p> : null}
    {data?.items.map((item: any) => <div key={item.id} className="campaign-history-item">
      <button type="button" className="campaign-history-open" aria-expanded={selectedId === item.id} onClick={() => setSelectedId(selectedId === item.id ? null : item.id)}>
        <span><strong>{item.title}</strong><span className="muted">{formatDateTimeRu(item.createdAt)}</span></span>
        <span>{t(STATUS[item.status] || "Статус неизвестен")}<span className="muted">{t("Отправлено")}: {item.summary.sent} / {item.summary.total} · {t("Ошибки")}: {item.summary.failed} · {t("Пропущено")}: {item.summary.skipped}</span></span>
      </button>
      {selectedId === item.id ? <div className="campaign-history-detail">
        {detailError ? <InlineFeedback kind="error">{detailError}</InlineFeedback>
          : !detail ? <p role="status">{t("Загрузка…")}</p> : <>
          {detail.statsJson?.billingPauseReason ? <p className="banner warn">{uiMessage(detail.statsJson.billingPauseReason)}</p> : null}
          <p className="muted">{t("«Отправлено» означает передачу сообщения провайдеру, а не прочтение клиентом.")}</p>
          {detail.recipients.map((recipient: any) => <div className="campaign-recipient" key={recipient.id}>
            <div><strong>{recipient.displayName || t("Без имени")}</strong><div>{recipient.phoneRaw || recipient.phoneNormalized || t("Телефон не указан")}</div>
              {recipient.conversationId ? <Link to={`/conversations/${recipient.conversationId}`}>{t("Открыть диалог")}</Link> : null}</div>
            <div><b>{t(STATUS[recipient.status] || "Статус неизвестен")}</b>
              {recipient.error || recipient.skipReason ? <p className="error">{uiMessage(
                /Green API HTTP 401/.test(recipient.error || "")
                  ? "Green API отклонил подключение (401). Для новой рассылки выберите подключённый номер WhatsApp."
                  : recipient.error || recipient.skipReason,
              )}</p> : null}
              {recipient.sentAt ? <span className="muted">{formatDateTimeRu(recipient.sentAt)}</span> : null}
            </div>
          </div>)}
        </>}
      </div> : null}
    </div>)}
    {data?.total > data?.pageSize ? <div className="actions">
      <button type="button" className="btn secondary" disabled={page === 1} onClick={() => { setPage(page - 1); setSelectedId(null); }}>{t("Назад")}</button>
      <span>{page} / {Math.ceil(data.total / data.pageSize)}</span>
      <button type="button" className="btn secondary" disabled={page * data.pageSize >= data.total} onClick={() => { setPage(page + 1); setSelectedId(null); }}>{t("Далее")}</button>
    </div> : null}
  </section>;
}
