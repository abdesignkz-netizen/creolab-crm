import { useEffect, useRef, useState } from "react";
import type { CrmReviewField, CrmReviewItem, CrmReviewList, CrmReviewValue } from "@creolab/contracts";
import { api } from "../lib/api";
import { uiFormatLocale, uiMessage, useUiText } from "../lib/uiText";
import CrmCalendarEffects from "./CrmCalendarEffects";
import { InlineFeedback } from "./InlineFeedback";
import { CrmCommercialSummary, formatCrmMoney, isCrmMoney } from "./CrmCommercialSummary";
import "./conversationCrmReview.css";

export function CrmReviewCard({ item, busy, onDecision }: {
  item: CrmReviewItem; busy: boolean; onDecision: (id: string, decision: "accept" | "dismiss" | "undo") => void;
}) {
  const uiText = useUiText();
  const [confirmUndo, setConfirmUndo] = useState(false);
  const proposed = ["pending", "dismissed", "superseded"].includes(item.status);
  const labels: Record<CrmReviewField, string> = {
    summary: uiText("Сводка о клиенте"), aiSummary: uiText("Сводка по заявке"), nextStep: uiText("Следующий шаг"),
    status: uiText("Статус заявки"), needsReply: uiText("Нужен ответ"),
    customerBudget: uiText("Бюджет клиента"), proposedPrice: uiText("Предложенная цена"), agreedPrice: uiText("Согласованная цена"),
    objection: uiText("Последнее возражение"), refusalReason: uiText("Последняя причина отказа"),
  };
  const statuses = {
    pending: uiText("Проверьте предложение"), accepted: uiText("Подтверждено сотрудником"), automatic: uiText("Обновлено автоматически"),
    dismissed: uiText("Отклонено"), superseded: uiText("Есть более новый анализ"), undone: uiText("Изменение отменено"),
  };
  const statusLabels: Record<string, string> = { new: uiText("Новая"), qualification: uiText("Квалификация"), qualified: uiText("Квалифицирована"),
    accepted: uiText("Принята"), in_progress: uiText("В работе"), waiting_client: uiText("Ждём клиента"), waiting_manager: uiText("Ждём менеджера") };
  const display = (key: CrmReviewField, value: CrmReviewValue) => value === null || value === "" ? uiText("Не заполнено")
    : typeof value === "boolean" ? value ? uiText("Да") : uiText("Нет") : isCrmMoney(value) ? formatCrmMoney(value, uiText) : key === "status" ? statusLabels[value] || value : value;
  const blocked = item.blockedReason === "permissions" ? item.process ? uiText("Подтверждение и отмена связанных действий доступны руководителю.") : uiText("Для этих полей нужны права руководителя или ответственного сотрудника.")
    : item.blockedReason === "changed" ? uiText("Карточка уже изменена. Повторите анализ, чтобы сохранить свежие данные.")
    : item.blockedReason === "conversation_changed" ? uiText("Переписка изменилась. Проверьте новые сообщения и повторите анализ.")
    : item.blockedReason === "settings_changed" ? uiText("Настройки или ответственный изменились. Повторите анализ с текущими правилами.")
    : item.blockedReason === "expired" ? uiText("Предложенное время уже прошло. Уточните новую дату и повторите анализ.")
    : item.blockedReason === "effects_started" ? uiText("Уже началось выполнение или создано уведомление. Проверьте результат в связанной задаче; автоматическая отмена недоступна.")
    : item.blockedReason === "calendar" ? uiText("Договорённость связана с внешним календарём. Сначала сверьте изменения с календарём.")
    : item.blockedReason === "related_activity" ? uiText("Связанные записи или исполнитель изменились. Проверьте их и повторите анализ.")
    : item.blockedReason ? uiText("Изменение сейчас недоступно.") : "";
  return <article className={`crm-review-card ${item.status === "pending" ? "pending" : ""}`}>
    <header><b>{item.entityType === "process" ? uiText("Действия по переписке") : item.entityType === "contact" ? uiText("Карточка клиента") : uiText("Заявка")}</b><span>{statuses[item.status]}</span></header>
    <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(uiFormatLocale(), { dateStyle: "short", timeStyle: "short" })}</time>
    {item.fields.map(field => <div key={field.key} className="crm-review-field">
      <b>{labels[field.key]}</b>
      <div className="crm-review-before"><small>{uiText("Было")}</small><p>{display(field.key, field.before)}</p></div>
      <div className="crm-review-after"><small>{item.status === "pending" ? uiText("Предлагается") : uiText("Изменение ИИ")}</small><p>{display(field.key, field.after)}</p></div>
    </div>)}
    {item.process ? <>
      {item.status === "pending" ? <p className="muted">{uiText("Это предложение: записи ещё не изменены. Проверьте даты, ответственных и источники. Все действия ниже применятся вместе.")}</p> : item.canUndo ? <p className="muted">{uiText("Связанные изменения отменяются вместе. Новые задачи и договорённости останутся в истории со статусом «Отменена».")}</p> : null}
      {item.process.entries.map(entry => <details className="crm-review-process-entry" open={item.status === "pending" || undefined} key={`${entry.entityType}:${entry.entityId}`}>
        <summary><b>{uiText(entry.entityType === "task" ? "Задача" : entry.entityType === "deal" ? "Сделка" : "Договорённость")}: {entry.title}</b><small>{proposed ? entry.created ? uiText("Новая запись") : uiText("Изменение записи") : entry.created ? uiText("Создано ИИ") : uiText("Обновлено ИИ")}</small></summary>
        <div className={entry.created ? "crm-review-new-fields" : undefined}>{entry.fields.filter(field => !entry.created || field.label !== "Название").map(field => <div className="crm-review-field" key={field.label}><b>{uiText(field.label)}</b>
          {!entry.created ? <div className="crm-review-before"><small>{uiText("Было")}</small><p>{field.before === null ? uiText("Не заполнено") : field.status ? uiText(field.before) : field.before}</p></div> : null}
          <div className="crm-review-after">{!entry.created ? <small>{proposed ? uiText("Предлагается") : uiText("Изменение ИИ")}</small> : null}<p>{field.after === null ? uiText("Не заполнено") : field.status ? uiText(field.after) : field.after}</p></div>
        </div>)}</div>
      </details>)}
      {item.process.reminders > 0 && (!proposed || item.status === "pending") ? <p className="muted">{proposed ? uiText("Напоминаний после подтверждения") : uiText("Запланировано напоминаний")}: {item.process.reminders}</p> : null}
      {item.status === "pending" ? <p className="muted">{uiText("Отправка сообщений и документов подтверждается отдельно в задаче.")}</p> : null}
      {item.status === "pending" && item.process.calendarSync ? <p className="crm-review-warning">{uiText("Подключён календарь: подтверждённая встреча может синхронизироваться с ним. Последующие изменения потребуют сверки.")}</p> : null}
      <CrmCalendarEffects effects={item.process.calendarEffects} queues={item.process.queues} />
    </> : null}
    <details className="crm-review-evidence"><summary>{uiText("На основании переписки")} · {item.evidence.length}</summary>
      {item.evidence.map(message => <blockquote key={message.id}>
        <small>{message.direction === "inbound" ? uiText("Клиент") : message.senderKind === "ai" ? "AI" : uiText("Сотрудник")} · {new Date(message.createdAt).toLocaleString(uiFormatLocale(), { dateStyle: "short", timeStyle: "short" })}</small>
        <p>{message.quote || message.text || uiText("Сообщение с вложением")}</p>
        {message.quote && message.quote !== message.text ? <details><summary>{uiText("Сообщение целиком")}</summary><p>{message.text}</p></details> : null}
      </blockquote>)}
    </details>
    {item.status === "pending" && item.confidence !== "HIGH" ? <p className="muted">{uiText("ИИ не уверен в выводе. Сверьте его с сообщениями клиента.")}</p> : null}
    {blocked ? <p className="crm-review-warning">{blocked}</p> : null}
    <div className="crm-review-actions">
      {item.status === "pending" ? <>
        <button type="button" className="btn" disabled={busy || !item.canAccept} onClick={() => onDecision(item.id, "accept")}>{item.process ? uiText("Подтвердить действия") : uiText("Применить изменения")}</button>
        <button type="button" className="btn secondary" disabled={busy || !item.canDismiss} onClick={() => onDecision(item.id, "dismiss")}>{uiText("Отклонить")}</button>
      </> : null}
      {item.canUndo && !confirmUndo ? <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmUndo(true)}>{uiText("Отменить изменение")}</button> : null}
    </div>
    {item.canUndo && confirmUndo ? <div className="crm-review-confirm" role="group" aria-label={uiText("Отмена изменения")}>
      <p>{item.process ? uiText("Восстановить прежние записи, отменить созданные ИИ задачи и договорённости и пересчитать неотправленные напоминания? История сохранится.") : uiText("Вернуть значения из блока «Было»? Это действие сохранится в истории.")}</p>
      <div className="crm-review-actions"><button type="button" className="btn" disabled={busy} onClick={() => onDecision(item.id, "undo")}>{uiText("Вернуть прежние значения")}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmUndo(false)}>{uiText("Оставить как есть")}</button></div>
    </div> : null}
  </article>;
}

export default function ConversationCrmReview({ conversationId, refreshKey, onChanged }: {
  conversationId: string; refreshKey: string; onChanged: () => Promise<void>;
}) {
  const uiText = useUiText();
  const [data, setData] = useState<CrmReviewList | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const version = useRef(0);
  const scope = useRef(conversationId);
  scope.current = conversationId;
  useEffect(() => {
    const request = ++version.current;
    setLoading(true); setLoadError("");
    api.conversationCrmReview(conversationId).then(result => {
      if (request === version.current) setData(result);
    }).catch(err => {
      if (request === version.current) { setData(null); setLoadError(err instanceof Error ? err.message : uiText("Не удалось загрузить изменения CRM")); }
    }).finally(() => { if (request === version.current) setLoading(false); });
    return () => { version.current += 1; };
  }, [conversationId, refreshKey, reload]);
  async function decide(id: string, decision: "accept" | "dismiss" | "undo") {
    if (busy || loading) return;
    const current = conversationId;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.reviewConversationCrmChange(current, id, decision);
      if (scope.current !== current) return;
      setNotice(decision === "undo" ? uiText("Изменение отменено") : decision === "accept" ? uiText("Изменения сохранены") : uiText("Предложение отклонено"));
      await onChanged();
    } catch (err) {
      if (scope.current === current) setError(err instanceof Error ? err.message : uiText("Не удалось сохранить изменения"));
    } finally {
      if (scope.current === current) { setBusy(false); setReload(n => n + 1); }
    }
  }
  const pending = data?.items.filter(item => item.status === "pending") || [];
  const history = data?.items.filter(item => item.status !== "pending") || [];
  return <section className="panel soft crm-review" aria-label={uiText("Изменения CRM из переписки")} aria-busy={loading || busy}>
    <div className="crm-review-heading"><b>{uiText("Изменения CRM из переписки")}</b><button type="button" className="btn secondary small" disabled={loading || busy} onClick={() => setReload(n => n + 1)}>{uiText("Обновить")}</button></div>
    <p className="muted">{uiText("Проверьте сведения из переписки и связанные действия ИИ. Здесь видны источники, изменения и возможность отмены.")}</p>
    <CrmCommercialSummary values={data?.commercial} />
    {error ? <InlineFeedback>{uiMessage(error)}</InlineFeedback> : null}
    {loadError ? <InlineFeedback>{uiMessage(loadError)}</InlineFeedback> : null}
    {notice ? <InlineFeedback kind="success">{notice}</InlineFeedback> : null}
    {loading && !data ? <p role="status">{uiText("Загрузка…")}</p> : null}
    {!loading && data && !pending.length ? <p className="muted">{uiText("Нет предложений для проверки. Новые появятся после анализа переписки.")}</p> : null}
    {pending.map(item => <CrmReviewCard key={item.id} item={item} busy={busy || loading} onDecision={decide} />)}
    {history.length ? <details className="crm-review-history"><summary>{uiText("История изменений")} · {history.length}</summary>
      {history.map(item => <CrmReviewCard key={item.id} item={item} busy={busy || loading} onDecision={decide} />)}
    </details> : null}
    {data?.hasMore ? <p className="muted">{uiText("Показаны последние 50 изменений. Полная история доступна в карточке клиента.")}</p> : null}
  </section>;
}
